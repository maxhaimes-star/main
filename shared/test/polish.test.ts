import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  applyAction, castOptions, createGame, type Ctx, type GameAction, type GameState, hasKeyword, manaOptionsFor, moveCard,
} from '../src/index.ts';
import { addEffect } from '../src/engine/durations.ts';
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

/** A card (by id) from anywhere in the player's library / hand / graveyard / exile. */
function find(g: GameState, pid: string, cardId: string, skip: string[] = []): string {
  const p = P(g, pid);
  const iid = [p.zones.library, p.zones.hand, p.zones.graveyard, p.zones.exile].flat().find((i) => g.cards[i].cardId === cardId && !skip.includes(i));
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}
function toZone(g: GameState, ctx: Ctx, pid: string, cardId: string, zone: 'hand' | 'graveyard', skip: string[] = []): string {
  const iid = find(g, pid, cardId, skip);
  if (g.cards[iid].zone !== zone) moveCard(g, ctx, iid, zone);
  return iid;
}
const tutor = (g: GameState, ctx: Ctx, pid: string, cardId: string, skip: string[] = []) => toZone(g, ctx, pid, cardId, 'hand', skip);
function put(g: GameState, ctx: Ctx, pid: string, cardId: string, skip: string[] = []): string {
  const iid = find(g, pid, cardId, skip);
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  return iid;
}
/** A fresh basic land (basics aren't in the 40-card test decks except Mountains). */
function basic(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = P(g, pid).zones.library.find((i) => g.cards[i].cardId === 'basic_mountain')!;
  g.cards[iid].cardId = cardId;
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  return iid;
}
const player = (pid: string) => ({ kind: 'player' as const, pid });
const cardRef = (iid: string) => ({ kind: 'card' as const, iid });
const stackRef = (id: string) => ({ kind: 'stack' as const, id });
const log = (g: GameState, n = 10) => g.log.slice(-n).map((l) => l.text).join('\n');

/** Alice casts Goblin Guide so Bob has a spell to counter. */
function aliceCastsBait(g: GameState, ctx: Ctx) {
  const gg = tutor(g, ctx, 'a', 'goblin_guide');
  act(g, ctx, 'a', { t: 'cast', iid: gg });
  return { gg, spell: g.stack[0] };
}

