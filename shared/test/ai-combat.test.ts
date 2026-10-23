/** Better bot play: combat math (first strike, deathtouch, double blocks), holding up removal and counterspells. */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import { applyAction, createGame, type Ctx, decideBotAction, type GameAction, type GameState, moveCard, newBotMemory, viewFor } from '../src/index.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[], fill = 'basic_mountain') => [...extra, ...Array(40 - extra.length).fill(fill)];

function setup(a: string[] = [], b: string[] = [], fillA = 'basic_mountain', fillB = 'basic_mountain', first = 'a') {
  const ctx: Ctx = { rng: seeded(7), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(a, fillA), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(b, fillB), side: [] },
  ], first, ctx);
  act(g, ctx, 'a', { t: 'keep' }); act(g, ctx, 'b', { t: 'keep' });
  return { g, ctx };
}

function act(g: GameState, ctx: Ctx, pid: string, action: GameAction) {
  const err = applyAction(g, pid, action, ctx);
  if (err) throw new Error(`${action.t}: ${err}`);
}

function put(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const p = g.players.find((x) => x.pid === pid)!;
  const iid = [...p.zones.hand, ...p.zones.library].find((i) => g.cards[i].cardId === cardId && !g.battlefield.includes(i));
  if (!iid) throw new Error(`no ${cardId}`);
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  return iid;
}

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

function passTo(g: GameState, ctx: Ctx, step: string, pid: string) {
  for (let i = 0; i < 60; i++) {
    if (g.step === step && g.priority === pid && !g.pending.length) return;
    act(g, ctx, g.priority, { t: 'pass' });
  }
  throw new Error(`never reached ${step} for ${pid} (at ${g.step})`);
}

/** Bob attacks Alice with `attacker`; Alice decides her blocks. */
function blockDecision(aliceBoard: string[], bobAttacker: string, fillA = 'basic_mountain', fillB = 'basic_plains') {
  const { g, ctx } = setup(aliceBoard, [bobAttacker], fillA, fillB, 'b');
  const mine = aliceBoard.map((id) => put(g, ctx, 'a', id));
  const atk = put(g, ctx, 'b', bobAttacker);
  setHand(g, ctx, 'b', []);
  setHand(g, ctx, 'a', []);
  passTo(g, ctx, 'attackers', 'b');
  act(g, ctx, 'b', { t: 'declareAttacker', iid: atk, target: 'a' });
  act(g, ctx, 'b', { t: 'pass' });
  passTo(g, ctx, 'blockers', 'a');
  const mem = newBotMemory(1);
  return { mine, atk, decision: decide(g, 'a', mem), mem };
}

describe('bot player: combat math', () => {
  it("doesn't throw a blocker in front of a first striker that kills it before it strikes", () => {
    // Thalia (2/1 first strike) attacks; a 2/1 blocker would die without dealing damage.
    expect(blockDecision(['embereth_shieldbreaker'], 'thalia_guardian_of_thraben').decision).toEqual({ t: 'pass' });
  });

  it('attacks with a first striker into blockers that would die before striking back', () => {
    const { g, ctx } = setup(['thalia_guardian_of_thraben'], ['embereth_shieldbreaker'], 'basic_plains', 'basic_mountain');
    const thalia = put(g, ctx, 'a', 'thalia_guardian_of_thraben');
    put(g, ctx, 'b', 'embereth_shieldbreaker');
    setHand(g, ctx, 'a', []);
    passTo(g, ctx, 'attackers', 'a');
    expect(decide(g, 'a')).toEqual({ t: 'declareAttacker', iid: thalia, target: 'b' });
  });

  it("doesn't attack into a deathtouch blocker", () => {
    const { g, ctx } = setup(['dryad_of_the_ilysian_grove'], ['baleful_strix'], 'basic_forest', 'basic_island');
    put(g, ctx, 'a', 'dryad_of_the_ilysian_grove');
    put(g, ctx, 'b', 'baleful_strix');
    setHand(g, ctx, 'a', []);
    passTo(g, ctx, 'attackers', 'a');
    expect(decide(g, 'a')).toEqual({ t: 'pass' });
  });

  it('double-blocks an attacker that two small creatures kill together (it can only take one of them)', () => {
    // Dryad (2/4) attacks into two 2/1s: one alone can't kill it, the pair can.
    const r = blockDecision(['embereth_shieldbreaker', 'embereth_shieldbreaker'], 'dryad_of_the_ilysian_grove', 'basic_mountain', 'basic_forest');
    expect(r.mem.blockPlan!.blocks.map((b) => b.attacker)).toEqual([r.atk, r.atk]);
    expect(r.mem.blockPlan!.blocks.map((b) => b.iid).sort()).toEqual(r.mine.slice().sort());
  });
});

describe('bot player: holding up responses', () => {
  it('holds instant removal for a small creature in its own main phase', () => {
    const { g, ctx } = setup(['lightning_bolt'], ['embereth_shieldbreaker'], 'basic_mountain', 'basic_mountain');
    put(g, ctx, 'b', 'embereth_shieldbreaker');
    put(g, ctx, 'a', 'basic_mountain');
    setHand(g, ctx, 'a', ['lightning_bolt']);
    passTo(g, ctx, 'main1', 'a');
    const dd = decide(g, 'a');
    expect(dd?.t).not.toBe('cast');
  });

  it('kills a real threat right away', () => {
    const { g, ctx } = setup(['infernal_grasp'], ['grave_titan'], 'basic_swamp', 'basic_swamp');
    const titan = put(g, ctx, 'b', 'grave_titan');
    put(g, ctx, 'a', 'basic_swamp');
    put(g, ctx, 'a', 'basic_swamp');
    setHand(g, ctx, 'a', ['infernal_grasp']);
    passTo(g, ctx, 'main1', 'a');
    const d = decide(g, 'a') as { t: string; targets?: unknown };
    expect(d.t).toBe('cast');
    expect(JSON.stringify(d.targets)).toContain(titan);
  });

  it("uses held removal on an attacker during the opponent's combat", () => {
    const { g, ctx } = setup(['lightning_bolt', 'sylvan_caryatid'], ['embereth_shieldbreaker'], 'basic_mountain', 'basic_mountain', 'b');
    const atk = put(g, ctx, 'b', 'embereth_shieldbreaker');
    put(g, ctx, 'a', 'sylvan_caryatid'); // a potential blocker, so Alice gets the declare-blockers step
    put(g, ctx, 'a', 'basic_mountain');
    setHand(g, ctx, 'a', ['lightning_bolt']);
    setHand(g, ctx, 'b', []);
    passTo(g, ctx, 'attackers', 'b');
    act(g, ctx, 'b', { t: 'declareAttacker', iid: atk, target: 'a' });
    act(g, ctx, 'b', { t: 'pass' });
    passTo(g, ctx, 'blockers', 'a');
    expect(g.priority).toBe('a');
    const d = decide(g, 'a') as { t: string; targets?: unknown };
    expect(d.t).toBe('cast');
    expect(JSON.stringify(d.targets)).toContain(atk);
  });
});
