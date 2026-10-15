import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import { activatedAbilitiesOf, applyAction, castOptions, createGame, type Ctx, FOREIGN_BASE, foreignAbilities, type GameAction, type GameState, moveCard, playerKeywords } from '../src/index.ts';
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
function resolveAll(g: GameState, ctx: Ctx) {
  for (let k = 0; k < 20 && g.stack.length; k++) {
    if (g.pending.length) throw new Error(`pending: ${g.pending[0].prompt}`);
    act(g, ctx, g.priority, { t: 'pass' });
  }
}
const cardRef = (iid: string) => ({ kind: 'card' as const, iid });
const logText = (g: GameState) => g.log.map((l) => l.text).join('\n');

describe('triggered keywords (engine/kwtriggers.ts)', () => {
  it('Persist: Glen Elendra Archmage returns with a -1/-1 counter, then stays dead', () => {
    const { g, ctx } = setup(['glen_elendra_archmage', 'lightning_bolt', 'lightning_bolt']);
    const ge = put(g, ctx, 'a', 'glen_elendra_archmage');
    act(g, ctx, 'a', { t: 'cast', iid: tutor(g, ctx, 'a', 'lightning_bolt'), targets: [[cardRef(ge)]] });
    resolveAll(g, ctx);
    expect(g.cards[ge].zone).toBe('battlefield');
    expect(g.cards[ge].counters['-1/-1']).toBe(1);
    const bolt2 = P(g, 'a').zones.library.find((i) => g.cards[i].cardId === 'lightning_bolt')!;
    moveCard(g, ctx, bolt2, 'hand');
    act(g, ctx, 'a', { t: 'cast', iid: bolt2, targets: [[cardRef(ge)]] });
    resolveAll(g, ctx);
    expect(g.cards[ge].zone).toBe('graveyard');
  });

  it('Living weapon: Batterskull enters attached to a 0/0 Germ', () => {
    const { g, ctx } = setup(['batterskull']);
    const bs = find(g, 'a', 'batterskull');
    act(g, ctx, 'a', { t: 'move', iid: bs, to: 'battlefield' });
    resolveAll(g, ctx);
    const germ = g.battlefield.find((i) => g.cards[i].token?.name === 'Phyrexian Germ');
    expect(germ).toBeDefined();
    expect(g.cards[bs].attachedTo).toBe(germ);
  });

  it('Exalted: Noble Hierarch pumps a creature attacking alone', () => {
    const { g, ctx } = setup(['noble_hierarch', 'goblin_guide']);
    put(g, ctx, 'a', 'noble_hierarch');
    const gg = put(g, ctx, 'a', 'goblin_guide');
    act(g, ctx, 'a', { t: 'pass' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: gg, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    const exalted = g.stack.find((s) => /Exalted/.test(s.text));
    expect(exalted).toBeDefined();
    resolveAll(g, ctx);
    expect(logText(g)).toMatch(/Goblin Guide gets \+1\/\+1/);
  });

  it('Fading: Parallax Wave loses a fade counter each upkeep', () => {
    const { g, ctx } = setup(['parallax_wave']);
    const pw = find(g, 'a', 'parallax_wave');
    act(g, ctx, 'a', { t: 'move', iid: pw, to: 'battlefield' });
    resolveAll(g, ctx);
    expect(g.cards[pw].counters.fade).toBe(5);
    act(g, ctx, 'a', { t: 'nextTurn' });
    act(g, ctx, 'b', { t: 'nextTurn' });
    resolveAll(g, ctx);
    expect(g.cards[pw].counters.fade).toBe(4);
  });

  it('Rebound: Ephemerate is exiled and offered again at the next upkeep', () => {
    const { g, ctx } = setup(['ephemerate', 'thraben_inspector']);
    const ti = put(g, ctx, 'a', 'thraben_inspector');
    const eph = tutor(g, ctx, 'a', 'ephemerate');
    act(g, ctx, 'a', { t: 'cast', iid: eph, targets: [[cardRef(ti)]] });
    resolveAll(g, ctx);
    expect(g.cards[eph].zone).toBe('exile');
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(g.delayedTriggers?.length).toBe(1); // not on the opponent's upkeep
    act(g, ctx, 'b', { t: 'nextTurn' });
    expect(g.stack.some((s) => /rebound/.test(s.text))).toBe(true);
    act(g, ctx, g.priority, { t: 'pass' });
    if (g.priority !== 'a' || !g.pending.length) act(g, ctx, g.priority, { t: 'pass' });
    const q = g.pending[0];
    expect(q?.prompt).toMatch(/cast Ephemerate/);
  });
});

describe('divided damage and player keywords', () => {
  it('Fury: the ETB trigger asks for the division of 4 damage', () => {
    const { g, ctx } = setup(['fury'], ['goblin_guide', 'goblin_guide']);
    const g1 = put(g, ctx, 'b', 'goblin_guide');
    const g2 = P(g, 'b').zones.library.find((i) => g.cards[i].cardId === 'goblin_guide')!;
    moveCard(g, ctx, g2, 'battlefield', { controller: 'b' });
    act(g, ctx, 'a', { t: 'move', iid: find(g, 'a', 'fury'), to: 'battlefield' });
    const tq = g.pending[0];
    expect(tq.targets).toBeDefined();
    act(g, ctx, 'a', { t: 'chooseTargets', id: tq.id, targets: [[cardRef(g1), cardRef(g2)]] });
    act(g, ctx, g.priority, { t: 'pass' });
    if (!g.pending.length) act(g, ctx, g.priority, { t: 'pass' });
    const dq = g.pending[0];
    expect(dq.divide).toMatchObject({ total: 4, min: 1 });
    expect(applyAction(g, 'a', { t: 'choose', id: dq.id, value: JSON.stringify({ [g1]: 1, [g2]: 1 }) }, ctx)).toMatch(/total 4/);
    act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: JSON.stringify({ [g1]: 2, [g2]: 2 }) });
    expect(g.cards[g1].zone).toBe('graveyard');
    expect(g.cards[g2].zone).toBe('graveyard');
  });

  it('The One Ring: you gain protection from everything until your next turn', () => {
    const { g, ctx } = setup(['the_one_ring']);
    const ring = tutor(g, ctx, 'a', 'the_one_ring');
    P(g, 'a').manaPool = { C: 4 };
    act(g, ctx, 'a', { t: 'cast', iid: ring });
    resolveAll(g, ctx);
    expect(playerKeywords(g, 'a', getCard)).toContain('Protection from everything');
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(playerKeywords(g, 'a', getCard)).toContain('Protection from everything');
    act(g, ctx, 'b', { t: 'nextTurn' });
    expect(playerKeywords(g, 'a', getCard)).not.toContain('Protection from everything');
  });
});

