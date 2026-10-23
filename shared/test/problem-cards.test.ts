/** The last hard cube cards: each automated with the real card (strict, rules-enforced games). */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  abilitiesOfInstance, abilityUsability, activatedAbilitiesOf, applyAction, hasKeyword, matchCard, castability, castOptions, castSpellAbility, createGame, effectivePT, faceOf, isCreature, type Ctx, type GameAction, type GameState, manaOptionsFor, moveCard, viewFor,
} from '../src/index.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[], fill = 'basic_island') => [...extra, ...Array(40 - extra.length).fill(fill)];

function setup(a: string[] = [], b: string[] = [], fillA = 'basic_island', fillB = 'basic_mountain', strict = true) {
  const ctx: Ctx = { rng: seeded(11), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(a, fillA), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(b, fillB), side: [] },
  ], 'a', ctx, { strict });
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
  const iid = [...p.zones.hand, ...p.zones.library, ...p.zones.graveyard, ...p.zones.exile].find((i) => g.cards[i].cardId === cardId && !skip.includes(i));
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}
function toHand(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId);
  if (g.cards[iid].zone !== 'hand') moveCard(g, ctx, iid, 'hand');
  return iid;
}
/** Put a permanent onto the battlefield (test setup, no triggers), not summoning sick. */
function put(g: GameState, ctx: Ctx, pid: string, cardId: string, sick = false): string {
  const iid = find(g, pid, cardId, g.battlefield.slice());
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = sick;
  g.events = []; g.triggerQueue = [];
  return iid;
}
function drain(g: GameState, ctx: Ctx) {
  for (let i = 0; i < 30 && g.stack.length && !g.pending.length; i++) act(g, ctx, g.priority, { t: 'pass' });
}
function answer(g: GameState, ctx: Ctx, match: RegExp) {
  const q = g.pending[0];
  if (!q) throw new Error('no question');
  const o = q.options.find((x) => match.test(x.label));
  if (!o) throw new Error(`no option ${match} in ${q.prompt}: ${q.options.map((x) => x.label).join(' / ')}`);
  act(g, ctx, q.pid, { t: 'choose', id: q.id, value: o.value });
}
/** Pass priority (answering questions with their first option) until `done`. */
function passUntil(g: GameState, ctx: Ctx, done: () => boolean) {
  for (let i = 0; i < 80 && !done(); i++) {
    const q = g.pending[0];
    const peeker = g.players.find((p) => p.peek);
    if (q?.options.length) act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options[0].value });
    else if (q?.number) act(g, ctx, q.pid, { t: 'choose', id: q.id, value: String(q.number.min) });
    else if (q?.targets) {
      const opp = q.pid === 'a' ? 'b' : 'a';
      act(g, ctx, q.pid, { t: 'chooseTargets', id: q.id, targets: q.targets.specs.map((s) => (s.min > 0 ? [s.players ? { kind: 'player' as const, pid: opp } : { kind: 'card' as const, iid: g.battlefield[0] }] : [])) });
    } else if (q) throw new Error(`unanswerable: ${q.prompt}`);
    else if (peeker?.peek) act(g, ctx, peeker.pid, { t: 'resolvePeek', top: peeker.peek.iids, bottom: [], graveyard: [], hand: [], battlefield: [], exile: [], shuffle: false });
    else act(g, ctx, g.priority, { t: 'pass' });
  }
  expect(done()).toBe(true);
}
const logText = (g: GameState) => g.log.map((l) => l.text).join('\n');
const lands = (g: GameState, pid: string, cardId: string, n: number) => Array.from({ length: n }, () => put(g, { rng: seeded(1), lookup: getCard, now: 0 }, pid, cardId));

