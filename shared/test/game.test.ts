import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import { applyAction, computeCombat, createGame, type Ctx, type GameState, isHidden, moveCard, viewFor, effectivePT } from '../src/index.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[]) => [...extra, ...Array(40 - extra.length).fill('basic_mountain')];

function setup(seed = 1) {
  const ctx: Ctx = { rng: seeded(seed), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(['lightning_bolt', 'goblin_guide', 'thalia_guardian_of_thraben']), side: ['opt'] },
    { pid: 'b', name: 'Bob', deck: deck(['questing_beast', 'glorybringer']), side: [] },
  ], 'a', ctx);
  return { g, ctx };
}

function act(g: GameState, ctx: Ctx, pid: string, action: Parameters<typeof applyAction>[2]) {
  const err = applyAction(g, pid, action, ctx);
  if (err) throw new Error(err);
}

function keepBoth(g: GameState, ctx: Ctx) {
  act(g, ctx, 'a', { t: 'keep' });
  act(g, ctx, 'b', { t: 'keep' });
}

function totalCards(g: GameState) {
  return Object.values(g.cards).filter((c) => !c.token).length;
}

/** Put a specific card from library into hand (test helper). */
function tutor(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const p = g.players.find((x) => x.pid === pid)!;
  const iid = [...p.zones.library, ...p.zones.hand].find((i) => g.cards[i].cardId === cardId)!;
  if (g.cards[iid].zone !== 'hand') moveCard(g, ctx, iid, 'hand');
  return iid;
}

describe('game setup', () => {
  it('deals 7 and keeps card counts', () => {
    const { g } = setup();
    for (const p of g.players) { expect(p.zones.hand).toHaveLength(7); expect(p.zones.library).toHaveLength(33); }
    expect(totalCards(g)).toBe(81);
    expect(g.phase).toBe('mulligan');
  });

  it('london mulligan puts cards on the bottom', () => {
    const { g, ctx } = setup();
    act(g, ctx, 'a', { t: 'mulligan' });
    act(g, ctx, 'a', { t: 'keep' });
    expect(g.players[0].needsBottom).toBe(1);
    expect(applyAction(g, 'a', { t: 'bottom', iids: [] }, ctx)).toMatch(/exactly 1/);
    const iid = g.players[0].zones.hand[0];
    act(g, ctx, 'a', { t: 'bottom', iids: [iid] });
    expect(g.players[0].zones.library.at(-1)).toBe(iid);
    expect(g.players[0].zones.hand).toHaveLength(6);
    act(g, ctx, 'b', { t: 'keep' });
    expect(g.phase).toBe('playing');
    expect(g.turn).toBe(1);
    expect(g.step).toBe('main1');
    expect(g.priority).toBe('a');
    expect(g.players[0].zones.hand).toHaveLength(6); // no draw on the play
  });
});

