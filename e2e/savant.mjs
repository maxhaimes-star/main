// Arcane Savant end to end: sealed from an imported list (Savants + Lightning Bolts), Max builds a Savant deck with the Bolts
// in the sideboard and saves it; a Constructed (Freeform) room plays the two saved decks. Before the game Max is asked to
// reveal Savant and exile a sideboard instant (Lightning Bolt); Sam sees the reveal. Fix mode puts a Savant onto the
// battlefield; its trigger casts a copy of the exiled Bolt for free at Sam (-3 life) and the Bolt stays in exile.
// Usage: node e2e/savant.mjs [baseUrl] [outDir]
import { assert, browser, errors, BASE, life, logText, needsDecision, newPage, passUntil, resolveStack, settle, shot, step } from './lib.mjs';

const LIST = '30 Arcane Savant\n30 Lightning Bolt';
const count = async (p, z) => Number((await p.locator(`.player-area.bottom .zone.${z} .zone-count`).innerText()).trim());
const lib = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('ojb:decks') ?? '[]'));

const A = await newPage(), B = await newPage();

async function room(mode) {
  for (const p of [A, B]) await p.goto(BASE);
  await A.getByLabel('Your name').fill('Max');
  await A.getByRole('button', { name: 'Create room' }).click();
  await A.waitForURL(/\/r\//);
  await B.goto(A.url());
  await B.getByLabel('Your name').fill('Sam');
  await B.getByRole('button', { name: 'Join' }).click();
  await A.getByText('Sam').waitFor();
  await A.getByRole('button', { name: new RegExp(`^${mode}`) }).click();
}

step('room 1: sealed from an imported list (Arcane Savant + Lightning Bolt)');
await room('Cube sealed');
await A.getByLabel('Cube:').selectOption({ label: 'Import new…' });
await A.getByLabel('Save to library').uncheck();
await A.locator('.custom-list textarea').fill(LIST);
await A.getByRole('button', { name: 'Use this list' }).click();
const set = async (label, v) => { await A.locator('.setting', { hasText: label }).locator('input').fill(String(v)); await A.waitForTimeout(250); };
await set('Seats at the table', 2);
await set('Packs per player', 1);
await set('Cards per pack', 20);
await A.locator('.setting.check', { hasText: 'bots' }).locator('input').click();
await A.waitForTimeout(300);
await A.getByRole('button', { name: /Start cube sealed/i }).click();

step('Max: every Savant in the deck, the Bolts stay in the sideboard; Islands; save');
await A.getByText('Deckbuilding').waitFor();
const poolSavant = A.locator('.db-main > .pool-summary .cube-card').filter({ has: A.locator('img[alt="Arcane Savant"]') });
assert((await A.locator('.db-main > .pool-summary .cube-card').filter({ has: A.locator('img[alt="Lightning Bolt"]') }).count()) > 0, 'Max needs a Lightning Bolt in his pool');
for (let i = 0; i < 25 && (await poolSavant.count()); i++) { await poolSavant.first().click({ force: true }); await A.waitForTimeout(80); }
assert((await poolSavant.count()) === 0, 'all Savants should be in the deck');
await A.getByRole('button', { name: /Suggest lands/ }).click();
await A.getByLabel('Deck name').fill('Savant Deck');
await A.getByRole('button', { name: 'Save deck' }).click();
await A.getByText(/Saved "Savant Deck"/).waitFor();
const saved = (await lib(A))[0];
assert(saved.main.length > 0 && saved.main.every((id) => id === 'arcane_savant'), `main should be Savants: ${saved.main.join(',')}`);
assert(saved.side.length > 0 && saved.side.every((id) => id === 'lightning_bolt'), `sideboard should be Bolts: ${saved.side.join(',')}`);
assert(saved.basics.U > 0, 'Islands suggested');

step('Sam: whole pool in the deck, save');
await B.getByText('Deckbuilding').waitFor();
for (let i = 0; i < 20; i++) await B.locator('.db-main > .pool-summary .pool-stack').first().locator('.cube-card').last().click({ force: true });
await B.getByRole('button', { name: /Suggest lands/ }).click();
await B.getByLabel('Deck name').fill('Sam Deck');
await B.getByRole('button', { name: 'Save deck' }).click();
await B.getByText(/Saved "Sam Deck"/).waitFor();

step('room 2: Constructed (Freeform) with the saved decks');
await room('Constructed');
await A.locator('.setting', { hasText: 'Format' }).locator('select').selectOption('Freeform');
await A.waitForTimeout(300);
await A.getByRole('button', { name: /Start constructed/i }).click();
for (const p of [A, B]) {
  await p.getByLabel('Saved deck').waitFor();
  await p.getByLabel('Saved deck').selectOption({ index: 1 });
  await p.getByRole('button', { name: 'Use saved deck' }).click();
  await p.getByText(/Using saved deck .* \(40 cards\)/).waitFor();
}
await A.locator('.challenge', { hasText: 'Sam' }).getByRole('button', { name: 'Play' }).click();

step('before the game: Max is asked to reveal Savant and exile a sideboard instant; Sam waits');
const q = A.locator('.modal.pending', { hasText: /Arcane Savant — before the game/ });
await q.waitFor();
assert((await A.getByRole('button', { name: /^Keep/ }).count()) === 0, 'no mulligan decision before the pre-game choice');
assert(/waiting for Max/i.test(await B.locator('.mulligan').innerText()), 'Sam should wait for Max');
await shot(A, 'savant-1-pregame');
await q.locator('button', { hasText: 'Exile Lightning Bolt' }).click();
// One question per Savant in the deck (each may exile its own card): the others decline.
for (let i = 0; i < 30 && !(await A.getByRole('button', { name: /^Keep/ }).count()); i++) {
  const more = A.locator('.modal.pending button', { hasText: "Don't reveal Arcane Savant" });
  if (await more.count()) { await more.first().click(); await settle(A, 250); } else await settle(A, 300);
}
await A.getByRole('button', { name: /^Keep/ }).waitFor();
for (const p of [A, B]) await p.getByRole('button', { name: /^Keep/ }).click();
await A.locator('.center-bar').waitFor();
await B.locator('.center-bar').waitFor();
await settle(A, 600);
const rz = await B.locator('[data-testid=revealed-zone]').innerText().catch(() => '');
assert(/Revealed|Arcane Savant/.test(rz), `Sam should see a Revealed zone (got "${rz}")`);
assert(/reveals Arcane Savant from their deck and exiles Lightning Bolt/.test(await logText(B)), 'the log tells Sam about the reveal and the exile');
assert((await count(A, 'ex')) === 1, "Lightning Bolt in Max's exile");
await shot(B, 'savant-2-revealed');

step('fix mode: a Savant from the library onto the battlefield');
await A.getByRole('button', { name: 'Fix board', exact: true }).click();
await B.getByRole('button', { name: 'Allow' }).click();
await A.locator('.fix-banner').waitFor();
await A.locator('.player-area.bottom .zone.lib').click();
await A.locator('.ctx-menu .ctx-item', { hasText: 'Search library' }).click();
const modal = A.locator('.modal', { hasText: 'Search your library' });
await modal.waitFor();
await modal.locator('input[placeholder^="Filter"]').fill('Arcane Savant');
await A.waitForTimeout(150);
assert((await modal.locator('.zcard select').count()) > 0, 'a Savant left in the library');
await modal.locator('.zcard select').first().selectOption('battlefield');
await modal.getByRole('button', { name: 'Done' }).click();
await settle(A, 500);
await A.getByRole('button', { name: 'Done fixing' }).click();
await settle(A, 500);

step('Savant enters: cast a copy of the exiled Bolt without paying its mana cost, at Sam');
const lifeBefore = await life(A, 'top');
await passUntil([A, B], () => needsDecision(A), 'the Savant trigger question', 40);
const cast = A.locator('.modal.pending', { hasText: /copy of Lightning Bolt/ });
await cast.waitFor();
await shot(A, 'savant-3-copy');
await cast.getByRole('button', { name: 'Cast a copy of Lightning Bolt' }).click();
await A.locator('.mode-hint').first().waitFor();
await A.locator('.player-area.top .player-panel').click();
await settle(A, 600);
await resolveStack([A, B]);
await settle(A, 400);
assert((await life(A, 'top')) === lifeBefore - 3, `Sam's life ${lifeBefore} -> ${await life(A, 'top')}, expected -3`);
const log = await logText(A);
assert(/casts Lightning Bolt without paying its mana cost \(Arcane Savant, a copy\)/.test(log), 'the log shows the free copy');
assert((await count(A, 'ex')) === 1, 'the original Bolt stays in exile');
assert((await count(A, 'gy')) === 0, 'no Bolt in the graveyard (the copy ceased to exist)');
await shot(A, 'savant-4-done');

await browser.close();
if (errors.length) { console.log('page errors:', errors.join('; ')); console.log('SAVANT FAILED'); process.exit(1); }
console.log('E2E OK');
