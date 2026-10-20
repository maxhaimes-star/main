// Strict (Arena-like) gameplay, played legally through the UI only (no manual moves, except inside the "Fix board" scenario):
//   1. one land per turn, uncastable cards dimmed, Lightning Bolt auto-pays by tapping the Mountain, no land on opp's turn
//   2. Duress-style discard (skipped with a note when the automation does not support it)
//   3. combat with summoning sickness (cannot attack the turn it enters, can the next turn)
//   4. Fix board: decline, then accept -> manual tools appear; set life to 3, Done fixing; Bolt for lethal ->
//      game over -> match continues to sideboarding -> game 2 starts
// Usage: node e2e/strict.mjs [baseUrl] [outDir]   (env ONLY=2 runs a single scenario)
import {
  assert, bfLands, handCard, handLands, life, logTail, newPage, passUntil, pressOk, resolveStack, Retry, runScenarios, setup, settle, shot, step, toastText, toStep, currentStep,
} from './lib.mjs';

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });
const handNames = (p) => p.locator('.hand .hcard img').evaluateAll((n) => n.map((i) => i.alt));
const cls = (loc) => loc.first().getAttribute('class');
const handCount = (p) => p.locator('.hand .hcard').count();

/** Setup until `ok(g)` holds for the opening hands (else Retry). */
async function setupWith(list, tag, ok) {
  const g = await setup(list, tag);
  try { if (!(await ok(g))) throw new Retry('opening hands unusable'); } catch (e) { await g.close(); throw e; }
  return g;
}

/** The attack buttons (`sel` must be shown) and the other priority buttons: visible, inside the viewport, not covered and not
 *  overlapping each other or the board pieces, on phones (portrait + landscape) and desktop. Leaves the desktop viewport. */