describe('hidden information', () => {
  it('hides opponent hand and all libraries', () => {
    const { g, ctx } = setup();
    keepBoth(g, ctx);
    const v = viewFor(g, 'a');
    for (const iid of v.players[1].zones.hand) expect(isHidden(v.cards[iid])).toBe(true);
    for (const iid of v.players[0].zones.hand) expect(isHidden(v.cards[iid])).toBe(false);
    expect(v.players[0].zones.library).toEqual([]);
    expect(v.players[1].zones.library).toEqual([]);
    expect(v.players[0].libraryCount).toBe(33);
    expect(v.players[1].zones.sideboard).toEqual([]);
    expect(v.players[0].zones.sideboard).toHaveLength(1);
    expect(JSON.stringify(v)).not.toContain('questing_beast"'.slice(0, 0) + 'history');
    // spectator sees no hands
    const s = viewFor(g, null);
    for (const p of s.players) for (const iid of p.zones.hand) expect(isHidden(s.cards[iid])).toBe(true);
  });

  it('never leaks hidden card ids in the opponent view', () => {
    const { g, ctx } = setup();
    keepBoth(g, ctx);
    const v = viewFor(g, 'b');
    for (const iid of g.players[0].zones.hand) {
      expect(v.cards[iid]).not.toHaveProperty('cardId');
      expect(v.cards[iid]).not.toHaveProperty('token');
    }
  });

  it('re-keys library cards on shuffle and peeks privately', () => {
    const { g, ctx } = setup();
    keepBoth(g, ctx);
    const before = g.players[0].zones.library.slice();
    act(g, ctx, 'a', { t: 'shuffle' });
    const after = g.players[0].zones.library;
    expect(after.some((i) => before.includes(i))).toBe(false);
    act(g, ctx, 'a', { t: 'peek', mode: 'scry', n: 2 });
    const [x, y] = g.players[0].peek!.iids;
    expect(isHidden(viewFor(g, 'a').cards[x])).toBe(false);
    expect(viewFor(g, 'b').cards[x]).toBeUndefined();
    act(g, ctx, 'a', { t: 'resolvePeek', top: [y], bottom: [x], graveyard: [], hand: [], battlefield: [], exile: [], shuffle: false });
    expect(g.players[0].zones.library[0]).toBe(y);
    expect(g.players[0].zones.library.at(-1)).toBe(x);
    expect(g.players[0].zones.library).toHaveLength(33);
    expect(totalCards(g)).toBe(81);
  });
});

describe('stack & priority', () => {
  it('casts with mana, opponent gets priority, resolves on pass', () => {
    const { g, ctx } = setup();
    keepBoth(g, ctx);
    const mountain = g.players[0].zones.hand.find((i) => g.cards[i].cardId === 'basic_mountain')!;
    act(g, ctx, 'a', { t: 'playLand', iid: mountain });
    act(g, ctx, 'a', { t: 'tapForMana', iid: mountain, mana: 'R' });
    expect(g.players[0].manaPool.R).toBe(1);
    const bolt = tutor(g, ctx, 'a', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: bolt });
    expect(g.players[0].manaPool.R).toBe(0);
    expect(g.stack).toHaveLength(1);
    expect(g.priority).toBe('b');
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.stack).toHaveLength(0);
    expect(g.cards[bolt].zone).toBe('graveyard');
    expect(g.priority).toBe('a');
    expect(g.step).toBe('main1');
  });

  it('creature spells resolve onto the battlefield', () => {
    const { g, ctx } = setup();
    keepBoth(g, ctx);
    const gg = tutor(g, ctx, 'a', 'goblin_guide');
    act(g, ctx, 'a', { t: 'cast', iid: gg });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[gg].zone).toBe('battlefield');
    expect(g.cards[gg].controller).toBe('a');
  });

  it('flows through an empty combat to main 2, then to the next turn', () => {
    const { g, ctx } = setup();
    keepBoth(g, ctx);
    act(g, ctx, 'a', { t: 'pass' });
    expect(g.step).toBe('main2');
    expect(g.priority).toBe('a');
    act(g, ctx, 'a', { t: 'pass' });
    // Bob stops at Alice's end step by default.
    expect(g.step).toBe('end');
    expect(g.priority).toBe('b');
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.turn).toBe(2);
    expect(g.activePlayer).toBe('b');
    expect(g.step).toBe('main1');
    expect(g.players[1].zones.hand).toHaveLength(8);
  });

  it('untaps the active player at their untap step', () => {
    const { g, ctx } = setup();
    keepBoth(g, ctx);
    const m = g.players[0].zones.hand.find((i) => g.cards[i].cardId === 'basic_mountain')!;
    act(g, ctx, 'a', { t: 'playLand', iid: m });
    act(g, ctx, 'a', { t: 'tap', iid: m });
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(g.cards[m].tapped).toBe(true);
    act(g, ctx, 'b', { t: 'nextTurn' });
    expect(g.activePlayer).toBe('a');
    expect(g.cards[m].tapped).toBe(false);
  });

  it('undo requires opponent approval', () => {
    const { g, ctx } = setup();
    keepBoth(g, ctx);
    const m = g.players[0].zones.hand.find((i) => g.cards[i].cardId === 'basic_mountain')!;
    act(g, ctx, 'a', { t: 'playLand', iid: m });
    act(g, ctx, 'a', { t: 'requestUndo' });
    expect(g.cards[m].zone).toBe('battlefield');
    act(g, ctx, 'b', { t: 'answerUndo', accept: true });
    expect(g.cards[m].zone).toBe('hand');
  });
});

