/**
 * "Power up" cards in strict (rules-enforced) games, with the real database cards and scripts (fixtures/power.ts,
 * fixtures/mana-rocks.ts): the Moxen tap for their color, Black Lotus sacrifices for three mana of one color, Ancestral
 * Recall draws 3, Time Walk gives an extra turn, Timetwister shuffles hands and graveyards away and draws 7, Sol Ring /
 * Mana Vault / Mana Crypt make colorless mana. Plus the cube list option (powerup.ts / cubeList).
 */
import { describe, expect, it } from 'vitest';
import { CUBE, getCard, registerCards } from '../src/cube.ts';
import {
  applyAction, castability, createGame, cubeList, type CardData, type Ctx, type GameAction, type GameState, manaOptionsFor, moveCard,
  planAutoPay, POWER_CARDS, type RoomState, withPower,
} from '../src/index.ts';
import { registerScripts } from '../src/engine/script.ts';
import { seeded } from './helpers.ts';
import { POWER } from './fixtures/power.ts';
import { ROCKS } from './fixtures/mana-rocks.ts';

const FIX = { ...POWER, ...ROCKS };
registerCards(Object.values(FIX).map((r) => ({ tokens: [], keywords: [], producedMana: [], colorIdentity: [], supertypes: [], subtypes: [], image: '', rank: 9999, ...r.card }) as unknown as CardData));
registerScripts(Object.fromEntries(Object.entries(FIX).map(([id, r]) => [id, r.script])) as never);

const deck = (extra: string[], fill = 'basic_island') => [...extra, ...Array(40 - extra.length).fill(fill)];

function setup(a: string[] = [], b: string[] = [], seed = 7) {
  const ctx: Ctx = { rng: seeded(seed), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(a), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(b), side: [] },
  ], 'a', ctx);
  act(g, ctx, 'a', { t: 'keep' });
  act(g, ctx, 'b', { t: 'keep' });
  expect(g.strict).toBe(true);
  return { g, ctx };
}
function act(g: GameState, ctx: Ctx, pid: string, action: GameAction) {
  const err = applyAction(g, pid, action, ctx);
  if (err) throw new Error(`${action.t}: ${err}`);
}
const P = (g: GameState, pid: string) => g.players.find((p) => p.pid === pid)!;
function find(g: GameState, pid: string, cardId: string): string {
  const p = P(g, pid);
  const iid = [...p.zones.hand, ...p.zones.library, ...p.zones.graveyard].find((i) => g.cards[i].cardId === cardId && !g.battlefield.includes(i));
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}
function put(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId);
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  g.cards[iid].tapped = false;
  return iid;
}
function toHand(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId);
  if (g.cards[iid].zone !== 'hand') moveCard(g, ctx, iid, 'hand');
  return iid;
}
function clearLands(g: GameState, ctx: Ctx) {
  for (const iid of [...g.battlefield]) if (g.cards[iid].cardId?.startsWith('basic_')) moveCard(g, ctx, iid, 'library');
}
/** Pass until the stack is empty (no questions expected). */
function resolveAll(g: GameState, ctx: Ctx) {
  for (let i = 0; i < 10 && (g.stack.length || g.pending.length); i++) {
    if (g.pending.length) throw new Error(`asked: ${g.pending[0].prompt}`);
    act(g, ctx, g.priority, { t: 'pass' });
  }
  expect(g.stack).toHaveLength(0);
}
const logText = (g: GameState) => g.log.map((l) => l.text).join('\n');
const MANUAL = /by hand|Not automated|manual/i;