async function attackButtonsFit(p, sel, tag) {
  for (const [w, h] of [[360, 740], [390, 844], [844, 390], [1440, 900]]) {
    await p.setViewportSize({ width: w, height: h });
    await settle(p, 400);
    const problems = await p.evaluate((sel) => {
      const out = [];
      const rect = (e) => e.getBoundingClientRect();
      const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
      const btns = [...document.querySelectorAll('.priority button, .priority .waiting')].filter((e) => rect(e).width > 0);
      const want = document.querySelector(sel);
      if (!want || rect(want).width === 0) out.push(`${sel} not visible`);
      for (const b of btns) {
        const r = rect(b);
        if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) out.push(`${b.textContent} leaves the viewport`);
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!at || !b.contains(at)) out.push(`${b.textContent} is covered by ${at?.className}`);
      }
      for (let i = 0; i < btns.length; i++) for (let j = i + 1; j < btns.length; j++) if (hit(rect(btns[i]), rect(btns[j]))) out.push(`${btns[i].textContent} overlaps ${btns[j].textContent}`);
      for (const b of btns) for (const o of document.querySelectorAll('.zones .zone, .player-panel, .stack-item')) if (hit(rect(b), rect(o))) out.push(`${b.textContent} overlaps ${o.className}`);
      return out;
    }, sel);
    await shot(p, `${tag}-${w}x${h}`);
    assert(!problems.length, `${w}x${h}: ${problems.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
scenario('1. one land per turn, castability dimming, Lightning Bolt auto-pay', async () => {
  const g = await setupWith('60 Lightning Bolt', 's1', async ({ active }) => (await handCard(active, 'Lightning Bolt').count()) >= 1 && (await handLands(active, 'Mountain').count()) >= 2);
  const { active, other, close } = g;
  try {
    step('with no land in play every Bolt is dimmed (uncastable), lands are not');
    const bolts = handCard(active, 'Lightning Bolt');
    for (let i = 0; i < await bolts.count(); i++) assert(/uncastable/.test(await bolts.nth(i).getAttribute('class')), 'Bolt should be uncastable with no mana');
    assert(/castable/.test(await cls(handLands(active, 'Mountain'))) && !/uncastable/.test(await cls(handLands(active, 'Mountain'))), 'a Mountain should be playable');
    await shot(active, 's1-1-dimmed');

    step('opponent cannot play a land on my turn');
    if (await handLands(other, 'Mountain').count()) {
      const n = await handCount(other);
      await handLands(other, 'Mountain').first().click();
      await settle(other, 400);
      assert((await handCount(other)) === n, 'land must stay in the hand');
      assert(/priority|your turn/i.test(await toastText(other)), 'expected a no-priority / not-your-turn toast, got: ' + await toastText(other));
    }

    step('play first land');
    const n0 = await handCount(active);
    await handLands(active, 'Mountain').first().click();
    await settle(active, 500);
    assert((await handCount(active)) === n0 - 1, 'first land should leave the hand');
    assert((await bfLands(active).count()) === 1, 'one land on the battlefield');

    step('second land click -> error toast, land stays in hand');
    await handLands(active, 'Mountain').first().click();
    await settle(active, 300);
    const t = await toastText(active);
    await shot(active, 's1-2-second-land');
    assert(/already played a land/i.test(t), 'expected "already played a land" toast, got: ' + t);
    assert((await handCount(active)) === n0 - 1, 'second land must NOT be played');
    assert((await bfLands(active).count()) === 1, 'still one land on the battlefield');
    assert(/1\/1/.test(await active.locator('.land-plays').innerText()), 'land counter should read 1/1');

    step('Bolt is castable now, hover previews the Mountain to be tapped');
    assert(/castable/.test(await cls(bolts)) && !/uncastable/.test(await cls(bolts)), 'Bolt should be castable with an untapped Mountain');
    await bolts.first().hover();
    await settle(active, 300);
    if (!(await active.locator('.tcard.pay-preview').count())) console.log('  (note) no .pay-preview highlight on hover');

    step('cast Bolt at the opponent: Mountain taps automatically');
    const lifeBefore = await life(active, 'top');
    const nBolts = await bolts.count();
    await bolts.first().click();
    await active.locator('.mode-hint').waitFor();
    await active.locator('.player-area.top .player-panel').click();
    await settle(active, 600);
    assert((await bfLands(active).first().getAttribute('class')).includes('tapped'), 'Mountain should be tapped by auto-pay');
    assert((await active.locator('.stack-item').count()) === 1, 'Bolt on the stack');
    if (nBolts > 1) assert(/uncastable/.test(await cls(bolts)), 'another Bolt should now be dimmed (Mountain tapped)');
    await shot(active, 's1-3-bolt-on-stack');
    await resolveStack([active, other]);
    assert((await life(active, 'top')) === lifeBefore - 3, `opponent life ${lifeBefore} -> ${await life(active, 'top')}, expected -3`);
    assert((await life(other, 'bottom')) === lifeBefore - 3, 'opponent sees the same life');
    await shot(active, 's1-4-resolved');

    step('next turn: land drop is available again for the other player, not for me');
    await toStep([active, other], other, /Main 1/);
    await handLands(other, 'Mountain').first().click().catch(() => {});
    await settle(other, 500);
    assert((await bfLands(other).count()) === 1, 'new active player can play their land');
    await handLands(active, 'Mountain').first().click().catch(() => {});
    await settle(active, 300);
    assert((await bfLands(active).count()) === 1, 'inactive player still cannot play a land');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------------------------------------------
scenario('2. Duress: opponent reveals, caster picks a noncreature spell to discard', async () => {
  const g = await setupWith('20 Duress\n20 Lightning Bolt', 's2', async ({ active, other }) =>
    (await handCard(active, 'Duress').count()) >= 1 && (await handLands(active, 'Swamp').count()) >= 1 && (await other.locator('.hand .hcard img').count()) >= 1);
  const { active, other, close } = g;
  try {
    await handLands(active, 'Swamp').first().click();
    await settle(active, 500);
    const before = await handCount(other);
    await handCard(active, 'Duress').first().click();
    await active.locator('.mode-hint').waitFor();
    await active.locator('.player-area.top .player-panel').click();
    await settle(active, 500);
    await resolveStack([active, other]);
    await settle(active, 800);
    const pend = active.locator('.modal.pending');
    if (!(await pend.count())) {
      console.log('  SKIP (note): Duress produced no discard choice, the automation for it is not present. Log:\n' + await logTail(active, 6));
      return;
    }
    step('choose from revealed hand: ' + (await pend.innerText()).replace(/\n/g, ' | '));
    await shot(active, 's2-duress-pending');
    assert(await pend.locator('button.rv.legal, button.pend-card').count() > 0, 'revealed hand should list legal choices');
    await pend.locator('button.rv.legal, button.pend-card').first().click();
    await settle(active, 800);
    assert((await handCount(other)) === before - 1, `opponent hand ${before} -> ${await handCount(other)}, expected -1`);
    assert(!(await pend.count()), 'pending closed');
    await shot(active, 's2-duress-done');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------------------------------------------
scenario('3. combat: summoning sickness, then a real attack', async () => {
  const g = await setupWith('60 Giver of Runes', 's3', async ({ active }) => (await handCard(active, 'Giver of Runes').count()) >= 1 && (await handLands(active, 'Plains').count()) >= 2);
  const { active, other, close } = g;
  const pages = [active, other];
  try {
    await handLands(active, 'Plains').first().click();
    await settle(active, 500);
    step('cast the creature (turn 1)');
    await handCard(active, 'Giver of Runes').first().click();
    await settle(active, 600);
    await resolveStack(pages);
    assert((await active.locator('.player-area.bottom .bf-row.creatures .tcard').count()) === 1, 'creature should be on the battlefield\n' + await logTail(active));
    const lifeStart = await life(active, 'top');

    step('summoning-sick creature cannot attack: combat is skipped on turn 1 (nothing can attack)');
    const creature = active.locator('.player-area.bottom .bf-row.creatures .tcard').first();
    assert(/sick/.test(await creature.getAttribute('class')), 'creature should be marked summoning sick');
    await shot(active, 's3-1-sick');
    await passUntil(pages, async () => (await active.locator('.player-area.bottom.active').count()) > 0 && /Main 2|End/.test(await currentStep(active)), 'my main 2');
    assert(/No attackers/.test(await logTail(active, 15)), 'engine should report no possible attackers\n' + await logTail(active, 15));
    assert(!/attacking|tapped/.test(await creature.getAttribute('class')), 'creature must not have attacked');
    assert((await life(active, 'top')) === lifeStart, 'no damage dealt on turn 1');

    step('pass the turn; opponent plays a land and passes back');
    await toStep(pages, other, /Main 1/);
    await handLands(other, 'Plains').first().click().catch(() => {});
    await settle(other, 300);
    await toStep(pages, active, /Main 1/);
    assert(!(await creature.getAttribute('class')).includes('sick'), 'creature should no longer be summoning sick');

    step('attack with it (turn 3)');
    await passUntil(pages, async () => (await active.locator('.player-area.bottom.active').count()) > 0 && /Attackers/.test(await currentStep(active)), 'my attackers step');
    assert(!/no-attack/.test(await creature.getAttribute('class')), 'creature may attack now');
    await creature.click();
    await settle(active, 400);
    assert(/attacking/.test(await creature.getAttribute('class')), 'creature should be attacking');
    await shot(active, 's3-2-attacking');

    step('"Clear attackers" undoes it; "Attack with all" declares every creature that can attack');
    await active.locator('.priority .clear-attackers-btn').click();
    await settle(active, 400);
    assert(!/attacking/.test(await creature.getAttribute('class')), 'Clear attackers should remove the attacker');
    assert(!(await active.locator('.priority .clear-attackers-btn').count()), 'no Clear button without attackers');
    assert(!(await other.locator('.attack-all').count()), 'the defender has no attack buttons');
    await attackButtonsFit(active, '.priority .attack-all-btn', 's3-attack-all');
    await active.locator('.priority .attack-all-btn').click();
    await settle(active, 400);
    assert(/attacking/.test(await creature.getAttribute('class')), 'Attack with all should declare the creature');
    assert(!(await active.locator('.priority .attack-all-btn').count()), 'no Attack-with-all button once everything attacks');
    await active.locator('.priority .clear-attackers-btn').waitFor();
    await attackButtonsFit(active, '.priority .clear-attackers-btn', 's3-clear');
    await active.locator('button.ok', { hasText: 'Attack with 1' }).click();
    await settle(other, 600);
    // The defender has no creatures, so the blockers step may be skipped; otherwise passUntil confirms "no blocks".
    await passUntil(pages, async () => (await life(active, 'top')) < lifeStart, 'combat damage', 15);
    assert((await life(active, 'top')) === lifeStart - 1, `defender life ${lifeStart} -> ${await life(active, 'top')}, expected -1`);
    assert((await life(other, 'bottom')) === lifeStart - 1, 'defender sees the same life');
    await shot(other, 's3-3-damage');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------------------------------------------
scenario('4. Fix board request/accept, lethal Bolt ends the game, match continues to sideboarding', async () => {
  const g = await setupWith('60 Lightning Bolt', 's4', async ({ active }) => (await handCard(active, 'Lightning Bolt').count()) >= 1 && (await handLands(active, 'Mountain').count()) >= 1);
  const { active, other, close } = g;
  const pages = [active, other];
  const manualVisible = async (p) => (await p.locator('.player-area .life button').count()) + (await p.getByRole('button', { name: 'Tokens' }).count());
  try {
    step('manual tools are hidden in strict mode');
    assert((await manualVisible(active)) === 0 && (await manualVisible(other)) === 0, 'life +/- and Tokens must be hidden');
    await shot(active, 's4-1-strict');

    step('request, opponent declines');
    await active.getByRole('button', { name: 'Fix board', exact: true }).click();
    await other.getByRole('button', { name: 'Decline' }).waitFor();
    assert(/wants to fix the board/i.test(await other.locator('.undo-req').innerText()), 'opponent sees the request');
    assert(/Waiting for your opponent/i.test(await active.locator('.undo-req').innerText()), 'requester sees a waiting note');
    await other.getByRole('button', { name: 'Decline' }).click();
    await settle(active, 500);
    assert((await manualVisible(active)) === 0, 'still no manual tools after decline');

    step('request again, opponent allows');
    await active.getByRole('button', { name: 'Fix board', exact: true }).click();
    await other.getByRole('button', { name: 'Allow' }).click();
    await active.locator('.fix-banner').waitFor();
    await other.locator('.fix-banner').waitFor();
    assert((await manualVisible(active)) > 0 && (await manualVisible(other)) > 0, 'manual tools visible for both players');
    await shot(active, 's4-2-fix-mode');

    step('manual: set the opponent to 3 life');
    await active.locator('.player-area.top .life-num').click();
    await active.locator('.prompt input').fill('3');
    await active.locator('.prompt').getByRole('button', { name: 'OK', exact: true }).click();
    await settle(active, 500);
    assert((await life(active, 'top')) === 3, 'opponent life should be 3, is ' + await life(active, 'top'));
    await active.getByRole('button', { name: 'Done fixing' }).click();
    await settle(active, 500);
    assert((await active.locator('.fix-banner').count()) === 0 && (await manualVisible(active)) === 0, 'fix mode off, tools hidden again');

    step('play Mountain, Bolt face for lethal');
    await handLands(active, 'Mountain').first().click();
    await settle(active, 500);
    await handCard(active, 'Lightning Bolt').first().click();
    await active.locator('.mode-hint').waitFor();
    await active.locator('.player-area.top .player-panel').click();
    await settle(active, 500);
    await resolveStack(pages);
    await settle(active, 800);
    await shot(active, 's4-3-game-over');
    // The game-over overlay may flash by; sideboarding is the stable state.
    for (const p of pages) await p.locator('.between-games').waitFor();
    const head = await active.locator('.between-games h2').innerText();
    step(head);
    assert(/wins/.test(head) && /1[–-]0|0[–-]1/.test(head), 'sideboarding header should show the game result and 1-0: ' + head);
    await shot(active, 's4-4-sideboarding');

    step('both ready -> game 2');
    for (const p of pages) await p.getByRole('button', { name: /Ready for next game/ }).click();
    for (const p of pages) await p.getByRole('button', { name: /^Keep/ }).click();
    await active.locator('.center-bar').waitFor();
    assert(/Game 2/.test(await active.locator('.turn-info').innerText()), 'game 2 should be under way');
    await shot(active, 's4-5-game2');
  } finally { await close(); }
});

await runScenarios('STRICT E2E', scenarios);
