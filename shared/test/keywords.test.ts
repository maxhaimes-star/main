import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  activatedAbilitiesOf, applyAction, createGame, type Ctx, effectivePT, type GameAction, type GameState, hasKeyword, isCreature, levelStatsOf,
  moveCard, SYNTH_BASE, targetSpecs,
} from '../src/index.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[]) => [...extra, ...Array(40 - extra.length).fill('basic_mountain')];

function setup(aCards: string[], bCards: string[] = [], filler = 'basic_mountain') {
  const ctx: Ctx = { rng: seeded(5), lookup: getCard, now: 0 };
  const d = (x: string[]) => [...x, ...Array(40 - x.length).fill(filler)];
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: filler === 'basic_mountain' ? deck(aCards) : d(aCards), side: [] },
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
const kw = (cardId: string, keyword: string, n = 0) => activatedAbilitiesOf(cardId, 0).filter((e) => e.keyword === keyword)[n];
const card = (iid: string) => ({ kind: 'card' as const, iid });
const resolveAll = (g: GameState, ctx: Ctx) => {
  for (let k = 0; k < 10 && g.stack.length && !g.pending.length; k++) act(g, ctx, g.priority, { t: 'pass' });
};

describe('keyword abilities: synthesis', () => {
  it('indexes and zones', () => {
    const eq = kw('umezawas_jitte', 'Equip');
    expect(eq.index).toBe(SYNTH_BASE + 10 * 0);
    expect(eq.ability.api).toBe('Attach');
    expect(eq.cost).toBe('2');
    expect(eq.zone).toBeUndefined();
    expect(targetSpecs(eq.ability)).toHaveLength(1);
    expect(activatedAbilitiesOf('umezawas_jitte', 0)[0].index).toBe(0); // the A: line keeps its index
    const cyc = kw('lorien_revealed', 'TypeCycling');
    expect(cyc.zone).toBe('hand');
    expect(cyc.ability.description).toMatch(/Islandcycling \{1\}/);
    expect(kw('lion_sash', 'Reconfigure', 1).index).toBe(SYNTH_BASE + 1);
    expect(kw('smugglers_copter', 'Crew').index).toBe(SYNTH_BASE + 10);
    // Channel: an A: line with ActivationZone$ Hand
    expect(activatedAbilitiesOf('boseiju_who_endures', 0).find((e) => e.index === 1)?.zone).toBe('hand');
  });
});

describe('keyword abilities: Equip / Reconfigure', () => {
  it("Umezawa's Jitte: equip a creature at sorcery speed", () => {
    const { g, ctx } = setup(['umezawas_jitte', 'goblin_guide']);
    const j = put(g, ctx, 'a', 'umezawas_jitte');
    const gg = put(g, ctx, 'a', 'goblin_guide');
    P(g, 'a').manaPool = { R: 2 };
    act(g, ctx, 'a', { t: 'activate', iid: j, text: '', ability: kw('umezawas_jitte', 'Equip').index, targets: [[card(gg)]] });
    expect(P(g, 'a').manaPool.R).toBe(0);
    expect(g.stack).toHaveLength(1);
    resolveAll(g, ctx);
    expect(g.cards[j].attachedTo).toBe(gg);
  });

  it('Equip: not at instant speed, not from hand, only your creatures', () => {
    const { g, ctx } = setup(['sword_of_fire_and_ice', 'goblin_guide', 'lightning_bolt'], ['questing_beast']);
    const sw = put(g, ctx, 'a', 'sword_of_fire_and_ice');
    const gg = put(g, ctx, 'a', 'goblin_guide');
    const qb = put(g, ctx, 'b', 'questing_beast');
    const idx = kw('sword_of_fire_and_ice', 'Equip').index;
    expect(applyAction(g, 'a', { t: 'activate', iid: sw, text: '', ability: idx, targets: [[card(qb)]] }, ctx)).toMatch(/illegal target/);
    const bolt = tutor(g, ctx, 'a', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: [[{ kind: 'player', pid: 'b' }]] });
    expect(applyAction(g, 'a', { t: 'activate', iid: sw, text: '', ability: idx, targets: [[card(gg)]] }, ctx)).toMatch(/sorcery/);
    resolveAll(g, ctx);
    moveCard(g, ctx, sw, 'hand');
    expect(applyAction(g, 'a', { t: 'activate', iid: sw, text: '', ability: idx, targets: [[card(gg)]] }, ctx)).toMatch(/only be activated/);
  });

  it("Lion Sash reconfigure: attached it isn't a creature; unattach makes it one again", () => {
    const { g, ctx } = setup(['lion_sash', 'goblin_guide']);
    const ls = put(g, ctx, 'a', 'lion_sash');
    const gg = put(g, ctx, 'a', 'goblin_guide');
    expect(isCreature(g.cards[ls], getCard)).toBe(true);
    act(g, ctx, 'a', { t: 'activate', iid: ls, text: '', ability: kw('lion_sash', 'Reconfigure', 0).index, targets: [[card(gg)]] });
    resolveAll(g, ctx);
    expect(g.cards[ls].attachedTo).toBe(gg);
    expect(isCreature(g.cards[ls], getCard)).toBe(false);
    act(g, ctx, 'a', { t: 'activate', iid: ls, text: '', ability: kw('lion_sash', 'Reconfigure', 1).index });
    resolveAll(g, ctx);
    expect(g.cards[ls].attachedTo).toBeUndefined();
    expect(isCreature(g.cards[ls], getCard)).toBe(true);
  });
});

