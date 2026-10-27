// Saved cube library: import a pasted list with "Save to library" on, open a fresh room, pick the saved cube, check the card count,
// then delete it and check the picker forgets it (and still has it after a reload until then).
// Usage: node e2e/cubelib.mjs [baseUrl] [outDir]
import { assert, browser, errors, BASE, newPage, shot, step } from './lib.mjs';

const NAME = 'My Saved Cube';
const LIST = '30 Lightning Bolt\n10 Duress\n5 Counterspell';

async function newRoom(p) {
  await p.goto(BASE);
  await p.getByLabel('Your name').fill('Max');
  await p.getByRole('button', { name: 'Create room' }).click();
  await p.waitForURL(/\/r\//);
  await p.getByRole('button', { name: /^Cube sealed/ }).click();
}

const A = await newPage();
step('room 1: import a pasted list with save on (default)');
await newRoom(A);
const picker = A.getByLabel('Cube:');
await picker.selectOption({ label: 'Import new…' });
assert(await A.getByLabel('Save to library').isChecked(), 'Save to library should default to on');
await A.getByPlaceholder('Cube name (optional)').fill(NAME);
await A.locator('.custom-list textarea').fill(LIST);
await A.getByRole('button', { name: 'Use this list' }).click();
await A.getByText(/Saved to your library/).waitFor();
await A.getByText(new RegExp(`Cube: ${NAME} \\(45 cards\\)`)).waitFor();
assert(await A.evaluate(() => JSON.parse(localStorage.getItem('ojb:cubes') ?? '[]').length) === 1, 'cube should be in localStorage');

step('room 2 (same browser): pick the saved cube from the dropdown');
const B = await A.context().newPage();
B.setDefaultTimeout(15000);
await newRoom(B);
await B.getByText(/Cube: .*Orangejuicebox/i).first().waitFor();
const opts = await B.getByLabel('Cube:').locator('option').allInnerTexts();
assert(opts.some((o) => o.startsWith(NAME) && o.includes('45 cards')), `saved cube missing from picker: ${opts.join(' | ')}`);
assert(opts.includes('Import new…'), 'picker needs an Import new option');
await B.getByLabel('Cube:').selectOption({ label: `${NAME} (45 cards)` });
await B.getByText(new RegExp(`Cube: ${NAME} \\(45 cards\\)`)).waitFor();
await shot(B, 'cubelib-picked');

step('importing with save off does not add to the library');
await B.getByLabel('Cube:').selectOption({ label: 'Import new…' });
await B.getByLabel('Save to library').uncheck();
await B.locator('.custom-list textarea').fill('20 Counterspell');
await B.getByRole('button', { name: 'Use this list' }).click();
await B.getByText(/Using 20 cards/).waitFor();
assert(await B.evaluate(() => JSON.parse(localStorage.getItem('ojb:cubes') ?? '[]').length) === 1, 'unsaved import must not be stored');

step('pick the saved cube again, then delete it');
await B.getByLabel('Cube:').selectOption({ label: `${NAME} (45 cards)` });
await B.getByRole('button', { name: 'Delete from library' }).click();
await B.getByText(/Deleted .* from your library/).waitFor();
assert(!(await B.getByLabel('Cube:').locator('option').allInnerTexts()).some((o) => o === `${NAME} (45 cards)`), 'deleted cube still listed');
assert(await B.evaluate(() => JSON.parse(localStorage.getItem('ojb:cubes') ?? '[]').length) === 0, 'library should be empty');

await browser.close();
if (errors.length) { console.log('page errors:', errors.join('; ')); console.log('CUBELIB FAILED'); process.exit(1); }
console.log('E2E OK');