describe('Improvise and Waterbend (auto-pay taps artifacts / creatures for generic mana)', () => {
  it('Kappa Cannoneer: two Islands + four artifacts pay {5}{U}', () => {
    const { g, ctx } = setup(['kappa_cannoneer', 'meekstone', 'skullclamp', 'senseis_divining_top', 'expedition_map']);
    lands(g, 'a', 'basic_island', 2);
    const arts = ['meekstone', 'skullclamp', 'senseis_divining_top', 'expedition_map'].map((id) => put(g, ctx, 'a', id));
    const k = toHand(g, ctx, 'a', 'kappa_cannoneer');
    expect(castability(g, 'a', k, getCard).ok).toBe(true);
    act(g, ctx, 'a', { t: 'cast', iid: k });
    expect(arts.every((i) => g.cards[i].tapped)).toBe(true);
    expect(logText(g)).toMatch(/improvise: pays \{4\}/);
    drain(g, ctx);
    expect(g.cards[k].zone).toBe('battlefield');
  });

  it("Kappa Cannoneer can't be cast with too few artifacts", () => {
    const { g, ctx } = setup(['kappa_cannoneer', 'meekstone']);
    lands(g, 'a', 'basic_island', 2);
    put(g, ctx, 'a', 'meekstone');
    const k = toHand(g, ctx, 'a', 'kappa_cannoneer');
    expect(castability(g, 'a', k, getCard).ok).toBe(false);
  });

  it("Aang's Iceberg: waterbend {3} paid by tapping a creature and artifacts", () => {
    const { g, ctx } = setup(['aangs_iceberg', 'meekstone', 'skullclamp', 'containment_priest']);
    const ice = put(g, ctx, 'a', 'aangs_iceberg');
    const priest = put(g, ctx, 'a', 'containment_priest', true);
    const arts = ['meekstone', 'skullclamp'].map((id) => put(g, ctx, 'a', id));
    const isl = lands(g, 'a', 'basic_island', 1)[0];
    const idx = activatedAbilitiesOf('aangs_iceberg', 0)[0].index;
    expect(abilityUsability(g, 'a', ice, idx, getCard).ok).toBe(true);
    act(g, ctx, 'a', { t: 'activate', iid: ice, ability: idx, text: '' });
    expect(arts.every((i) => g.cards[i].tapped)).toBe(true);
    expect(g.cards[isl].tapped).toBe(true);
    expect(logText(g)).toMatch(/waterbend: pays \{2\}/);
    expect(g.cards[priest].tapped).toBe(false);
  });
});

describe('Urza, Lord High Artificer', () => {
  it('ETB Construct; artifacts tap for {U} (by hand and auto-pay); {5}: exile the top card, play it free', () => {
    const { g, ctx } = setup(['urza_lord_high_artificer', 'meekstone', 'skullclamp']);
    const urza = toHand(g, ctx, 'a', 'urza_lord_high_artificer');
    lands(g, 'a', 'basic_island', 5);
    act(g, ctx, 'a', { t: 'cast', iid: urza });
    drain(g, ctx);
    expect(g.cards[urza].zone).toBe('battlefield');
    const construct = g.battlefield.find((i) => g.cards[i].token?.name === 'Construct')!;
    expect(construct).toBeTruthy();
    const arts = ['meekstone', 'skullclamp'].map((id) => put(g, ctx, 'a', id));
    // one mana option per untapped artifact (the Construct token too)
    const opts = manaOptionsFor(g, urza, getCard);
    expect(opts.length).toBe(3);
    act(g, ctx, 'a', { t: 'activateMana', iid: urza, option: opts.find((o) => o.id.endsWith(`@${arts[0]}`))!.id });
    expect(g.cards[arts[0]].tapped).toBe(true);
    expect(g.players[0].manaPool.U).toBe(1);
    // {5}: floating {U} + two artifacts via Urza is not enough; two more lands are
    const ab5 = activatedAbilitiesOf('urza_lord_high_artificer', 0).find((a) => a.ability.api === 'Shuffle')!.index;
    expect(abilityUsability(g, 'a', urza, ab5, getCard).ok).toBe(false);
    lands(g, 'a', 'basic_island', 2);
    expect(abilityUsability(g, 'a', urza, ab5, getCard).ok).toBe(true);
    act(g, ctx, 'a', { t: 'activate', iid: urza, ability: ab5, text: '' });
    expect(g.players[0].manaPool.U ?? 0).toBe(0);
    expect(logText(g)).toMatch(/Urza, Lord High Artificer for \{U\} \(Tap Construct\)/);
    drain(g, ctx);
    const exiled = g.players[0].zones.exile.at(-1)!;
    expect(castability(g, 'a', exiled, getCard).ok).toBe(true);
  });
});