describe('keyword abilities: from hand', () => {
  it('Lórien Revealed: Islandcycling searches for an Island', () => {
    const { g, ctx } = setup(['lorien_revealed'], [], 'basic_island');
    const lr = tutor(g, ctx, 'a', 'lorien_revealed');
    P(g, 'a').manaPool = { U: 1 };
    act(g, ctx, 'a', { t: 'activate', iid: lr, text: '', ability: kw('lorien_revealed', 'TypeCycling').index });
    expect(g.cards[lr].zone).toBe('graveyard');
    expect(P(g, 'a').manaPool.U).toBe(0);
    resolveAll(g, ctx);
    const q = g.pending[0];
    expect(q.options.every((o) => o.value === 'none' || g.cards[o.value].cardId === 'basic_island')).toBe(true);
    const island = q.options.find((o) => o.value !== 'none')!.value;
    const hand = P(g, 'a').zones.hand.length;
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: island });
    expect(P(g, 'a').zones.hand.length).toBe(hand + 1);
    expect(P(g, 'a').zones.hand.some((i) => g.cards[i].cardId === 'basic_island')).toBe(true);
  });

  it('Cycling: a Triome cycles (discard, draw)', () => {
    const { g, ctx } = setup(['raugrin_triome']);
    const t = tutor(g, ctx, 'a', 'raugrin_triome');
    const hand = P(g, 'a').zones.hand.length;
    act(g, ctx, 'a', { t: 'activate', iid: t, text: '', ability: kw('raugrin_triome', 'Cycling').index });
    resolveAll(g, ctx);
    expect(g.cards[t].zone).toBe('graveyard');
    expect(P(g, 'a').zones.hand.length).toBe(hand); // -1 discarded, +1 drawn
    // Cycling isn't available on the battlefield
    const t2 = g.cards[t];
    moveCard(g, ctx, t2.iid, 'battlefield', { controller: 'a' });
    expect(applyAction(g, 'a', { t: 'activate', iid: t2.iid, text: '', ability: kw('raugrin_triome', 'Cycling').index }, ctx)).toMatch(/only be activated/);
  });

  it('Boseiju, Who Endures: channel from hand destroys an opponent\'s artifact', () => {
    const { g, ctx } = setup(['boseiju_who_endures'], ['umezawas_jitte']);
    const jit = put(g, ctx, 'b', 'umezawas_jitte');
    const bos = tutor(g, ctx, 'a', 'boseiju_who_endures');
    P(g, 'a').manaPool = { G: 2 };
    act(g, ctx, 'a', { t: 'activate', iid: bos, text: '', ability: 1, targets: [[card(jit)]] });
    expect(g.cards[bos].zone).toBe('graveyard');
    expect(g.log.some((l) => /Pay by hand/.test(l.text))).toBe(false);
    resolveAll(g, ctx);
    expect(g.cards[jit].zone).toBe('graveyard');
    // Bob may search for a land (peek); finish it.
    const pk = P(g, 'b').peek;
    if (pk) act(g, ctx, 'b', { t: 'resolvePeek', top: [], bottom: [], graveyard: [], hand: [], battlefield: [], exile: [], shuffle: true });
    // The mana ability isn't activatable from hand; the land's own A: lines still need the battlefield.
    expect(g.stack).toHaveLength(0);
  });
});

