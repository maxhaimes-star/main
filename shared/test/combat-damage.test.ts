/** Combat damage assignment (game/combat.ts): lethal damage, trample and damage-doubling replacement effects. */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import { applyAction, computeCombat, createGame, type Ctx, type GameAction, type GameState, moveCard } from '../src/index.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[]) => [...extra, ...Array(40 - extra.length).fill('basic_mountain')];

function setup(a: string[], b: string[]) {
  const ctx: Ctx = { rng: seeded(3), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(a), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(b), side: [] },
  ], 'a', ctx);
  act(g, ctx, 'a', { t: 'keep' });
  act(g, ctx, 'b', { t: 'keep' });
  return { g, ctx };
}
function act(g: GameState, ctx: Ctx, pid: string, action: GameAction) {
  const err = applyAction(g, pid, action, ctx);
  if (err) throw new Error(err);
}
function put(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const p = g.players.find((x) => x.pid === pid)!;
  const iid = [...p.zones.hand, ...p.zones.library].find((i) => g.cards[i].cardId === cardId)!;
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  g.events = []; g.triggerQueue = [];
  return iid;
}
function passUntil(g: GameState, ctx: Ctx, done: () => boolean) {
  for (let i = 0; i < 80 && !done(); i++) {
    const q = g.pending[0];
    if (q?.options.length) act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options[0].value });
    else act(g, ctx, g.priority, { t: 'pass' });
  }
  expect(done()).toBe(true);
}

/** Alice's Lightning, Army of One hits Bob: damage to Bob and his permanents is doubled (a DamageDone replacement). */
function staggered(a: string[], b: string[]) {
  const { g, ctx } = setup(['lightning_army_of_one', ...a], b);
  const light = put(g, ctx, 'a', 'lightning_army_of_one');
  act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
  act(g, ctx, 'a', { t: 'declareAttacker', iid: light, target: 'b' });
  act(g, ctx, 'a', { t: 'confirmAttackers' });
  passUntil(g, ctx, () => g.step === 'main2');
  expect(g.effects?.some((e) => e.kind === 'effect' && e.name === 'Lightning, Army of One')).toBe(true);
  for (const id of g.battlefield) g.cards[id].tapped = false;
  return { g, ctx };
}

describe('combat damage assignment', () => {
  it('blockers and attackers deal damage simultaneously (both die)', () => {
    const { g, ctx } = setup(['goblin_guide'], ['scythecat_cub']);
    const gg = put(g, ctx, 'a', 'goblin_guide');
    const cub = put(g, ctx, 'b', 'scythecat_cub');
    g.cards[gg].attacking = 'b';
    g.cards[cub].blocking = gg;
    const p = computeCombat(g, getCard);
    expect(p.dies.sort()).toEqual([gg, cub].sort());
  });

  it('trample: lethal damage is assigned ignoring a damage doubler; the doubled amounts are dealt', () => {
    // Rule 510.1c-d / 702.19b: lethal damage ignores abilities and effects that change the damage actually dealt.
    const { g, ctx } = staggered(['primeval_titan'], ['goblin_guide']);
    const titan = put(g, ctx, 'a', 'primeval_titan'); // 6/6 trample
    const gg = put(g, ctx, 'b', 'goblin_guide'); // 2/2
    g.cards[titan].attacking = 'b';
    g.cards[gg].blocking = titan;
    const p = computeCombat(g, getCard);
    expect(p.damage[gg]).toBe(4); // 2 assigned (lethal), doubled
    expect(p.lifeChange.b).toBe(-8); // 4 assigned to Bob, doubled
    expect(p.dies).toEqual([gg]);
  });

  it('trample: damage already marked counts toward lethal', () => {
    const { g, ctx } = setup(['primeval_titan'], ['scythecat_cub']);
    const titan = put(g, ctx, 'a', 'primeval_titan');
    const cub = put(g, ctx, 'b', 'scythecat_cub');
    g.cards[cub].damage = 1;
    g.cards[titan].attacking = 'b';
    g.cards[cub].blocking = titan;
    const p = computeCombat(g, getCard);
    expect(p.damage[cub]).toBe(1);
    expect(p.lifeChange.b).toBe(-5);
  });

  it('double strike + trample with a doubler: first-strike damage actually dealt (doubled) is marked damage for the second strike', () => {
    const { g, ctx } = staggered(['primeval_titan'], ['woodfall_primus']);
    const titan = put(g, ctx, 'a', 'primeval_titan'); // 6/6 trample
    g.cards[titan].note = 'double strike';
    const wp = put(g, ctx, 'b', 'woodfall_primus'); // 6/6
    g.cards[titan].attacking = 'b';
    g.cards[wp].blocking = titan;
    const p = computeCombat(g, getCard);
    // first strike: 6 assigned to the 6/6 (lethal), dealt 12 — it's destroyed before regular damage, so the
    // second strike's 6 all tramples over to Bob (doubled to 12)
    expect(p.damage[wp]).toBe(12);
    expect(p.lifeChange.b).toBe(-12);
  });
});
