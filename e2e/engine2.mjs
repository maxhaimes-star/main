// Engine UI scenarios under STRICT rules: every scenario plays legally (one land per turn, auto-pay, priority), no manual moves.
// Each runs in a fresh room with a custom sealed list so both players hold known cards.
//   1. trigger target  (Orcish Bowmasters ETB ping: targeting banner appears automatically)
//   2. Mana Leak       (controller gets the "pay {3}?" pending, declines, spell is countered)
//   3. alt cost        (Force of Will: OptionsModal -> exile a blue card via card-image pending, life -1)
//   4. shockland       (Steam Vents "pay 2 life?" -> untapped, life 18)
//   5. Thraben Inspector ETB -> Clue token automatically
// Usage: node e2e/engine2.mjs [baseUrl] [outDir]   (env ONLY=3 runs a single scenario)
import {
  assert, bfLands, handCard, handLands, life, logTail, logText, Retry, resolveStack, runScenarios, setup, settle, shot as shotRaw, step, toStep, pressOk, passUntil,
} from './lib.mjs';

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });
const shot = (p, n) => shotRaw(p, `e2-${n}`);
const pass = async (p) => { await p.locator('button.ok').click(); await settle(p, 600); };
const nHand = (p) => p.locator('.hand .hcard').count();

/** Play a basic land from hand on my own turn (main phase). Returns false when I have none. */
async function land(p, name) {
  const c = handLands(p, name);
  if (!(await c.count())) return false;
  await c.first().click();
  await settle(p, 450);
  return true;
}
/** Let the turn pass until `who` is in their Main 1 again. */
const turnOf = (pages, who) => toStep(pages, who, /Main 1/);

/** Pick a single target in the targeting banner, confirming with Done if it did not auto-advance. */
async function pickTarget(p, loc) {
  await loc.click();
  await settle(p, 500);
  const done = p.locator('.mode-hint button', { hasText: 'Done' });
  if (await done.count() && await done.isEnabled().catch(() => false)) { await done.click(); await settle(p, 500); }
}

async function withGame(list, tag, ok, fn) {
  const g = await setup(list, tag);
  try {
    if (!(await ok(g))) throw new Retry('opening hands unusable');
    await fn(g);
  } finally { await g.close(); }
}

// ---------------------------------------------------------------------------------------------------------------
scenario('1. trigger target: Orcish Bowmasters ETB ping', async () => {
  await withGame('40 Orcish Bowmasters', 'e2-1',
    async ({ active }) => (await handCard(active, 'Orcish Bowmasters').count()) >= 1 && (await handLands(active, 'Swamp').count()) >= 2,
    async ({ active, other }) => {
      const pages = [active, other];
      await land(active, 'Swamp');                    // turn 1
      await turnOf(pages, other);
      await land(other, 'Swamp');                      // turn 2 (the opponent's own land drop)
      await turnOf(pages, active);
      await land(active, 'Swamp');                    // turn 3: two lands
      step('cast Bowmasters with two lands (auto-pay)');
      await handCard(active, 'Orcish Bowmasters').first().click();
      await settle(active);
      await pass(other);                               // opponent lets it resolve
      const hint = active.locator('.mode-hint', { hasText: /choose target/i });
      if (!(await hint.count())) await settle(active, 1000);
      await hint.waitFor();
      step('targeting banner appeared for the ETB trigger');
      await shot(active, '1-trigger-target');
      const before = await life(active, 'top');
      await pickTarget(active, active.locator('.player-area.top .player-panel'));
      await resolveStack(pages);
      const after = await life(active, 'top');
      await shot(active, '1-trigger-resolved');
      assert(after === before - 1, `opponent life ${before} -> ${after}, expected -1\n${await logTail(active, 8)}`);
    });
});

