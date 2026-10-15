// Engine UI scenarios #2: each runs in a fresh room with a custom sealed list so both players hold known cards.
//   1. trigger target  (Orcish Bowmasters ETB ping: targeting banner appears automatically)
//   2. Mana Leak       (controller gets the "pay {3}?" pending, declines, spell is countered)
//   3. alt cost        (Force of Will: OptionsModal -> exile a blue card via card-image pending, life -1)
//   4. shockland       (Steam Vents "pay 2 life?" -> untapped, life 18)
//   5. Thraben Inspector ETB -> Clue token automatically
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:3007';
const OUT = process.argv[3] ?? '/tmp/claude-0/shots-e2e';
fs.mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROME_PATH ?? (fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
const browser = await chromium.launch({ executablePath: exe });
const errors = [];
const step = (s) => console.log('  ·', s);
const assert = (c, m) => { if (!c) throw new Error('ASSERT: ' + m); };
const T = 15000;

class Retry extends Error {}

/** Fresh room, sealed 1x20 from `list`, both decks = whole pool + suggested lands, game started, both kept. */
async function setup(list) {
  const mk = async () => { const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); p.setDefaultTimeout(T); p.on('pageerror', (e) => errors.push(e.message)); return p; };
  const A = await mk(), B = await mk();
  await A.goto(BASE);
  await A.getByLabel('Your name').fill('Max');
  await A.getByRole('button', { name: 'Create room' }).click();
  await A.waitForURL(/\/r\//);
  await B.goto(A.url());
  await B.getByLabel('Your name').fill('Sam');
  await B.getByRole('button', { name: 'Join' }).click();
  await A.getByText('Sam').waitFor();
  await A.getByRole('button', { name: /Sealed/ }).click();
  await A.getByRole('button', { name: /custom card list/ }).click();
  await A.locator('.custom-list textarea').fill(list);
  await A.getByRole('button', { name: 'Use this list' }).click();
  const set = async (label, v) => { await A.locator('.setting', { hasText: label }).locator('input').fill(String(v)); await A.waitForTimeout(250); };
  await set('Seats at the table', 2);
  await set('Packs per player', 1);
  await set('Cards per pack', 20);
  await A.locator('.setting.check', { hasText: 'bots' }).locator('input').click();
  await A.waitForTimeout(300);
  await A.getByRole('button', { name: /Start sealed/ }).click();
  for (const p of [A, B]) {
    await p.getByText("Deckbuilding").waitFor().catch(async (e) => { await p.screenshot({ path: `${OUT}/e2-debug.png` }); throw e; });
    for (let i = 0; i < 20; i++) await p.locator('.db-main > .pool-summary .pool-stack').first().locator('.cube-card').last().click();
    await p.getByRole('button', { name: /Suggest lands/ }).click();
    await p.getByLabel('Deck ready').check();
    await p.waitForTimeout(600);
  }
  await A.locator('.challenge', { hasText: 'Sam' }).getByRole('button', { name: 'Play' }).click();
  for (const p of [A, B]) await p.getByRole('button', { name: /^Keep/ }).click();
  await A.locator('.center-bar').waitFor();
  await A.waitForTimeout(600);
  const active = (await A.locator('.player-area.bottom.active').count()) ? A : B;
  const other = active === A ? B : A;
  return { A, B, active, other, close: async () => { await A.context().close(); await B.context().close(); } };
}

const handCard = (p, name) => p.locator('.hand .hcard').filter({ has: p.locator(`img[alt="${name}"]`) });
const handLands = (p, name) => p.locator('.hand .hcard').filter({ has: p.locator(`img[alt="${name}"], .text-card.basic`) });
const logText = (p) => p.locator('.log-entries').innerText().catch(() => '');
const life = async (p, which) => Number((await p.locator(`.player-area.${which} .life-num`).innerText()).trim());
const shot = (p, n) => p.screenshot({ path: `${OUT}/e2-${n}.png` });
const settle = (p, ms = 700) => p.waitForTimeout(ms);

/** Right-click a hand card, Move > Onto the battlefield (sandbox-style setup; works at any time). */
async function toBattlefield(p, locator) {
  await locator.first().click({ button: 'right' });
  await p.locator('.ctx-item.has-sub', { hasText: /^Move/ }).hover();
  await p.locator('.ctx-sub .ctx-item', { hasText: /^Onto the battlefield$/ }).click();
  await settle(p, 400);
}
async function landsToBF(p, name, n) {
  const hand = handLands(p, name);
  if ((await hand.count()) < n) throw new Retry(`only ${await hand.count()} ${name} in hand`);
  for (let i = 0; i < n; i++) await toBattlefield(p, hand);
}
const tapLands = async (p, n) => { for (let i = 0; i < n; i++) { await p.locator('.player-area.bottom .bf-row.lands .tcard:not(.tapped)').first().click(); await settle(p, 250); } };
const pass = async (p) => { await p.locator('button.ok').click(); await settle(p, 600); };
/** Pass priority (whoever holds it) until the stack is empty or a decision / targeting prompt needs the user. */
async function resolveStack(...pages) {
  for (let i = 0; i < 8; i++) {
    await settle(pages[0], 500);
    if (!(await pages[0].locator('.stack-item').count())) return;
    for (const p of pages) if (await p.locator('.modal.pending, .mode-hint').count()) return;
    for (const p of pages) if (await p.locator('.player-area.bottom .player-panel.has-priority').count() && await p.locator('button.ok').count()) { await pass(p); break; }
  }
}

/** Pick a single target in the targeting banner, confirming with Done if it did not auto-advance. */
async function pickTarget(p, loc) {
  await loc.click();
  await settle(p, 500);
  const done = p.locator('.mode-hint button', { hasText: 'Done' });
  if (await done.count() && await done.isEnabled().catch(() => false)) { await done.click(); await settle(p, 500); }
}

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

// ---------------------------------------------------------------------------------------------------------------
scenario('1. trigger target: Orcish Bowmasters ETB ping', async () => {
  const { active, other, close } = await setup('40 Orcish Bowmasters');
  try {
    await landsToBF(active, 'Swamp', 2);
    await tapLands(active, 2);
    step('cast Bowmasters');
    await handCard(active, 'Orcish Bowmasters').first().click();
    await settle(active);
    await pass(other); // opponent lets it resolve (or active resolves, whichever holds priority)
    const hint = active.locator('.mode-hint', { hasText: /choose target/i });
    if (!(await hint.count())) { await settle(active, 1000); }
    await hint.waitFor();
    step('targeting banner appeared for the ETB trigger');
    await shot(active, '1-trigger-target');
    const before = await life(active, 'top');
    await pickTarget(active, active.locator('.player-area.top .player-panel'));
    await resolveStack(active, other);
    const log = await logText(active);
    const after = await life(active, 'top');
    await shot(active, '1-trigger-resolved');
    assert(after === before - 1, `opponent life ${before} -> ${after}, expected -1\n${log.split('\n').slice(-8).join('\n')}`);
  } finally { await close(); }
});

// ---------------------------------------------------------------------------------------------------------------
scenario('2. Mana Leak: payer declines, spell countered', async () => {
  const { active, other, close } = await setup('20 Mana Leak\n20 Opt');
  try {
    await landsToBF(active, 'Island', 1);
    await landsToBF(other, 'Island', 2);
    await tapLands(active, 1);
    if (!(await handCard(active, 'Opt').count()) || !(await handCard(other, 'Mana Leak').count())) throw new Retry('missing Opt / Mana Leak');
    step('active casts Opt');
    await handCard(active, 'Opt').first().click();
    await settle(active);
    // Opt has no target; the opponent should now hold priority.
    await tapLands(other, 2);
    step('opponent casts Mana Leak targeting Opt');
    await handCard(other, 'Mana Leak').first().click();
    await other.locator('.mode-hint').waitFor();
    await pickTarget(other, other.locator('.stack-item:not(.top)').first().or(other.locator('.stack-item').first()));
    await settle(other, 800);
    await shot(other, '2-leak-cast');
    // Resolve Mana Leak: both may need to pass.
    for (let i = 0; i < 4; i++) {
      if (await active.locator('.modal.pending').count()) break;
      const who = (await other.locator('button.ok').count()) ? other : active;
      if (await who.locator('button.ok').count()) await pass(who);
    }
    const pend = active.locator('.modal.pending');
    await pend.waitFor();
    const txt = await pend.innerText();
    step('pending: ' + txt.replace(/\n/g, ' | '));
    assert(/3/.test(txt), 'pending should mention {3}');
    await shot(active, '2-leak-pending');
    await pend.getByRole('button', { name: /^(No|Don't|Decline)/i }).first().click();
    await settle(active, 800);
    const log = await logText(active);
    assert(/counter/i.test(log), 'log should mention the counter:\n' + log.split('\n').slice(-8).join('\n'));
    assert(await active.locator('.stack-item').count() === 0, 'stack should be empty');
    await shot(active, '2-leak-countered');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------------------------------------------
scenario('3. alt cost: Force of Will exiling a blue card', async () => {
  const { active, other, close } = await setup('20 Force of Will\n20 Brainstorm');
  try {
    await landsToBF(active, 'Island', 1);
    await tapLands(active, 1);
    if (!(await handCard(active, 'Brainstorm').count()) || (await handCard(other, 'Force of Will').count()) < 1 || (await other.locator('.hand .hcard').count()) < 7) throw new Retry('missing cards');
    const nBlue = await other.locator('.hand .hcard').filter({ has: other.locator('img[alt="Brainstorm"], img[alt="Force of Will"]') }).count();
    if (nBlue < 2) throw new Retry('need a second blue card');
    step('active casts Brainstorm');
    await handCard(active, 'Brainstorm').first().click();
    await settle(active);
    const handBefore = await other.locator('.hand .hcard').count();
    const lifeBefore = await life(other, 'bottom');
    step('opponent casts Force of Will');
    await handCard(other, 'Force of Will').first().click();
    const opts = other.locator('.opt-list');
    await opts.waitFor();
    const optTxt = await opts.innerText();
    step('options: ' + optTxt.replace(/\n/g, ' | '));
    assert(/exile|life/i.test(optTxt), 'alternative cost option should be offered');
    await shot(other, '3-fow-options');
    await opts.locator('.opt-item:not(.disabled)', { hasText: /exile|life|alternative|Force/i }).filter({ hasNotText: /^\s*\{?2\}?\{?U/ }).last().click();
    await settle(other, 500);
    if (await other.locator('.mode-hint').count()) { // target the Brainstorm on the stack
      await pickTarget(other, other.locator('.stack-item').first());
    }
    await settle(other, 800);
    const pend = other.locator('.modal.pending');
    await pend.waitFor();
    assert(await pend.locator('button.pend-card').count() > 0, 'exile choice should be card images');
    step('choose blue card to exile');
    await shot(other, '3-fow-pending');
    await pend.locator('button.pend-card').first().click();
    await settle(other, 800);
    const lifeAfter = await life(other, 'bottom');
    assert(lifeAfter === lifeBefore - 1, `life ${lifeBefore} -> ${lifeAfter}, expected -1`);
    // 2 cards left the hand: FoW + exiled blue card
    assert((await other.locator('.hand .hcard').count()) === handBefore - 2, 'hand should shrink by 2');
    await shot(other, '3-fow-cast');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------------------------------------------
scenario('4. shockland: Steam Vents pay 2 life', async () => {
  const { active, close } = await setup('40 Steam Vents');
  try {
    const sv = handCard(active, 'Steam Vents');
    if (!(await sv.count())) throw new Retry('no Steam Vents');
    await sv.first().click();
    const pend = active.locator('.modal.pending');
    await pend.waitFor();
    const txt = await pend.innerText();
    step('pending: ' + txt.replace(/\n/g, ' | '));
    assert(/2 life/i.test(txt), 'should ask about 2 life');
    await shot(active, '4-shock-pending');
    await pend.getByRole('button', { name: /^yes|pay/i }).first().click();
    await settle(active, 800);
    assert((await life(active, 'bottom')) === 18, 'life should be 18, got ' + (await life(active, 'bottom')));
    const land = active.locator('.player-area.bottom .bf-row.lands .tcard').filter({ has: active.locator('img[alt="Steam Vents"]') });
    assert((await land.count()) === 1, 'Steam Vents on the battlefield');
    assert(!(await land.first().evaluate((e) => e.classList.contains('tapped'))), 'Steam Vents should be untapped');
    await shot(active, '4-shock-paid');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------------------------------------------
scenario('5. Thraben Inspector ETB makes a Clue', async () => {
  const { active, other, close } = await setup('40 Thraben Inspector');
  try {
    await landsToBF(active, 'Plains', 1);
    await tapLands(active, 1);
    await handCard(active, 'Thraben Inspector').first().click();
    await settle(active);
    await resolveStack(active, other);
    await settle(active, 800);
    await shot(active, '5-inspector-clue');
    assert(await active.locator('.tcard img[alt="Clue"], .tcard:has-text("Clue")').count() > 0, 'Clue token should be on the battlefield\n' + (await logText(active)).split('\n').slice(-8).join('\n'));
  } finally { await close(); }
});

// ---------------------------------------------------------------------------------------------------------------
const only = process.env.ONLY;
let failed = 0;
for (const s of scenarios) {
  if (only && !s.name.startsWith(only)) continue;
  console.log(s.name);
  let ok = false;
  for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
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
if (failed) { console.log('ENGINE2 E2E FAILED'); process.exit(1); }
console.log('ENGINE2 E2E OK');