describe('Once Upon a Time', () => {
  it('free only as the first spell of the game; looks at the top five', () => {
    const { g, ctx } = setup(['once_upon_a_time', 'opt', 'containment_priest'], [], 'basic_forest');
    const ouat = toHand(g, ctx, 'a', 'once_upon_a_time');
    const alt = castOptions(g, ouat).find((o) => /first spell/.test(o.label))!;
    expect(alt).toBeTruthy();
    expect(alt.unavailable).toBeUndefined();
    expect(alt.cost).toBe('{0}');
    act(g, ctx, 'a', { t: 'cast', iid: ouat, costOption: alt.id });
    drain(g, ctx);
    expect(g.pending.length + (g.players[0].peek ? 1 : 0)).toBeGreaterThan(0);
  });

  it('not free after another spell was cast this game', () => {
    const { g, ctx } = setup(['once_upon_a_time', 'opt'], [], 'basic_island');
    lands(g, 'a', 'basic_island', 1);
    const opt = toHand(g, ctx, 'a', 'opt');
    act(g, ctx, 'a', { t: 'cast', iid: opt });
    drain(g, ctx);
    const ouat = toHand(g, ctx, 'a', 'once_upon_a_time');
    const alt = castOptions(g, ouat).find((o) => /first spell/.test(o.label))!;
    expect(alt.unavailable).toMatch(/Condition not met/);
  });
});

describe('Entreat the Angels (miracle with X)', () => {
  it('drawn as the first card of the turn: cast for {X}{W}{W}, choosing X', () => {
    const { g, ctx } = setup(['entreat_the_angels', 'opt', 'basic_island'], [], 'basic_plains');
    lands(g, 'a', 'basic_island', 1);
    lands(g, 'a', 'basic_plains', 4);
    const opt = toHand(g, ctx, 'a', 'opt');
    const ent = find(g, 'a', 'entreat_the_angels');
    moveCard(g, ctx, ent, 'library', { position: 'top' });
    act(g, ctx, 'a', { t: 'cast', iid: opt });
    drain(g, ctx);
    // Opt: scry 1 (keep it on top), then draw it
    if (g.players[0].peek) {
      const pk = g.players[0].peek;
      act(g, ctx, 'a', { t: 'resolvePeek', top: pk.iids, bottom: [], graveyard: [], hand: [], battlefield: [], exile: [], shuffle: false });
    }
    for (let i = 0; i < 5 && g.pending.length && !/X=/.test(g.pending[0].options.map((o) => o.label).join()); i++) answer(g, ctx, /yes|Put|Cast|Miracle|Keep|^Top/i);
    drain(g, ctx);
    const q = g.pending[0];
    expect(q.options.map((o) => o.label)).toContain('Cast Entreat the Angels with X=2');
    answer(g, ctx, /X=2/);
    drain(g, ctx);
    expect(g.battlefield.filter((i) => g.cards[i].token?.name === 'Angel').length).toBe(2);
    expect(g.cards[ent].zone).toBe('graveyard');
  });
});

describe('Glorybringer (exert)', () => {
  it('exerting deals 4 to a non-Dragon creature; it stays tapped during the next untap step', () => {
    const { g, ctx } = setup(['glorybringer'], ['containment_priest']);
    const gb = put(g, ctx, 'a', 'glorybringer');
    const priest = put(g, ctx, 'b', 'containment_priest');
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: gb, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    // the exert trigger asks for its target (or "Don't use it")
    const q = g.pending[0];
    expect(q.targets).toBeTruthy();
    expect(q.options.some((o) => o.value === 'decline')).toBe(true);
    act(g, ctx, 'a', { t: 'chooseTargets', id: q.id, targets: [[{ kind: 'card', iid: priest }]] });
    expect(logText(g)).toMatch(/exerts Glorybringer/);
    drain(g, ctx);
    expect(g.cards[priest].zone).toBe('graveyard');
    for (let i = 0; i < 10 && g.step !== 'main2'; i++) act(g, ctx, g.priority, { t: 'pass' });
    expect(g.players[1].life).toBe(16);
    passUntil(g, ctx, () => g.activePlayer === 'b');
    passUntil(g, ctx, () => g.activePlayer === 'a');
    expect(g.cards[gb].tapped).toBe(true);
    expect(logText(g)).toMatch(/Glorybringer stays tapped \(exerted\)/);
  });

  it('declining: no damage, untaps normally', () => {
    const { g, ctx } = setup(['glorybringer'], ['containment_priest']);
    const gb = put(g, ctx, 'a', 'glorybringer');
    const priest = put(g, ctx, 'b', 'containment_priest');
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: gb, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: 'decline' });
    expect(g.cards[priest].zone).toBe('battlefield');
    expect(g.remembered?.[`exerted|${gb}`]).toBeUndefined();
  });
});