describe('alternative costs', () => {
  it('castOptions lists the normal cost and Force of Will\'s pitch cost', () => {
    const { g, ctx } = setup([], ['force_of_will', 'counterspell']);
    const fow = tutor(g, ctx, 'b', 'force_of_will');
    const opts = castOptions(g, fow);
    expect(opts.map((o) => o.id)).toEqual(['normal', 'alt0']);
    expect(opts[0].cost).toBe('{3}{U}{U}');
    expect(opts[1]).toMatchObject({ cost: '', extra: ['Pay 1 life', 'Exile a blue card from your hand'] });
    expect(opts[1].unavailable).toMatch(/not enough/); // no other blue card in hand yet
  });

  it('Force of Will: pay 1 life and exile a blue card (chosen via Pending)', () => {
    const { g, ctx } = setup(['goblin_guide'], ['force_of_will', 'counterspell', 'brainstorm']);
    const { gg, spell } = aliceCastsBait(g, ctx);
    const fow = tutor(g, ctx, 'b', 'force_of_will');
    const cs = tutor(g, ctx, 'b', 'counterspell');
    const bs = tutor(g, ctx, 'b', 'brainstorm');
    act(g, ctx, 'b', { t: 'cast', iid: fow, costOption: 'alt0', targets: [[stackRef(spell.id)]] });
    expect(P(g, 'b').life).toBe(19);
    const q = g.pending[0];
    expect(q.pid).toBe('b');
    expect(q.options.map((o) => o.value).sort()).toEqual([cs, bs].sort());
    expect(applyAction(g, 'a', { t: 'pass' }, ctx)).toMatch(/Waiting/);
    act(g, ctx, 'b', { t: 'choose', id: q.id, value: cs });
    expect(g.cards[cs].zone).toBe('exile');
    expect(g.pending).toHaveLength(0);
    act(g, ctx, 'a', { t: 'pass' });
    expect(g.cards[gg].zone).toBe('graveyard');
    expect(g.cards[fow].zone).toBe('graveyard');
  });

  it('Daze: return an Island instead of paying mana', () => {
    const { g, ctx } = setup(['goblin_guide'], ['daze']);
    const { spell } = aliceCastsBait(g, ctx);
    const daze = tutor(g, ctx, 'b', 'daze');
    expect(applyAction(g, 'b', { t: 'cast', iid: daze, costOption: 'alt0', targets: [[stackRef(spell.id)]] }, ctx)).toMatch(/not enough/);
    const island = basic(g, ctx, 'b', 'basic_island');
    act(g, ctx, 'b', { t: 'cast', iid: daze, costOption: 'alt0', targets: [[stackRef(spell.id)]] });
    expect(g.cards[island].zone).toBe('hand'); // only one Island: no question needed
    expect(g.stack.at(-1)?.castInfo?.option).toBe('alt0');
  });

  it('Snuff Out: pay 4 life (needs a Swamp)', () => {
    const { g, ctx } = setup(['snuff_out'], ['goblin_guide']);
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const so = tutor(g, ctx, 'a', 'snuff_out');
    expect(castOptions(g, so).find((o) => o.id === 'alt0')?.unavailable).toMatch(/Swamp/);
    expect(applyAction(g, 'a', { t: 'cast', iid: so, costOption: 'alt0', targets: [[cardRef(gg)]] }, ctx)).toMatch(/Swamp/);
    basic(g, ctx, 'a', 'basic_swamp');
    act(g, ctx, 'a', { t: 'cast', iid: so, costOption: 'alt0', targets: [[cardRef(gg)]] });
    expect(P(g, 'a').life).toBe(16);
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[gg].zone).toBe('graveyard');
  });

  it('Fireblast: sacrifice two Mountains (chosen) and deal 4', () => {
    const { g, ctx } = setup(['fireblast']);
    const m = [put(g, ctx, 'a', 'basic_mountain')];
    m.push(put(g, ctx, 'a', 'basic_mountain', m));
    m.push(put(g, ctx, 'a', 'basic_mountain', m));
    const fb = tutor(g, ctx, 'a', 'fireblast');
    act(g, ctx, 'a', { t: 'cast', iid: fb, costOption: 'alt0', targets: [[player('b')]] });
    act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: m[0] });
    act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: m[2] });
    expect(g.pending).toHaveLength(0);
    expect([m[0], m[1], m[2]].map((i) => g.cards[i].zone)).toEqual(['graveyard', 'battlefield', 'graveyard']);
    act(g, ctx, 'b', { t: 'pass' });
    expect(P(g, 'b').life).toBe(16);
  });

  it('Evoke: Fury exiles a red card; its ETB trigger resolves, then the evoke sacrifice trigger', () => {
    const { g, ctx } = setup(['fury', 'lightning_bolt'], ['questing_beast']);
    const qb = put(g, ctx, 'b', 'questing_beast');
    const fury = tutor(g, ctx, 'a', 'fury');
    const bolt = tutor(g, ctx, 'a', 'lightning_bolt');
    expect(castOptions(g, fury).map((o) => o.id)).toContain('evoke');
    act(g, ctx, 'a', { t: 'cast', iid: fury, costOption: 'evoke' });
    expect(g.cards[bolt].zone).toBe('exile');
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[fury].zone).toBe('battlefield');
    expect(g.cards[fury].castInfo?.evoked).toBe(true); // visible to ETB triggers
    // Fury's own ETB trigger asks for targets; the evoke trigger is already queued underneath it.
    const q = g.pending[0];
    expect(q.targets).toBeDefined();
    act(g, ctx, 'a', { t: 'chooseTargets', id: q.id, targets: [[cardRef(qb)]] });
    expect(g.stack.map((s) => s.text)).toEqual([expect.stringMatching(/Evoke/), expect.stringMatching(/4 damage/)]);
    act(g, ctx, 'b', { t: 'pass' }); // Fury's damage
    expect(g.cards[qb].zone).toBe('graveyard');
    expect(g.cards[fury].zone).toBe('battlefield');
    act(g, ctx, g.priority, { t: 'pass' }); // evoke sacrifice
    if (g.stack.length) act(g, ctx, g.priority, { t: 'pass' });
    expect(g.cards[fury].zone).toBe('graveyard');
    expect(g.stack).toHaveLength(0);
  });

  it('Kicker is visible to ETB triggers: kicked Goblin Bushwhacker pumps the team', () => {
    const { g, ctx } = setup(['goblin_bushwhacker', 'goblin_guide']);
    const gg = put(g, ctx, 'a', 'goblin_guide');
    const gb = tutor(g, ctx, 'a', 'goblin_bushwhacker');
    act(g, ctx, 'a', { t: 'addMana', mana: 'R', n: 2 });
    act(g, ctx, 'a', { t: 'cast', iid: gb, kicked: true });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.stack.map((s) => s.kind)).toEqual(['trigger']);
    act(g, ctx, 'b', { t: 'pass' });
    expect(hasKeyword(g.cards[gg], getCard, 'Haste')).toBe(true);
    expect(g.cards[gg].tempPT).toEqual([1, 0]);
  });

  it('unkicked Goblin Bushwhacker does not trigger', () => {
    const { g, ctx } = setup(['goblin_bushwhacker']);
    const gb = tutor(g, ctx, 'a', 'goblin_bushwhacker');
    act(g, ctx, 'a', { t: 'cast', iid: gb });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[gb].zone).toBe('battlefield');
    expect(g.stack).toHaveLength(0);
  });

  it('Flashback: Lingering Souls from the graveyard, then exiled', () => {
    const { g, ctx } = setup(['lingering_souls']);
    const ls = toZone(g, ctx, 'a', 'lingering_souls', 'graveyard');
    const fb = castOptions(g, ls).find((o) => o.id === 'flashback')!;
    expect(fb).toMatchObject({ cost: '{1}{B}' });
    expect(fb.unavailable).toBeUndefined();
    act(g, ctx, 'a', { t: 'addMana', mana: 'B', n: 2 });
    act(g, ctx, 'a', { t: 'cast', iid: ls, costOption: 'flashback' });
    expect(P(g, 'a').manaPool.B).toBe(0);
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.battlefield.filter((i) => g.cards[i].token?.name === 'Spirit')).toHaveLength(2);
    expect(g.cards[ls].zone).toBe('exile');
    // flashback only from the graveyard
    const ls2 = g.cards[ls];
    moveCard(g, ctx, ls2.iid, 'hand');
    expect(castOptions(g, ls).find((o) => o.id === 'flashback')?.unavailable).toMatch(/graveyard/);
  });

  it('Kicker: Burst Lightning deals 4 when kicked, 2 otherwise', () => {
    const { g, ctx } = setup(['burst_lightning']);
    const bl = tutor(g, ctx, 'a', 'burst_lightning');
    expect(castOptions(g, bl).find((o) => o.id === 'kicked')?.cost).toBe('{R}{4}');
    act(g, ctx, 'a', { t: 'addMana', mana: 'R', n: 5 });
    act(g, ctx, 'a', { t: 'cast', iid: bl, kicked: true, targets: [[player('b')]] });
    expect(P(g, 'a').manaPool.R).toBe(0);
    act(g, ctx, 'b', { t: 'pass' });
    expect(P(g, 'b').life).toBe(16);
    moveCard(g, ctx, bl, 'hand');
    act(g, ctx, 'a', { t: 'cast', iid: bl, targets: [[player('b')]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(P(g, 'b').life).toBe(14);
  });

  it('Delve: Treasure Cruise exiles graveyard cards to pay generic mana', () => {
    const { g, ctx } = setup(['treasure_cruise']);
    const gy: string[] = [];
    for (let k = 0; k < 5; k++) { const i = P(g, 'a').zones.library.find((x) => g.cards[x].cardId === 'basic_mountain')!; moveCard(g, ctx, i, 'graveyard'); gy.push(i); }
    const tc = tutor(g, ctx, 'a', 'treasure_cruise');
    act(g, ctx, 'a', { t: 'addMana', mana: 'U', n: 1 });
    act(g, ctx, 'a', { t: 'addMana', mana: 'R', n: 2 });
    const hand = P(g, 'a').zones.hand.length;
    act(g, ctx, 'a', { t: 'cast', iid: tc });
    for (let k = 0; k < 5; k++) act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: gy[k] });
    expect(g.pending).toHaveLength(0); // {7}{U}: 5 delved, {2}{U} paid from the pool
    expect(gy.every((i) => g.cards[i].zone === 'exile')).toBe(true);
    expect(P(g, 'a').manaPool).toMatchObject({ U: 0, R: 0 });
    act(g, ctx, 'b', { t: 'pass' });
    expect(P(g, 'a').zones.hand.length).toBe(hand - 1 + 3);
  });

  it('Delve: "Done" stops early', () => {
    const { g, ctx } = setup(['treasure_cruise']);
    const i = P(g, 'a').zones.library.find((x) => g.cards[x].cardId === 'basic_mountain')!;
    moveCard(g, ctx, i, 'graveyard');
    const tc = tutor(g, ctx, 'a', 'treasure_cruise');
    act(g, ctx, 'a', { t: 'addMana', mana: 'U', n: 8 });
    act(g, ctx, 'a', { t: 'cast', iid: tc });
    act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: 'none' });
    expect(g.cards[i].zone).toBe('graveyard');
    expect(P(g, 'a').manaPool.U).toBe(0);
  });
});

