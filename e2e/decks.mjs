// Saved deck library: build sealed decks with two humans, save one by hand (the other is auto-saved when the game starts), open a new
// Constructed (Freeform) room, pick the saved deck for BOTH players, start the game and check library/hand counts. Then manage the
// decks from "My decks" (view, rename, export, delete).
// Usage: node e2e/decks.mjs [baseUrl] [outDir]
import { assert, browser, errors, BASE, newPage, shot, step } from './lib.mjs';

const LIST = '30 Lightning Bolt\n10 Duress\n10 Counterspell\n10 Shock';
const lib = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('ojb:decks') ?? '[]'));

const A = await newPage(), B = await newPage();

step('room 1: sealed from an imported list, two humans');
await A.goto(BASE);
await A.getByLabel('Your name').fill('Max');
await A.getByRole('button', { name: 'Create room' }).click();
await A.waitForURL(/\/r\//);
await B.goto(A.url());
await B.getByLabel('Your name').fill('Sam');
await B.getByRole('button', { name: 'Join' }).click();
await A.getByText('Sam').waitFor();
await A.getByRole('button', { name: /^Cube sealed/ }).click();
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

step('both build 40-card decks (20 spells + 20 lands); Max saves his by hand');
for (const p of [A, B]) {
  await p.getByText('Deckbuilding').waitFor();
  for (let i = 0; i < 20; i++) await p.locator('.db-main > .pool-summary .pool-stack').first().locator('.cube-card').last().click({ force: true });
  await p.getByRole('button', { name: /Suggest lands/ }).click();
  assert((await lib(p)).length === 0, 'library should start empty');
}
await A.getByLabel('Deck name').fill('Burn Deck');
await A.getByRole('button', { name: 'Save deck' }).click();
await A.getByText(/Saved "Burn Deck"/).waitFor();
let maxLib = await lib(A);
assert(maxLib.length === 1, 'Max should have one saved deck');
assert(maxLib[0].main.length === 20 && maxLib[0].side.length === 0 && Object.values(maxLib[0].basics).reduce((a, b) => a + b, 0) === 20, `bad saved deck ${JSON.stringify(maxLib[0]).slice(0, 200)}`);
assert(maxLib[0].cube === 'Imported list' || maxLib[0].cube.length > 0, 'deck should record its cube');
await A.getByRole('button', { name: 'Save deck' }).click(); // saving the same content again must not duplicate
assert((await lib(A)).length === 1, 'duplicate save must not add a deck');

step('starting a game auto-saves the deck (Sam never clicked Save)');
for (const p of [A, B]) { await p.getByLabel('Deck ready').check(); await p.waitForTimeout(600); }
await A.locator('.challenge', { hasText: 'Sam' }).getByRole('button', { name: 'Play' }).click();
for (const p of [A, B]) await p.getByRole('button', { name: /^Keep/ }).click();
await A.locator('.center-bar').waitFor();
await A.waitForTimeout(500);
maxLib = await lib(A);
const samLib = await lib(B);
assert(maxLib.length === 1 && maxLib[0].name === 'Burn Deck', `auto-save must dedupe against Max's manual save and keep its name: ${JSON.stringify(maxLib.map((d) => d.name))}`);
assert(samLib.length === 1 && samLib[0].auto === true && samLib[0].main.length === 20, 'Sam should have an auto-saved deck');
const samDeckName = samLib[0].name;

step('room 2: Constructed (Freeform), each player picks a saved deck');
for (const p of [A, B]) await p.goto(BASE);
await A.getByLabel('Your name').fill('Max');
await A.getByRole('button', { name: 'Create room' }).click();
await A.waitForURL(/\/r\//);
await B.goto(A.url());
await B.getByLabel('Your name').fill('Sam');
await B.getByRole('button', { name: 'Join' }).click();
await A.getByText('Sam').waitFor();
await A.getByRole('button', { name: /^Constructed/ }).click();
await A.locator('.setting', { hasText: 'Format' }).locator('select').selectOption('Freeform');
await A.waitForTimeout(300);
await A.getByRole('button', { name: /Start constructed/i }).click();
for (const p of [A, B]) {
  await p.getByLabel('Saved deck').waitFor();
  const opts = await p.getByLabel('Saved deck').locator('option').allInnerTexts();
  assert(opts.length === 2 && /40 cards/.test(opts[1]), `saved deck missing from picker: ${opts.join(' | ')}`);
  await p.getByLabel('Saved deck').selectOption({ index: 1 });
  await p.getByRole('button', { name: 'Use saved deck' }).click();
  await p.getByText(/Using saved deck .* \(40 cards\)/).waitFor();
}
await shot(A, 'decks-constructed');
assert((await A.getByLabel('Saved deck').locator('option').allInnerTexts())[1].startsWith('Burn Deck'), "Max's picker should list Burn Deck");
assert((await B.getByLabel('Saved deck').locator('option').allInnerTexts())[1].startsWith(samDeckName), "Sam's picker should list his auto-saved deck");

step('start the game: 7 in hand, 33 in library for both');
await A.locator('.challenge', { hasText: 'Sam' }).getByRole('button', { name: 'Play' }).click();
for (const p of [A, B]) await p.getByRole('button', { name: /^Keep/ }).click();
await A.locator('.center-bar').waitFor();
await B.locator('.center-bar').waitFor();
await A.waitForTimeout(600);
for (const p of [A, B]) {
  const hand = await p.locator('.hand .hcard').count();
  const libText = await p.locator('.player-area.bottom [title="Cards in library"]').innerText();
  assert(hand === 7, `hand should be 7, got ${hand}`);
  assert(/33/.test(libText), `library should be 33, got "${libText}"`);
}
await shot(A, 'decks-game');

step('My decks: view, rename, export, delete');
const M = await A.context().newPage();
M.setDefaultTimeout(15000);
await M.goto(BASE);
await M.locator('summary', { hasText: 'My decks (1)' }).click();
await M.getByRole('button', { name: 'View list' }).click();
await M.getByText(/Main deck \(40\)/).waitFor();
assert((await M.locator('.saved-deck-list li').allInnerTexts()).some((t) => /^(10|\d+) (Lightning Bolt|Duress|Counterspell|Shock)$/.test(t.trim())), 'list should show card names');
await M.getByRole('button', { name: 'Rename' }).click();
await M.getByLabel('Deck name').fill('Red Burn v2');
await M.getByRole('button', { name: 'Save name' }).click();
await M.getByText('Red Burn v2').waitFor();
assert((await lib(M))[0].name === 'Red Burn v2', 'rename should persist');
const [dl] = await Promise.all([M.waitForEvent('download'), M.getByRole('button', { name: 'Export text' }).click()]);
const fs = await import('node:fs');
const txt = fs.readFileSync(await dl.path(), 'utf8');
assert(/^Deck\n/.test(txt) && /Lightning Bolt|Duress|Counterspell|Shock/.test(txt) && /\d+ (Mountain|Island|Swamp|Plains|Forest)/.test(txt), `bad text export: ${txt.slice(0, 100)}`);
M.once('dialog', (d) => d.accept());
await M.getByRole('button', { name: 'Delete' }).click();
await M.getByText(/No saved decks yet/).waitFor();
assert((await lib(M)).length === 0, 'library should be empty after delete');

await browser.close();
if (errors.length) { console.log('page errors:', errors.join('; ')); console.log('DECKS FAILED'); process.exit(1); }
console.log('E2E OK');
