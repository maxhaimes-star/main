/** The computer opponent's decisions (shared/src/ai/player.ts), on real games with cube cards. */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  applyAction, botActionFailed, botNeedsToAct, botStep, createGame, type Ctx, decideBotAction, type GameAction, type GameState,
  moveCard, newBotMemory, viewFor,
} from '../src/index.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[], fill = 'basic_mountain') => [...extra, ...Array(40 - extra.length).fill(fill)];

function setup(a: string[] = [], b: string[] = [], fillA = 'basic_mountain', fillB = 'basic_mountain', first = 'a', keep = true) {
  const ctx: Ctx = { rng: seeded(7), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(a, fillA), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(b, fillB), side: [] },
  ], first, ctx);
  if (keep) { act(g, ctx, 'a', { t: 'keep' }); act(g, ctx, 'b', { t: 'keep' }); }
  return { g, ctx };
}

function act(g: GameState, ctx: Ctx, pid: string, action: GameAction) {
  const err = applyAction(g, pid, action, ctx);
  if (err) throw new Error(`${action.t}: ${err}`);
}

function find(g: GameState, pid: string, cardId: string, skip: string[] = []): string {
  const p = g.players.find((x) => x.pid === pid)!;
  const iid = [...p.zones.hand, ...p.zones.library, ...p.zones.graveyard].find((i) => g.cards[i].cardId === cardId && !skip.includes(i));
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}

function put(g: GameState, ctx: Ctx, pid: string, cardId: string, sick = false): string {
  const iid = find(g, pid, cardId, g.battlefield.slice());
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = sick;
  return iid;
}

/** Make `pid`'s hand exactly these cards (from the library). */
function setHand(g: GameState, ctx: Ctx, pid: string, ids: string[]) {
  const p = g.players.find((x) => x.pid === pid)!;
  for (const iid of [...p.zones.hand]) moveCard(g, ctx, iid, 'library');
  const used: string[] = [];
  for (const id of ids) {
    const iid = p.zones.library.find((i) => g.cards[i].cardId === id && !used.includes(i))!;
    used.push(iid);
    moveCard(g, ctx, iid, 'hand');
  }
}

const decide = (g: GameState, pid: string, mem = newBotMemory(1)) => decideBotAction(viewFor(g, pid), pid, mem);

/** Pass priority (both players) until `pid` has priority in `step` of `turn`. */
function passTo(g: GameState, ctx: Ctx, step: string, pid: string) {
  for (let i = 0; i < 60; i++) {
    if (g.step === step && g.priority === pid && !g.pending.length) return;
    act(g, ctx, g.priority, { t: 'pass' });
  }
  throw new Error(`never reached ${step} for ${pid} (at ${g.step})`);
}

describe('bot player: mulligans', () => {
  it('keeps a hand with lands and spells, mulligans one without lands', () => {
    const good = setup(['embereth_shieldbreaker', 'embereth_shieldbreaker', 'embereth_shieldbreaker', 'embereth_shieldbreaker'], [], 'basic_mountain', 'basic_mountain', 'a', false);
    setHand(good.g, good.ctx, 'a', ['basic_mountain', 'basic_mountain', 'basic_mountain', 'embereth_shieldbreaker', 'embereth_shieldbreaker', 'embereth_shieldbreaker', 'embereth_shieldbreaker']);
    expect(decide(good.g, 'a')).toEqual({ t: 'keep' });
    const bad = setup(Array(33).fill('embereth_shieldbreaker'), [], 'basic_mountain', 'basic_mountain', 'a', false);
    setHand(bad.g, bad.ctx, 'a', Array(7).fill('embereth_shieldbreaker'));
    expect(decide(bad.g, 'a')).toEqual({ t: 'mulligan' });
    // After a mulligan it bottoms one card and keeps lands.
    act(bad.g, bad.ctx, 'a', { t: 'mulligan' });
    setHand(bad.g, bad.ctx, 'a', ['basic_mountain', 'basic_mountain', 'basic_mountain', 'basic_mountain', 'embereth_shieldbreaker', 'embereth_shieldbreaker', 'embereth_shieldbreaker']);
    act(bad.g, bad.ctx, 'a', { t: 'keep' });
    const b = decide(bad.g, 'a');
    expect(b?.t).toBe('bottom');
    expect((b as { iids: string[] }).iids).toHaveLength(1);
    act(bad.g, bad.ctx, 'a', b!);
  });
});