describe('Gideon, Battle-Forged (+2)', () => {
  it("the targeted creature must attack Gideon during its controller's next turn", () => {
    const { g, ctx } = setup(['kytheon_hero_of_akros'], ['containment_priest']);
    const gid = put(g, ctx, 'a', 'kytheon_hero_of_akros');
    g.cards[gid].transformed = true;
    g.cards[gid].counters.loyalty = 3;
    const priest = put(g, ctx, 'b', 'containment_priest');
    const plus2 = activatedAbilitiesOf('kytheon_hero_of_akros', 1).find((a) => a.ability.api === 'DelayedTrigger')!;
    expect(plus2).toBeTruthy();
    act(g, ctx, 'a', { t: 'activate', iid: gid, ability: plus2.index, text: '', targets: [[{ kind: 'card', iid: priest }]] });
    drain(g, ctx);
    expect(g.cards[gid].counters.loyalty).toBe(5);
    passUntil(g, ctx, () => g.activePlayer === 'b' && g.step === 'main1');
    act(g, ctx, 'b', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'b', { t: 'confirmAttackers' });
    expect(logText(g)).toMatch(/Containment Priest attacks \(attacks each combat if able\)/);
    expect(g.cards[gid].counters.loyalty).toBe(3); // dealt 2 damage
  });
});

describe('Nissa, Ascended Animist (compleated)', () => {
  it('enters with 7 loyalty when paid with mana, 3 when both {G/P} were paid with life', () => {
    const { g, ctx } = setup(['nissa_ascended_animist'], [], 'basic_forest');
    lands(g, 'a', 'basic_forest', 5);
    const n = toHand(g, ctx, 'a', 'nissa_ascended_animist');
    act(g, ctx, 'a', { t: 'cast', iid: n });
    drain(g, ctx);
    expect(g.cards[n].zone).toBe('battlefield');
    expect(g.players[0].life).toBe(16);
    expect(g.cards[n].counters.loyalty).toBe(3);
    expect(logText(g)).toMatch(/4 fewer loyalty counters/);
  });

  it('full mana: 7 loyalty', () => {
    const { g, ctx } = setup(['nissa_ascended_animist'], [], 'basic_forest');
    lands(g, 'a', 'basic_forest', 7);
    const n = toHand(g, ctx, 'a', 'nissa_ascended_animist');
    act(g, ctx, 'a', { t: 'cast', iid: n });
    drain(g, ctx);
    expect(g.players[0].life).toBe(20);
    expect(g.cards[n].counters.loyalty).toBe(7);
  });
});

describe('Springheart Nantuko (bestow)', () => {
  it('cast for its bestow cost it enchants a creature (+1/+1); when the creature leaves it becomes a creature', () => {
    const { g, ctx } = setup(['springheart_nantuko', 'containment_priest'], [], 'basic_forest');
    lands(g, 'a', 'basic_forest', 2);
    const priest = put(g, ctx, 'a', 'containment_priest');
    const sn = toHand(g, ctx, 'a', 'springheart_nantuko');
    const opt = castOptions(g, sn).find((o) => o.id === 'bestow')!;
    expect(opt.cost).toBe('{1}{G}');
    expect(castSpellAbility('springheart_nantuko', 0, 'bestow')).toBeTruthy();
    act(g, ctx, 'a', { t: 'cast', iid: sn, costOption: 'bestow', targets: [[{ kind: 'card', iid: priest }]] });
    expect(faceOf(g.cards[sn], getCard).types).not.toContain('Creature');
    drain(g, ctx);
    expect(g.cards[sn].zone).toBe('battlefield');
    expect(g.cards[sn].attachedTo).toBe(priest);
    expect(isCreature(g.cards[sn], getCard, g)).toBe(false);
    expect(effectivePT(g.cards[priest], getCard, g)).toEqual([3, 3]);
    // the enchanted creature leaves: Springheart Nantuko is a 1/1 creature again
    moveCard(g, ctx, priest, 'graveyard');
    act(g, ctx, 'a', { t: 'setStops', own: ['main1', 'main2'], opp: ['end'] });
    expect(g.cards[sn].zone).toBe('battlefield');
    expect(isCreature(g.cards[sn], getCard, g)).toBe(true);
    expect(effectivePT(g.cards[sn], getCard, g)).toEqual([1, 1]);
  });

  it('target gone while on the stack: it resolves as a creature', () => {
    const { g, ctx } = setup(['springheart_nantuko', 'containment_priest'], [], 'basic_forest');
    lands(g, 'a', 'basic_forest', 2);
    const priest = put(g, ctx, 'a', 'containment_priest');
    const sn = toHand(g, ctx, 'a', 'springheart_nantuko');
    act(g, ctx, 'a', { t: 'cast', iid: sn, costOption: 'bestow', targets: [[{ kind: 'card', iid: priest }]] });
    moveCard(g, ctx, priest, 'graveyard');
    drain(g, ctx);
    expect(g.cards[sn].zone).toBe('battlefield');
    expect(isCreature(g.cards[sn], getCard, g)).toBe(true);
  });
});

