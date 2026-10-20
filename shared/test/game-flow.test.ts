/** Game flow (workstream C): hold priority, blockers never skipped, mulligan house rules, proposals the opponent agrees to. */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  applyAction, canBlockAny, createGame, type Ctx, decideBotAction, type GameAction, type GameState, manaOptionsFor, moveCard, newBotMemory, viewFor,
} from '../src/index.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[], fill = 'basic_mountain') => [...extra, ...Array(40 - extra.length).fill(fill)];

function fresh(a: string[] = [], b: string[] = [], seed = 7) {
  const ctx: Ctx = { rng: seeded(seed), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(a), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(b), side: [] },
  ], 'a', ctx);
  return { g, ctx };
}

function setup(a: string[] = [], b: string[] = []) {
  const { g, ctx } = fresh(a, b);
  act(g, ctx, 'a', { t: 'keep' });
  act(g, ctx, 'b', { t: 'keep' });
  return { g, ctx };
}

function act(g: GameState, ctx: Ctx, pid: string, action: GameAction) {
  const err = applyAction(g, pid, action, ctx);
  if (err) throw new Error(err);
}

const P = (g: GameState, pid: string) => g.players.find((p) => p.pid === pid)!;

function find(g: GameState, pid: string, cardId: string, skip: string[] = []): string {
  const p = P(g, pid);
  const iid = [...p.zones.hand, ...p.zones.library, ...p.zones.graveyard].find((i) => g.cards[i].cardId === cardId && !skip.includes(i));
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}

function put(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId, g.battlefield.slice());
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  return iid;
}

function toHand(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId);
  if (g.cards[iid].zone !== 'hand') moveCard(g, ctx, iid, 'hand');
  return iid;
}

const pool = (g: GameState, pid: string) => Object.values(P(g, pid).manaPool).reduce((x, y) => x + y, 0);

describe('hold priority', () => {
  it('Wheel of Fortune held: sacrifice Lion\'s Eye Diamond for mana with the wheel on the stack, the mana survives the wheel', () => {
    const { g, ctx } = setup(['wheel_of_fortune', 'lions_eye_diamond']);
    for (let i = 0; i < 3; i++) put(g, ctx, 'a', 'basic_mountain');
    const led = put(g, ctx, 'a', 'lions_eye_diamond');
    const wheel = toHand(g, ctx, 'a', 'wheel_of_fortune');
    expect(g.step).toBe('main1');
    act(g, ctx, 'a', { t: 'cast', iid: wheel, hold: true });
    expect(g.stack.map((s) => s.iid)).toEqual([wheel]);
    expect(g.priority).toBe('a'); // kept priority
    const opt = manaOptionsFor(g, led).find((o) => o.produces === 'RRR')!;
    expect(opt).toBeTruthy();
    const handBefore = P(g, 'a').zones.hand.length;
    expect(handBefore).toBeGreaterThan(0);
    act(g, ctx, 'a', { t: 'activateMana', iid: led, option: opt.id });
    expect(P(g, 'a').zones.hand).toEqual([]); // discarded the hand as the cost
    expect(g.cards[led].zone).toBe('graveyard');
    expect(P(g, 'a').manaPool.R).toBe(3);
    act(g, ctx, 'a', { t: 'pass' });
    expect(g.priority).toBe('b');
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.stack).toEqual([]);
    expect(P(g, 'a').zones.hand.length).toBe(7);
    expect(P(g, 'b').zones.hand.length).toBe(7);
    expect(P(g, 'a').manaPool.R).toBe(3); // same step: the floating mana is still there
    expect(g.step).toBe('main1');
    expect(g.priority).toBe('a');
  });

  it('without hold the opponent gets priority, so the diamond can\'t be used in response', () => {
    const { g, ctx } = setup(['wheel_of_fortune', 'lions_eye_diamond']);
    for (let i = 0; i < 3; i++) put(g, ctx, 'a', 'basic_mountain');
    const led = put(g, ctx, 'a', 'lions_eye_diamond');
    const wheel = toHand(g, ctx, 'a', 'wheel_of_fortune');
    act(g, ctx, 'a', { t: 'cast', iid: wheel });
    expect(g.priority).toBe('b');
    const opt = manaOptionsFor(g, led).find((o) => o.produces === 'RRR')!;
    expect(applyAction(g, 'a', { t: 'activateMana', iid: led, option: opt.id }, ctx)).toMatch(/priority/);
    expect(pool(g, 'a')).toBe(0);
  });

  it('held activated ability keeps priority too', () => {
    const { g, ctx } = setup(['wheel_of_fortune']);
    for (let i = 0; i < 3; i++) put(g, ctx, 'a', 'basic_mountain');
    const wheel = toHand(g, ctx, 'a', 'wheel_of_fortune');
    act(g, ctx, 'a', { t: 'cast', iid: wheel, hold: true });
    act(g, ctx, 'a', { t: 'pass' });
    expect(g.priority).toBe('b');
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.stack).toEqual([]);
  });
});

