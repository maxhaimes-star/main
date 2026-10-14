// End-to-end smoke test: two browsers draft (with 2 bots), build decks and start a game.
// Usage: start the server (npm run build && npm start), then: node e2e/smoke.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3001';
const OUT = process.argv[3] ?? 'test-results';
fs.mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROME_PATH ?? (fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const browser = await chromium.launch({ executablePath: exe });
const mk = async () => { const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => console.error('PAGE ERROR', e.message)); return p; };
const A = await mk();
const B = await mk();
const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png` });
const step = (s) => console.log('·', s);

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
await A.getByRole('button', { name: /Start booster draft/ }).click();
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
  for (let i = 0; i < 23; i++) {
    await p.locator('.db-main > .pool-summary .pool-stack').first().locator('.cube-card').last().click();
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
if (!/^NAME:/.test(dck) || dck.split('\n').length < 10) throw new Error('bad .dck export');
fs.writeFileSync(`${OUT}/max.dck`, dck);

step('start match');
await A.locator('.challenge', { hasText: 'Sam' }).getByRole('button', { name: 'Play' }).click();
await A.getByRole('button', { name: /^Keep/ }).waitFor();
await shot(A, '04-mulligan');
await A.getByRole('button', { name: /^Keep/ }).click();
await B.getByRole('button', { name: /^Keep/ }).click();
await A.locator('.center-bar').waitFor();
await A.waitForTimeout(500);

// Whoever is active plays a land and passes.
const active = (await A.locator('.player-area.bottom.active').count()) ? A : B;
const other = active === A ? B : A;
step(`active player is ${active === A ? 'Max' : 'Sam'}`);
const land = active.locator('.hand .hcard').filter({ has: active.locator('img[alt="Plains"], img[alt="Island"], img[alt="Swamp"], img[alt="Mountain"], img[alt="Forest"], .text-card.basic') });
const handBefore = await active.locator('.hand .hcard').count();
if (await land.count()) {
  await land.first().click();
  await active.waitForTimeout(400);
  if ((await active.locator('.hand .hcard').count()) !== handBefore - 1) throw new Error('land was not played');
  // tap it for mana
  await active.locator('.player-area.bottom .bf-row.lands .tcard').first().click();
  await active.waitForTimeout(300);
  if (!(await active.locator('.player-area.bottom .mana-pool .pip').count())) throw new Error('tapping the land did not add mana');
  if (!(await active.locator('.player-area.bottom .bf-row.lands .tcard.tapped').count())) throw new Error('land did not tap');
}
await shot(active, '05-game-active');
await shot(other, '06-game-other');

step('scry 2 via library menu');
await active.locator('.player-area.bottom .zone.lib').click();
await active.getByText('Scry X…').click();
await active.locator('.prompt input').fill('2');
await active.locator('.prompt').getByRole('button', { name: 'OK', exact: true }).click();
await active.getByText(/Scry \(2\)/).waitFor();
await shot(active, '07-scry');
await active.getByRole('button', { name: 'Done' }).click();

step('make a token');
await active.locator('.player-area.bottom').getByRole('button', { name: 'Tokens' }).click();
await active.locator('.modal .zone-grid .zcard').first().click();
await active.waitForTimeout(400);

step('opponent hand is hidden');
const oppHandImgs = await other.locator('.player-area.top .hcard img').count();
if (oppHandImgs) throw new Error('opponent hand visible');

step('pass priority to next turn');
for (let i = 0; i < 6; i++) {
  for (const p of [active, other]) {
    const ok = p.locator('button.ok');
    if (await ok.count()) { await ok.click(); await p.waitForTimeout(250); }
  }
  if (await other.locator('.player-area.bottom.active').count()) break;
}
await active.waitForTimeout(500);
await shot(other, '08-next-turn');
const log = await A.locator('.log-entries').innerText();
fs.writeFileSync(`${OUT}/game-log.txt`, log);
console.log(log.split('\n').slice(-12).join('\n'));
if (!(await other.locator('.player-area.bottom.active').count())) throw new Error('turn did not pass to the other player');
step('combat: new active player makes a 3/3 and attacks');
const atk = other, def = active;
await atk.locator('.player-area.bottom').getByRole('button', { name: 'Tokens' }).click();
await atk.locator('.modal .zcard').filter({ has: atk.locator('img[alt="Beast"], .text-card:has-text("Beast")') }).first().click();
await atk.waitForTimeout(300);
// pass to declare attackers
for (let i = 0; i < 4 && !(await atk.locator('.phase.current', { hasText: 'Attackers' }).count()); i++) {
  await atk.locator('button.ok').click(); await atk.waitForTimeout(300);
}
await atk.locator('.player-area.bottom .bf-row.creatures .tcard').first().click();
await atk.waitForTimeout(300);
await shot(atk, '09-attack');
await atk.locator('button.ok', { hasText: 'Attack with 1' }).click();
await def.locator('button.ok', { hasText: 'Confirm blocks' }).click();
await def.locator('.combat-panel').waitFor();
await shot(def, '09b-damage');
for (const p of [atk, def]) { const ok = p.locator('button.ok'); if (await ok.count()) { await ok.click(); await p.waitForTimeout(300); } }
for (const p of [atk, def]) { const ok = p.locator('button.ok', { hasText: 'Confirm damage' }); if (await ok.count()) { await ok.click(); await p.waitForTimeout(300); } }
await def.waitForTimeout(500);
const lifeText = await def.locator('.player-area.bottom .life-num').innerText();
console.log('defender life', lifeText);
if (lifeText.trim() !== '17') throw new Error('combat damage not applied');
await browser.close();
console.log('E2E OK');