describe('Serra Paragon', () => {
  it('once per turn: a permanent spell (MV <= 3) from the graveyard gains "dies: exile it, gain 2 life"', () => {
    const { g, ctx } = setup(['serra_paragon', 'containment_priest', 'lightning_bolt', 'basic_mountain', 'basic_island'], [], 'basic_plains');
    put(g, ctx, 'a', 'serra_paragon');
    lands(g, 'a', 'basic_plains', 2);
    lands(g, 'a', 'basic_mountain', 1);
    const priest = find(g, 'a', 'containment_priest');
    moveCard(g, ctx, priest, 'graveyard');
    const isl = find(g, 'a', 'basic_island');
    moveCard(g, ctx, isl, 'graveyard');
    expect(castability(g, 'a', priest, getCard).ok).toBe(true);
    act(g, ctx, 'a', { t: 'cast', iid: priest });
    drain(g, ctx);
    expect(g.cards[priest].zone).toBe('battlefield');
    expect(logText(g)).toMatch(/Containment Priest gains "When this permanent is put into a graveyard/);
    // the once-per-turn permission is used up: no land from the graveyard this turn
    expect(castability(g, 'a', isl, getCard).ok).toBe(false);
    const bolt = toHand(g, ctx, 'a', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: [[{ kind: 'card', iid: priest }]] });
    drain(g, ctx);
    expect(g.cards[priest].zone).toBe('exile');
    expect(g.players[0].life).toBe(22);
  });

  it('plays a land from the graveyard (once per turn), which gains the trigger too', () => {
    const { g, ctx } = setup(['serra_paragon', 'basic_island', 'containment_priest'], [], 'basic_plains');
    put(g, ctx, 'a', 'serra_paragon');
    lands(g, 'a', 'basic_plains', 2);
    const isl = find(g, 'a', 'basic_island');
    moveCard(g, ctx, isl, 'graveyard');
    const priest = find(g, 'a', 'containment_priest');
    moveCard(g, ctx, priest, 'graveyard');
    act(g, ctx, 'a', { t: 'playLand', iid: isl });
    expect(g.cards[isl].zone).toBe('battlefield');
    expect(g.cards[isl].animations?.some((a) => a.grant?.triggers?.length)).toBe(true);
    expect(castability(g, 'a', priest, getCard).ok).toBe(false);
  });
});

