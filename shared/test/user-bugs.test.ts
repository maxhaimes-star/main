/** User-reported bugs (strict mode, real cube scripts). */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  activatedAbilitiesOf, applyAction, createGame, type Ctx, type GameAction, type GameState, manaOptionsFor, moveCard, viewFor,
} from '../src/index.ts';
import { createTokenInstance } from '../src/engine/resolve.ts';
import { SCRIPTS } from '../src/engine/script.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[], fill = 'basic_mountain') => [...extra, ...Array(40 - extra.length).fill(fill)];

function setup(a: string[] = [], b: string[] = [], fillA = 'basic_mountain', fillB = 'basic_mountain') {
  const ctx: Ctx = { rng: seeded(7), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(a, fillA), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(b, fillB), side: [] },
  ], 'a', ctx);
  act(g, ctx, 'a', { t: 'keep' });
  act(g, ctx, 'b', { t: 'keep' });
  return { g, ctx };
}

function act(g: GameState, ctx: Ctx, pid: string, action: GameAction) {
  const err = applyAction(g, pid, action, ctx);
  if (err) throw new Error(err);
}

function find(g: GameState, pid: string, cardId: string, skip: string[] = []): string {
  const p = g.players.find((x) => x.pid === pid)!;
  const all = [...p.zones.hand, ...p.zones.library, ...p.zones.graveyard, ...p.zones.exile];
  const iid = all.find((i) => g.cards[i].cardId === cardId && !skip.includes(i));
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}

function toZone(g: GameState, ctx: Ctx, pid: string, cardId: string, zone: 'hand' | 'graveyard' | 'exile', skip: string[] = []): string {
  const iid = find(g, pid, cardId, skip);
  if (g.cards[iid].zone !== zone) moveCard(g, ctx, iid, zone);
  return iid;
}

function put(g: GameState, ctx: Ctx, pid: string, cardId: string, sick = false): string {
  const iid = find(g, pid, cardId, g.battlefield.slice());
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = sick;
  return iid;
}

/** Answer pending questions for `pid` with the first option (or `pick`). */
function answer(g: GameState, ctx: Ctx, pick?: (q: GameState['pending'][number]) => string) {
  for (let i = 0; i < 10 && g.pending.length; i++) {
    const q = g.pending[0];
    act(g, ctx, q.pid, { t: 'choose', id: q.id, value: pick ? pick(q) : q.options[0].value });
  }
}

function drain(g: GameState, ctx: Ctx, pick?: (q: GameState['pending'][number]) => string) {
  for (let i = 0; i < 30 && (g.stack.length || g.pending.length); i++) {
    if (g.pending.length) { answer(g, ctx, pick); continue; }
    act(g, ctx, g.priority, { t: 'pass' });
  }
}

function treasure(g: GameState, ctx: Ctx, pid: string): string {
  return createTokenInstance(g, ctx, pid, SCRIPTS.tokens.c_a_treasure_sac, false).iid;
}

const card = (iid: string) => [[{ kind: 'card' as const, iid }]];

describe('1: sacrifice-for-mana abilities in strict mode', () => {
  it('a Treasure token has a mana ability and can be sacrificed for mana without fix mode', () => {
    const { g, ctx } = setup();
    const t = treasure(g, ctx, 'a');
    const opts = manaOptionsFor(g, t, getCard);
    expect(opts.length).toBe(5);
    act(g, ctx, 'a', { t: 'activateMana', iid: t, option: opts.find((o) => o.produces === 'U')!.id });
    expect(g.players[0].manaPool.U).toBe(1);
    expect(g.cards[t]?.zone ?? 'gone').not.toBe('battlefield');
  });

  it('auto-pay sacrifices a Treasure when needed', () => {
    const { g, ctx } = setup(['brainstorm']);
    treasure(g, ctx, 'a');
    const bs = toZone(g, ctx, 'a', 'brainstorm', 'hand');
    act(g, ctx, 'a', { t: 'cast', iid: bs });
    expect(g.stack.length).toBe(1);
    expect(g.battlefield.filter((i) => g.cards[i].token?.name === 'Treasure')).toHaveLength(0);
  });

  it('a Clue token can be activated (token abilities)', () => {
    const { g, ctx } = setup();
    const clue = createTokenInstance(g, ctx, 'a', SCRIPTS.tokens.c_a_clue_draw, false).iid;
    for (const iid of g.players[0].zones.hand.slice(0, 2)) act(g, ctx, 'a', { t: 'playLand', iid }), (g.players[0].landsPlayed = 0);
    const hand = g.players[0].zones.hand.length;
    act(g, ctx, 'a', { t: 'activate', iid: clue, text: '', ability: 0 });
    drain(g, ctx);
    expect(g.cards[clue]).toBeUndefined();
    expect(g.players[0].zones.hand.length).toBe(hand + 1);
  });

  it('Lotus Petal: sacrifice for mana in strict mode', () => {
    const { g, ctx } = setup(['lotus_petal']);
    const lp = put(g, ctx, 'a', 'lotus_petal');
    const o = manaOptionsFor(g, lp, getCard).find((x) => x.produces === 'G')!;
    act(g, ctx, 'a', { t: 'activateMana', iid: lp, option: o.id });
    expect(g.players[0].manaPool.G).toBe(1);
    expect(g.cards[lp].zone).toBe('graveyard');
  });
});

describe('2: Deathrite Shaman', () => {
  it('exiles a land card from a graveyard and adds one mana of any color', () => {
    const { g, ctx } = setup(['deathrite_shaman']);
    const drs = put(g, ctx, 'a', 'deathrite_shaman');
    const land = toZone(g, ctx, 'b', 'basic_mountain', 'graveyard');
    act(g, ctx, 'a', { t: 'activate', iid: drs, text: '', ability: 0, targets: card(land) });
    drain(g, ctx, (q) => (q.options.some((o) => o.value === 'B') ? 'B' : q.options[0].value));
    expect(g.cards[land].zone).toBe('exile');
    expect(g.players[0].manaPool.B).toBe(1);
    expect(g.cards[drs].tapped).toBe(true);
  });

  it('exiles an instant: opponent loses 2; exiles a creature: gain 2', () => {
    const { g, ctx } = setup(['deathrite_shaman', 'lightning_bolt', 'basic_swamp', 'basic_forest'], ['giver_of_runes']);
    const drs = put(g, ctx, 'a', 'deathrite_shaman');
    put(g, ctx, 'a', 'basic_swamp');
    put(g, ctx, 'a', 'basic_forest');
    const bolt = toZone(g, ctx, 'a', 'lightning_bolt', 'graveyard');
    act(g, ctx, 'a', { t: 'activate', iid: drs, text: '', ability: 1, targets: card(bolt) });
    drain(g, ctx);
    expect(g.cards[bolt].zone).toBe('exile');
    expect(g.players[1].life).toBe(18);
    g.cards[drs].tapped = false;
    const bears = toZone(g, ctx, 'b', 'giver_of_runes', 'graveyard');
    act(g, ctx, 'a', { t: 'activate', iid: drs, text: '', ability: 2, targets: card(bears) });
    drain(g, ctx);
    expect(g.cards[bears].zone).toBe('exile');
    expect(g.players[0].life).toBe(22);
    expect(activatedAbilitiesOf('deathrite_shaman', 0).map((e) => e.index)).toEqual([0, 1, 2]);
  });
});
