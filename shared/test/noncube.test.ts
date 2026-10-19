/**
 * Cards outside the cube (Standard / recent sets) found by the playtester with a database pool
 * (scripts/playtest.ts --pool=standard|set:CODE). The cards and their Forge scripts are real (fixtures/noncube-cards.ts).
 */
import { describe, expect, it } from 'vitest';
import { getCard, registerCards } from '../src/cube.ts';
import { applyAction, createGame, type CardData, type Ctx, evalCount, type GameAction, type GameState, effectivePT, moveCard } from '../src/index.ts';
import { registerScripts } from '../src/engine/script.ts';
import { seeded } from './helpers.ts';
import { REAL } from './fixtures/noncube-cards.ts';

registerCards(Object.values(REAL).map((r) => ({ tokens: [], keywords: [], producedMana: [], colorIdentity: [], supertypes: [], subtypes: [], image: '', rank: 9999, ...r.card }) as unknown as CardData));
registerScripts(Object.fromEntries(Object.entries(REAL).map(([id, r]) => [id, r.script])) as never);

const deck = (extra: string[], fill = 'basic_forest') => [...extra, ...Array(40 - extra.length).fill(fill)];
function setup(a: string[], b: string[] = []) {
  const ctx: Ctx = { rng: seeded(9), lookup: getCard, now: 0 };
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
function find(g: GameState, pid: string, cardId: string): string {
  const p = g.players.find((x) => x.pid === pid)!;
  const iid = [...p.zones.hand, ...p.zones.library].find((i) => g.cards[i].cardId === cardId);
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}
function toHand(g: GameState, ctx: Ctx, cardId: string, pid = 'a'): string {
  const iid = find(g, pid, cardId);
  if (g.cards[iid].zone !== 'hand') moveCard(g, ctx, iid, 'hand');
  return iid;
}
function put(g: GameState, ctx: Ctx, cardId: string, pid = 'a'): string {
  const iid = find(g, pid, cardId);
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  g.events = []; g.triggerQueue = [];
  return iid;
}
/** Resolve the stack, answering questions with the option matching `pick` (else the first). */
function resolveAll(g: GameState, ctx: Ctx, pick?: (labels: string[]) => number) {
  for (let i = 0; i < 60 && (g.stack.length || g.pending.length); i++) {
    const q = g.pending[0];
    if (q?.options.length) act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options[Math.max(0, pick ? pick(q.options.map((o) => o.label)) : 0)].value });
    else if (q) throw new Error(`unanswerable: ${q.prompt}`);
    else act(g, ctx, g.priority, { t: 'pass' });
  }
}
const logText = (g: GameState) => g.log.map((l) => l.text).join('\n');
const MANUAL = /by hand|Not automated/;
const pool = (g: GameState, pid: string, mana: Record<string, number>) => Object.assign(g.players.find((p) => p.pid === pid)!.manaPool, mana);

describe('variables: ParentTargeted$CardPower, /Twice math, Pump NumAtt$ Double', () => {
  it('Bite Down: my creature deals damage equal to its power to the other target', () => {
    const { g, ctx } = setup(['bite_down', 'grizzly_bears'], ['savannah_lions']);
    const bear = put(g, ctx, 'grizzly_bears');
    const lion = put(g, ctx, 'savannah_lions', 'b');
    pool(g, 'a', { G: 2 });
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'bite_down'), targets: [[{ kind: 'card', iid: bear }], [{ kind: 'card', iid: lion }]] });
    resolveAll(g, ctx);
    expect(g.cards[lion].zone).toBe('graveyard');
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Polliwallop: twice its power', () => {
    const { g, ctx } = setup(['polliwallop', 'grizzly_bears'], ['serra_angel']);
    const bear = put(g, ctx, 'grizzly_bears');
    const angel = put(g, ctx, 'serra_angel', 'b');
    pool(g, 'a', { G: 4 });
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'polliwallop'), targets: [[{ kind: 'card', iid: bear }], [{ kind: 'card', iid: angel }]] });
    resolveAll(g, ctx);
    expect(g.cards[angel].zone).toBe('graveyard'); // 4 damage to a 4/4
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Bulk Up doubles power', () => {
    const { g, ctx } = setup(['bulk_up', 'grizzly_bears']);
    const bear = put(g, ctx, 'grizzly_bears');
    pool(g, 'a', { R: 2 });
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'bulk_up'), targets: [[{ kind: 'card', iid: bear }]] });
    resolveAll(g, ctx);
    expect(effectivePT(g.cards[bear], getCard, g)).toEqual([4, 2]);
    expect(logText(g)).not.toMatch(MANUAL);
  });
});

describe('Count$ aggregates: $Colors (Vivid), ThisTurnCast_...$CardTypes', () => {
  it('Luminollusk: gain life equal to the number of colors among permanents you control', () => {
    const { g, ctx } = setup(['luminollusk', 'savannah_lions']);
    put(g, ctx, 'savannah_lions');
    pool(g, 'a', { G: 4 });
    const life = g.players[0].life;
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'luminollusk') });
    resolveAll(g, ctx);
    expect(g.players[0].life).toBe(life + 2); // green + white
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it("April O'Neil counts card types among spells you've cast this turn", () => {
    const { g, ctx } = setup(['april_oneil_hacktivist', 'lightning_bolt', 'grizzly_bears', 'savannah_lions']);
    pool(g, 'a', { R: 1, G: 2, W: 1 });
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'lightning_bolt'), targets: [[{ kind: 'player', pid: 'b' }]] });
    resolveAll(g, ctx);
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'grizzly_bears') });
    resolveAll(g, ctx);
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'savannah_lions') });
    resolveAll(g, ctx);
    const env = { state: g, lookup: getCard, controller: 'a' };
    expect(evalCount('Count$ThisTurnCast_Card.YouCtrl$CardTypes', env)).toBe(2);
    expect(evalCount('Count$ThisTurnCast_Card.YouCtrl', env)).toBe(3);
    expect(evalCount('Count$ThisTurnCast_Card.YouCtrl$GreatestCardManaCost', env)).toBe(2);
    expect(evalCount('Count$Valid Creature.YouCtrl$CardPower', env)).toBe(4); // 2/2 + 2/1
    expect(evalCount('Count$Valid Creature.YouCtrl$Colors', env)).toBe(2);
  });
});