describe('Power up: the cube list', () => {
  const room = (customList?: string[], powerUp = true) => ({ settings: { customList, powerUp } }) as unknown as RoomState;

  it('adds the 12 power cards, skipping any already in the list', () => {
    expect(POWER_CARDS).toHaveLength(12);
    expect(CUBE.list).toContain('timetwister');
    const def = cubeList(room(), CUBE.list);
    expect(def.length).toBe(CUBE.list.length + 11);
    expect(def.filter((id) => id === 'timetwister')).toHaveLength(CUBE.list.filter((id) => id === 'timetwister').length);
    for (const id of POWER_CARDS) expect(def).toContain(id);
    // an imported list
    const imported = ['lightning_bolt', 'sol_ring', 'counterspell'];
    expect(cubeList(room(imported), CUBE.list)).toEqual([...imported, ...POWER_CARDS.filter((id) => id !== 'sol_ring')]);
    // off: unchanged
    expect(cubeList(room(undefined, false), CUBE.list)).toBe(CUBE.list);
    // only cards the server can load
    expect(withPower(['x'], (id) => id === 'time_walk')).toEqual(['x', 'time_walk']);
  });
});

describe('Power up cards work automatically in strict mode', () => {
  it('the Moxen are free to cast and tap for their color', () => {
    const moxen: [string, string][] = [['mox_pearl', 'W'], ['mox_sapphire', 'U'], ['mox_jet', 'B'], ['mox_ruby', 'R'], ['mox_emerald', 'G']];
    const { g, ctx } = setup(moxen.map(([id]) => id));
    clearLands(g, ctx);
    for (const [id, color] of moxen) {
      const iid = toHand(g, ctx, 'a', id);
      expect(castability(g, 'a', iid).ok).toBe(true);
      act(g, ctx, 'a', { t: 'cast', iid });
      resolveAll(g, ctx);
      expect(g.cards[iid].zone).toBe('battlefield');
      const opts = manaOptionsFor(g, iid, getCard);
      expect(opts).toHaveLength(1);
      expect(opts[0].produces).toBe(color);
      act(g, ctx, 'a', { t: 'activateMana', iid, option: opts[0].id });
      expect(P(g, 'a').manaPool[color]).toBe(1);
    }
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('a Mox pays for spells through auto-pay', () => {
    const { g, ctx } = setup(['mox_sapphire', 'ancestral_recall']);
    clearLands(g, ctx);
    put(g, ctx, 'a', 'mox_sapphire');
    const ar = toHand(g, ctx, 'a', 'ancestral_recall');
    expect(castability(g, 'a', ar).ok).toBe(true);
  });

  it('Black Lotus: sacrifice for three mana of any one color (click and auto-pay)', () => {
    const { g, ctx } = setup(['black_lotus', 'black_lotus', 'counterspell', 'time_walk']);
    clearLands(g, ctx);
    const lotus = put(g, ctx, 'a', 'black_lotus');
    const opts = manaOptionsFor(g, lotus, getCard);
    expect(opts.map((o) => o.produces).sort()).toEqual(['BBB', 'GGG', 'RRR', 'UUU', 'WWW']);
    act(g, ctx, 'a', { t: 'activateMana', iid: lotus, option: opts.find((o) => o.produces === 'RRR')!.id });
    expect(P(g, 'a').manaPool.R).toBe(3);
    expect(g.cards[lotus].zone).toBe('graveyard');
    // the second Lotus pays for Time Walk ({1}{U}) by itself
    const lotus2 = put(g, ctx, 'a', 'black_lotus');
    P(g, 'a').manaPool = {};
    const tw = toHand(g, ctx, 'a', 'time_walk');
    expect(planAutoPay(g, 'a', '{1}{U}', 0)?.picks.map((p) => p.key)).toEqual([lotus2]);
    expect(castability(g, 'a', tw).ok).toBe(true);
    act(g, ctx, 'a', { t: 'cast', iid: tw });
    expect(g.cards[lotus2].zone).toBe('graveyard');
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Ancestral Recall: target player draws three', () => {
    const { g, ctx } = setup(['ancestral_recall', 'ancestral_recall']);
    const ar1 = toHand(g, ctx, 'a', 'ancestral_recall');
    put(g, ctx, 'a', 'basic_island');
    put(g, ctx, 'a', 'basic_island');
    const hand = P(g, 'a').zones.hand.length;
    act(g, ctx, 'a', { t: 'cast', iid: ar1, targets: [[{ kind: 'player', pid: 'a' }]] });
    resolveAll(g, ctx);
    expect(P(g, 'a').zones.hand).toHaveLength(hand - 1 + 3);
    // targeting the opponent
    const ar2 = toHand(g, ctx, 'a', 'ancestral_recall');
    const bHand = P(g, 'b').zones.hand.length;
    act(g, ctx, 'a', { t: 'cast', iid: ar2, targets: [[{ kind: 'player', pid: 'b' }]] });
    resolveAll(g, ctx);
    expect(P(g, 'b').zones.hand).toHaveLength(bHand + 3);
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Time Walk: Alice takes an extra turn', () => {
    const { g, ctx } = setup(['time_walk']);
    const tw = toHand(g, ctx, 'a', 'time_walk');
    put(g, ctx, 'a', 'basic_island');
    put(g, ctx, 'a', 'basic_island');
    act(g, ctx, 'a', { t: 'cast', iid: tw });
    resolveAll(g, ctx);
    expect(g.cards[tw].zone).toBe('graveyard');
    const turn = g.turn;
    // pass to the next turn
    for (let i = 0; i < 60 && g.turn === turn; i++) {
      if (g.pending.length) {
        const q = g.pending[0];
        // cleanup discard (hand size): discard whatever is asked
        act(g, ctx, q.pid, { t: 'choose', id: q.id, value: (q as { options?: { id: string }[] }).options?.slice(0, (q as { max?: number }).max ?? 1).map((o) => o.id) ?? [] } as unknown as GameAction);
        continue;
      }
      act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(g.turn).toBe(turn + 1);
    expect(g.activePlayer).toBe('a');
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Timetwister: hands and graveyards are shuffled into libraries, then each player draws seven', () => {
    const { g, ctx } = setup(['timetwister', 'ancestral_recall']);
    clearLands(g, ctx);
    const tt = toHand(g, ctx, 'a', 'timetwister');
    for (let i = 0; i < 3; i++) put(g, ctx, 'a', 'basic_island');
    // something in each graveyard
    moveCard(g, ctx, find(g, 'a', 'ancestral_recall'), 'graveyard');
    moveCard(g, ctx, P(g, 'b').zones.library[0], 'graveyard');
    act(g, ctx, 'a', { t: 'cast', iid: tt });
    resolveAll(g, ctx);
    for (const pid of ['a', 'b']) {
      expect(P(g, pid).zones.hand).toHaveLength(7);
      expect(P(g, pid).zones.graveyard.filter((i) => i !== tt)).toHaveLength(0);
    }
    expect(g.cards[tt].zone).toBe('graveyard');
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Sol Ring, Mana Vault and Mana Crypt cast and tap for colorless mana', () => {
    const { g, ctx } = setup(['mana_crypt', 'sol_ring', 'mana_vault']);
    clearLands(g, ctx);
    const crypt = toHand(g, ctx, 'a', 'mana_crypt');
    act(g, ctx, 'a', { t: 'cast', iid: crypt });
    resolveAll(g, ctx);
    const ring = toHand(g, ctx, 'a', 'sol_ring');
    act(g, ctx, 'a', { t: 'cast', iid: ring }); // the Crypt pays, {C} floats
    resolveAll(g, ctx);
    const vault = toHand(g, ctx, 'a', 'mana_vault');
    expect(castability(g, 'a', vault).ok).toBe(true);
    act(g, ctx, 'a', { t: 'cast', iid: vault });
    resolveAll(g, ctx);
    for (const iid of [crypt, ring, vault]) expect(g.cards[iid].zone).toBe('battlefield');
    expect(manaOptionsFor(g, ring, getCard)[0].produces).toBe('CC');
    expect(manaOptionsFor(g, vault, getCard)[0].produces).toBe('CCC');
    expect(logText(g)).not.toMatch(MANUAL);
  });
});
