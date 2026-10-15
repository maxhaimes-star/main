/** The last hard cube cards: each automated with the real card (strict, rules-enforced games). */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  abilityUsability, activatedAbilitiesOf, applyAction, castability, castOptions, createGame, type Ctx, type GameAction, type GameState, manaOptionsFor, moveCard,
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
  for (let i = 0; i < 60 && !done(); i++) {
    const q = g.pending[0];
    if (q) act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options[0].value });
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