describe('Walk-In Closet // Forgotten Cellar (Room)', () => {
  it('casting a door unlocks it; unlocking the other door triggers; locked doors have no abilities', () => {
    const { g, ctx } = setup(['walk_in_closet_forgotten_cellar', 'basic_island', 'once_upon_a_time'], [], 'basic_forest');
    lands(g, 'a', 'basic_forest', 10);
    const room = toHand(g, ctx, 'a', 'walk_in_closet_forgotten_cellar');
    act(g, ctx, 'a', { t: 'cast', iid: room, face: 0 });
    drain(g, ctx);
    expect(g.cards[room].zone).toBe('battlefield');
    expect(g.cards[room].unlocked).toEqual([0]);
    // Walk-In Closet: lands from the graveyard
    const isl = find(g, 'a', 'basic_island');
    moveCard(g, ctx, isl, 'graveyard');
    expect(castability(g, 'a', isl, getCard).ok).toBe(true);
    const ouat = find(g, 'a', 'once_upon_a_time');
    moveCard(g, ctx, ouat, 'graveyard');
    expect(castability(g, 'a', ouat, getCard).ok).toBe(false);
    // unlock Forgotten Cellar ({3}{G}{G})
    const abs = abilitiesOfInstance(g.cards[room]);
    const unlock = abs.find((a) => a.ability.api === '_Unlock')!;
    expect(unlock).toBeTruthy();
    expect(abilityUsability(g, 'a', room, unlock.index, getCard).ok).toBe(true);
    act(g, ctx, 'a', { t: 'activate', iid: room, ability: unlock.index, text: '' });
    expect(g.cards[room].unlocked).toEqual([0, 1]);
    expect(logText(g)).toMatch(/unlocks Forgotten Cellar/);
    drain(g, ctx);
    // you may cast spells from your graveyard this turn; they're exiled instead of going to the graveyard
    expect(castability(g, 'a', ouat, getCard).ok).toBe(true);
    act(g, ctx, 'a', { t: 'cast', iid: ouat });
    drain(g, ctx);
    while (g.pending.length) answer(g, ctx, /./);
    expect(g.cards[ouat].zone).toBe('exile');
    expect(abilitiesOfInstance(g.cards[room]).some((a) => a.ability.api === '_Unlock')).toBe(false);
  });
});

describe('granted triggers (S:AddTrigger)', () => {
  it('Kaldra Compleat: the equipped creature exiles a creature it deals combat damage to', () => {
    const { g, ctx } = setup(['kaldra_compleat', 'stoneforge_mystic'], ['goblin_guide']);
    const kaldra = put(g, ctx, 'a', 'kaldra_compleat');
    const mine = put(g, ctx, 'a', 'stoneforge_mystic');
    g.cards[kaldra].attachedTo = mine;
    const theirs = put(g, ctx, 'b', 'goblin_guide');
    g.cards[theirs].tempKeywords = ['Indestructible'];
    expect(effectivePT(g.cards[mine], getCard, g)).toEqual([6, 7]);
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: mine, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    passUntil(g, ctx, () => g.step === 'blockers' && g.priority === 'b');
    act(g, ctx, 'b', { t: 'declareBlocker', iid: theirs, attacker: mine });
    act(g, ctx, 'b', { t: 'confirmBlockers' });
    passUntil(g, ctx, () => g.cards[theirs].zone !== 'battlefield' || g.step === 'main2');
    expect(g.cards[theirs].zone).toBe('exile');
  });

  it('Nadu, Winged Wisdom: a creature you control becoming a target reveals the top card (land onto the battlefield)', () => {
    const { g, ctx } = setup(['nadu_winged_wisdom', 'lightning_bolt', 'basic_mountain']);
    const nadu = put(g, ctx, 'a', 'nadu_winged_wisdom');
    lands(g, 'a', 'basic_mountain', 1);
    const bolt = toHand(g, ctx, 'a', 'lightning_bolt');
    const before = g.battlefield.length;
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: [[{ kind: 'card', iid: nadu }]] });
    drain(g, ctx);
    expect(logText(g)).toMatch(/Nadu, Winged Wisdom's trigger/);
    expect(g.battlefield.length).toBe(before + 1); // an Island from the top
    expect(g.cards[nadu].zone).toBe('battlefield');
  });
});

describe('Lightning, Army of One (stagger)', () => {
  it('after combat damage to a player, damage to that player and their permanents is doubled until your next turn', () => {
    const { g, ctx } = setup(['lightning_army_of_one', 'lightning_bolt', 'lightning_bolt'], ['goblin_guide'], 'basic_mountain');
    const light = put(g, ctx, 'a', 'lightning_army_of_one');
    const gg = put(g, ctx, 'b', 'goblin_guide');
    g.cards[gg].tapped = true; // no blocks
    lands(g, 'a', 'basic_mountain', 2);
    const pw = effectivePT(g.cards[light], getCard, g)[0];
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: light, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    passUntil(g, ctx, () => g.step === 'main2');
    expect(g.players[1].life).toBe(20 - pw);
    expect(g.effects?.some((e) => e.kind === 'effect' && e.name === 'Lightning, Army of One')).toBe(true);
    const bolt = toHand(g, ctx, 'a', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: [[{ kind: 'player', pid: 'b' }]] });
    drain(g, ctx);
    expect(g.players[1].life).toBe(20 - pw - 6);
    // Goblin Guide (Bob's permanent) takes double damage too
    const bolt2 = toHand(g, ctx, 'a', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: bolt2, targets: [[{ kind: 'card', iid: gg }]] });
    drain(g, ctx);
    expect(logText(g)).toMatch(/Lightning Bolt deals 3 damage to Goblin Guide/);
    expect(g.cards[gg].zone).toBe('graveyard');
  });
});

