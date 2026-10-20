// End-to-end smoke test: two browsers draft (with 2 bots), build decks, export, start a (strict) game, play a land, pass turns.
// Detailed gameplay rules are covered by strict.mjs / engine2.mjs.
// Usage: node e2e/smoke.mjs [baseUrl] [outDir]
import fs from 'node:fs';
import { assert, browser, errors, BASE, OUT, newPage, passUntil, settle, shot, step, handLands, toastText } from './lib.mjs';

const A = await newPage();
const B = await newPage();
A.setDefaultTimeout(30000); B.setDefaultTimeout(30000);

step('host creates room');
await A.goto(BASE);
await A.getByLabel('Your name').fill('Max');
await A.getByRole('button', { name: 'Create room' }).click();
await A.waitForURL(/\/r\//);
const url = A.url();

step('friend joins');
await B.goto(url);
await B.getByLabel('Your name').fill('Sam');
await B.getByRole('button', { name: 'Join' }).click();
await A.getByText('Sam').waitFor();
await A.locator('.setting', { hasText: 'Pick timer' }).locator('input').fill('0');
await A.waitForTimeout(400);
await shot(A, '01-lobby');

step('start draft (4 seats: 2 humans + 2 bots)');
await A.getByRole('button', { name: /Start cube draft/i }).click();
await A.getByText(/Pack 1\/3/).waitFor();
await shot(A, '02-draft');

async function draftAll(p) {
  for (let i = 0; i < 200; i++) {
    if (await p.getByText('Deckbuilding').count()) return;
    const cards = p.locator('.draft-main > .card-grid .cube-card');
    if (await cards.count()) {
      try { await cards.first().click({ timeout: 2000 }); await cards.first().click({ timeout: 2000 }); } catch { /* pack moved on */ }
    }
    await p.waitForTimeout(80);
  }
}
await Promise.all([draftAll(A), draftAll(B)]);
await A.getByText('Deckbuilding').waitFor({ timeout: 30000 });
step('drafted 45 cards each');

async function build(p, name) {
  // Draft picks arrive in the main deck (all 45); cut it down to 23 by moving cards to the sideboard.
  for (let i = 0; i < 22; i++) {
    await p.locator('.db-columns .cube-card').first().click({ force: true });
  }
  await p.getByRole('button', { name: /Suggest lands/ }).click();
  await p.getByLabel('Deck ready').check();
  await p.waitForTimeout(800);
  await shot(p, `03-deck-${name}`);
}
await build(A, 'max');
await build(B, 'sam');

step('export XMage deck');
const [dl] = await Promise.all([A.waitForEvent('download'), A.getByRole('button', { name: 'XMage (.dck)' }).click()]);
const dck = fs.readFileSync(await dl.path(), 'utf8');
assert(/^NAME:/.test(dck) && dck.split('\n').length >= 10, 'bad .dck export');
fs.writeFileSync(`${OUT}/max.dck`, dck);

step('start match');
await A.locator('.challenge', { hasText: 'Sam' }).getByRole('button', { name: 'Play' }).click();
await A.getByRole('button', { name: /^Keep/ }).waitFor();
await shot(A, '04-mulligan');
await A.getByRole('button', { name: /^Keep/ }).click();
await B.getByRole('button', { name: /^Keep/ }).click();
await A.locator('.center-bar').waitFor();
await B.locator('.center-bar').waitFor();
await A.waitForTimeout(500);

const active = (await A.locator('.player-area.bottom.active').count()) ? A : B;
const other = active === A ? B : A;
step(`active player is ${active === A ? 'Max' : 'Sam'}`);

step('strict mode: manual tools are hidden, hand hint says mana is paid automatically');
assert((await active.getByRole('button', { name: 'Tokens' }).count()) === 0, 'Tokens button must be hidden in strict mode');
assert(/paid automatically/.test(await active.locator('.hand-hint').innerText()), 'hand hint should describe strict play');
assert(await active.getByRole('button', { name: 'Fix board', exact: true }).count() === 1, 'Fix board button available');

step('play a land (one per turn)');
const handBefore = await active.locator('.hand .hcard').count();
let played = false;
for (const basic of ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']) {
  const land = handLands(active, basic);
  if (await land.count()) { await land.first().click(); played = true; break; }
}
await active.waitForTimeout(500);
if (played) {
  assert((await active.locator('.hand .hcard').count()) === handBefore - 1, 'land was not played');
  assert((await active.locator('.player-area.bottom .bf-row.lands .tcard').count()) === 1, 'land should be on the battlefield');
  assert(/1\/1/.test(await active.locator('.land-plays').innerText()), 'land counter should read 1/1');
} else step('(note) no basic land in the opening hand, skipping land play');
await shot(active, '05-game-active');
await shot(other, '06-game-other');

step('opponent hand is hidden');
assert((await other.locator('.player-area.top .hcard img').count()) === 0, 'opponent hand visible');

step('pass priority to the next turn');
const pages = [active, other];
await passUntil(pages, async () => (await other.locator('.player-area.bottom.active').count()) > 0, 'other player turn', 60);
await settle(active, 500);
await shot(other, '08-next-turn');
const log = await A.locator('.log-entries').innerText();
fs.writeFileSync(`${OUT}/game-log.txt`, log);
console.log(log.split('\n').slice(-8).join('\n'));
assert(/Land plays|Lands: 0\/1/.test(await other.locator('.land-plays').innerText()), 'new active player has a fresh land drop');

await browser.close();
if (errors.length) { console.log('page errors:', errors.join('; ')); console.log('SMOKE FAILED'); process.exit(1); }
console.log('E2E OK');