// ---------------------------------------------------------------------------------------------------------------
scenario('2. Mana Leak: payer declines, spell countered', async () => {
  // active holds Mana Leak + 2 Islands; the opponent holds Opt + 2 Islands and casts Opt on their turn 2 with 2 lands.
  await withGame('20 Mana Leak\n20 Opt', 'e2-2',
    async ({ active, other }) => (await handCard(active, 'Mana Leak').count()) >= 1 && (await handLands(active, 'Island').count()) >= 2
      && (await handCard(other, 'Opt').count()) >= 1 && (await handLands(other, 'Island').count()) >= 2,
    async ({ active, other }) => {
      const pages = [active, other];
      await land(active, 'Island');                    // turn 1
      await turnOf(pages, other);
      await land(other, 'Island');                     // turn 2: 1 land
      await turnOf(pages, active);
      await land(active, 'Island');                    // turn 3: 2 lands (kept untapped for Mana Leak)
      await turnOf(pages, other);
      await land(other, 'Island');                     // turn 4: 2 lands
      step('opponent casts Opt on their own turn');
      await handCard(other, 'Opt').first().click();
      await settle(other);
      // Opt has no target; the active player now holds priority and answers with Mana Leak.
      await settle(active, 500);
      step('active casts Mana Leak targeting Opt');
      await handCard(active, 'Mana Leak').first().click();
      await active.locator('.mode-hint').waitFor();
      await pickTarget(active, active.locator('.stack-item').first());
      await settle(active, 800);
      await shot(active, '2-leak-cast');
      // Resolve Mana Leak: whoever holds priority passes. The Opt controller (other) is asked to pay {3}.
      for (let i = 0; i < 6; i++) {
        if (await other.locator('.modal.pending').count()) break;
        for (const p of pages) { if (await pressOk(p, 500)) break; }
      }
      const pend = other.locator('.modal.pending');
      if (await pend.count()) {
        const txt = await pend.innerText();
        step('pending: ' + txt.replace(/\n/g, ' | '));
        assert(/3/.test(txt), 'pending should mention {3}');
        await shot(other, '2-leak-pending');
        await pend.getByRole('button', { name: /^(No|Don't|Decline)/i }).first().click();
        await settle(other, 800);
      } else step('(note) no pay-{3} prompt: the engine skipped it because the payer cannot afford it');
      await resolveStack(pages);
      const log = await logText(active);
      assert(/counter/i.test(log), 'log should mention the counter:\n' + log.split('\n').slice(-8).join('\n'));
      assert(await active.locator('.stack-item').count() === 0, 'stack should be empty');
      await shot(active, '2-leak-countered');
    });
});

// ---------------------------------------------------------------------------------------------------------------
scenario('3. alt cost: Force of Will exiling a blue card', async () => {
  await withGame('20 Force of Will\n20 Brainstorm', 'e2-3',
    async ({ active, other }) => (await handCard(active, 'Brainstorm').count()) >= 1 && (await handLands(active, 'Island').count()) >= 1
      && (await handCard(other, 'Force of Will').count()) >= 1 && (await other.locator('.hand .hcard img').count()) >= 2,
    async ({ active, other }) => {
      await land(active, 'Island');
      step('active casts Brainstorm');
      await handCard(active, 'Brainstorm').first().click();
      await settle(active);
      const handBefore = await nHand(other);
      const lifeBefore = await life(other, 'bottom');
      step('opponent casts Force of Will with its alternative cost');
      await handCard(other, 'Force of Will').first().click();
      const opts = other.locator('.opt-list');
      await opts.waitFor();
      const optTxt = await opts.innerText();
      step('options: ' + optTxt.replace(/\n/g, ' | '));
      assert(/exile|life|alternative|Force/i.test(optTxt), 'alternative cost option should be offered');
      await shot(other, '3-fow-options');
      await opts.locator('.opt-item:not(.disabled)', { hasText: /exile|life|alternative|Force/i }).filter({ hasNotText: /^\s*\{?2\}?\{?U/ }).last().click();
      await settle(other, 500);
      if (await other.locator('.mode-hint').count()) await pickTarget(other, other.locator('.stack-item').first());
      await settle(other, 800);
      const pend = other.locator('.modal.pending');
      const asked = await pend.waitFor({ timeout: 3000 }).then(() => true, () => false);
      if (asked) {
        assert(await pend.locator('button.pend-card').count() > 0, 'exile choice should be card images');
        step('choose blue card to exile');
        await shot(other, '3-fow-pending');
        await pend.locator('button.pend-card').first().click();
        await settle(other, 800);
      } else {
        step('(note) engine auto-picked the only blue card to exile');
        assert(/exiles .* to pay for Force of Will/.test(await logText(other)), 'expected the exile cost in the log\n' + await logTail(other, 8));
      }
      await settle(other, 800);
      const lifeAfter = await life(other, 'bottom');
      assert(lifeAfter === lifeBefore - 1, `life ${lifeBefore} -> ${lifeAfter}, expected -1`);
      assert((await nHand(other)) === handBefore - 2, 'hand should shrink by 2 (Force of Will + exiled blue card)');
      await shot(other, '3-fow-cast');
    });
});

// ---------------------------------------------------------------------------------------------------------------
scenario('4. shockland: Steam Vents pay 2 life', async () => {
  await withGame('40 Steam Vents', 'e2-4',
    async ({ active }) => (await handCard(active, 'Steam Vents').count()) >= 1,
    async ({ active }) => {
      await handCard(active, 'Steam Vents').first().click();
      const pend = active.locator('.modal.pending');
      await pend.waitFor();
      const txt = await pend.innerText();
      step('pending: ' + txt.replace(/\n/g, ' | '));
      assert(/2 life/i.test(txt), 'should ask about 2 life');
      await shot(active, '4-shock-pending');
      await pend.getByRole('button', { name: /^yes|pay/i }).first().click();
      await settle(active, 800);
      assert((await life(active, 'bottom')) === 18, 'life should be 18, got ' + (await life(active, 'bottom')));
      const l = bfLands(active).filter({ has: active.locator('img[alt="Steam Vents"]') });
      assert((await l.count()) === 1, 'Steam Vents on the battlefield');
      assert(!(await l.first().evaluate((e) => e.classList.contains('tapped'))), 'Steam Vents should be untapped');
      await shot(active, '4-shock-paid');
    });
});

// ---------------------------------------------------------------------------------------------------------------
scenario('5. Thraben Inspector ETB makes a Clue', async () => {
  await withGame('40 Thraben Inspector', 'e2-5',
    async ({ active }) => (await handCard(active, 'Thraben Inspector').count()) >= 1 && (await handLands(active, 'Plains').count()) >= 1,
    async ({ active, other }) => {
      await land(active, 'Plains');
      await handCard(active, 'Thraben Inspector').first().click();
      await settle(active);
      await resolveStack([active, other]);
      await settle(active, 800);
      await shot(active, '5-inspector-clue');
      assert(await active.locator('.tcard img[alt="Clue"], .tcard:has-text("Clue")').count() > 0, 'Clue token should be on the battlefield\n' + await logTail(active, 8));
    });
});

await runScenarios('ENGINE2 E2E', scenarios);
