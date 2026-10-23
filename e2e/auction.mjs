// Auction + sealed smoke test (one human, bots fill the table).
// Auction rules: every player gets N packs of M cards (defaults 2 x 30), $200 budget, $2 minimum bid. The nominator picks a card
// from the open pack and opens the bidding ("Open at $X") or puts it up without a bid; there is no unilateral discard: a card
// goes unsold only when nobody bids. Won cards go to the main deck (click to move them to the sideboard). "Pass on the rest"
// ends the auction once every player has ticked it (bots go along). A broke opponent never gets a card awarded to anyone.
// Usage: node e2e/auction.mjs [baseUrl] [outDir]
import { assert, BASE, browser, errors, newPage, OUT, settle, step } from './lib.mjs';

const page = await newPage();
page.setDefaultTimeout(8000);

await page.goto(BASE);
await page.getByLabel('Your name').fill('Max');
await page.getByRole('button', { name: 'Create room' }).click();
await page.waitForURL(/\/r\//);
await page.getByRole('button', { name: /^Cube auction/ }).click();
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
await page.getByRole('button', { name: /Start cube auction/i }).click();
await page.getByText(/Auction · Pack 1/).waitFor();
const head = await page.locator('.draft-head').innerText();
assert(new RegExp(`Pack 1/${SEATS * PACKS}`).test(head), 'header should show the total pack count: ' + head);
assert(new RegExp(`Min bid ${MIN_BID}\\b`).test(head), 'header should show the minimum bid: ' + head);
assert(new RegExp(`[1-${PACK_SIZE}] card\\(s\\) left in this pack`).test(head), "header should show the cards left: " + head);

const me = page.locator('.budgets tr.me');
const myBudget = async () => Number((await me.locator('td').nth(1).innerText()).replace(/\D/g, ''));
const myWon = async () => Number((await me.locator('td').nth(2).innerText()).trim());
assert((await myBudget()) === BUDGET, 'start budget should be $200');

let shotLot = false, shotNom = false, putUpNoBid = false, opened = 0, passed = 0, bids = 0;
let lastWon = 0, lastBudget = BUDGET, movedToSide = null;
const mainCount = async () => Number((await page.locator('.picks-main h4').innerText().catch(() => '(0)')).match(/\((\d+)\)/)?.[1] ?? 0);
const sideCount = async () => Number((await page.locator('.picks-side h4').innerText().catch(() => '(0)')).match(/\((\d+)\)/)?.[1] ?? 0);
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

  // Main deck / sideboard: once I've won a card, move one to the sideboard.
  if (!movedToSide && lastWon > 0 && await page.locator('.picks-main .cube-card').count()) {
    const [m0, s0] = [await mainCount(), await sideCount()];
    await page.locator('.picks-main .cube-card').first().click().catch(() => {});
    await settle(page, 600);
    if (await page.getByText('Deckbuilding').count()) break;
    const [m1, s1] = [await mainCount(), await sideCount()];
    assert(m1 === m0 - 1 && s1 === s0 + 1, `moving a won card to the sideboard: main ${m0}->${m1}, side ${s0}->${s1}`);
    movedToSide = { main: m1, side: s1 };
  }

  // Pass on the rest: once a card has been moved to the sideboard, end the auction (the bots go along).
  if (movedToSide) {
    const won = await myWon();
    await page.getByLabel('Pass on the rest').check();
    await page.getByText('Deckbuilding').waitFor({ timeout: 8000 });
    lastWon = won;
    break;
  }

  // My turn to nominate: no Skip button any more; open at $X, or put it up without a bid (first time).
  const choose = page.locator('.auction .card-grid .cube-card.clickable');
  if (await choose.count()) {
    await choose.first().click().catch(() => {});
    const open = page.getByRole('button', { name: /^Open at \$/ });
    if (await open.count()) {
      assert(await page.getByRole('button', { name: /^Skip/ }).count() === 0, 'the nominator must not be able to discard a card');
      const min = await page.locator('.nominate-panel input').getAttribute('min');
      assert(Number(min) === MIN_BID, 'opening bid input should have min ' + MIN_BID);
      if (!shotNom) { await page.screenshot({ path: `${OUT}/10b-auction-nominate.png` }); shotNom = true; }
      if (!putUpNoBid) {
        await page.getByRole('button', { name: 'Put up, no bid' }).click({ timeout: 1000 }).catch(() => {});
        putUpNoBid = true;
        await settle(page, 300);
        const info = await page.locator('.lot-info').innerText().catch(() => '');
        if (info) assert(/no bids yet|High bid|Opened by/.test(info), 'a card put up without a bid shows no bids yet: ' + info);
      } else if (await open.click({ timeout: 1000 }).then(() => true, () => false)) opened++;
    }
  }

  // Bidding: the lot shows Pass; bid a little sometimes, pass otherwise.
  const bid1 = page.locator('.bid-buttons button.primary:not([disabled])', { hasText: /^Bid/ });
  if (await bid1.count() && Math.random() < 0.35) { if (await bid1.click({ timeout: 800 }).then(() => true, () => false)) bids++; }
  const pass = page.getByRole('button', { name: 'Pass', exact: true });
  if (await pass.count() && await pass.isEnabled().catch(() => false) && Math.random() < 0.5) {
    if (await pass.click({ timeout: 800 }).then(() => true, () => false)) passed++;
  }
  if (!shotLot && await page.locator('.lot-card').count()) { await settle(page, 500); await page.screenshot({ path: `${OUT}/10-auction.png` }); shotLot = true; }
  await settle(page, 250);
}
await page.getByText('Deckbuilding').waitFor({ timeout: 5000 });
await page.screenshot({ path: `${OUT}/10c-auction-deckbuilding.png` });
// Pool = deck view + sideboard; the main/sideboard split carried over.
const deckCount = await page.locator('.db-columns .cube-card').count();
const sideboard = await page.locator('.db-main > .pool-summary .cube-card').count();
console.log(`  auction pool: ${deckCount} in the deck + ${sideboard} sideboard (won ${lastWon}, last budget $${lastBudget}); opened ${opened}, bids ${bids}, passes ${passed}, put up without a bid: ${putUpNoBid}, moved to side: ${!!movedToSide}`);
assert(deckCount + sideboard <= TOTAL, `expected at most ${TOTAL} cards`);
assert(deckCount + sideboard >= lastWon && deckCount + sideboard <= lastWon + 1, `pool ${deckCount + sideboard} should match the last seen Won count ${lastWon}`);
assert(lastBudget >= 0 && lastBudget <= BUDGET, 'budget stays within 0..200');
if (movedToSide) {
  assert(sideboard >= 1, 'the card moved to the sideboard during the auction is in the sideboard');
  assert(deckCount === movedToSide.main || deckCount === movedToSide.main + 1, `main deck carried over: ${deckCount} vs ${movedToSide.main}`);
} else console.log('  (never won a card in time: the main/sideboard move was not exercised)');