describe('Grist, the Hunger Tide', () => {
  it("is a 1/1 Insect creature card outside the battlefield, a planeswalker (not a creature) on it", () => {
    const { g, ctx } = setup(['grist_the_hunger_tide', 'grist_the_hunger_tide'], [], 'basic_forest');
    const [g1, g2] = g.players[0].zones.library.filter((i) => g.cards[i].cardId === 'grist_the_hunger_tide');
    moveCard(g, ctx, g1, 'graveyard');
    const f = faceOf(g.cards[g1], getCard);
    expect(f.types).toContain('Creature');
    expect(f.types).toContain('Planeswalker');
    expect(f.typeLine).toMatch(/Insect/);
    expect(f.power).toBe('1');
    expect(matchCard(g.cards[g1], 'Creature', { controller: 'a', lookup: getCard })).toBe(true);
    moveCard(g, ctx, g2, 'battlefield', { controller: 'a' });
    expect(isCreature(g.cards[g2], getCard, g)).toBe(false);
    expect(g.cards[g2].counters.loyalty).toBe(3);
    // -5: each opponent loses life equal to the number of creature cards in your graveyard (Grist counts)
    g.cards[g2].counters.loyalty = 5;
    const minus5 = activatedAbilitiesOf('grist_the_hunger_tide', 0).find((a) => a.loyalty === -5)!;
    act(g, ctx, 'a', { t: 'activate', iid: g2, ability: minus5.index, text: '' });
    drain(g, ctx);
    expect(g.players[1].life).toBe(18); // Grist itself died (0 loyalty) before the ability resolved: two creature cards
  });
});


