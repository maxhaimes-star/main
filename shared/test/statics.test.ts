import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  activeStatics, applyAction, computeCombat, createGame, type Ctx, effectiveCost, effectivePT, type GameAction, type GameState,
  hasKeyword, moveCard, parseStatic, staticGaps, viewFor,
} from '../src/index.ts';
import { SCRIPTS } from '../src/engine/script.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[]) => [...extra, ...Array(40 - extra.length).fill('basic_mountain')];

function setup(aCards: string[], bCards: string[] = []) {
  const ctx: Ctx = { rng: seeded(7), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(aCards), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(bCards), side: [] },
  ], 'a', ctx);
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
function toGraveyard(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId);
  moveCard(g, ctx, iid, 'graveyard');
  return iid;
}
const player = (pid: string) => ({ kind: 'player' as const, pid });
const cardRef = (iid: string) => ({ kind: 'card' as const, iid });
const pt = (g: GameState, iid: string) => effectivePT(g.cards[iid], getCard, g);

describe('statics: continuous effects', () => {
  it('Elesh Norn: anthem for your other creatures, -2/-2 for opponents; SBA kills 0-toughness creatures', () => {
    const { g, ctx } = setup(['elesh_norn_grand_cenobite', 'thalia_guardian_of_thraben', 'lightning_bolt'], ['goblin_guide', 'questing_beast']);
    const norn = put(g, ctx, 'a', 'elesh_norn_grand_cenobite');
    const thalia = put(g, ctx, 'a', 'thalia_guardian_of_thraben');
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const qb = put(g, ctx, 'b', 'questing_beast');
    expect(pt(g, norn)).toEqual([4, 7]);
    expect(pt(g, thalia)).toEqual([4, 3]);
    expect(pt(g, gg)).toEqual([0, 0]);
    expect(pt(g, qb)).toEqual([2, 2]);
    // without state: printed values (backwards compatible)
    expect(effectivePT(g.cards[thalia], getCard)).toEqual([2, 1]);
    // the client view sees the same numbers
    expect(effectivePT(g.cards[thalia], getCard, viewFor(g, 'b'))).toEqual([4, 3]);
    // any state-based check now kills the 0/0 Goblin Guide; bolt (+ Thalia tax) finishes Questing Beast
    act(g, ctx, 'a', { t: 'addMana', mana: 'R', n: 2 });
    act(g, ctx, 'a', { t: 'cast', iid: tutor(g, ctx, 'a', 'lightning_bolt'), targets: [[cardRef(qb)]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[gg].zone).toBe('graveyard');
    expect(g.cards[qb].zone).toBe('graveyard');
    // Norn leaves: back to printed
    moveCard(g, ctx, norn, 'graveyard');
    expect(pt(g, thalia)).toEqual([2, 1]);
    const list = activeStatics(g, getCard);
    expect(list.some((s) => s.sourceIid === thalia && s.support === 'full')).toBe(true);
  });

  it('equipment grants keywords: Lightning Greaves gives shroud (blocks targeting) and haste', () => {
    const { g, ctx } = setup(['lightning_greaves', 'lightning_bolt'], ['goblin_guide', 'lightning_greaves']);
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const lg = put(g, ctx, 'b', 'lightning_greaves');
    expect(hasKeyword(g.cards[gg], getCard, 'Shroud', g)).toBe(false);
    act(g, ctx, 'b', { t: 'attach', iid: lg, to: gg });
    expect(hasKeyword(g.cards[gg], getCard, 'Shroud', g)).toBe(true);
    expect(hasKeyword(g.cards[gg], getCard, 'Shroud')).toBe(false);
    const bolt = tutor(g, ctx, 'a', 'lightning_bolt');
    expect(applyAction(g, 'a', { t: 'cast', iid: bolt, targets: [[cardRef(gg)]] }, ctx)).toMatch(/illegal target/);
  });

  it('Barrowgoyf / Nethergoyf: characteristic-defining P/T from card types in graveyards', () => {
    const { g, ctx } = setup(['barrowgoyf', 'nethergoyf', 'lightning_bolt'], ['goblin_guide']);
    const bg = put(g, ctx, 'a', 'barrowgoyf');
    const ng = put(g, ctx, 'a', 'nethergoyf');
    expect(pt(g, bg)).toEqual([0, 1]);
    toGraveyard(g, ctx, 'a', 'lightning_bolt'); // instant (Alice)
    toGraveyard(g, ctx, 'b', 'goblin_guide'); // creature (Bob)
    toGraveyard(g, ctx, 'b', 'basic_mountain'); // land (Bob)
    expect(pt(g, bg)).toEqual([3, 4]); // all graveyards
    expect(pt(g, ng)).toEqual([1, 2]); // only its owner's graveyard
  });

  it('Construct token (Urza\'s Saga / Karn) gets +1/+1 per artifact you control and survives SBA', () => {
    const { g, ctx } = setup(['urzas_bauble', 'lightning_bolt']);
    act(g, ctx, 'a', { t: 'createToken', token: SCRIPTS.tokens.c_0_0_a_construct_total_artifacts, n: 1 });
    const construct = g.battlefield.find((i) => g.cards[i].token?.name === 'Construct')!;
    expect(pt(g, construct)).toEqual([1, 1]);
    put(g, ctx, 'a', 'urzas_bauble');
    expect(pt(g, construct)).toEqual([2, 2]);
  });
});

describe('statics: costs', () => {
  it('Thalia taxes noncreature spells paid from the pool (not creatures)', () => {
    const { g, ctx } = setup(['thalia_guardian_of_thraben', 'lightning_bolt', 'goblin_guide']);
    put(g, ctx, 'a', 'thalia_guardian_of_thraben');
    const bolt = tutor(g, ctx, 'a', 'lightning_bolt');
    const gg = tutor(g, ctx, 'a', 'goblin_guide');
    expect(effectiveCost(g, bolt, 0, getCard)).toBe('{1}{R}');
    expect(effectiveCost(g, gg, 0, getCard)).toBe('{R}');
    act(g, ctx, 'a', { t: 'addMana', mana: 'R', n: 1 });
    act(g, ctx, 'a', { t: 'addMana', mana: 'C', n: 1 });
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: [[player('b')]] });
    expect(P(g, 'a').manaPool).toEqual({ R: 0, C: 0 });
    expect(g.log.at(-1)!.text).toMatch(/Thalia, Guardian of Thraben \+\{1\}/);
  });

  it('Leyline Binding costs {1} less per basic land type among your lands (domain)', () => {
    const { g, ctx } = setup(['leyline_binding', 'basic_forest', 'basic_island']);
    const lb = tutor(g, ctx, 'a', 'leyline_binding');
    expect(effectiveCost(g, lb, 0, getCard)).toBe('{5}{W}');
    put(g, ctx, 'a', 'basic_mountain');
    put(g, ctx, 'a', 'basic_forest');
    put(g, ctx, 'a', 'basic_island');
    expect(effectiveCost(g, lb, 0, getCard)).toBe('{2}{W}');
    act(g, ctx, 'a', { t: 'addMana', mana: 'W', n: 1 });
    act(g, ctx, 'a', { t: 'addMana', mana: 'C', n: 2 });
    act(g, ctx, 'a', { t: 'cast', iid: lb });
    expect(Object.values(P(g, 'a').manaPool).reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('statics: ability costs', () => {
  it('Zirda reduces activated abilities by {2} (min one mana) but not spells', () => {
    const { g, ctx } = setup(['zirda_the_dawnwaker', 'kytheon_hero_of_akros', 'lightning_bolt']);
    put(g, ctx, 'a', 'zirda_the_dawnwaker');
    const ky = put(g, ctx, 'a', 'kytheon_hero_of_akros');
    expect(effectiveCost(g, tutor(g, ctx, 'a', 'lightning_bolt'), 0, getCard)).toBe('{R}');
    act(g, ctx, 'a', { t: 'addMana', mana: 'W', n: 1 });
    act(g, ctx, 'a', { t: 'addMana', mana: 'R', n: 1 });
    act(g, ctx, 'a', { t: 'activate', iid: ky, text: '', ability: 0 });
    expect(P(g, 'a').manaPool).toEqual({ W: 0, R: 1 });
    expect(g.log.at(-1)!.text).toMatch(/Zirda/);
  });
});

describe('statics: restrictions', () => {
  it('Ensnaring Bridge: creatures with power > its controller\'s hand size can\'t attack; force overrides', () => {
    const { g, ctx } = setup(['questing_beast', 'goblin_guide'], ['ensnaring_bridge']);
    const qb = put(g, ctx, 'a', 'questing_beast');
    const gg = put(g, ctx, 'a', 'goblin_guide');
    put(g, ctx, 'b', 'ensnaring_bridge');
    for (const iid of P(g, 'b').zones.hand.slice(2)) moveCard(g, ctx, iid, 'library');
    expect(P(g, 'b').zones.hand).toHaveLength(2);
    act(g, ctx, 'a', { t: 'pass' });
    expect(g.step).toBe('attackers');
    expect(applyAction(g, 'a', { t: 'declareAttacker', iid: qb, target: 'b' }, ctx)).toMatch(/can't attack/);
    act(g, ctx, 'a', { t: 'declareAttacker', iid: gg, target: 'b' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: qb, target: 'b', force: true });
    expect(g.cards[qb].attacking).toBe('b');
  });

  it('Glacial Chasm: your creatures can\'t attack', () => {
    const { g, ctx } = setup(['glacial_chasm', 'goblin_guide']);
    put(g, ctx, 'a', 'glacial_chasm');
    const gg = put(g, ctx, 'a', 'goblin_guide');
    act(g, ctx, 'a', { t: 'pass' });
    expect(applyAction(g, 'a', { t: 'declareAttacker', iid: gg, target: 'b' }, ctx)).toMatch(/can't attack/);
  });

  it('Teferi, Time Raveler: opponents cast only at sorcery speed; force overrides', () => {
    const { g, ctx } = setup(['teferi_time_raveler', 'lightning_bolt'], ['lightning_bolt', 'counterspell']);
    put(g, ctx, 'a', 'teferi_time_raveler');
    const boltB = tutor(g, ctx, 'b', 'lightning_bolt');
    expect(applyAction(g, 'b', { t: 'cast', iid: boltB, targets: [[player('a')]] }, ctx)).toMatch(/sorcery/);
    // Teferi's controller is unaffected
    const boltA = tutor(g, ctx, 'a', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: boltA, targets: [[player('b')]] });
    const cs = tutor(g, ctx, 'b', 'counterspell');
    expect(applyAction(g, 'b', { t: 'cast', iid: cs, targets: [[{ kind: 'stack', id: g.stack[0].id }]] }, ctx)).toMatch(/sorcery/);
    act(g, ctx, 'b', { t: 'cast', iid: cs, targets: [[{ kind: 'stack', id: g.stack[0].id }]], force: true });
    expect(g.stack).toHaveLength(2);
  });

  it('Bloodghast can\'t block; Questing Beast can\'t be blocked by power 2 or less', () => {
    const { g, ctx } = setup(['questing_beast', 'goblin_guide'], ['bloodghast', 'goblin_guide']);
    const qb = put(g, ctx, 'a', 'questing_beast');
    const bgh = put(g, ctx, 'b', 'bloodghast');
    const gg = put(g, ctx, 'b', 'goblin_guide');
    act(g, ctx, 'a', { t: 'pass' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: qb, target: 'b' });
    act(g, ctx, 'a', { t: 'pass' });
    expect(g.step).toBe('blockers');
    expect(applyAction(g, 'b', { t: 'declareBlocker', iid: bgh, attacker: qb }, ctx)).toMatch(/can't block/);
    expect(applyAction(g, 'b', { t: 'declareBlocker', iid: gg, attacker: qb }, ctx)).toMatch(/can't block/);
    act(g, ctx, 'b', { t: 'declareBlocker', iid: gg, attacker: qb, force: true });
    expect(g.cards[gg].blocking).toBe(qb);
  });
});

describe('statics: combat', () => {
  it('combat uses static P/T and keywords (Shadowspear: +1/+1, trample, lifelink)', () => {
    const { g, ctx } = setup(['goblin_guide', 'shadowspear'], ['basic_mountain']);
    const gg = put(g, ctx, 'a', 'goblin_guide');
    const sp = put(g, ctx, 'a', 'shadowspear');
    act(g, ctx, 'a', { t: 'attach', iid: sp, to: gg });
    g.cards[gg].attacking = 'b';
    const prop = computeCombat(g, getCard);
    expect(prop.lifeChange.b).toBe(-3);
    expect(prop.lifeChange.a).toBe(3);
  });
});

describe('statics: parsing / support', () => {
  it('classifies supported statics', () => {
    expect(staticGaps(parseStatic('Mode$ Continuous | Affected$ Creature.YouCtrl+Other | AddPower$ 1 | AddToughness$ 1 | AddKeyword$ Flying'))).toEqual([]);
    expect(staticGaps(parseStatic('Mode$ RaiseCost | ValidCard$ Card.nonCreature | Type$ Spell | Amount$ 1'))).toEqual([]);
    expect(staticGaps(parseStatic('Mode$ Continuous | Affected$ Land.YouOwn | MayPlay$ True | AffectedZone$ Graveyard')).length).toBeGreaterThan(0);
  });
});
