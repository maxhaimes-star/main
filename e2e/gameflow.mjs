// Game flow (strict rules, UI only):
//   1. hold priority: Ctrl-click Wheel of Fortune keeps priority; sacrifice Lion's Eye Diamond for RRR with the wheel on the stack;
//      the wheel resolves and the mana is still floating. Lands never look summoning sick.
//   2. mulligans: free mulligan proposed and agreed twice, then "Request another 6" agreed -> keep 6.
//   3. proposals in game: Scry 1 (opponent agrees, scry window), opponent discards at random (agreed, logged), undo.
// Usage: node e2e/gameflow.mjs [baseUrl] [outDir]   (env ONLY=2 runs a single scenario)
import {
  assert, handCard, handLands, logTail, logText, passUntil, pressOk, Retry, runScenarios, setup, settle, shot as shotRaw, step, toStep,
} from './lib.mjs';

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });
const shot = (p, n) => shotRaw(p, `gf-${n}`);
const nHand = (p) => p.locator('.hand .hcard').count();
const turnOf = (pages, who) => toStep(pages, who, /Main 1/);
const agree = async (p) => { await p.locator('.proposal-ask button', { hasText: 'Agree' }).click(); await settle(p, 500); };

async function land(p) {
  const c = handLands(p, 'Mountain');
  if (!(await c.count())) return false;
  await c.first().click();
  await settle(p, 450);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
scenario('1. hold priority: Wheel of Fortune, then Lion\'s Eye Diamond in response', async () => {
  const g = await setup('20 Wheel of Fortune\n20 Lion\'s Eye Diamond', 'gf1');
  const { active, other, close } = g;
  const pages = [active, other];
  try {
    const ok = (await handCard(active, 'Wheel of Fortune').count()) >= 1 && (await handCard(active, "Lion's Eye Diamond").count()) >= 1 && (await handLands(active, 'Mountain').count()) >= 3;
    if (!ok) throw new Retry('opening hand needs Wheel, Lion\'s Eye Diamond and 3 Mountains');

    step('turn 1: Mountain + Lion\'s Eye Diamond; a land never looks summoning sick');
    await land(active);
    assert((await active.locator('.player-area.bottom .bf-row.lands .tcard.sick').count()) === 0, 'a land shows the summoning-sick styling');
    await handCard(active, "Lion's Eye Diamond").first().click();
    await settle(active, 500);
    await pressOk(other, 500); // let it resolve
    await passUntil(pages, async () => (await active.locator('.stack-item').count()) === 0, 'LED resolved', 10);
    const led = active.locator('.player-area.bottom .tcard').filter({ has: active.locator('img[alt="Lion\'s Eye Diamond"]') });
    assert((await led.count()) === 1, 'LED on the battlefield');
    assert(!/\bsick\b/.test(await led.first().getAttribute('class')), 'an artifact shows the summoning-sick styling');

    for (let t = 0; t < 2; t++) {
      await turnOf(pages, other);
      await land(other);
      await turnOf(pages, active);
      await land(active);
    }

    step('Ctrl-click Wheel of Fortune: priority stays with me');
    await handCard(active, 'Wheel of Fortune').first().click({ modifiers: ['Control'] });
    await settle(active, 700);
    assert((await active.locator('.stack-item').count()) === 1, 'Wheel on the stack');
    assert((await active.locator('button.ok').count()) === 1, 'I kept priority (OK button)');
    assert((await other.locator('button.ok').count()) === 0, 'the opponent does not have priority');
    await shot(active, '1-held');

    step('sacrifice Lion\'s Eye Diamond for RRR with the wheel on the stack');
    await led.first().click();
    await settle(active, 400);
    await active.locator('.ctx-item', { hasText: /\{R\}\{R\}\{R\}/ }).first().click();
    await settle(active, 600);
    assert((await nHand(active)) === 0, 'the hand was discarded as the cost');
    assert(/R/.test(await active.locator('.pool-chip.mine').innerText()), 'RRR floating');
    await shot(active, '1-led');

    step('pass, the opponent passes: Wheel resolves, RRR still floating');
    await pressOk(active, 500);
    await pressOk(other, 800);
    assert((await active.locator('.stack-item').count()) === 0, 'the stack resolved\n' + await logTail(active));
    assert((await nHand(active)) === 7, 'drew seven');
    assert(/R/.test(await active.locator('.pool-chip.mine').innerText().catch(() => '')), 'the mana is still floating after the wheel');
    assert(/Wheel of Fortune resolves|Wheel of Fortune/.test(await logText(active)), 'log mentions the wheel');
  } finally { await close(); }
});

// ---------------------------------------------------------------------------------------------------------------
scenario('2. mulligans: two free mulligans, then another 6, then proposals in game', async () => {
  const { A, B, close } = await setup('40 Lightning Bolt', 'gf2', { keep: false });
  try {
    step('A proposes a free mulligan, B agrees; A proposes a second one, B agrees');
    await A.getByRole('button', { name: 'Propose a free first mulligan' }).click();
    await settle(A, 500);
    await agree(B);
    await A.getByRole('button', { name: 'Propose a second free mulligan' }).click();
    await settle(A, 500);
    await agree(B);
    assert(/first two mulligans are free/.test(await A.locator('.mulligan').innerText()), 'two free mulligans agreed');

    step('two free mulligans keep seven, the third goes to 6');
    for (let i = 0; i < 2; i++) { await A.getByRole('button', { name: 'Free mulligan (to 7)' }).click(); await settle(A, 400); }
    await A.getByRole('button', { name: 'Mulligan to 6' }).click();
    await settle(A, 400);
    assert((await A.getByRole('button', { name: 'Keep 6' }).count()) === 1, 'Keep 6 after the third mulligan');

    step('about to go to 5: Request another 6, B agrees -> mulligan to 6 again');
    await A.getByRole('button', { name: 'Request another 6' }).click();
    await settle(A, 500);
    assert((await A.locator('.proposal-wait').count()) === 1, 'waiting for the opponent');
    await agree(B);
    assert((await A.getByRole('button', { name: 'Keep 6' }).count()) === 1, 'still Keep 6 after another 6');
    await shot(A, '2-another6');
    await A.getByRole('button', { name: 'Keep 6' }).click();
    await settle(A, 400);
    await A.locator('.mull-hand .zcard').first().click();
    await A.getByRole('button', { name: 'Put on bottom' }).click();
    await B.getByRole('button', { name: /^Keep 7/ }).click();
    await A.locator('.center-bar').waitFor();
    await B.locator('.center-bar').waitFor();
    await settle(A, 600);
    assert((await nHand(A)) === 6 || (await nHand(A)) === 7, 'A kept 6 (7 after a draw)');
    assert(/mulligans to 6 again|to 6 again/.test(await logText(A)), 'log shows another 6');

    step('in game: A proposes Scry 1, B agrees, A scries to the bottom');
    await A.locator('.sub-actions .propose-btn').click();
    await A.locator('.ctx-item', { hasText: 'Scry 1' }).click();
    await settle(A, 500);
    await agree(B);
    await A.locator('.modal', { hasText: 'Scry (1)' }).waitFor();
    await A.locator('.zone-grid.peek select').first().selectOption('bottom');
    await A.locator('.modal', { hasText: 'Scry (1)' }).getByRole('button', { name: 'Done' }).click();
    await settle(A, 500);
    assert(/Sam agrees: Max scries 1/.test(await logText(A)), 'scry agreed in the log');
    assert(/1 on the bottom/.test(await logText(A)), 'scried to the bottom');

    step('A proposes that Sam discards at random; Sam agrees; then undo');
    const before = await nHand(B);
    await A.locator('.sub-actions .propose-btn').click();
    await A.locator('.ctx-item', { hasText: 'Sam discards a card at random' }).click();
    await settle(A, 500);
    await agree(B);
    assert((await nHand(B)) === before - 1, 'Sam discarded one');
    assert(/Sam discards .* at random/.test(await logText(A)), 'random discard logged');
    await B.locator('.undo-btn').first().click();
    await settle(B, 400);
    await A.locator('.undo-req button', { hasText: 'Allow' }).click();
    await settle(A, 600);
    assert((await nHand(B)) === before, 'undo gave the card back');
    await shot(A, '2-proposals');
  } finally { await close(); }
});

await runScenarios('gameflow', scenarios);