/** a attacks b with `attacker` (from main 1). */
function attack(g: GameState, ctx: Ctx, attacker: string) {
  act(g, ctx, 'a', { t: 'pass' }); // main 1 -> declare attackers (stops: a decision)
  expect(g.step).toBe('attackers');
  act(g, ctx, 'a', { t: 'declareAttacker', iid: attacker, target: 'b' });
  act(g, ctx, 'a', { t: 'confirmAttackers' });
}

describe('declare blockers is never skipped', () => {
  it('pass-until-end-of-turn (F6) still stops for blocks when a creature can block', () => {
    const { g, ctx } = setup(['embereth_shieldbreaker'], ['embereth_shieldbreaker']);
    const atk = put(g, ctx, 'a', 'embereth_shieldbreaker');
    const blk = put(g, ctx, 'b', 'embereth_shieldbreaker');
    act(g, ctx, 'b', { t: 'passUntilEOT' });
    attack(g, ctx, atk);
    expect(canBlockAny(g, 'b', getCard)).toBe(true);
    expect(g.step).toBe('blockers');
    expect(g.priority).toBe('b');
    expect(g.combat.blockersDeclared).toBe(false);
    act(g, ctx, 'b', { t: 'declareBlocker', iid: blk, attacker: atk });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[atk].zone).toBe('graveyard');
    expect(g.cards[blk].zone).toBe('graveyard');
  });

  it('a flier with no flying / reach blocker: the step is skipped ("No blockers")', () => {
    const { g, ctx } = setup(['griselbrand'], ['embereth_shieldbreaker']);
    const atk = put(g, ctx, 'a', 'griselbrand');
    put(g, ctx, 'b', 'embereth_shieldbreaker');
    const life = P(g, 'b').life;
    attack(g, ctx, atk);
    expect(g.log.some((l) => l.text === 'No blockers.')).toBe(true);
    expect(P(g, 'b').life).toBe(life - 7);
  });

  it('passing on a spell during the blockers step does not lock in "no blocks"', () => {
    const { g, ctx } = setup(['embereth_shieldbreaker'], ['embereth_shieldbreaker']);
    const atk = put(g, ctx, 'a', 'embereth_shieldbreaker');
    put(g, ctx, 'b', 'embereth_shieldbreaker');
    attack(g, ctx, atk);
    expect(g.priority).toBe('b');
    // As if Alice had cast something now: she passed, Bob may respond.
    g.stack.push({ id: 'x', kind: 'trigger', controller: 'a', text: 'Some trigger' });
    g.passed = ['a'];
    act(g, ctx, 'b', { t: 'pass' }); // both passed: it resolves, the declaration is still open
    expect(g.stack).toEqual([]);
    expect(g.step).toBe('blockers');
    expect(g.priority).toBe('b');
    expect(g.combat.blockersDeclared).toBe(false);
  });
});

