// Rooms survive a server restart without a disk: two players import a cube and start a draft, make picks, then the server
// process is KILLED and restarted with an empty data dir (as on Render's free tier). The browsers re-upload their room snapshot,
// the room comes back under the same code with the draft where it was, and the draft goes on. Saved cubes still work after it.
// This test runs its own server (port = base port + 10, or $RESTORE_PORT); the base server is not used.
// Usage: node e2e/restore.mjs [baseUrl] [outDir]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, browser, errors, BASE, newPage, shot, step } from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.RESTORE_PORT ?? Number(new URL(BASE).port || 3001) + 10);
const URL_ = `http://localhost:${port}`;
const SECRET = 'e2e-restore-secret';
const CUBE_NAME = 'Restore Test Cube';
const LIST = '30 Lightning Bolt\n10 Duress\n5 Counterspell';

let server = null;
let dataDir = null;
async function startServer() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ojb-restore-'));
  // Node itself (not the tsx wrapper, which would leave its child running when killed) with tsx as a loader.
  server = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ROOM_SECRET: SECRET, SNAPSHOT_MS: '500' },
  });
  server.stdout.on('data', (d) => process.stdout.write(`    [server] ${d}`));
  server.stderr.on('data', (d) => process.stdout.write(`    [server] ${d}`));
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${URL_}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}
/** SIGKILL (no graceful save) and wipe the data dir: the restarted server knows nothing about the room. */
async function killServer() {
  const s = server;
  server = null;
  if (!s || s.exitCode !== null) return;
  const gone = new Promise((r) => s.once('exit', r));
  s.kill('SIGKILL');
  await gone;
  fs.rmSync(dataDir, { recursive: true, force: true });
}

const picksCount = async (p) => Number((/Your picks \((\d+)\)/.exec(await p.locator('.picks-head h3').innerText()) ?? [])[1]);
async function pickOne(p) {
  const before = await picksCount(p);
  const card = p.locator('.draft-main > .card-grid .cube-card').first();
  await card.click();
  if ((await picksCount(p)) === before) await card.click().catch(() => {});
  await p.waitForFunction((n) => {
    const m = /Your picks \((\d+)\)/.exec(document.querySelector('.picks-head h3')?.textContent ?? '');
    return m && Number(m[1]) > n;
  }, before);
}

let failed = false;
try {
  await startServer();
  const A = await newPage(), B = await newPage();

  step('host creates a room and imports a cube (saved to the library)');
  await A.goto(URL_);
  await A.getByLabel('Your name').fill('Max');
  await A.getByRole('button', { name: 'Create room' }).click();
  await A.waitForURL(/\/r\/[A-HJ-NP-Z]{4}$/);
  const code = new URL(A.url()).pathname.split('/').pop();
  await A.getByLabel('Cube:').selectOption({ label: 'Import new…' });
  await A.getByPlaceholder('Cube name (optional)').fill(CUBE_NAME);
  await A.locator('.custom-list textarea').fill(LIST);
  await A.getByRole('button', { name: 'Use this list' }).click();
  await A.getByText(new RegExp(`Cube: ${CUBE_NAME} \\(45 cards\\)`)).waitFor();

  step('friend joins; 2 seats, 1 pack of 15, no bots, no timer');
  await B.goto(`${URL_}/r/${code}`);
  await B.getByLabel('Your name').fill('Sam');
  await B.getByRole('button', { name: 'Join' }).click();
  await A.getByText('Sam').waitFor();
  const set = async (label, v) => { await A.locator('.setting', { hasText: label }).locator('input').first().fill(String(v)); await A.waitForTimeout(250); };
  await set('Seats at the table', 2);
  await set('Packs per player', 1);
  await set('Cards per pack', 15);
  await set('Pick timer', 0);
  const bots = A.locator('.setting.check', { hasText: 'bots' }).locator('input');
  if (await bots.isChecked()) await bots.click();
  await A.waitForTimeout(300);

  step('start the draft and make picks');
  await A.getByRole('button', { name: /Start cube draft/i }).click();
  for (const p of [A, B]) await p.getByText(/Pack 1\/1/).waitFor();
  await pickOne(A); await pickOne(B); await pickOne(A);
  const before = { A: await picksCount(A), B: await picksCount(B), headA: await A.locator('.draft-head h2').innerText() };
  const picksA = await A.locator('.picks .cube-card img').evaluateAll((els) => els.map((e) => e.getAttribute('alt')).sort());
  step(`picks before restart: Max ${before.A}, Sam ${before.B} (${before.headA})`);
  await A.waitForTimeout(1500); // snapshots are sent every 500ms in this test (SNAPSHOT_MS)
  for (const p of [A, B]) {
    const snap = await p.evaluate((c) => localStorage.getItem(`ojb:snap:${c}`), code);
    assert(snap && JSON.parse(snap).blob.startsWith('s1.'), 'browser should hold an opaque room snapshot');
    assert(!snap.includes('Lightning Bolt') && !snap.includes('lightning'), 'snapshot must not expose card ids');
  }

  step('KILL the server and restart it with an empty data dir');
  await killServer();
  await A.getByText(/Reconnecting|restoring/i).first().waitFor();
  await startServer();

  step('both browsers reconnect; the room and draft come back under the same code');
  for (const p of [A, B]) {
    await p.locator('.banner.warn').waitFor({ state: 'detached', timeout: 30000 });
    await p.getByText(/Pack 1\/1/).waitFor();
  }
  assert(new URL(A.url()).pathname === `/r/${code}`, 'room code changed');
  assert(await picksCount(A) === before.A && await picksCount(B) === before.B, `pick counts changed: ${await picksCount(A)}/${await picksCount(B)}`);
  assert(await A.locator('.draft-head h2').innerText() === before.headA, 'draft position changed');
  const picksA2 = await A.locator('.picks .cube-card img').evaluateAll((els) => els.map((e) => e.getAttribute('alt')).sort());
  assert(JSON.stringify(picksA2) === JSON.stringify(picksA), `picks changed: ${picksA2} vs ${picksA}`);
  const info = await (await fetch(`${URL_}/api/rooms/${code}`)).json();
  assert(info.phase === 'drafting' && info.players.join(',') === 'Max,Sam', `room info after restore: ${JSON.stringify(info)}`);
  await shot(A, 'restore-after');

  step('the draft goes on after the restore');
  await pickOne(B);
  await pickOne(A);
  assert(await picksCount(A) === before.A + 1, 'host could not pick after restore');

  step('saved cubes still work after the restart: new room, pick it from the library');
  const C = await A.context().newPage();
  await C.goto(URL_);
  await C.getByLabel('Your name').fill('Max');
  await C.getByRole('button', { name: 'Create room' }).click();
  await C.waitForURL(/\/r\//);
  await C.getByLabel('Cube:').selectOption({ label: `${CUBE_NAME} (45 cards)` });
  await C.getByText(new RegExp(`Cube: ${CUBE_NAME} \\(45 cards\\)`)).waitFor();
} catch (e) {
  console.log('  FAIL', e.message);
  failed = true;
} finally {
  await killServer().catch(() => {});
  await browser.close();
}
if (errors.length) { console.log('page errors:', errors.join('; ')); failed = true; }
if (failed) { console.log('RESTORE FAILED'); process.exit(1); }
console.log('E2E OK');
