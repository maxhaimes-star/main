// Room codes, invite links and joining: the host sees a short code with "Copy invite link" and "Share"; a friend opens /r/CODE
// (any case), enters a name and lands in the room; another types the code on the home page and lands straight in the room.
// Usage: node e2e/share.mjs [baseUrl] [outDir]
import { assert, browser, errors, BASE, shot, step, T } from './lib.mjs';

const ctx = async (opts = {}) => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...opts });
  const p = await c.newPage();
  p.setDefaultTimeout(T);
  p.on('pageerror', (e) => errors.push(e.message));
  return p;
};

let failed = false;
try {
  step('server serves the app for /r/CODE');
  const html = await (await fetch(`${BASE}/r/QWER`)).text();
  assert(html.includes('id="root"'), '/r/CODE should serve the single-page app');

  step('host creates a room: 4-letter code, shown big');
  const A = await ctx({ permissions: ['clipboard-read', 'clipboard-write'] });
  // Record what the Share button hands to the phone's share sheet.
  await A.addInitScript(() => { navigator.share = async (d) => { window.__shared = d; }; });
  await A.goto(BASE);
  await A.getByLabel('Your name').fill('Max');
  await A.getByLabel('Room name').fill('Friday cube');
  await A.getByRole('button', { name: 'Create room' }).click();
  await A.waitForURL(/\/r\/[A-HJ-NP-Z]{4}$/);
  const code = new URL(A.url()).pathname.split('/').pop();
  assert(!/[OI01]/.test(code), `ambiguous characters in ${code}`);
  assert((await A.locator('.invite-code .code').innerText()).trim() === code, 'room code should be shown');
  const link = `${new URL(BASE).origin}/r/${code}`;

  step('Copy invite link copies /r/CODE');
  await A.getByRole('button', { name: 'Copy invite link' }).click();
  await A.getByText('Link copied!').waitFor();
  assert(await A.evaluate(() => navigator.clipboard.readText()) === link, 'clipboard should hold the invite link');

  step('Share uses the share sheet when there is one');
  await A.getByRole('button', { name: 'Share', exact: true }).click();
  await A.waitForFunction(() => !!window.__shared);
  const shared = await A.evaluate(() => window.__shared);
  assert(shared.url === link && shared.text.includes(code), `share data: ${JSON.stringify(shared)}`);
  await shot(A, 'share-lobby');

  step('a friend opens the link (lowercase): the code is canonical, the room is named, a name gets them in');
  const B = await ctx();
  await B.goto(`${BASE}/r/${code.toLowerCase()}`);
  await B.waitForURL(new RegExp(`/r/${code}$`));
  await B.getByText('Friday cube').first().waitFor();
  await B.getByText(/Hosted by Max/).waitFor();
  await B.getByLabel('Your name').fill('Sam');
  await B.getByLabel('Your name').press('Enter');
  await B.locator('.invite-code .code').waitFor();
  await A.getByText('Sam').waitFor();
  assert(await B.evaluate(() => localStorage.getItem('ojb:name')) === 'Sam', 'name should be remembered');

  step('reloading keeps the seat');
  await B.reload();
  await B.getByText('Sam (you)').waitFor();

  step('the remembered name is prefilled for the next room');
  await B.goto(`${BASE}/r/${code}`);
  await B.getByText('Sam (you)').waitFor();

  step('typing the code on the home page with a name lands straight in the room');
  const C = await ctx();
  await C.goto(BASE);
  await C.getByLabel('Your name').fill('Lee');
  await C.getByLabel('Room code or link').fill(code.toLowerCase());
  await C.getByRole('button', { name: 'Join', exact: true }).click();
  await C.waitForURL(new RegExp(`/r/${code}$`));
  await C.getByText('Lee (you)').waitFor();
  await A.getByText('Lee').waitFor();

  step('pasting the full link works too; the name form is prefilled');
  const D = await ctx();
  await D.goto(BASE);
  await D.evaluate(() => localStorage.setItem('ojb:name', 'Kim'));
  await D.goto(BASE);
  await D.getByLabel('Room code or link').fill(link);
  await D.getByRole('button', { name: 'Join', exact: true }).click();
  await D.getByText('Kim (you)').waitFor();

  step('an unknown code says so');
  let missing = 'ZZZZ';
  while ((await fetch(`${BASE}/api/rooms/${missing}`)).ok) missing = String.fromCharCode(65 + Math.floor(Math.random() * 8)).repeat(4);
  const E = await ctx();
  await E.goto(`${BASE}/r/${missing}`);
  await E.getByText(`No room with code ${missing}`).waitFor();
  assert((await (await fetch(`${BASE}/api/rooms/${missing}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"x"}' })).status) === 404, 'join should 404');
} catch (e) {
  console.log('  FAIL', e.message);
  failed = true;
} finally {
  await browser.close();
}
if (errors.length) { console.log('page errors:', errors.join('; ')); failed = true; }
if (failed) { console.log('SHARE FAILED'); process.exit(1); }
console.log('E2E OK');