describe('mulligans', () => {
  it('a second free mulligan can be proposed and agreed: two mulligans keep seven, the third costs one', () => {
    const { g, ctx } = fresh();
    act(g, ctx, 'a', { t: 'requestFreeMulligan' });
    act(g, ctx, 'b', { t: 'answerProposal', accept: true });
    expect(g.freeMulligan).toMatchObject({ on: true, count: 1 });
    act(g, ctx, 'b', { t: 'propose', kind: 'freeMulligan' });
    expect(g.proposal?.text).toMatch(/second free mulligan/);
    act(g, ctx, 'a', { t: 'answerFreeMulligan', accept: true });
    expect(g.freeMulligan?.count).toBe(2);
    expect(applyAction(g, 'a', { t: 'propose', kind: 'freeMulligan' }, ctx)).toMatch(/Two free mulligans/);
    act(g, ctx, 'a', { t: 'mulligan' });
    act(g, ctx, 'a', { t: 'mulligan' });
    act(g, ctx, 'a', { t: 'keep' });
    expect(P(g, 'a').needsBottom).toBe(0);
    act(g, ctx, 'b', { t: 'mulligan' });
    act(g, ctx, 'b', { t: 'mulligan' });
    act(g, ctx, 'b', { t: 'mulligan' });
    act(g, ctx, 'b', { t: 'keep' });
    expect(P(g, 'b').needsBottom).toBe(1);
  });

  it('"Request another 6": only when the next mulligan goes to 5; agreed, you mulligan to 6 again', () => {
    const { g, ctx } = fresh();
    expect(applyAction(g, 'a', { t: 'propose', kind: 'another6' }, ctx)).toMatch(/down to 5/);
    act(g, ctx, 'a', { t: 'mulligan' }); // to 6
    act(g, ctx, 'a', { t: 'propose', kind: 'another6' });
    act(g, ctx, 'b', { t: 'answerProposal', accept: true });
    expect(P(g, 'a').mulligans).toBe(2);
    expect(P(g, 'a').extraFreeMulligans).toBe(1);
    expect(P(g, 'a').zones.hand.length).toBe(7);
    act(g, ctx, 'a', { t: 'keep' });
    expect(P(g, 'a').needsBottom).toBe(1); // keeps 6
    expect(g.log.some((l) => /Bob agrees: Alice mulligans to 6 again/.test(l.text))).toBe(true);
  });

  it('declined: the next mulligan goes to 5 as usual', () => {
    const { g, ctx } = fresh();
    act(g, ctx, 'a', { t: 'mulligan' });
    act(g, ctx, 'a', { t: 'propose', kind: 'another6' });
    act(g, ctx, 'b', { t: 'answerProposal', accept: false });
    expect(g.proposal).toBeNull();
    act(g, ctx, 'a', { t: 'mulligan' });
    act(g, ctx, 'a', { t: 'keep' });
    expect(P(g, 'a').needsBottom).toBe(2);
  });

  it('the bot agrees to free mulligans and to one "another 6"', () => {
    const { g, ctx } = fresh();
    const mem = newBotMemory();
    act(g, ctx, 'a', { t: 'requestFreeMulligan' });
    expect(decideBotAction(viewFor(g, 'b'), 'b', mem)).toEqual({ t: 'answerProposal', accept: true });
    act(g, ctx, 'b', { t: 'answerProposal', accept: true });
    act(g, ctx, 'a', { t: 'mulligan' });
    act(g, ctx, 'a', { t: 'mulligan' });
    act(g, ctx, 'a', { t: 'propose', kind: 'another6' });
    expect(decideBotAction(viewFor(g, 'b'), 'b', mem)).toEqual({ t: 'answerProposal', accept: true });
    act(g, ctx, 'b', { t: 'answerProposal', accept: true });
    act(g, ctx, 'a', { t: 'propose', kind: 'another6' });
    expect(decideBotAction(viewFor(g, 'b'), 'b', mem)).toEqual({ t: 'answerProposal', accept: false });
  });
});