describe('Sanctum of All (Panharmonicon for Shrines)', () => {
  it("with six Shrines, another Shrine's ability triggers an additional time", () => {
    const shrines = ['sanctum_of_calm_waters', 'honden_of_seeing_winds', 'sanctum_of_stone_fangs', 'honden_of_nights_reach', 'sanctum_of_fruitful_harvest'];
    const { g, ctx } = setup(['sanctum_of_all', ...shrines]);
    put(g, ctx, 'a', 'sanctum_of_all');
    for (const s of shrines) put(g, ctx, 'a', s);
    passUntil(g, ctx, () => g.activePlayer === 'b');
    passUntil(g, ctx, () => g.activePlayer === 'a' && g.step === 'main1' && !g.stack.length && !g.pending.length);
    // Stone Fangs (precombat main): each opponent loses 6, you gain 6 — twice
    expect((logText(g).match(/Sanctum of Stone Fangs's trigger/g) ?? []).length).toBe(2);
    expect(g.players[1].life).toBe(8);
  });

  it('fewer than six Shrines: no extra trigger', () => {
    const { g, ctx } = setup(['sanctum_of_all', 'sanctum_of_stone_fangs']);
    put(g, ctx, 'a', 'sanctum_of_all');
    put(g, ctx, 'a', 'sanctum_of_stone_fangs');
    passUntil(g, ctx, () => g.activePlayer === 'b');
    passUntil(g, ctx, () => g.activePlayer === 'a' && g.step === 'main1' && !g.stack.length && !g.pending.length);
    expect((logText(g).match(/Sanctum of Stone Fangs's trigger/g) ?? []).length).toBe(1);
  });
});

describe("Thespian's Stage", () => {
  it('becomes a copy of a land but keeps its copy ability; copying Dark Depths makes Marit Lage', () => {
    const { g, ctx } = setup(['thespians_stage', 'dark_depths', 'strip_mine'], [], 'basic_island');
    const stage = put(g, ctx, 'a', 'thespians_stage');
    lands(g, 'a', 'basic_island', 4);
    const depths = put(g, ctx, 'a', 'dark_depths');
    g.cards[depths].counters.ice = 10;
    const copyAb = activatedAbilitiesOf('thespians_stage', 0).find((a) => a.ability.api === 'Clone')!;
    act(g, ctx, 'a', { t: 'activate', iid: stage, ability: copyAb.index, text: '', targets: [[{ kind: 'card', iid: depths }]] });
    passUntil(g, ctx, () => !g.stack.length && !g.pending.length);
    expect(g.cards[stage]?.zone ?? 'gone').not.toBe('battlefield'); // the copy of Dark Depths had no ice counters: sacrificed
    const marit = g.battlefield.find((i) => g.cards[i].token?.name === 'Marit Lage');
    expect(marit).toBeTruthy();
  });

  it('the copy keeps "{2}, {T}: becomes a copy of target land, except it has this ability"', () => {
    const { g, ctx } = setup(['thespians_stage', 'strip_mine'], [], 'basic_island');
    const stage = put(g, ctx, 'a', 'thespians_stage');
    lands(g, 'a', 'basic_island', 2);
    const urborg = put(g, ctx, 'a', 'strip_mine');
    const copyAb = activatedAbilitiesOf('thespians_stage', 0).find((a) => a.ability.api === 'Clone')!;
    act(g, ctx, 'a', { t: 'activate', iid: stage, ability: copyAb.index, text: '', targets: [[{ kind: 'card', iid: urborg }]] });
    drain(g, ctx);
    expect(faceOf(g.cards[stage], getCard).name).toBe('Strip Mine');
    const abs = abilitiesOfInstance(g.cards[stage]);
    const kept = abs.find((a) => a.ability.api === 'Clone');
    expect(kept && kept.index >= 3000).toBe(true);
  });
});

describe("Agatha's Soul Cauldron", () => {
  it('exiles a creature card; creatures with +1/+1 counters get its activated abilities, paid with mana of any color', () => {
    const { g, ctx } = setup(['agathas_soul_cauldron', 'stoneforge_mystic', 'kytheon_hero_of_akros'], [], 'basic_island');
    const cauldron = put(g, ctx, 'a', 'agathas_soul_cauldron');
    const sfm = put(g, ctx, 'a', 'stoneforge_mystic');
    const ky = find(g, 'a', 'kytheon_hero_of_akros');
    moveCard(g, ctx, ky, 'graveyard');
    lands(g, 'a', 'basic_island', 3);
    const ab = activatedAbilitiesOf('agathas_soul_cauldron', 0)[0];
    act(g, ctx, 'a', { t: 'activate', iid: cauldron, ability: ab.index, text: '', targets: [[{ kind: 'card', iid: ky }]] });
    for (let i = 0; i < 10 && (g.stack.length || g.pending.length); i++) {
      const q = g.pending[0];
      if (q?.targets) act(g, ctx, 'a', { t: 'chooseTargets', id: q.id, targets: [[{ kind: 'card', iid: sfm }]] });
      else if (q) answer(g, ctx, /./);
      else act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(g.cards[ky].zone).toBe('exile');
    expect(g.cards[sfm].counters['+1/+1']).toBe(1);
    const granted = abilitiesOfInstance(g.cards[sfm], g, getCard).find((a) => a.index >= 4000 && /indestructible/.test(a.ability.description));
    expect(granted).toBeTruthy();
    // {2}{W} with three Islands: mana of any color for creatures' abilities
    expect(abilityUsability(g, 'a', sfm, granted!.index, getCard).ok).toBe(true);
    // The client works from the player's view: the granted ability must show there too, usable with any color.
    const v = viewFor(g, 'a');
    const vg = abilitiesOfInstance(v.cards[sfm] as never, v as never, getCard).find((a) => a.index === granted!.index);
    expect(vg, 'granted ability in the view').toBeTruthy();
    expect(abilityUsability(v as never, 'a', sfm, granted!.index, getCard).ok).toBe(true);
    // An opponent's creature card in their graveyard works the same way.
    act(g, ctx, 'a', { t: 'activate', iid: sfm, ability: granted!.index, text: '' });
    drain(g, ctx);
    expect(hasKeyword(g.cards[sfm], getCard, 'Indestructible', g)).toBe(true);
  });
});
