// "Power up" lobby option: checking it adds the power cards the cube lacks (default cube: +11, Timetwister is already in it;
// an imported list: +12 minus the ones it has). Also checks that an imported "Burning Inquiry" resolves (card overrides:
// it's "Burning Sensation" now) and is listed under its new name.
// Usage: node e2e/powerup.mjs [baseUrl] [outDir]
import { assert, browser, errors, BASE, newPage, shot, step } from './lib.mjs';

const A = await newPage();
await A.goto(BASE);
await A.getByLabel('Your name').fill('Max');
await A.getByRole('button', { name: 'Create room' }).click();
await A.waitForURL(/\/r\//);
await A.getByRole('button', { name: /^Cube draft/ }).click();

const sizeLine = A.locator('p.muted', { hasText: /^Cube: / });
async function cubeSize(expect) {
  if (expect != null) await A.locator('p.muted', { hasText: new RegExp(`^Cube: .*\\(${expect} cards\\)`) }).waitFor();
  const m = /\((\d+) cards\)/.exec(await sizeLine.innerText());
  assert(m, 'no cube size line');
  return Number(m[1]);
}
const power = A.locator('.setting.check', { hasText: 'Power up' }).locator('input');

step('default cube: Power up adds 11 cards (Timetwister is already in it)');
const base = await cubeSize();
assert(base > 400, `default cube size looks wrong: ${base}`);
assert(!(await power.isChecked()), 'Power up should start unchecked');
await power.check();
await cubeSize(base + 11);
await shot(A, 'powerup-default');
await power.uncheck();
await cubeSize(base);

step('imported list (with Sol Ring and the old name of Burning Sensation): +11');
await A.getByLabel('Cube:').selectOption({ label: 'Import new…' });
await A.getByLabel('Save to library').uncheck();
await A.locator('.custom-list textarea').fill('30 Lightning Bolt\n1 Burning Inquiry\n1 Sol Ring');
await A.getByRole('button', { name: 'Use this list' }).click();
await A.getByText(/Using 32 cards/).waitFor();
await cubeSize(32);
await power.check();
await cubeSize(43);

step('the renamed card shows under its new name in the cube browser');
await A.getByRole('button', { name: /Browse the cube/ }).click();
await A.locator('.cube-browser .filters input').fill('Burning Sensation');
await A.locator('.cube-browser .filters', { hasText: /^.*\b1 cards\b/ }).waitFor();
await shot(A, 'powerup-imported');

await browser.close();
if (errors.length) { console.log('page errors:', errors.join('; ')); console.log('POWERUP FAILED'); process.exit(1); }
console.log('E2E OK');
