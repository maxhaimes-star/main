// Auction + sealed smoke test (one human, bots fill the table).
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3001';
const OUT = process.argv[3] ?? 'test-results';
fs.mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROME_PATH ?? (fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const browser = await chromium.launch({ executablePath: exe });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE);
await page.getByLabel('Your name').fill('Max');
await page.getByRole('button', { name: 'Create room' }).click();
await page.waitForURL(/\/r\//);
await page.getByRole('button', { name: /Auction draft/ }).click();
const set = async (label, v) => { await page.locator('.setting', { hasText: label }).locator('input').fill(String(v)); await page.waitForTimeout(250); };
await set('Cards per player', 10);
await set('Bid timer', 3);
await set('Cards per pack', 8);
await page.getByRole('button', { name: /Start auction draft/ }).click();
await page.getByText(/Auction · Pack 1/).waitFor();

let shot = false;
const until = Date.now() + 9 * 60_000;
while (Date.now() < until) {
  if (await page.getByText('Deckbuilding').count()) break;
  const choose = page.locator('.cube-card.clickable');
  if (await choose.count()) await choose.first().click().catch(() => {});
  const bid1 = page.locator('.bid-buttons button.primary:not([disabled])');
  if (await bid1.count() && Math.random() < 0.3) await bid1.click().catch(() => {});
  if (!shot && await page.locator('.lot-card').count()) { await page.waitForTimeout(500); await page.screenshot({ path: `${OUT}/10-auction.png` }); shot = true; }
  await page.waitForTimeout(300);
}
await page.getByText('Deckbuilding').waitFor({ timeout: 5000 });
const poolCount = await page.locator('.db-main > .pool-summary .cube-card').count();
console.log('auction pool size', poolCount);
if (poolCount !== 10) throw new Error('expected 10 cards');

// Sealed: host returns to lobby and runs sealed for one seat.
page.on('dialog', (d) => d.accept());
await page.getByRole('button', { name: /New event/ }).click();
await page.getByRole('button', { name: /Sealed/ }).waitFor();
await page.getByRole('button', { name: /Sealed/ }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: /Start sealed/ }).click();
await page.getByText('Deckbuilding').waitFor();
const sealed = await page.locator('.db-main > .pool-summary .cube-card').count();
console.log('sealed pool size', sealed);
await page.screenshot({ path: `${OUT}/11-sealed.png` });
if (sealed !== 90) throw new Error('expected 90 sealed cards');
if (errors.length) throw new Error('page errors: ' + errors.join('; '));
await browser.close();
console.log('AUCTION+SEALED OK');