// Out of money: a $10 budget. Max never bids and lets his nominations time out; once the bots are broke, a card Max
// didn't bid on must never be awarded to him. Then Pass on the rest ends it.
step('out of money: nobody is handed a card they did not bid on');
page.on('dialog', (d) => d.accept());
await page.getByRole('button', { name: /New event/ }).click();
await page.getByRole('button', { name: /^Cube auction/ }).waitFor();
await page.getByRole('button', { name: /^Cube auction/ }).click();
await set('Budget per player', 10);
await set('Packs per player', 1);
await set('Cards per pack', 8);
await set('Bid timer', 2);
await set('Time to choose a card', 2);
await page.getByRole('button', { name: /Start cube auction/i }).click();
await page.getByText(/Auction · Pack 1/).waitFor();
let sawUnsold = false;
const broke = Date.now() + 90_000;
while (Date.now() < broke && !(await page.getByText('Deckbuilding').count())) {
  const won = await myWon().catch(() => 0);
  assert(won === 0, `Max never bid but was given ${won} card(s)`);
  assert((await myBudget().catch(() => 10)) === 10, 'Max never bid, so he still has $10');
  if (/unsold/.test(await page.locator('.results').innerText().catch(() => ''))) sawUnsold = true;
  const p = page.getByRole('button', { name: 'Pass', exact: true });
  if (await p.count() && await p.isEnabled().catch(() => false)) await p.click({ timeout: 500 }).catch(() => {});
  if (sawUnsold && Date.now() > broke - 60_000) { await page.getByLabel('Pass on the rest').check().catch(() => {}); }
  await settle(page, 300);
}
await page.getByText('Deckbuilding').waitFor({ timeout: 10000 });
const brokePool = await page.locator('.db-columns .cube-card').count() + await page.locator('.db-main > .pool-summary .cube-card').count();
assert(brokePool === 0, `Max should have no cards, has ${brokePool}`);
assert(sawUnsold, 'cards nobody bid on should go unsold');
console.log('  out of money: no auto-awards, unsold cards seen');

// Sealed: host returns to lobby and runs sealed for one seat.
page.setDefaultTimeout(15000);
await page.getByRole('button', { name: /New event/ }).click();
await page.getByRole('button', { name: /^Cube sealed/ }).waitFor();
await page.getByRole('button', { name: /^Cube sealed/ }).click();
await settle(page, 300);
await page.getByRole('button', { name: /Start cube sealed/i }).click();
await page.getByText('Deckbuilding').waitFor();
const sealed = await page.locator('.db-main > .pool-summary .cube-card').count();
console.log('  sealed pool size', sealed);
await page.screenshot({ path: `${OUT}/11-sealed.png` });
assert(sealed === 90, 'expected 90 sealed cards');
await browser.close();
if (errors.length) { console.log('page errors:', errors.join('; ')); console.log('AUCTION+SEALED FAILED'); process.exit(1); }
console.log('AUCTION+SEALED OK');
