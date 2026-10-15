// Auction + sealed smoke test (one human, bots fill the table).
// New auction rules: every player gets N packs of M cards (defaults 2 x 30), $200 budget, $2 minimum bid. The nominator picks a card
// from the open pack and either opens the bidding ("Open at $X") or skips it (unsold cards are discarded); everyone else can bid or Pass.
// Usage: node e2e/auction.mjs [baseUrl] [outDir]
import { assert, BASE, browser, errors, newPage, OUT, settle, step } from './lib.mjs';

const page = await newPage();
page.setDefaultTimeout(8000);

await page.goto(BASE);
await page.getByLabel('Your name').fill('Max');
await page.getByRole('button', { name: 'Create room' }).click();
await page.waitForURL(/\/r\//);
await page.getByRole('button', { name: /Auction draft/ }).click();
const setting = (label) => page.locator('.setting', { hasText: label }).locator('input');
const set = async (label, v) => { await setting(label).fill(String(v)); await settle(page, 250); };

step('defaults: 2 packs x 30 cards, $200 budget, $2 minimum bid');
const defaults = {
  'Budget per player': '200', 'Minimum bid': '2', 'Packs per player': '2', 'Cards per pack': '30', 'Pool size cap': '0',
};
for (const [label, v] of Object.entries(defaults)) assert((await setting(label).inputValue()) === v, `${label} default should be ${v}, is ${await setting(label).inputValue()}`);
await page.screenshot({ path: `${OUT}/10-auction-lobby.png` });

// Keep it short: 4 seats (1 human + 3 bots) x 1 pack x 6 cards = 24 lots.
const PACKS = 1, PACK_SIZE = 6, SEATS = 4, TOTAL = SEATS * PACKS * PACK_SIZE, BUDGET = 200, MIN_BID = 2;
await set('Packs per player', PACKS);
await set('Cards per pack', PACK_SIZE);
await set('Bid timer', 4);
await set('Time to choose a card', 4);
await page.getByRole('button', { name: /Start auction draft/ }).click();
await page.getByText(/Auction · Pack 1/).waitFor();
const head = await page.locator('.draft-head').innerText();
assert(new RegExp(`Pack 1/${SEATS * PACKS}`).test(head), 'header should show the total pack count: ' + head);
assert(new RegExp(`Min bid ${MIN_BID}\\b`).test(head), 'header should show the minimum bid: ' + head);
assert(new RegExp(`[1-${PACK_SIZE}] card\\(s\\) left in this pack`).test(head), "header should show the cards left: " + head);

const me = page.locator('.budgets tr.me');
const myBudget = async () => Number((await me.locator('td').nth(1).innerText()).replace(/\D/g, ''));
const myWon = async () => Number((await me.locator('td').nth(2).innerText()).trim());
assert((await myBudget()) === BUDGET, 'start budget should be $200');

let shotLot = false, shotNom = false, skipped = false, opened = 0, passed = 0, bids = 0;
let lastWon = 0, lastBudget = BUDGET;
const until = Date.now() + 4 * 60_000;
while (Date.now() < until) {
  if (await page.getByText('Deckbuilding').count()) break;

  // Consistency check on a single snapshot: money spent == sum of my winning prices in the sales feed, "Won" == number of those sales.
  if (await me.count()) {
    const [budget, won, results] = await Promise.all([myBudget(), myWon(), page.locator('.results').innerText()]).catch(() => [null, null, null]);
    if (results != null) {
      const mine = [...results.matchAll(/→ Max \(\$(\d+)\)/g)].map((m) => Number(m[1]));
      if (mine.length === won && mine.every((x) => x >= MIN_BID)) {
        assert(BUDGET - budget === mine.reduce((a, b) => a + b, 0), `budget ${budget} inconsistent with purchases ${mine}`);
        lastWon = won; lastBudget = budget;
      }
    }
  }

  // My turn to nominate: choose a card, then Open at $X or Skip.
  const choose = page.locator('.auction .card-grid .cube-card.clickable');
  if (await choose.count()) {
    const leftBefore = Number((await page.locator('.draft-head').innerText()).match(/(\d+) card\(s\) left/)?.[1]);
    await choose.first().click().catch(() => {});
    const open = page.getByRole('button', { name: /^Open at \$/ });
    const skip = page.getByRole('button', { name: /^Skip/ });
    if (await open.count()) {
      const min = await page.locator('.nominate-panel input').getAttribute('min');
      assert(Number(min) === MIN_BID, 'opening bid input should have min ' + MIN_BID);
      if (!shotNom) { await page.screenshot({ path: `${OUT}/10b-auction-nominate.png` }); shotNom = true; }
      if (!skipped) {
        // First nomination: skip it, the card must be discarded (unsold, one fewer card in the open pack).
        await skip.click({ timeout: 1000 }).catch(() => {});
        skipped = true;
        await settle(page, 600);
        const results = await page.locator('.results').innerText();
        assert(/unsold/.test(results), 'a skipped card should appear as unsold in the feed: ' + results);
        const leftAfter = Number((await page.locator('.draft-head').innerText().catch(() => '')).match(/(\d+) card\(s\) left/)?.[1] ?? NaN);
        if (!Number.isNaN(leftAfter) && leftAfter < PACK_SIZE) assert(leftAfter < leftBefore, `open pack ${leftBefore} -> ${leftAfter} after skipping`);
      } else if (await open.click({ timeout: 1000 }).then(() => true, () => false)) opened++;
    }
  }

  // Bidding: the lot shows Pass; bid a little sometimes, pass otherwise.
  const bid1 = page.locator('.bid-buttons button.primary:not([disabled])', { hasText: /^Bid/ });
  if (await bid1.count() && Math.random() < 0.25) { if (await bid1.click({ timeout: 800 }).then(() => true, () => false)) bids++; }
  const pass = page.getByRole('button', { name: 'Pass', exact: true });
  if (await pass.count() && await pass.isEnabled().catch(() => false) && Math.random() < 0.6) {
    if (await pass.click({ timeout: 800 }).then(() => true, () => false)) passed++;
  }
  if (!shotLot && await page.locator('.lot-card').count()) { await settle(page, 500); await page.screenshot({ path: `${OUT}/10-auction.png` }); shotLot = true; }
  await settle(page, 250);
}
await page.getByText('Deckbuilding').waitFor({ timeout: 5000 });
const poolCount = await page.locator('.db-main > .pool-summary .cube-card').count();
console.log(`  auction pool size ${poolCount} (won ${lastWon}, last budget $${lastBudget}); opened ${opened}, bids ${bids}, passes ${passed}, skipped first: ${skipped}`);
assert(poolCount <= TOTAL, `expected at most ${TOTAL} cards (4 seats x ${PACKS} pack x ${PACK_SIZE})`);
assert(poolCount >= lastWon && poolCount <= lastWon + 1, `pool ${poolCount} should match the last seen Won count ${lastWon}`);
assert(lastBudget >= 0 && lastBudget <= BUDGET, 'budget stays within 0..200');
assert(skipped, 'never got a turn to nominate (the skip path was not exercised)');

// Sealed: host returns to lobby and runs sealed for one seat.
page.setDefaultTimeout(15000);
page.on('dialog', (d) => d.accept());
await page.getByRole('button', { name: /New event/ }).click();
await page.getByRole('button', { name: /Sealed/ }).waitFor();
await page.getByRole('button', { name: /Sealed/ }).click();
await settle(page, 300);
await page.getByRole('button', { name: /Start sealed/ }).click();
await page.getByText('Deckbuilding').waitFor();
const sealed = await page.locator('.db-main > .pool-summary .cube-card').count();
console.log('  sealed pool size', sealed);
await page.screenshot({ path: `${OUT}/11-sealed.png` });
assert(sealed === 90, 'expected 90 sealed cards');
await browser.close();
if (errors.length) { console.log('page errors:', errors.join('; ')); console.log('AUCTION+SEALED FAILED'); process.exit(1); }
console.log('AUCTION+SEALED OK');