describe('abilities granted by other objects (engine/grants.ts)', () => {
  it('Splinter Twin: the enchanted creature gets "{T}: create a hasty token copy"', () => {
    const { g, ctx } = setup(['splinter_twin', 'goblin_guide']);
    const gg = put(g, ctx, 'a', 'goblin_guide');
    const st = put(g, ctx, 'a', 'splinter_twin');
    g.cards[st].attachedTo = gg;
    const granted = foreignAbilities(g, gg, getCard);
    expect(granted).toHaveLength(1);
    expect(granted[0].index).toBe(FOREIGN_BASE);
    act(g, ctx, 'a', { t: 'activate', iid: gg, text: '', ability: FOREIGN_BASE, targets: [] });
    expect(g.cards[gg].tapped).toBe(true);
    resolveAll(g, ctx);
    expect(g.battlefield.filter((i) => g.cards[i].controller === 'a' && /Goblin Guide/.test(logText(g)) && i !== gg && g.cards[i].token)).toHaveLength(1);
  });
});

describe('cast keywords (engine/castkw.ts)', () => {
  it('Bone Shards: either additional cost is an option', () => {
    const { g, ctx } = setup(['bone_shards']);
    const bs = tutor(g, ctx, 'a', 'bone_shards');
    const opts = castOptions(g, bs);
    expect(opts.map((o) => o.id)).toEqual(expect.arrayContaining(['normal', 'altadd']));
    expect(opts.find((o) => o.id === 'normal')?.extra.join(' ')).toMatch(/Sacrifice/);
    expect(opts.find((o) => o.id === 'altadd')?.extra.join(' ')).toMatch(/Discard/);
  });

  it('Everflowing Chalice: multikicker twice enters with two charge counters', () => {
    const { g, ctx } = setup(['everflowing_chalice']);
    const ec = tutor(g, ctx, 'a', 'everflowing_chalice');
    expect(castOptions(g, ec).some((o) => o.id === 'multikicker2' && /\{2\}\{2\}/.test(o.cost))).toBe(true);
    P(g, 'a').manaPool = { C: 4 };
    act(g, ctx, 'a', { t: 'cast', iid: ec, costOption: 'multikicker2' });
    resolveAll(g, ctx);
    expect(g.cards[ec].zone).toBe('battlefield');
    expect(g.cards[ec].counters.charge).toBe(2);
  });

  it("Madness: Anje's Ravager discarded is exiled and may be cast for its madness cost", () => {
    const { g, ctx } = setup(['anjes_ravager']);
    const ar = tutor(g, ctx, 'a', 'anjes_ravager');
    moveCard(g, ctx, ar, 'graveyard', { cause: 'discard' });
    expect(g.cards[ar].zone).toBe('exile');
    P(g, 'a').manaPool = { R: 2 };
    act(g, ctx, 'a', { t: 'pass' });
    for (let k = 0; k < 4 && !g.pending.length && g.stack.length; k++) act(g, ctx, g.priority, { t: 'pass' });
    const q = g.pending[0];
    expect(q?.prompt).toMatch(/cast Anje's Ravager/);
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: 'yes' });
    expect(g.cards[ar].zone).toBe('stack');
  });

  it("Foretell: Alrund's Epiphany is exiled face down for {2}, then cast on a later turn for its foretell cost", () => {
    const { g, ctx } = setup(['alrunds_epiphany']);
    const ae = tutor(g, ctx, 'a', 'alrunds_epiphany');
    const fore = activatedAbilitiesOf('alrunds_epiphany', 0).find((e) => e.keyword === 'Foretell')!;
    P(g, 'a').manaPool = { C: 2 };
    act(g, ctx, 'a', { t: 'activate', iid: ae, text: '', ability: fore.index, targets: [] });
    expect(g.cards[ae].zone).toBe('exile');
    expect(g.cards[ae].faceDown).toBe(true);
    expect(g.stack).toHaveLength(0);
    expect(logText(g)).not.toMatch(/Alrund/);
    expect(castOptions(g, ae).find((o) => o.id === 'foretell')?.unavailable).toMatch(/turn you foretold/);
    act(g, ctx, 'a', { t: 'nextTurn' });
    act(g, ctx, 'b', { t: 'nextTurn' });
    for (let k = 0; k < 6 && g.step !== 'main1'; k++) act(g, ctx, g.priority, { t: 'pass' });
    expect(castOptions(g, ae).find((o) => o.id === 'foretell')?.unavailable).toBeUndefined();
    P(g, 'a').manaPool = { C: 2, U: 2 };
    act(g, ctx, 'a', { t: 'cast', iid: ae, costOption: 'foretell' });
    expect(g.cards[ae].zone).toBe('stack');
    expect(g.cards[ae].faceDown).toBeFalsy();
  });

  it('Spectacle needs an opponent to have lost life this turn', () => {
    const { g, ctx } = setup(['light_up_the_stage', 'lightning_bolt']);
    const lu = tutor(g, ctx, 'a', 'light_up_the_stage');
    expect(castOptions(g, lu).find((o) => o.id === 'spectacle')?.unavailable).toMatch(/lost life/);
    P(g, 'a').manaPool = { R: 1 };
    act(g, ctx, 'a', { t: 'cast', iid: tutor(g, ctx, 'a', 'lightning_bolt'), targets: [[{ kind: 'player', pid: 'b' }]] });
    resolveAll(g, ctx);
    expect(castOptions(g, lu).find((o) => o.id === 'spectacle')?.unavailable).toBeUndefined();
  });
});