describe('keyword abilities: Level up, Crew, Ninjutsu, Ward', () => {
  it('Student of Warfare: level up adds level counters; level stats from its statics', () => {
    const { g, ctx } = setup(['student_of_warfare']);
    const sw = put(g, ctx, 'a', 'student_of_warfare');
    const idx = kw('student_of_warfare', 'Level up').index;
    for (let k = 0; k < 2; k++) {
      P(g, 'a').manaPool = { W: 1 };
      act(g, ctx, 'a', { t: 'activate', iid: sw, text: '', ability: idx });
      resolveAll(g, ctx);
    }
    expect(g.cards[sw].counters.level).toBe(2);
    expect(levelStatsOf(g.cards[sw])).toMatchObject({ power: 3, toughness: 3, keywords: ['First Strike'] });
    // applied by the static-effects layer
    expect(effectivePT(g.cards[sw], getCard, g)).toEqual([3, 3]);
    expect(hasKeyword(g.cards[sw], getCard, 'First strike', g)).toBe(true);
    g.cards[sw].counters.level = 7;
    expect(levelStatsOf(g.cards[sw])).toMatchObject({ power: 4, toughness: 4, keywords: ['Double Strike'] });
    expect(effectivePT(g.cards[sw], getCard, g)).toEqual([4, 4]);
    expect(hasKeyword(g.cards[sw], getCard, 'Double strike', g)).toBe(true);
  });

  it("Smuggler's Copter: crew 1 taps a creature and makes it a creature until end of turn", () => {
    const { g, ctx } = setup(['smugglers_copter', 'goblin_guide']);
    const sc = put(g, ctx, 'a', 'smugglers_copter');
    const gg = put(g, ctx, 'a', 'goblin_guide');
    expect(isCreature(g.cards[sc], getCard)).toBe(false);
    act(g, ctx, 'a', { t: 'activate', iid: sc, text: '', ability: kw('smugglers_copter', 'Crew').index });
    expect(g.pending).toHaveLength(1);
    const q = g.pending[0];
    expect(q.options.map((o) => o.value)).toContain(gg);
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: gg });
    expect(g.cards[gg].tapped).toBe(true);
    expect(g.pending).toHaveLength(0);
    resolveAll(g, ctx);
    expect(isCreature(g.cards[sc], getCard)).toBe(true);
    expect(effectivePT(g.cards[sc], getCard)).toEqual([3, 3]);
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(isCreature(g.cards[sc], getCard)).toBe(false);
  });

  it('Crew needs enough power', () => {
    const { g, ctx } = setup(['smugglers_copter']);
    const sc = put(g, ctx, 'a', 'smugglers_copter');
    expect(applyAction(g, 'a', { t: 'activate', iid: sc, text: '', ability: kw('smugglers_copter', 'Crew').index }, ctx)).toMatch(/Crew 1/);
  });

  it('Ninjutsu: swap an unblocked attacker for the ninja, tapped and attacking', () => {
    const { g, ctx } = setup(['fallen_shinobi', 'goblin_guide']);
    const gg = put(g, ctx, 'a', 'goblin_guide');
    const fs = tutor(g, ctx, 'a', 'fallen_shinobi');
    const idx = kw('fallen_shinobi', 'Ninjutsu').index;
    expect(applyAction(g, 'a', { t: 'activate', iid: fs, text: '', ability: idx, targets: [[card(gg)]] }, ctx)).toMatch(/illegal target/); // not attacking
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: gg, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    // Goblin Guide's attack trigger resolves first.
    for (let k = 0; k < 20 && g.step === 'attackers'; k++) {
      const q = g.pending[0];
      if (q) { act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options[0].value }); continue; }
      act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(g.step).toBe('blockers');
    act(g, ctx, 'b', { t: 'confirmBlockers' });
    expect(g.combat.blockersDeclared).toBe(true);
    P(g, 'a').manaPool = { U: 1, B: 1, C: 2 };
    act(g, ctx, 'a', { t: 'activate', iid: fs, text: '', ability: idx, targets: [[card(gg)]] });
    expect(g.cards[gg].zone).toBe('hand');
    resolveAll(g, ctx);
    expect(g.cards[fs].zone).toBe('battlefield');
    expect(g.cards[fs].tapped).toBe(true);
    expect(g.cards[fs].attacking).toBe('b');
  });

  it('Ward: targeting an opponent\'s ward permanent triggers "counter it unless that player pays"', () => {
    const { g, ctx } = setup(['lightning_bolt'], ['kappa_cannoneer']);
    const kc = put(g, ctx, 'b', 'kappa_cannoneer');
    const bolt = tutor(g, ctx, 'a', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: [[card(kc)]] });
    // the ward trigger goes on the stack above the Bolt
    expect(g.stack).toHaveLength(2);
    expect(g.stack[1].text).toMatch(/Ward \{4\}/);
    act(g, ctx, 'a', { t: 'pass' }); // the ward trigger resolves; a can't pay {4}: Bolt is countered without a question
    expect(g.pending).toHaveLength(0);
    expect(g.cards[bolt].zone).toBe('graveyard');
    expect(g.stack).toHaveLength(0);
    expect(g.cards[kc].damage).toBe(0);
  });
});
