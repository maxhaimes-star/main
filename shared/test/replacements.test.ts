import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import { applyAction, computeCombat, createGame, type Ctx, type GameAction, type GameState, moveCard } from '../src/index.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[]) => [...extra, ...Array(40 - extra.length).fill('basic_mountain')];

function setup(aCards: string[], bCards: string[] = []) {
  const ctx: Ctx = { rng: seeded(11), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(aCards), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(bCards), side: [] },
  ], 'a', ctx, { strict: false });
  act(g, ctx, 'a', { t: 'keep' });
  act(g, ctx, 'b', { t: 'keep' });
  return { g, ctx };
}

function act(g: GameState, ctx: Ctx, pid: string, action: GameAction) {
  const err = applyAction(g, pid, action, ctx);
  if (err) throw new Error(err);
}

const P = (g: GameState, pid: string) => g.players.find((p) => p.pid === pid)!;

function find(g: GameState, pid: string, cardId: string): string {
  const p = P(g, pid);
  return [p.zones.library, p.zones.hand, p.zones.graveyard, p.zones.exile].flat().find((i) => g.cards[i].cardId === cardId)!;
}
function tutor(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId);
  if (g.cards[iid].zone !== 'hand') moveCard(g, ctx, iid, 'hand');
  return iid;
}
function put(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId);
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  return iid;
}
function lands(g: GameState, ctx: Ctx, pid: string, n: number) {
  const lib = P(g, pid).zones.library;
  for (let k = 0; k < n; k++) moveCard(g, ctx, lib.find((i) => g.cards[i].cardId === 'basic_mountain')!, 'battlefield', { controller: pid });
}
const logText = (g: GameState, n = 10) => g.log.slice(-n).map((l) => l.text).join('\n');

describe('replacements: enters tapped', () => {
  it('ETBTapped: Celestial Colonnade and a Triome enter tapped', () => {
    const { g, ctx } = setup(['celestial_colonnade', 'raugrin_triome']);
    const col = tutor(g, ctx, 'a', 'celestial_colonnade');
    act(g, ctx, 'a', { t: 'playLand', iid: col });
    expect(g.cards[col].zone).toBe('battlefield');
    expect(g.cards[col].tapped).toBe(true);
    const tri = put(g, ctx, 'a', 'raugrin_triome');
    expect(g.cards[tri].tapped).toBe(true);
  });

  it('fastland: untapped with two or fewer other lands, tapped with three', () => {
    const { g, ctx } = setup(['seachrome_coast', 'blackcleave_cliffs']);
    lands(g, ctx, 'a', 2);
    const sc = tutor(g, ctx, 'a', 'seachrome_coast');
    act(g, ctx, 'a', { t: 'playLand', iid: sc });
    expect(g.cards[sc].tapped).toBe(false);
    // now 3 other lands
    const bc = put(g, ctx, 'a', 'blackcleave_cliffs');
    expect(g.cards[bc].tapped).toBe(true);
    expect(logText(g)).toMatch(/Blackcleave Cliffs enters tapped/);
  });

  it('fastland counts only its controller\'s lands', () => {
    const { g, ctx } = setup(['seachrome_coast']);
    lands(g, ctx, 'b', 4);
    const sc = put(g, ctx, 'a', 'seachrome_coast');
    expect(g.cards[sc].tapped).toBe(false);
  });

  it('shockland: pay 2 life → untapped', () => {
    const { g, ctx } = setup(['hallowed_fountain']);
    const hf = tutor(g, ctx, 'a', 'hallowed_fountain');
    act(g, ctx, 'a', { t: 'playLand', iid: hf });
    expect(g.cards[hf].tapped).toBe(true); // tapped until the choice is made
    expect(g.pending).toHaveLength(1);
    const q = g.pending[0];
    expect(q.pid).toBe('a');
    expect(applyAction(g, 'a', { t: 'pass' }, ctx)).toMatch(/Waiting/);
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: 'pay' });
    expect(g.cards[hf].tapped).toBe(false);
    expect(P(g, 'a').life).toBe(18);
    expect(g.pending).toHaveLength(0);
  });

  it('shockland: decline → tapped, no life paid', () => {
    const { g, ctx } = setup(['steam_vents']);
    const sv = tutor(g, ctx, 'a', 'steam_vents');
    act(g, ctx, 'a', { t: 'playLand', iid: sv });
    act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: 'decline' });
    expect(g.cards[sv].tapped).toBe(true);
    expect(P(g, 'a').life).toBe(20);
  });

  it('Baloth Prime enters tapped with six stun counters; untap step removes one instead', () => {
    const { g, ctx } = setup(['baloth_prime']);
    const bp = put(g, ctx, 'a', 'baloth_prime');
    expect(g.cards[bp].tapped).toBe(true);
    expect(g.cards[bp].counters.stun).toBe(6);
    act(g, ctx, 'a', { t: 'nextTurn' });
    act(g, ctx, 'b', { t: 'nextTurn' });
    expect(g.activePlayer).toBe('a');
    expect(g.cards[bp].tapped).toBe(true);
    expect(g.cards[bp].counters.stun).toBe(5);
  });

  it('etbCounter: Dark Depths enters with ten ice counters', () => {
    const { g, ctx } = setup(['dark_depths']);
    const dd = put(g, ctx, 'a', 'dark_depths');
    expect(g.cards[dd].counters.ice).toBe(10);
  });
});