describe('proposals: scry 1, discard at random, shuffle a card into the library', () => {
  it('scry 1: agreed, the proposer gets a scry window; undo goes back to before the proposal', () => {
    const { g, ctx } = setup();
    const top = P(g, 'a').zones.library[0];
    act(g, ctx, 'a', { t: 'propose', kind: 'scry1' });
    expect(applyAction(g, 'a', { t: 'answerProposal', accept: true }, ctx)).toMatch(/No proposal/); // not your own
    expect(applyAction(g, 'a', { t: 'propose', kind: 'scry1' }, ctx)).toMatch(/Waiting for an answer/);
    act(g, ctx, 'b', { t: 'answerProposal', accept: true });
    expect(P(g, 'a').peek).toMatchObject({ mode: 'scry', iids: [top] });
    act(g, ctx, 'a', { t: 'resolvePeek', top: [], bottom: [top], graveyard: [], hand: [], battlefield: [], exile: [], shuffle: false });
    expect(P(g, 'a').zones.library.at(-1)).toBe(top);
    act(g, ctx, 'a', { t: 'requestUndo' });
    act(g, ctx, 'b', { t: 'answerUndo', accept: true });
    act(g, ctx, 'a', { t: 'requestUndo' });
    act(g, ctx, 'b', { t: 'answerUndo', accept: true });
    expect(P(g, 'a').peek).toBeNull();
    expect(g.proposal).toBeNull();
    expect(P(g, 'a').zones.library[0]).toBe(top);
    expect(g.log.map((l) => l.text).join('\n')).toMatch(/Alice proposes: Alice scries 1[\s\S]*Bob agrees: Alice scries 1/);
  });

  it('discard at random: the target player discards one card; the bot agrees; undo restores it', () => {
    const { g, ctx } = setup();
    const n = P(g, 'b').zones.hand.length;
    act(g, ctx, 'a', { t: 'propose', kind: 'discardRandom', target: 'b' });
    expect(g.proposal?.text).toBe('Bob discards a card at random');
    const ans = decideBotAction(viewFor(g, 'b'), 'b', newBotMemory());
    expect(ans).toEqual({ t: 'answerProposal', accept: true });
    act(g, ctx, 'b', ans!);
    expect(P(g, 'b').zones.hand.length).toBe(n - 1);
    expect(P(g, 'b').zones.graveyard.length).toBe(1);
    expect(g.log.some((l) => /Bob discards .* at random/.test(l.text))).toBe(true);
    act(g, ctx, 'b', { t: 'requestUndo' });
    act(g, ctx, 'a', { t: 'answerUndo', accept: true });
    expect(P(g, 'b').zones.hand.length).toBe(n);
  });

  it('declined or withdrawn proposals change nothing', () => {
    const { g, ctx } = setup();
    const n = P(g, 'a').zones.hand.length;
    act(g, ctx, 'a', { t: 'propose', kind: 'discardRandom' });
    act(g, ctx, 'a', { t: 'cancelProposal' });
    expect(g.proposal).toBeNull();
    act(g, ctx, 'a', { t: 'propose', kind: 'discardRandom' });
    act(g, ctx, 'b', { t: 'answerProposal', accept: false });
    expect(P(g, 'a').zones.hand.length).toBe(n);
    expect(g.log.some((l) => /Bob declines: Alice discards a card at random/.test(l.text))).toBe(true);
  });

  it('shuffle a card from hand into the library: fix mode only', () => {
    const { g, ctx } = setup();
    const iid = P(g, 'a').zones.hand[0];
    expect(applyAction(g, 'a', { t: 'propose', kind: 'shuffleIntoLibrary', iid }, ctx)).toMatch(/fix mode/);
    act(g, ctx, 'a', { t: 'requestFixMode' });
    act(g, ctx, 'b', { t: 'answerFixMode', accept: true });
    const lib = P(g, 'a').zones.library.length;
    act(g, ctx, 'a', { t: 'propose', kind: 'shuffleIntoLibrary', iid });
    expect(decideBotAction(viewFor(g, 'b'), 'b', newBotMemory())).toEqual({ t: 'answerProposal', accept: true });
    act(g, ctx, 'b', { t: 'answerProposal', accept: true });
    expect(P(g, 'a').zones.library.length).toBe(lib + 1); // shuffled (library cards are re-keyed)
    expect(P(g, 'a').zones.hand).not.toContain(iid);
    act(g, ctx, 'a', { t: 'requestUndo' });
    act(g, ctx, 'b', { t: 'answerUndo', accept: true });
    expect(P(g, 'a').zones.hand).toContain(iid);
  });
});