describe('bot player: main phase', () => {
  it('plays a land, then casts the best spell it can pay for', () => {
    const { g, ctx } = setup(['rotting_regisaur', 'embereth_shieldbreaker'], [], 'basic_swamp');
    for (let i = 0; i < 2; i++) put(g, ctx, 'a', 'basic_swamp');
    setHand(g, ctx, 'a', ['basic_swamp', 'rotting_regisaur', 'embereth_shieldbreaker']);
    expect(g.step).toBe('main1');
    const land = decide(g, 'a');
    expect(land).toMatchObject({ t: 'playLand' });
    act(g, ctx, 'a', land!);
    const cast = decide(g, 'a');
    expect(cast).toMatchObject({ t: 'cast', iid: find(g, 'a', 'rotting_regisaur') });
    act(g, ctx, 'a', cast!);
  });

  it('points removal at the biggest threat and burn at what it kills', () => {
    const { g, ctx } = setup(['swords_to_plowshares', 'lightning_bolt'], ['llanowar_elves', 'embereth_shieldbreaker', 'griselbrand'], 'basic_plains', 'basic_swamp');
    put(g, ctx, 'a', 'basic_plains');
    const elves = put(g, ctx, 'b', 'llanowar_elves');
    const shield = put(g, ctx, 'b', 'embereth_shieldbreaker');
    const gris = put(g, ctx, 'b', 'griselbrand');
    setHand(g, ctx, 'a', ['swords_to_plowshares']);
    expect(decide(g, 'a')).toMatchObject({ t: 'cast', targets: [[{ kind: 'card', iid: gris }]] });
    // Lightning Bolt can't kill Griselbrand: it takes the best creature it kills.
    const bolt = setup(['lightning_bolt'], ['llanowar_elves', 'embereth_shieldbreaker', 'griselbrand'], 'basic_mountain', 'basic_swamp');
    put(bolt.g, bolt.ctx, 'a', 'basic_mountain');
    put(bolt.g, bolt.ctx, 'b', 'llanowar_elves');
    const s2 = put(bolt.g, bolt.ctx, 'b', 'embereth_shieldbreaker');
    put(bolt.g, bolt.ctx, 'b', 'griselbrand');
    setHand(bolt.g, bolt.ctx, 'a', ['lightning_bolt']);
    expect(decide(bolt.g, 'a')).toMatchObject({ t: 'cast', targets: [[{ kind: 'card', iid: s2 }]] });
    // ... and at the face when that's lethal.
    bolt.g.players[1].life = 3;
    expect(decide(bolt.g, 'a')).toMatchObject({ t: 'cast', targets: [[{ kind: 'player', pid: 'b' }]] });
    void elves; void shield;
  });

  it("doesn't burn its own creatures or cast removal without a target", () => {
    const { g, ctx } = setup(['swords_to_plowshares', 'embereth_shieldbreaker'], [], 'basic_plains');
    put(g, ctx, 'a', 'basic_plains');
    put(g, ctx, 'a', 'embereth_shieldbreaker');
    setHand(g, ctx, 'a', ['swords_to_plowshares']);
    expect(decide(g, 'a')).toEqual({ t: 'pass' });
  });

  it('never retries a refused action at the same state', () => {
    const { g, ctx } = setup(['embereth_shieldbreaker'], []);
    put(g, ctx, 'a', 'basic_mountain');
    put(g, ctx, 'a', 'basic_mountain');
    setHand(g, ctx, 'a', ['embereth_shieldbreaker']);
    const mem = newBotMemory(1);
    const first = decide(g, 'a', mem)!;
    expect(first.t).toBe('cast');
    botActionFailed(mem, first, g.seq);
    expect(decide(g, 'a', mem)).toEqual({ t: 'pass' });
  });
});

describe('bot player: combat', () => {
  it('attacks an empty board, not into a bigger blocker', () => {
    const { g, ctx } = setup(['rotting_regisaur'], ['griselbrand'], 'basic_swamp', 'basic_swamp');
    const rex = put(g, ctx, 'a', 'rotting_regisaur');
    setHand(g, ctx, 'a', []);
    passTo(g, ctx, 'attackers', 'a');
    expect(decide(g, 'a')).toEqual({ t: 'declareAttacker', iid: rex, target: 'b' });

    const two = setup(['embereth_shieldbreaker'], ['griselbrand'], 'basic_mountain', 'basic_swamp');
    put(two.g, two.ctx, 'a', 'embereth_shieldbreaker');
    put(two.g, two.ctx, 'b', 'griselbrand');
    setHand(two.g, two.ctx, 'a', []);
    passTo(two.g, two.ctx, 'attackers', 'a');
    expect(decide(two.g, 'a')).toEqual({ t: 'pass' });
  });

  it('chump-blocks only when the damage would be lethal, and takes free kills', () => {
    const run = (life: number) => {
      const { g, ctx } = setup(['sylvan_caryatid'], ['rotting_regisaur'], 'basic_forest', 'basic_swamp', 'b');
      const wall = put(g, ctx, 'a', 'sylvan_caryatid');
      const rex = put(g, ctx, 'b', 'rotting_regisaur');
      g.players[0].life = life;
      setHand(g, ctx, 'b', []);
      passTo(g, ctx, 'attackers', 'b');
      act(g, ctx, 'b', { t: 'declareAttacker', iid: rex, target: 'a' });
      act(g, ctx, 'b', { t: 'pass' });
      passTo(g, ctx, 'blockers', 'a');
      return { a: decide(g, 'a'), wall, rex };
    };
    expect(run(20).a).toEqual({ t: 'pass' });
    const low = run(5);
    expect(low.a).toEqual({ t: 'declareBlocker', iid: low.wall, attacker: low.rex });

    const { g, ctx } = setup(['thalia_guardian_of_thraben'], ['llanowar_elves'], 'basic_plains', 'basic_forest', 'b');
    const thalia = put(g, ctx, 'a', 'thalia_guardian_of_thraben');
    const elves = put(g, ctx, 'b', 'llanowar_elves');
    setHand(g, ctx, 'b', []);
    passTo(g, ctx, 'attackers', 'b');
    act(g, ctx, 'b', { t: 'declareAttacker', iid: elves, target: 'a' });
    act(g, ctx, 'b', { t: 'pass' });
    passTo(g, ctx, 'blockers', 'a');
    expect(decide(g, 'a')).toEqual({ t: 'declareBlocker', iid: thalia, attacker: elves });
  });
});

