// Automatic effects check: sealed from a custom list of Lightning Bolts, then Bolt the opponent
// through the targeting UI and confirm the engine deals the damage.
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3001';
const OUT = process.argv[3] ?? 'test-results';
fs.mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROME_PATH ?? (fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const browser = await chromium.launch({ executablePath: exe });
const errors = [];
const mk = async () => { const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); p.on('pageerror', (e) => errors.push(e.message)); return p; };
const A = await mk();
const B = await mk();
const step = (s) => console.log('·', s);

await A.goto(BASE);
await A.getByLabel('Your name').fill('Max');
await A.getByRole('button', { name: 'Create room' }).click();
await A.waitForURL(/\/r\//);
await B.goto(A.url());
await B.getByLabel('Your name').fill('Sam');
await B.getByRole('button', { name: 'Join' }).click();
await A.getByText('Sam').waitFor();

step('custom list: 60 Lightning Bolt, sealed 1×20');
await A.getByRole('button', { name: /Sealed/ }).click();
await A.getByRole('button', { name: /custom card list/ }).click();
await A.locator('.custom-list textarea').fill('60 Lightning Bolt');
await A.getByRole('button', { name: 'Use this list' }).click();
const set = async (label, v) => { await A.locator('.setting', { hasText: label }).locator('input').fill(String(v)); await A.waitForTimeout(250); };
await set('Seats at the table', 2);
await set('Packs per player', 1);
await set('Cards per pack', 20);
await A.locator('.setting.check', { hasText: 'bots' }).locator('input').uncheck();
await A.waitForTimeout(300);
await A.getByRole('button', { name: /Start sealed/ }).click();

for (const p of [A, B]) {
  await p.getByText('Deckbuilding').waitFor();
  for (let i = 0; i < 20; i++) await p.locator('.db-main > .pool-summary .pool-stack').first().locator('.cube-card').last().click();
  await p.getByRole('button', { name: /Suggest lands/ }).click();
  await p.getByLabel('Deck ready').check();
  await p.waitForTimeout(600);
}
await A.locator('.challenge', { hasText: 'Sam' }).getByRole('button', { name: 'Play' }).click();
for (const p of [A, B]) { await p.getByRole('button', { name: /^Keep/ }).click(); }
await A.locator('.center-bar').waitFor();
await A.waitForTimeout(500);

const active = (await A.locator('.player-area.bottom.active').count()) ? A : B;
const other = active === A ? B : A;
step('play Mountain, tap it');
await active.locator('.hand .hcard').filter({ has: active.locator('img[alt="Mountain"], .text-card.basic') }).first().click();
await active.waitForTimeout(300);
await active.locator('.player-area.bottom .bf-row.lands .tcard').first().click();
await active.waitForTimeout(300);

step('cast Lightning Bolt → targeting mode → click opponent');
await active.locator('.hand .hcard').filter({ has: active.locator('img[alt="Lightning Bolt"]') }).first().click();
await active.locator('.mode-hint').waitFor();
await active.screenshot({ path: `${OUT}/20-targeting.png` });
await active.locator('.player-area.top .player-panel').click();
await active.waitForTimeout(500);
const stack = await active.locator('.stack').innerText().catch(() => '');
console.log('stack:', stack.replace(/\n/g, ' | '));
await active.screenshot({ path: `${OUT}/21-on-stack.png` });
await other.locator('button.ok').click();
await other.waitForTimeout(600);
const life = (await other.locator('.player-area.bottom .life-num').innerText()).trim();
console.log('opponent life', life);
const log = await A.locator('.log-entries').innerText();
console.log(log.split('\n').slice(-6).join('\n'));
if (life !== '17') throw new Error('Bolt did not deal 3');
if (errors.length) throw new Error('page errors: ' + errors.join('; '));
await browser.close();
console.log('ENGINE E2E OK');