describe('combat', () => {
  function board() {
    const { g, ctx } = setup();
    keepBoth(g, ctx);
    const put = (pid: string, id: string) => { const iid = tutor(g, ctx, pid, id); moveCard(g, ctx, iid, 'battlefield', { controller: pid }); g.cards[iid].summoningSick = false; return iid; };
    return { g, ctx, put };
  }

  it('full attack/block/damage flow with deathtouch and first strike', () => {
    const { g, ctx, put } = board();
    const thalia = put('a', 'thalia_guardian_of_thraben'); // 2/1 first strike
    const gg = put('a', 'goblin_guide'); // 2/2 haste
    const beast = put('b', 'questing_beast'); // 4/4 vigilance deathtouch haste
    act(g, ctx, 'a', { t: 'setAutoTriggers', on: false }); // this test is about combat itself (Goblin Guide's attack trigger is tested in triggers.test.ts)
    act(g, ctx, 'a', { t: 'pass' }); // to attackers
    expect(g.step).toBe('attackers');
    act(g, ctx, 'a', { t: 'declareAttacker', iid: thalia, target: 'b' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: gg, target: 'b' });
    act(g, ctx, 'a', { t: 'pass' });
    expect(g.cards[thalia].tapped).toBe(true);
    expect(g.step).toBe('blockers');
    expect(g.priority).toBe('b');
    act(g, ctx, 'b', { t: 'declareBlocker', iid: beast, attacker: gg });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.step).toBe('damage');
    const prop = g.combat.proposal!;
    expect(prop.lifeChange.b).toBe(-2);
    expect(prop.dies).toEqual([gg]);
    act(g, ctx, 'a', { t: 'pass' });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.players[1].life).toBe(18);
    expect(g.cards[gg].zone).toBe('graveyard');
    expect(g.cards[beast].damage).toBe(2);
    expect(g.step).toBe('main2');
  });

  it('first strike kills a blocker before it deals damage', () => {
    const { g, ctx, put } = board();
    const thalia = put('a', 'thalia_guardian_of_thraben');
    const gg = put('b', 'glorybringer');
    g.cards[thalia].attacking = 'b';
    g.cards[gg].counters['-1/-1'] = 3; // 1/1
    g.cards[gg].blocking = thalia;
    const p = computeCombat(g, getCard);
    expect(p.dies).toEqual([gg]);
    expect(p.damage[thalia]).toBeUndefined();
  });

  it('trample and lifelink', () => {
    const { g, ctx, put } = board();
    const beast = put('b', 'questing_beast');
    const gg = put('a', 'goblin_guide');
    g.cards[beast].attacking = 'a';
    g.cards[beast].note = 'trample, lifelink';
    g.cards[gg].blocking = beast;
    const p = computeCombat(g, getCard);
    // deathtouch + trample: 1 to blocker is lethal, 3 tramples over
    expect(p.damage[gg]).toBe(1);
    expect(p.lifeChange.a).toBe(-3);
    expect(p.lifeChange.b).toBe(4);
  });

  it('counts counters in P/T', () => {
    const { g, put } = board();
    const gg = put('a', 'goblin_guide');
    g.cards[gg].counters['+1/+1'] = 2;
    expect(effectivePT(g.cards[gg], getCard)).toEqual([4, 4]);
  });
});