describe('bot player: questions and hidden information', () => {
  it('discards down to hand size with its least useful card', () => {
    const { g, ctx } = setup(['griselbrand'], [], 'basic_mountain');
    for (let i = 0; i < 5; i++) put(g, ctx, 'a', 'basic_mountain');
    setHand(g, ctx, 'a', ['griselbrand', 'basic_mountain', 'basic_mountain', 'basic_mountain', 'basic_mountain', 'basic_mountain', 'basic_mountain', 'basic_mountain', 'basic_mountain']);
    const mem = newBotMemory(1);
    for (let i = 0; i < 40 && !g.pending.length; i++) {
      if (g.priority === 'a') {
        const a = decideBotAction(viewFor(g, 'a'), 'a', mem)!;
        const err = applyAction(g, 'a', a, ctx);
        if (err) botActionFailed(mem, a, g.seq);
      } else act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(g.pending[0]?.pid).toBe('a');
    const q = decide(g, 'a')!;
    expect(q.t).toBe('choose');
    expect(g.cards[(q as { value: string }).value].cardId).toBe('basic_mountain');
    act(g, ctx, 'a', q);
  });

  it("decides the same whatever is in the opponent's hand (it only sees its view)", () => {
    const one = setup(['embereth_shieldbreaker'], ['lightning_bolt', 'griselbrand'], 'basic_mountain', 'basic_mountain');
    put(one.g, one.ctx, 'a', 'basic_mountain');
    put(one.g, one.ctx, 'a', 'basic_mountain');
    setHand(one.g, one.ctx, 'a', ['embereth_shieldbreaker']);
    const view1 = viewFor(one.g, 'a');
    setHand(one.g, one.ctx, 'b', ['lightning_bolt', 'griselbrand']);
    const view2 = viewFor(one.g, 'a');
    const bHand = view2.players[1].zones.hand;
    expect(bHand.every((iid) => 'hidden' in view2.cards[iid])).toBe(true);
    expect(decideBotAction(view1, 'a', newBotMemory(3))).toEqual(decideBotAction(view2, 'a', newBotMemory(3)));
  });

  it('answers undo requests and wins a game against a player who never does anything', () => {
    // The bot plays a real deck; the other seat only keeps and passes.
    const ctx2: Ctx = { rng: seeded(3), lookup: getCard, now: 0 };
    const real = createGame('r', [
      { pid: 'a', name: 'Bot', deck: [...Array(20).fill('embereth_shieldbreaker'), ...Array(20).fill('basic_mountain')], side: [] },
      { pid: 'b', name: 'Idle', deck: Array(40).fill('basic_mountain'), side: [] },
    ], 'a', ctx2);
    const mem = newBotMemory(5);
    let undoAsked = false;
    for (let i = 0; i < 3000 && real.phase !== 'over'; i++) {
      if (botNeedsToAct(real, 'a')) {
        const r = botStep(() => viewFor(real, 'a'), 'a', mem, (a) => applyAction(real, 'a', a, ctx2));
        expect(r.stuck).toBe(false);
        continue;
      }
      if (real.phase === 'mulligan') { act(real, ctx2, 'b', { t: 'keep' }); continue; }
      if (!undoAsked && real.turn === 3 && real.history.length) {
        undoAsked = true;
        act(real, ctx2, 'b', { t: 'requestUndo' });
        expect(botNeedsToAct(real, 'a')).toBe(true);
        continue;
      }
      const q = real.pending.find((x) => x.pid === 'b');
      if (q) { act(real, ctx2, 'b', { t: 'choose', id: q.id, value: q.options[0].value }); continue; }
      if (real.priority === 'b') act(real, ctx2, 'b', { t: 'pass' });
    }
    expect(undoAsked).toBe(true);
    expect(real.winner).toBe('a');
  });
});