describe('replacements: counter / untap / damage / draw', () => {
  it("Abrupt Decay can't be countered", () => {
    const { g, ctx } = setup(['abrupt_decay', 'goblin_guide'], ['counterspell']);
    const gg = put(g, ctx, 'a', 'goblin_guide');
    const target = gg; // any nonland permanent with mana value 3 or less
    const ad = tutor(g, ctx, 'a', 'abrupt_decay');
    act(g, ctx, 'a', { t: 'cast', iid: ad, targets: [[{ kind: 'card', iid: target }]] });
    const spell = g.stack[0];
    const cs = tutor(g, ctx, 'b', 'counterspell');
    act(g, ctx, 'b', { t: 'cast', iid: cs, targets: [[{ kind: 'stack', id: spell.id }]] });
    act(g, ctx, 'a', { t: 'pass' }); // Counterspell resolves
    expect(logText(g)).toMatch(/can't be countered/);
    expect(g.stack.map((s) => s.id)).toEqual([spell.id]);
    act(g, ctx, 'a', { t: 'pass' });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[ad].zone).toBe('graveyard');
    expect(g.cards[gg].zone).toBe('graveyard');
  });

  it("Grim Monolith doesn't untap during its controller's untap step", () => {
    const { g, ctx } = setup(['grim_monolith', 'goblin_guide']);
    const gm = put(g, ctx, 'a', 'grim_monolith');
    const gg = put(g, ctx, 'a', 'goblin_guide');
    expect(g.cards[gm].noUntap).toBe(true);
    g.cards[gm].tapped = true;
    g.cards[gg].tapped = true;
    act(g, ctx, 'a', { t: 'nextTurn' });
    act(g, ctx, 'b', { t: 'nextTurn' });
    expect(g.cards[gm].tapped).toBe(true);
    expect(g.cards[gg].tapped).toBe(false);
  });

  it("Meekstone: creatures with power 3+ don't untap", () => {
    const { g, ctx } = setup(['meekstone'], ['questing_beast', 'goblin_guide']);
    put(g, ctx, 'a', 'meekstone');
    const qb = put(g, ctx, 'b', 'questing_beast');
    const gg = put(g, ctx, 'b', 'goblin_guide');
    g.cards[qb].tapped = true;
    g.cards[gg].tapped = true;
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(g.activePlayer).toBe('b');
    expect(g.cards[qb].tapped).toBe(true);
    expect(g.cards[gg].tapped).toBe(false);
  });

  it('Glacial Chasm prevents damage to its controller (spells and combat)', () => {
    const { g, ctx } = setup(['lightning_bolt', 'goblin_guide'], ['glacial_chasm']);
    put(g, ctx, 'b', 'glacial_chasm');
    const bolt = tutor(g, ctx, 'a', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: [[{ kind: 'player', pid: 'b' }]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(P(g, 'b').life).toBe(20);
    expect(logText(g)).toMatch(/prevented/);
    const gg = put(g, ctx, 'a', 'goblin_guide');
    g.cards[gg].attacking = 'b';
    expect(computeCombat(g, getCard).lifeChange.b ?? 0).toBe(0);
  });

  it('Mox Diamond: discard a land or it goes to the graveyard', () => {
    const { g, ctx } = setup(['mox_diamond']);
    const mox = tutor(g, ctx, 'a', 'mox_diamond');
    act(g, ctx, 'a', { t: 'cast', iid: mox });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[mox].zone).toBe('battlefield');
    const q = g.pending[0];
    expect(q.options.length).toBeGreaterThan(1);
    const land = q.options[0].value;
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: land });
    expect(g.cards[land].zone).toBe('graveyard');
    expect(g.cards[mox].zone).toBe('battlefield');
  });

  it('Solitary Confinement skips its controller\'s draw step', () => {
    const { g, ctx } = setup([], ['solitary_confinement']);
    put(g, ctx, 'b', 'solitary_confinement');
    const hand = P(g, 'b').zones.hand.length;
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(g.activePlayer).toBe('b');
    // Its upkeep trigger ("sacrifice unless you discard") goes on the stack first: discard to keep it.
    for (let k = 0; k < 20 && ['untap', 'upkeep'].includes(g.step); k++) {
      const q = g.pending[0];
      if (q) { act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options.find((o) => o.value !== 'none' && !/sacrifice|don't/i.test(o.label))?.value ?? q.options[0].value }); continue; }
      act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(['untap', 'upkeep', 'draw']).not.toContain(g.step);
    expect(P(g, 'b').zones.hand.length).toBeLessThanOrEqual(hand); // nothing drawn (maybe one discarded)
    expect(g.log.some((l) => /skips their draw step/.test(l.text))).toBe(true);
    expect(g.log.some((l) => /Bob draws for the turn/.test(l.text))).toBe(false);
  });

  it('Hullbreacher: opponent draws from effects become Treasures', () => {
    const { g, ctx } = setup(['hullbreacher'], ['opt']);
    put(g, ctx, 'a', 'hullbreacher');
    const hand = P(g, 'b').zones.hand.length;
    // Bob draws with an engine effect
    const opt = tutor(g, ctx, 'b', 'opt');
    act(g, ctx, 'a', { t: 'pass' });
    act(g, ctx, 'b', { t: 'cast', iid: opt });
    act(g, ctx, 'a', { t: 'pass' });
    const pk = P(g, 'b').peek;
    if (pk) act(g, ctx, 'b', { t: 'resolvePeek', top: pk.iids, bottom: [], graveyard: [], hand: [], battlefield: [], exile: [], shuffle: false });
    expect(P(g, 'b').zones.hand.length).toBe(hand); // +1 Opt tutored, -1 cast, +0 drawn
    expect(g.battlefield.filter((i) => g.cards[i].token?.name === 'Treasure' && g.cards[i].controller === 'a')).toHaveLength(1);
  });
});

describe('replacements: zone redirects', () => {
  it('Containment Priest exiles creatures that enter without being cast', () => {
    const { g, ctx } = setup(['containment_priest', 'goblin_guide']);
    put(g, ctx, 'a', 'containment_priest');
    const gg = find(g, 'a', 'goblin_guide');
    moveCard(g, ctx, gg, 'graveyard');
    act(g, ctx, 'a', { t: 'move', iid: gg, to: 'battlefield' });
    expect(g.cards[gg].zone).toBe('exile');
  });

  it('Containment Priest lets cast creatures enter', () => {
    const { g, ctx } = setup(['containment_priest', 'goblin_guide']);
    put(g, ctx, 'a', 'containment_priest');
    const gg = tutor(g, ctx, 'a', 'goblin_guide');
    act(g, ctx, 'a', { t: 'cast', iid: gg });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[gg].zone).toBe('battlefield');
  });

  it("Dauthi Voidwalker exiles opponents' cards with a void counter", () => {
    const { g, ctx } = setup(['dauthi_voidwalker'], ['lightning_bolt']);
    put(g, ctx, 'a', 'dauthi_voidwalker');
    const bolt = tutor(g, ctx, 'b', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'pass' });
    act(g, ctx, 'b', { t: 'cast', iid: bolt, targets: [[{ kind: 'player', pid: 'a' }]] });
    act(g, ctx, 'a', { t: 'pass' });
    expect(g.cards[bolt].zone).toBe('exile');
    expect(g.cards[bolt].counters.void).toBe(1);
  });

  it('Blightsteel Colossus is shuffled into the library instead of the graveyard', () => {
    const { g, ctx } = setup(['blightsteel_colossus']);
    const bc = put(g, ctx, 'a', 'blightsteel_colossus');
    const libBefore = P(g, 'a').zones.library.length;
    moveCard(g, ctx, bc, 'graveyard');
    expect(P(g, 'a').zones.graveyard.some((i) => g.cards[i].cardId === 'blightsteel_colossus')).toBe(false);
    expect(P(g, 'a').zones.library.length).toBe(libBefore + 1);
  });
});
