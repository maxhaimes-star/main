// Shared helpers for the browser tests. Base URL: argv[2] or $BASE_URL (default http://localhost:3001).
// Screenshots: argv[3] or $E2E_OUT (default test-results).
import { chromium } from 'playwright';
import fs from 'node:fs';

export const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:3001';
export const OUT = process.argv[3] ?? process.env.E2E_OUT ?? 'test-results';
fs.mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROME_PATH ?? (fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
export const browser = await chromium.launch({ executablePath: exe });
export const errors = [];
export const step = (s) => console.log('  ·', s);
export const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };
export const T = 15000;
export class Retry extends Error {}

export const newPage = async () => {
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  p.setDefaultTimeout(T);
  p.on('pageerror', (e) => errors.push(e.message));
  patchClick(p);
  return p;
};

// In the Arena-style table the centre action buttons (.sub-actions) can overlap part of the fanned hand, so a real mouse click on a
// hand card is sometimes intercepted. When Playwright reports that, fall back to dispatching the click on the card itself.
let patched = false;
function patchClick(p) {
  if (patched) return;
  patched = true;
  const proto = Object.getPrototypeOf(p.locator('body'));
  const orig = proto.click;
  proto.click = async function (opts) {
    try { return await orig.call(this, { ...opts, timeout: opts?.timeout ?? 8000 }); }
    catch (e) {
      if (!/intercepts pointer events/.test(String(e.message))) throw e;
      overlapFallbacks++;
      return this.dispatchEvent('click');
    }
  };
}
export let overlapFallbacks = 0;
export const settle = (p, ms = 500) => p.waitForTimeout(ms);
export const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png` });

/** Fresh room with two humans; sealed 1x20 from `list`; both decks = whole pool + suggested lands; game started; both kept. */
export async function setup(list, tag = 'e') {
  const A = await newPage(), B = await newPage();
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
  await A.locator('.custom-list textarea').fill(list);
  await A.getByRole('button', { name: 'Use this list' }).click();
  const set = async (label, v) => { await A.locator('.setting', { hasText: label }).locator('input').fill(String(v)); await A.waitForTimeout(250); };
  await set('Seats at the table', 2);
  await set('Packs per player', 1);
  await set('Cards per pack', 20);
  await A.locator('.setting.check', { hasText: 'bots' }).locator('input').click();
  await A.waitForTimeout(300);
  await A.getByRole('button', { name: /Start cube sealed/i }).click();
  for (const p of [A, B]) {
    await p.getByText('Deckbuilding').waitFor().catch(async (e) => { await shot(p, `${tag}-debug`); throw e; });
    for (let i = 0; i < 20; i++) await p.locator('.db-main > .pool-summary .pool-stack').first().locator('.cube-card').last().click({ force: true });
    await p.getByRole('button', { name: /Suggest lands/ }).click();
    await p.getByLabel('Deck ready').check();
    await p.waitForTimeout(600);
  }
  await A.locator('.challenge', { hasText: 'Sam' }).getByRole('button', { name: 'Play' }).click();
  for (const p of [A, B]) await p.getByRole('button', { name: /^Keep/ }).click();
  await A.locator('.center-bar').waitFor();
  await B.locator('.center-bar').waitFor();
  await A.waitForTimeout(600);
  const active = (await A.locator('.player-area.bottom.active').count()) ? A : B;
  const other = active === A ? B : A;
  return { A, B, active, other, close: async () => { await A.context().close(); await B.context().close(); } };
}

export const handCard = (p, name) => p.locator('.hand .hcard').filter({ has: p.locator(`img[alt="${name}"]`) });
// Basic lands render as text cards (no image), so match them by the printed name.
export const handLands = (p, name) => p.locator('.hand .hcard').filter({ has: p.locator(`img[alt="${name}"]`).or(p.locator('.text-card.basic .tc-name', { hasText: new RegExp(`^${name}$`) })) });
export const logText = (p) => p.locator('.log-entries').innerText().catch(() => '');
export const logTail = async (p, n = 10) => (await logText(p)).split('\n').slice(-n).join('\n');
export const life = async (p, which) => Number((await p.locator(`.player-area.${which} .life-num`).innerText()).trim());
export const bfLands = (p, side = 'bottom') => p.locator(`.player-area.${side} .bf-row.lands .tcard`);
export const toastText = async (p) => (await p.locator('.toast').allInnerTexts()).join(' | ');

/** Press the main OK/Pass button if this player has it. Returns whether it pressed. */
export async function pressOk(p, ms = 400) {
  const ok = p.locator('button.ok');
  if (await ok.count()) { await ok.first().click().catch(() => {}); await settle(p, ms); return true; }
  return false;
}
/** True if a decision (pending modal / targeting banner) needs a human on this page. */
export const needsDecision = async (p) => (await p.locator('.modal.pending, .mode-hint').count()) > 0;

/** Pass priority on both pages until `cond()` holds (or a decision is pending). Throws on timeout. */
export async function passUntil(pages, cond, label = 'condition', max = 60) {
  for (let i = 0; i < max; i++) {
    if (await cond()) return;
    let pressed = false;
    for (const p of pages) {
      if (await needsDecision(p)) return;
      if (await pressOk(p, 250)) { pressed = true; break; }
    }
    if (!pressed) await settle(pages[0], 300);
  }
  if (!(await cond())) throw new Error(`timeout waiting for ${label}\n${await logTail(pages[0])}`);
}

/** Pass until the stack is empty (stops early on a pending decision). */
export const resolveStack = (pages) => passUntil(pages, async () => (await pages[0].locator('.stack-item').count()) === 0, 'empty stack', 12);

export const currentStep = (p) => p.locator('.phase.current').innerText().catch(() => '');

/** Pass priority around until `target` is the active player in a step matching stepRe (label on the phase bar, e.g. /Main 1/). */
export async function toStep(pages, target, stepRe) {
  await passUntil(pages, async () => {
    if (!(await target.locator('.player-area.bottom.active').count())) return false;
    return stepRe.test(await currentStep(target));
  }, `step ${stepRe} for active player`, 80);
}

export async function runScenarios(name, scenarios) {
  const only = process.env.ONLY;
  let failed = 0;
  for (const s of scenarios) {
    if (only && !s.name.startsWith(only)) continue;
    console.log(s.name);
    let ok = false;
    for (let attempt = 1; attempt <= 6 && !ok; attempt++) {
      try { await s.fn(); ok = true; console.log('  PASS'); }
      catch (e) {
        if (e instanceof Retry) { console.log(`  (retry ${attempt}: ${e.message})`); continue; }
        console.log('  FAIL', e.message); failed++; break;
      }
    }
    if (!ok && !failed) { console.log('  FAIL (could not get a usable opening hand)'); failed++; }
  }
  await browser.close();
  if (errors.length) { console.log('page errors:', errors.join('; ')); failed++; }
  if (failed) { console.log(`${name} FAILED`); process.exit(1); }
  console.log(`${name} OK`);
}