describe('conditions', () => {
  it('Fatal Push: revolt off (MV 4 survives) and on (MV 4 dies)', () => {
    const { g, ctx } = setup(['fatal_push'], ['questing_beast']);
    const qb = put(g, ctx, 'b', 'questing_beast');
    const fp = tutor(g, ctx, 'a', 'fatal_push');
    act(g, ctx, 'a', { t: 'cast', iid: fp, targets: [[cardRef(qb)]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[qb].zone).toBe('battlefield');
    expect(log(g)).toMatch(/condition not met/);
    // a permanent Alice controls leaves the battlefield → revolt
    const land = put(g, ctx, 'a', 'basic_mountain');
    act(g, ctx, 'a', { t: 'move', iid: land, to: 'hand' });
    moveCard(g, ctx, fp, 'hand');
    act(g, ctx, 'a', { t: 'cast', iid: fp, targets: [[cardRef(qb)]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[qb].zone).toBe('graveyard');
    expect(log(g)).not.toMatch(/Check by hand/);
  });

  it('Prismatic Ending: converge counts the colors spent', () => {
    const { g, ctx } = setup(['prismatic_ending'], ['questing_beast', 'thalia_guardian_of_thraben']);
    const thalia = put(g, ctx, 'b', 'thalia_guardian_of_thraben'); // MV 2
    const pe = tutor(g, ctx, 'a', 'prismatic_ending');
    act(g, ctx, 'a', { t: 'addMana', mana: 'W', n: 3 }); // {X=1}{W} + Thalia's {1} tax
    act(g, ctx, 'a', { t: 'cast', iid: pe, x: 1, targets: [[cardRef(thalia)]] }); // WWW: one color
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[thalia].zone).toBe('battlefield');
    moveCard(g, ctx, pe, 'hand');
    act(g, ctx, 'a', { t: 'addMana', mana: 'W', n: 1 });
    act(g, ctx, 'a', { t: 'addMana', mana: 'B', n: 2 });
    act(g, ctx, 'a', { t: 'cast', iid: pe, x: 1, targets: [[cardRef(thalia)]] }); // W + BB: two colors
    expect(g.stack[0].auto?.colorsSpent?.sort()).toEqual(['B', 'W']);
    expect(P(g, 'a').manaPool).toMatchObject({ W: 0, B: 0 }); // tax paid too
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[thalia].zone).toBe('exile');
  });
});

describe('divided damage', () => {
  it('Fire Covenant: X life, damage divided as chosen', () => {
    const { g, ctx } = setup(['fire_covenant'], ['goblin_guide', 'thalia_guardian_of_thraben', 'questing_beast']);
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const th = put(g, ctx, 'b', 'thalia_guardian_of_thraben');
    const qb = put(g, ctx, 'b', 'questing_beast');
    const fc = tutor(g, ctx, 'a', 'fire_covenant');
    const targets = [[cardRef(gg), cardRef(th), cardRef(qb)]];
    expect(applyAction(g, 'a', { t: 'cast', iid: fc, x: 7, targets, division: { [gg]: 1, [th]: 1, [qb]: 4 } }, ctx)).toMatch(/add up to 7/);
    expect(applyAction(g, 'a', { t: 'cast', iid: fc, x: 7, targets, division: { [gg]: 3, [qb]: 4 } }, ctx)).toMatch(/each target/);
    act(g, ctx, 'a', { t: 'cast', iid: fc, x: 7, targets, division: { [gg]: 2, [th]: 1, [qb]: 4 } });
    expect(P(g, 'a').life).toBe(13);
    act(g, ctx, 'b', { t: 'pass' });
    expect([gg, th, qb].map((i) => g.cards[i].zone)).toEqual(['graveyard', 'graveyard', 'graveyard']);
  });

  it('without a division, several targets fall back to resolve-by-hand', () => {
    const { g, ctx } = setup(['fire_covenant'], ['goblin_guide', 'questing_beast']);
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const qb = put(g, ctx, 'b', 'questing_beast');
    const fc = tutor(g, ctx, 'a', 'fire_covenant');
    act(g, ctx, 'a', { t: 'cast', iid: fc, x: 2, targets: [[cardRef(gg), cardRef(qb)]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[gg].damage + g.cards[qb].damage).toBe(0);
    expect(log(g)).toMatch(/Not automated/);
  });
});

describe('timing and limits', () => {
  it('loyalty abilities: once per turn, sorcery speed; force overrides', () => {
    const { g, ctx } = setup(['jace_the_mind_sculptor']);
    const jace = put(g, ctx, 'a', 'jace_the_mind_sculptor');
    act(g, ctx, 'a', { t: 'activate', iid: jace, text: '', ability: 0, targets: [[player('b')]] });
    act(g, ctx, 'b', { t: 'pass' });
    if (P(g, 'a').peek) act(g, ctx, 'a', { t: 'resolvePeek', top: P(g, 'a').peek!.iids, bottom: [], graveyard: [], hand: [], battlefield: [], exile: [], shuffle: false });
    expect(applyAction(g, 'a', { t: 'activate', iid: jace, text: '', ability: 1 }, ctx)).toMatch(/already activated/);
    expect(applyAction(g, 'a', { t: 'activate', iid: jace, text: 'Brainstorm', loyalty: 0 }, ctx)).toMatch(/already activated/);
    act(g, ctx, 'a', { t: 'activate', iid: jace, text: '', ability: 1, force: true });
    expect(g.stack).toHaveLength(1);
  });

  it('loyalty abilities need an empty stack on your own turn', () => {
    const { g, ctx } = setup(['jace_the_mind_sculptor'], ['jace_the_mind_sculptor']);
    const theirs = put(g, ctx, 'b', 'jace_the_mind_sculptor');
    expect(applyAction(g, 'b', { t: 'activate', iid: theirs, text: '', ability: 0, targets: [[player('a')]] }, ctx)).toMatch(/sorcery speed/);
    const { g: g2, ctx: c2 } = setup(['jace_the_mind_sculptor', 'goblin_guide']);
    const jace = put(g2, c2, 'a', 'jace_the_mind_sculptor');
    const gg = tutor(g2, c2, 'a', 'goblin_guide');
    act(g2, c2, 'a', { t: 'cast', iid: gg });
    expect(applyAction(g2, 'a', { t: 'activate', iid: jace, text: '', ability: 0, targets: [[player('b')]] }, c2)).toMatch(/sorcery speed/);
  });

  it('sorceries and creatures need sorcery timing; instants and flash do not', () => {
    const { g, ctx } = setup([], ['wrath_of_god', 'goblin_guide', 'lightning_bolt', 'solitude']);
    const w = tutor(g, ctx, 'b', 'wrath_of_god');
    const gg = tutor(g, ctx, 'b', 'goblin_guide');
    expect(applyAction(g, 'b', { t: 'cast', iid: w }, ctx)).toMatch(/sorcery speed/);
    expect(applyAction(g, 'b', { t: 'cast', iid: gg }, ctx)).toMatch(/sorcery speed/);
    const bolt = tutor(g, ctx, 'b', 'lightning_bolt');
    act(g, ctx, 'b', { t: 'cast', iid: bolt, targets: [[player('a')]] });
    act(g, ctx, 'a', { t: 'pass' });
    const sol = tutor(g, ctx, 'b', 'solitude');
    act(g, ctx, 'b', { t: 'cast', iid: sol }); // flash
    act(g, ctx, 'a', { t: 'pass' });
    expect(g.cards[sol].zone).toBe('battlefield');
    act(g, ctx, 'b', { t: 'cast', iid: gg, force: true });
    expect(g.stack.at(-1)?.iid).toBe(gg);
    expect(g.cards[gg].zone).toBe('stack');
  });
});

describe('durations', () => {
  it('"until your next turn" pump survives the cleanup and ends on your next turn', () => {
    const { g, ctx } = setup(['kytheon_hero_of_akros', 'goblin_guide']);
    const k = put(g, ctx, 'a', 'kytheon_hero_of_akros');
    g.cards[k].transformed = true;
    g.cards[k].counters.loyalty = 3;
    const gg = put(g, ctx, 'a', 'goblin_guide');
    act(g, ctx, 'a', { t: 'activate', iid: k, text: '', ability: 1, targets: [[cardRef(gg)]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(hasKeyword(g.cards[gg], getCard, 'Indestructible')).toBe(true);
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(g.activePlayer).toBe('b');
    expect(hasKeyword(g.cards[gg], getCard, 'Indestructible')).toBe(true);
    act(g, ctx, 'b', { t: 'nextTurn' });
    expect(g.activePlayer).toBe('a');
    expect(hasKeyword(g.cards[gg], getCard, 'Indestructible')).toBe(false);
  });
});

describe('mana abilities', () => {
  it('Ancient Tomb: {C}{C} and 2 damage', () => {
    const { g, ctx } = setup(['ancient_tomb']);
    const at = put(g, ctx, 'a', 'ancient_tomb');
    const opts = manaOptionsFor(g, at);
    expect(opts).toEqual([{ id: '0', label: 'Add {C}{C}', produces: 'CC', sideEffects: ['Ancient Tomb deals 2 damage to you'] }]);
    act(g, ctx, 'a', { t: 'activateMana', iid: at, option: '0' });
    expect(P(g, 'a').manaPool.C).toBe(2);
    expect(P(g, 'a').life).toBe(18);
    expect(g.cards[at].tapped).toBe(true);
    expect(applyAction(g, 'a', { t: 'activateMana', iid: at, option: '0' }, ctx)).toMatch(/tapped/);
  });

  it("Gaea's Cradle counts creatures; basics tap for their type", () => {
    const { g, ctx } = setup(['gaeas_cradle', 'goblin_guide', 'thalia_guardian_of_thraben']);
    const gc = put(g, ctx, 'a', 'gaeas_cradle');
    expect(manaOptionsFor(g, gc)[0].produces).toBe('');
    put(g, ctx, 'a', 'goblin_guide');
    put(g, ctx, 'a', 'thalia_guardian_of_thraben');
    expect(manaOptionsFor(g, gc)[0]).toMatchObject({ produces: 'GG', label: 'Add {G}{G}' });
    act(g, ctx, 'a', { t: 'activateMana', iid: gc, option: '0' });
    expect(P(g, 'a').manaPool.G).toBe(2);
    const m = put(g, ctx, 'a', 'basic_mountain');
    expect(manaOptionsFor(g, m)).toEqual([{ id: 'type:R', label: 'Add {R}', produces: 'R', sideEffects: [] }]);
  });

  it('Lotus Petal: any color, sacrificed', () => {
    const { g, ctx } = setup(['lotus_petal']);
    const lp = put(g, ctx, 'a', 'lotus_petal');
    const opts = manaOptionsFor(g, lp);
    expect(opts.map((o) => o.produces)).toEqual(['W', 'U', 'B', 'R', 'G']);
    act(g, ctx, 'a', { t: 'activateMana', iid: lp, option: opts[1].id });
    expect(P(g, 'a').manaPool.U).toBe(1);
    expect(g.cards[lp].zone).toBe('graveyard');
  });
});

describe('durations: control and until-host-leaves', () => {
  it('gain control until end of turn reverts at cleanup', () => {
    const { g, ctx } = setup([], ['goblin_guide']);
    const gg = put(g, ctx, 'b', 'goblin_guide');
    g.cards[gg].controller = 'a';
    addEffect(g, ctx, { kind: 'control', controller: 'a', until: 'eot', iid: gg, previous: 'b' });
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(g.cards[gg].controller).toBe('b');
    expect(g.effects).toEqual([]);
  });

  it('exiled until the host leaves: returns when the host leaves the battlefield', () => {
    const { g, ctx } = setup(['portable_hole'], ['goblin_guide']);
    const hole = put(g, ctx, 'a', 'portable_hole');
    const gg = put(g, ctx, 'b', 'goblin_guide');
    moveCard(g, ctx, gg, 'exile');
    addEffect(g, ctx, { kind: 'exiled', controller: 'a', until: 'hostLeaves', hostIid: hole, cards: [{ iid: gg, from: 'battlefield', owner: 'b' }] });
    act(g, ctx, 'a', { t: 'move', iid: hole, to: 'graveyard' });
    expect(g.cards[gg].zone).toBe('battlefield');
    expect(g.cards[gg].controller).toBe('b');
  });
});

/** Pass priority (whoever holds it) until the stack is empty. */
function drain(g: GameState, ctx: Ctx) {
  for (let k = 0; k < 20 && g.stack.length && !g.pending.length; k++) act(g, ctx, g.priority, { t: 'pass' });
}

describe('durations and costs through real triggers', () => {
  it('Zealous Conscripts: gain control until end of turn (ETB trigger), reverts at cleanup', () => {
    const { g, ctx } = setup(['zealous_conscripts'], ['questing_beast']);
    const qb = put(g, ctx, 'b', 'questing_beast');
    g.cards[qb].tapped = true;
    const zc = tutor(g, ctx, 'a', 'zealous_conscripts');
    act(g, ctx, 'a', { t: 'addMana', mana: 'R', n: 5 });
    act(g, ctx, 'a', { t: 'cast', iid: zc });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[zc].zone).toBe('battlefield');
    act(g, ctx, 'a', { t: 'chooseTargets', id: g.pending[0].id, targets: [[cardRef(qb)]] });
    drain(g, ctx);
    expect(g.cards[qb].controller).toBe('a');
    expect(g.cards[qb].tapped).toBe(false);
    expect(hasKeyword(g.cards[qb], getCard, 'Haste')).toBe(true);
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(g.cards[qb].controller).toBe('b');
  });

  it('Portable Hole: ETB exiles until it leaves; the card returns when Hole leaves', () => {
    const { g, ctx } = setup(['portable_hole'], ['goblin_guide']);
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const hole = tutor(g, ctx, 'a', 'portable_hole');
    act(g, ctx, 'a', { t: 'addMana', mana: 'W', n: 1 });
    act(g, ctx, 'a', { t: 'cast', iid: hole });
    act(g, ctx, 'b', { t: 'pass' });
    act(g, ctx, 'a', { t: 'chooseTargets', id: g.pending[0].id, targets: [[cardRef(gg)]] });
    drain(g, ctx);
    expect(g.cards[gg].zone).toBe('exile');
    expect(g.effects?.map((e) => e.kind)).toEqual(['exiled']);
    act(g, ctx, 'a', { t: 'move', iid: hole, to: 'hand' });
    expect(g.cards[gg].zone).toBe('battlefield');
    expect(g.cards[gg].controller).toBe('b');
  });

  it('City of Traitors is sacrificed when you play another land (trigger)', () => {
    const { g, ctx } = setup(['city_of_traitors']);
    const city = put(g, ctx, 'a', 'city_of_traitors');
    const land = tutor(g, ctx, 'a', 'basic_mountain');
    act(g, ctx, 'a', { t: 'playLand', iid: land });
    drain(g, ctx);
    expect(g.cards[city].zone).toBe('graveyard');
    expect(g.cards[land].zone).toBe('battlefield');
  });

  it('Dash: Ragavan gains haste and returns to hand at the next end step (delayed trigger)', () => {
    const { g, ctx } = setup(['ragavan_nimble_pilferer']);
    const rag = tutor(g, ctx, 'a', 'ragavan_nimble_pilferer');
    act(g, ctx, 'a', { t: 'addMana', mana: 'R', n: 2 });
    act(g, ctx, 'a', { t: 'cast', iid: rag, costOption: 'dash' });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[rag].zone).toBe('battlefield');
    expect(hasKeyword(g.cards[rag], getCard, 'Haste')).toBe(true);
    act(g, ctx, 'a', { t: 'gotoStep', step: 'end' });
    drain(g, ctx);
    expect(g.cards[rag].zone).toBe('hand');
  });

  it("Thalia's tax applies to an alternative cost", () => {
    const { g, ctx } = setup(['goblin_guide'], ['force_of_will', 'counterspell', 'thalia_guardian_of_thraben']);
    put(g, ctx, 'b', 'thalia_guardian_of_thraben');
    const { spell } = aliceCastsBait(g, ctx);
    const fow = tutor(g, ctx, 'b', 'force_of_will');
    tutor(g, ctx, 'b', 'counterspell');
    act(g, ctx, 'b', { t: 'addMana', mana: 'U', n: 1 });
    act(g, ctx, 'b', { t: 'cast', iid: fow, costOption: 'alt0', targets: [[stackRef(spell.id)]] });
    expect(P(g, 'b').manaPool.U).toBe(0); // {0} + Thalia's {1}
    expect(log(g, 6)).toMatch(/Thalia/);
  });

  it("Teferi, Time Raveler's lock: opponents' instants are refused, force overrides", () => {
    const { g, ctx } = setup(['teferi_time_raveler'], ['lightning_bolt']);
    put(g, ctx, 'a', 'teferi_time_raveler');
    const bolt = tutor(g, ctx, 'b', 'lightning_bolt');
    expect(applyAction(g, 'b', { t: 'cast', iid: bolt, targets: [[player('a')]] }, ctx)).toMatch(/sorcery speed.*force/);
    act(g, ctx, 'b', { t: 'cast', iid: bolt, targets: [[player('a')]], force: true });
    expect(g.stack.at(-1)?.iid).toBe(bolt);
  });
});
