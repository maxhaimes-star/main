/** No manual steps in strict (Arena-style) games: user-reported rules bugs, with the real cube scripts. */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import { CUBE } from '../src/cube.ts';
import {
  abilitiesOfInstance, abilityUsability, activatedAbilitiesOf, applyAction, handClick, castableFaces, castOptions, createGame, type Ctx, type GameAction, type GameState, getScript, isAutomatable,
  mayPlayFrom, moveCard, parseStatic, scriptRef, spellAbility, staticGaps, triggerSupport,
} from '../src/index.ts';
import { createTokenInstance } from '../src/engine/resolve.ts';
import { effectivePT, faceOf } from '../src/game/rules.ts';
import { SCRIPTS } from '../src/engine/script.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[], fill = 'basic_mountain') => [...extra, ...Array(40 - extra.length).fill(fill)];

function setup(a: string[] = [], b: string[] = [], fillA = 'basic_mountain', fillB = 'basic_mountain', first = 'a') {
  const ctx: Ctx = { rng: seeded(7), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(a, fillA), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(b, fillB), side: [] },
  ], first, ctx);
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

type Q = GameState['pending'][number];

/** Answer pending questions with the first option (or `pick`). */
function answer(g: GameState, ctx: Ctx, pick?: (q: Q) => string) {
  for (let i = 0; i < 20 && g.pending.length; i++) {
    const q = g.pending[0];
    act(g, ctx, q.pid, { t: 'choose', id: q.id, value: pick ? pick(q) : q.options[0].value });
  }
}

function drain(g: GameState, ctx: Ctx, pick?: (q: Q) => string) {
  for (let i = 0; i < 40 && (g.stack.length || g.pending.length); i++) {
    if (g.pending.length) { answer(g, ctx, pick); continue; }
    act(g, ctx, g.priority, { t: 'pass' });
  }
}

/** Pass priority until something needs an answer or the stack is empty. */
function passUntilQuestion(g: GameState, ctx: Ctx) {
  for (let i = 0; i < 10 && g.stack.length && !g.pending.length && !g.players.some((p) => p.peek); i++) act(g, ctx, g.priority, { t: 'pass' });
}

/** Put these cards (by card id, from anywhere but the battlefield) on top of `pid`'s library in this order. */
function stackLibrary(g: GameState, pid: string, ids: string[]): string[] {
  const p = g.players.find((x) => x.pid === pid)!;
  const used: string[] = [];
  const iids = ids.map((id) => {
    const iid = [...p.zones.library, ...p.zones.hand].find((i) => g.cards[i].cardId === id && !used.includes(i))!;
    if (!iid) throw new Error(`no ${id}`);
    used.push(iid);
    for (const z of [p.zones.library, p.zones.hand]) { const k = z.indexOf(iid); if (k >= 0) z.splice(k, 1); }
    g.cards[iid].zone = 'library';
    return iid;
  });
  p.zones.library.unshift(...iids);
  return iids;
}

const card = (iid: string) => [[{ kind: 'card' as const, iid }]];
const logTail = (g: GameState, n = 6) => g.log.slice(-n).map((l) => l.text).join('\n');

describe('0: the audit sees look-at-the-top windows', () => {
  it('every cube card with a library look is automatable (no by-hand look window)', () => {
    const bad: string[] = [];
    for (const c of CUBE.cards) {
      (getScript(c.id) ?? []).forEach((_f, face) => {
        const abs = [spellAbility(c.id, face)?.ability, ...activatedAbilitiesOf(c.id, face).map((e) => e.ability)];
        for (const ab of abs) if (ab) for (const u of isAutomatable(ab).unsupported) if (/^peek/.test(u)) bad.push(`${c.name}: ${u}`);
        (getScript(c.id)?.[face]?.triggers ?? []).forEach((_l, k) => { const t = triggerSupport(c.id, face, k); if (/peek/.test(t.reason ?? '')) bad.push(`${c.name}: trigger ${t.reason}`); });
      });
    }
    expect(bad).toEqual([]);
  });
});

describe('2: the back face of a transforming card cannot be cast', () => {
  it('Fable of the Mirror-Breaker: only the front face is castable from hand', () => {
    const { g, ctx } = setup(['fable_of_the_mirror_breaker']);
    for (let k = 0; k < 3; k++) put(g, ctx, 'a', 'basic_mountain');
    const fable = toZone(g, ctx, 'a', 'fable_of_the_mirror_breaker', 'hand');
    expect(castOptions(g, fable, 1).filter((o) => !o.unavailable)).toEqual([]);
    expect(castableFaces(getCard('fable_of_the_mirror_breaker'))).toEqual([0]);
    expect(applyAction(g, 'a', { t: 'cast', iid: fable, face: 1 }, ctx)).toMatch(/back face/i);
    expect(g.cards[fable].zone).toBe('hand');
    act(g, ctx, 'a', { t: 'cast', iid: fable, face: 0 });
    expect(g.cards[fable].zone).toBe('stack');
  });

  it('adventure, modal DFC and split cards keep both faces', () => {
    expect(castableFaces(getCard('brazen_borrower'))).toEqual([0, 1]);
    expect(castableFaces(getCard('valki_god_of_lies'))).toEqual([0, 1]);
    expect(castableFaces(getCard('life_death'))).toEqual([0, 1]);
    expect(castableFaces(getCard('lightning_bolt'))).toEqual([0]);
    for (const id of ['kytheon_hero_of_akros', 'ajani_nacatl_pariah', 'cecil_dark_knight', 'concealing_curtains', 'tamiyo_inquisitive_student']) expect(castableFaces(getCard(id)), id).toEqual([0]);
    const { g, ctx } = setup(['brazen_borrower'], [], 'basic_island');
    for (let k = 0; k < 2; k++) put(g, ctx, 'a', 'basic_island');
    const bb = toZone(g, ctx, 'a', 'brazen_borrower', 'hand');
    expect(castOptions(g, bb, 1).some((o) => o.id === 'normal' && !o.unavailable)).toBe(true);
  });
});

const tok = (g: GameState, ctx: Ctx, pid: string, key: string) => createTokenInstance(g, ctx, pid, SCRIPTS.tokens[key], false).iid;
const tokensNamed = (g: GameState, name: string) => g.battlefield.filter((i) => g.cards[i].token?.name === name);

function attackWith(g: GameState, ctx: Ctx, iids: string[]) {
  act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
  for (const iid of iids) act(g, ctx, 'a', { t: 'declareAttacker', iid, target: 'b' });
  act(g, ctx, 'a', { t: 'confirmAttackers' });
}

describe('4: cycling lands from hand', () => {
  const lands = CUBE.cards.filter((c) => c.types.includes('Land') && (getScript(c.id)?.[0]?.keywords ?? []).some((k) => /^Cycling:/.test(k))).map((c) => c.id);
  it('the cube has cycling lands (Triomes ...)', () => {
    expect(lands).toEqual(expect.arrayContaining(['savai_triome', 'ketria_triome', 'indatha_triome', 'raugrin_triome', 'zagoth_triome']));
  });
  for (const id of lands) {
    it(`${id}: cycling from hand pays {3}, discards it and draws, even after the land drop`, () => {
      const { g, ctx } = setup([id, 'basic_mountain']);
      for (let k = 0; k < 3; k++) put(g, ctx, 'a', 'basic_mountain');
      act(g, ctx, 'a', { t: 'playLand', iid: g.players[0].zones.hand.find((i) => g.cards[i].cardId === 'basic_mountain')! });
      const land = toZone(g, ctx, 'a', id, 'hand');
      const cyc = activatedAbilitiesOf(id, 0).find((e) => e.zone === 'hand' && e.keyword === 'Cycling');
      expect(cyc, JSON.stringify(activatedAbilitiesOf(id, 0))).toBeTruthy();
      expect(abilityUsability(g, 'a', land, cyc!.index)).toEqual({ ok: true });
      const hand = g.players[0].zones.hand.length;
      const top = g.players[0].zones.library[0];
      act(g, ctx, 'a', { t: 'activate', iid: land, text: '', ability: cyc!.index });
      drain(g, ctx);
      expect(g.cards[land].zone).toBe('graveyard');
      expect(g.cards[top].zone, logTail(g)).toBe('hand');
      expect(g.players[0].zones.hand.length).toBe(hand); // -1 cycled, +1 drawn
      expect(g.battlefield.filter((i) => g.cards[i].controller === 'a' && g.cards[i].tapped).length).toBe(3);
    });
  }
  it('clicking a cycling land in hand opens the menu (play land + cycling), even after the land drop', () => {
    const { g, ctx } = setup(['savai_triome', 'fable_of_the_mirror_breaker', 'brazen_borrower']);
    const tri = toZone(g, ctx, 'a', 'savai_triome', 'hand');
    const mtn = g.players[0].zones.hand.find((i) => g.cards[i].cardId === 'basic_mountain')!;
    expect(handClick(g, 'a', tri)).toBe('menu');
    expect(handClick(g, 'a', mtn)).toBe('playLand');
    expect(handClick(g, 'a', toZone(g, ctx, 'a', 'fable_of_the_mirror_breaker', 'hand'))).toBe('cast');
    expect(handClick(g, 'a', toZone(g, ctx, 'a', 'brazen_borrower', 'hand'))).toBe('menu');
    act(g, ctx, 'a', { t: 'playLand', iid: mtn });
    expect(handClick(g, 'a', tri)).toBe('menu');
  });

  it('not enough mana: refused', () => {
    const { g, ctx } = setup(['savai_triome']);
    put(g, ctx, 'a', 'basic_mountain');
    const land = toZone(g, ctx, 'a', 'savai_triome', 'hand');
    const cyc = activatedAbilitiesOf('savai_triome', 0).find((e) => e.zone === 'hand')!;
    expect(abilityUsability(g, 'a', land, cyc.index).ok).toBe(false);
    expect(applyAction(g, 'a', { t: 'activate', iid: land, text: '', ability: cyc.index }, ctx)).toBeTruthy();
    expect(g.cards[land].zone).toBe('hand');
  });
});

describe('3: token abilities', () => {
  it('Fable chapter I Goblin Shaman: attacking creates a Treasure', () => {
    const { g, ctx } = setup(['fable_of_the_mirror_breaker']);
    for (let k = 0; k < 3; k++) put(g, ctx, 'a', 'basic_mountain');
    const fable = toZone(g, ctx, 'a', 'fable_of_the_mirror_breaker', 'hand');
    act(g, ctx, 'a', { t: 'cast', iid: fable });
    drain(g, ctx);
    const [shaman] = tokensNamed(g, 'Goblin Shaman');
    expect(shaman, logTail(g)).toBeTruthy();
    g.cards[shaman].summoningSick = false;
    attackWith(g, ctx, [shaman]);
    drain(g, ctx);
    expect(tokensNamed(g, 'Treasure').length, logTail(g)).toBe(1);
  });

  it('Moloid: attacking may mill a card', () => {
    const { g, ctx } = setup();
    const m = tok(g, ctx, 'a', 'moloid');
    g.cards[m].summoningSick = false;
    const top = g.players[0].zones.library[0];
    attackWith(g, ctx, [m]);
    drain(g, ctx, (q) => (q.options.find((o) => /yes/i.test(o.label + o.value)) ?? q.options[0]).value);
    expect(g.cards[top].zone, logTail(g)).toBe('graveyard');
  });

  it('Pest: dying gains 1 life', () => {
    const { g, ctx } = setup(['lightning_bolt']);
    const pest = tok(g, ctx, 'a', 'bg_1_1_pest_lifegain');
    put(g, ctx, 'a', 'basic_mountain');
    const bolt = toZone(g, ctx, 'a', 'lightning_bolt', 'hand');
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: card(pest) });
    drain(g, ctx);
    expect(g.players[0].life, logTail(g)).toBe(21);
  });

  it('Map: {1}, {T}, sacrifice: target creature you control explores, only as a sorcery', () => {
    const { g, ctx } = setup(['giver_of_runes'], [], 'basic_forest');
    const bears = put(g, ctx, 'a', 'giver_of_runes');
    put(g, ctx, 'a', 'basic_forest');
    const map = tok(g, ctx, 'a', 'c_a_map_sac_explore');
    const ab = abilitiesOfInstance(g.cards[map], g, getCard);
    expect(ab.length).toBe(1);
    const [land] = stackLibrary(g, 'a', ['basic_forest']);
    act(g, ctx, 'a', { t: 'activate', iid: map, text: '', ability: ab[0].index, targets: card(bears) });
    drain(g, ctx);
    expect(g.cards[map]).toBeUndefined();
    expect(g.cards[land].zone, logTail(g)).toBe('hand');
    // at instant speed: refused
    const map2 = tok(g, ctx, 'a', 'c_a_map_sac_explore');
    g.cards[g.battlefield.find((i) => g.cards[i].cardId === 'basic_forest')!].tapped = false;
    act(g, ctx, 'a', { t: 'gotoStep', step: 'beginCombat' });
    expect(applyAction(g, 'a', { t: 'activate', iid: map2, text: '', ability: ab[0].index, targets: card(bears) }, ctx)).toMatch(/sorcery/);
  });

  it('Mutagen: {1}, {T}, sacrifice: +1/+1 counter on target creature, only as a sorcery', () => {
    const { g, ctx } = setup(['giver_of_runes'], [], 'basic_forest');
    const bears = put(g, ctx, 'a', 'giver_of_runes');
    put(g, ctx, 'a', 'basic_forest');
    const mut = tok(g, ctx, 'a', 'c_a_mutagen_sac');
    const ab = abilitiesOfInstance(g.cards[mut], g, getCard);
    expect(ab.length).toBe(1);
    act(g, ctx, 'a', { t: 'activate', iid: mut, text: '', ability: ab[0].index, targets: card(bears) });
    drain(g, ctx);
    expect(g.cards[bears].counters['+1/+1'], logTail(g)).toBe(1);
  });

  it('every token with rules text beyond keywords has its abilities', () => {
    const bad: string[] = [];
    for (const [key, t] of Object.entries(SCRIPTS.tokens)) {
      const lines = (t.oracle ?? '').replace(/\([^)]*\)/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
      const kws = new Set((t.keywords ?? []).map((k) => k.toLowerCase()));
      if (lines.every((l) => l.split(/,\s*/).every((w) => kws.has(w.toLowerCase())))) continue;
      const ref = scriptRef({ transformed: false, token: t });
      const f = ref ? getScript(ref.cardId)?.[ref.face] : undefined;
      if (!ref || !f) { bad.push(`${key}: no token script (${t.oracle})`); continue; }
      for (const e of activatedAbilitiesOf(ref.cardId, ref.face)) for (const u of isAutomatable(e.ability).unsupported) bad.push(`${key}: ${u}`);
      f.triggers.forEach((_l, i) => { const s = triggerSupport(ref.cardId, ref.face, i); if (!(s.detect && s.chain)) bad.push(`${key}: trigger ${s.reason}`); });
      for (const line of f.statics) for (const gap of staticGaps(parseStatic(line, f.svars))) bad.push(`${key}: static ${gap}`);
      if (!f.abilities.length && !f.triggers.length && !f.statics.length) bad.push(`${key}: empty token script`);
    }
    expect(bad).toEqual([]);
  });
});

const lib = (g: GameState, pid: string) => g.players.find((p) => p.pid === pid)!.zones.library;
const pickVal = (iid: string) => (q: Q) => (q.options.some((o) => o.value === iid) ? iid : q.options[0].value);
const loyalty = (id: string, k: number) => activatedAbilitiesOf(id, 0).filter((e) => e.loyalty != null)[k].index;
const noManual = (g: GameState) => g.log.filter((l) => /by hand|not automated|manual/i.test(l.text)).map((l) => l.text);

describe('5: look-at-the-top effects are engine questions', () => {
  it("Jace, the Mind Sculptor +2: look at the top card of target player's library, may put it on the bottom", () => {
    const { g, ctx } = setup(['jace_the_mind_sculptor'], ['lightning_bolt', 'ponder'], 'basic_island');
    const jace = put(g, ctx, 'a', 'jace_the_mind_sculptor');
    const [bolt] = stackLibrary(g, 'b', ['lightning_bolt']);
    act(g, ctx, 'a', { t: 'activate', iid: jace, text: '', ability: loyalty('jace_the_mind_sculptor', 0), targets: [[{ kind: 'player', pid: 'b' }]] });
    passUntilQuestion(g, ctx);
    expect(g.players.every((p) => !p.peek), 'no by-hand look window').toBe(true);
    const q = g.pending[0];
    expect(q?.pid, logTail(g)).toBe('a');
    expect(q.options.map((o) => o.value)).toEqual(['top', 'bottom']);
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: 'bottom' });
    drain(g, ctx);
    expect(lib(g, 'b').at(-1)).toBe(bolt);
    expect(g.cards[jace].counters.loyalty).toBe(5);
  });

  it('Jace +2 on myself: keeping it leaves it on top', () => {
    const { g, ctx } = setup(['jace_the_mind_sculptor', 'ponder'], [], 'basic_island');
    const jace = put(g, ctx, 'a', 'jace_the_mind_sculptor');
    const [pd] = stackLibrary(g, 'a', ['ponder']);
    act(g, ctx, 'a', { t: 'activate', iid: jace, text: '', ability: loyalty('jace_the_mind_sculptor', 0), targets: [[{ kind: 'player', pid: 'a' }]] });
    drain(g, ctx, () => 'top');
    expect(lib(g, 'a')[0]).toBe(pd);
  });

  it('Jace 0: draw three, put two back', () => {
    const { g, ctx } = setup(['jace_the_mind_sculptor'], [], 'basic_island');
    const jace = put(g, ctx, 'a', 'jace_the_mind_sculptor');
    const hand = g.players[0].zones.hand.length;
    act(g, ctx, 'a', { t: 'activate', iid: jace, text: '', ability: loyalty('jace_the_mind_sculptor', 1) });
    drain(g, ctx);
    expect(g.players[0].zones.hand.length, logTail(g)).toBe(hand + 1);
    expect(noManual(g)).toEqual([]);
  });

  it('Jace −1: return target creature to its owner\'s hand', () => {
    const { g, ctx } = setup(['jace_the_mind_sculptor'], ['giver_of_runes'], 'basic_island');
    const jace = put(g, ctx, 'a', 'jace_the_mind_sculptor');
    const giver = put(g, ctx, 'b', 'giver_of_runes');
    act(g, ctx, 'a', { t: 'activate', iid: jace, text: '', ability: loyalty('jace_the_mind_sculptor', 2), targets: card(giver) });
    drain(g, ctx);
    expect(g.cards[giver].zone).toBe('hand');
    expect(noManual(g)).toEqual([]);
  });

  it('Jace −12: exile target player\'s library, they shuffle their hand into it', () => {
    const { g, ctx } = setup(['jace_the_mind_sculptor'], [], 'basic_island');
    const jace = put(g, ctx, 'a', 'jace_the_mind_sculptor');
    g.cards[jace].counters.loyalty = 12;
    const hand = g.players[1].zones.hand.length;
    act(g, ctx, 'a', { t: 'activate', iid: jace, text: '', ability: loyalty('jace_the_mind_sculptor', 3), targets: [[{ kind: 'player', pid: 'b' }]] });
    drain(g, ctx);
    expect(g.players[1].zones.hand.length, logTail(g)).toBe(0);
    expect(lib(g, 'b').length).toBe(hand);
    expect(noManual(g)).toEqual([]);
  });

  it('Expressive Iteration: one to hand, one to the bottom, one exiled and playable this turn', () => {
    const { g, ctx } = setup(['expressive_iteration', 'ponder', 'lightning_bolt', 'giver_of_runes', 'basic_mountain'], [], 'basic_island');
    put(g, ctx, 'a', 'basic_island'); put(g, ctx, 'a', 'basic_mountain');
    const ei = toZone(g, ctx, 'a', 'expressive_iteration', 'hand');
    const [pd, bolt, giver] = stackLibrary(g, 'a', ['ponder', 'lightning_bolt', 'giver_of_runes']);
    act(g, ctx, 'a', { t: 'cast', iid: ei });
    passUntilQuestion(g, ctx);
    expect(g.players.every((p) => !p.peek), 'no by-hand look window').toBe(true);
    const q1 = g.pending[0];
    expect(q1.options.map((o) => o.value).sort()).toEqual([pd, bolt, giver].sort());
    act(g, ctx, 'a', { t: 'choose', id: q1.id, value: bolt }); // hand
    const q2 = g.pending[0];
    expect(q2.options.map((o) => o.value).sort(), logTail(g)).toEqual([pd, giver].sort());
    act(g, ctx, 'a', { t: 'choose', id: q2.id, value: giver }); // bottom
    drain(g, ctx);
    expect(g.cards[bolt].zone).toBe('hand');
    expect(lib(g, 'a').at(-1), logTail(g, 12)).toBe(giver);
    expect(g.cards[pd].zone, logTail(g)).toBe('exile');
    expect(mayPlayFrom(g, 'a', pd, getCard)).toBe(true);
  });

  it('Ponder: put the top three back in a chosen order, may shuffle, then draw', () => {
    const { g, ctx } = setup(['ponder', 'lightning_bolt', 'giver_of_runes', 'expressive_iteration'], [], 'basic_island');
    put(g, ctx, 'a', 'basic_island');
    const pd = toZone(g, ctx, 'a', 'ponder', 'hand');
    const [a1, a2, a3] = stackLibrary(g, 'a', ['lightning_bolt', 'giver_of_runes', 'expressive_iteration']);
    act(g, ctx, 'a', { t: 'cast', iid: pd });
    passUntilQuestion(g, ctx);
    expect(g.players.every((p) => !p.peek), 'no by-hand look window').toBe(true);
    let q = g.pending[0];
    expect(q.options.map((o) => o.value).sort()).toEqual([a1, a2, a3].sort());
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: a3 });
    q = g.pending[0];
    expect(q.options.map((o) => o.value).sort()).toEqual([a1, a2].sort());
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: a1 });
    q = g.pending[0];
    expect(q.options.map((o) => o.value).sort(), q.prompt).toEqual(['no', 'yes']);
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: 'no' });
    drain(g, ctx);
    expect(g.cards[a3].zone, logTail(g)).toBe('hand'); // drawn
    expect(lib(g, 'a').slice(0, 2)).toEqual([a1, a2]);
  });

  it("Sensei's Divining Top: {1}: rearrange the top three", () => {
    const { g, ctx } = setup(['senseis_divining_top', 'lightning_bolt', 'giver_of_runes', 'ponder']);
    const top = put(g, ctx, 'a', 'senseis_divining_top');
    put(g, ctx, 'a', 'basic_mountain');
    const [a1, a2, a3] = stackLibrary(g, 'a', ['lightning_bolt', 'giver_of_runes', 'ponder']);
    act(g, ctx, 'a', { t: 'activate', iid: top, text: '', ability: activatedAbilitiesOf('senseis_divining_top', 0)[0].index });
    passUntilQuestion(g, ctx);
    expect(g.players.every((p) => !p.peek), 'no by-hand look window').toBe(true);
    answer(g, ctx, pickVal(a2));
    drain(g, ctx);
    expect(lib(g, 'a')[0]).toBe(a2);
    expect(lib(g, 'a').slice(0, 3).sort()).toEqual([a1, a2, a3].sort());
    expect(g.pending.length).toBe(0);
  });

  it('Karn, Scion of Urza +1: an opponent chooses; that card to my hand, the other exiled with a silver counter', () => {
    const { g, ctx } = setup(['karn_scion_of_urza', 'lightning_bolt', 'ponder']);
    const karn = put(g, ctx, 'a', 'karn_scion_of_urza');
    const [bolt, pd] = stackLibrary(g, 'a', ['lightning_bolt', 'ponder']);
    act(g, ctx, 'a', { t: 'activate', iid: karn, text: '', ability: loyalty('karn_scion_of_urza', 0) });
    passUntilQuestion(g, ctx);
    expect(g.players.every((p) => !p.peek), 'no by-hand look window').toBe(true);
    const q = g.pending[0];
    expect(q?.pid, logTail(g)).toBe('b');
    act(g, ctx, 'b', { t: 'choose', id: q.id, value: pd });
    drain(g, ctx);
    expect(g.cards[pd].zone).toBe('hand');
    expect(g.cards[bolt].zone).toBe('exile');
    expect(g.cards[bolt].counters.silver).toBe(1);
  });

  it("Thassa's Oracle: the chosen card goes on top, the rest on the bottom", () => {
    const { g, ctx } = setup(['thassas_oracle', 'lightning_bolt', 'ponder', 'jace_the_mind_sculptor'], [], 'basic_island');
    put(g, ctx, 'a', 'basic_island'); put(g, ctx, 'a', 'basic_island');
    put(g, ctx, 'a', 'jace_the_mind_sculptor'); // devotion: UU (Jace) + UU (Oracle) = 4
    const to = toZone(g, ctx, 'a', 'thassas_oracle', 'hand');
    const top = stackLibrary(g, 'a', ['lightning_bolt', 'ponder']);
    act(g, ctx, 'a', { t: 'cast', iid: to });
    drain(g, ctx, pickVal(top[1]));
    expect(g.players.every((p) => !p.peek)).toBe(true);
    expect(lib(g, 'a')[0], logTail(g, 14)).toBe(top[1]);
    expect(lib(g, 'a').slice(-3)).toContain(top[0]);
  });

  for (const [label, grave, n] of [['one card', [], 1], ['two cards with an instant and a sorcery in the graveyard', ['lightning_bolt', 'ponder'], 2]] as const) {
    it(`Flow State: ${label} into hand, the rest on the bottom`, () => {
      const { g, ctx } = setup(['flow_state', 'lightning_bolt', 'ponder', 'giver_of_runes', 'brainstorm', 'expressive_iteration'], [], 'basic_island');
      put(g, ctx, 'a', 'basic_island'); put(g, ctx, 'a', 'basic_island');
      for (const id of grave) toZone(g, ctx, 'a', id, 'graveyard');
      const fs = toZone(g, ctx, 'a', 'flow_state', 'hand');
      const top = stackLibrary(g, 'a', ['giver_of_runes', 'brainstorm', 'expressive_iteration']);
      act(g, ctx, 'a', { t: 'cast', iid: fs });
      drain(g, ctx);
      expect(g.players.every((p) => !p.peek), 'no by-hand look window').toBe(true);
      expect(top.filter((x) => g.cards[x].zone === 'hand').length, logTail(g)).toBe(n);
      expect(lib(g, 'a').slice(-(3 - n)).sort()).toEqual(top.filter((x) => g.cards[x].zone === 'library').sort());
    });
  }

  it("Mirri's Guile: at my upkeep, may rearrange the top three", () => {
    const { g, ctx } = setup(['mirris_guile', 'lightning_bolt', 'giver_of_runes', 'ponder']);
    put(g, ctx, 'a', 'mirris_guile');
    const [, a2] = stackLibrary(g, 'a', ['lightning_bolt', 'giver_of_runes', 'ponder']);
    let asked = 0;
    for (let k = 0; k < 300 && !(g.turn >= 3 && !['untap', 'upkeep'].includes(g.step)); k++) {
      if (g.players.some((p) => p.peek)) throw new Error('by-hand look window');
      const q = g.pending[0];
      if (q) { if (/Mirri/.test(q.prompt)) asked++; act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options.find((o) => o.value === a2 || /^(yes|true)$/i.test(o.value))?.value ?? q.options[0].value }); continue; }
      act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(asked, logTail(g, 12)).toBeGreaterThanOrEqual(2);
    expect(g.cards[a2].zone, logTail(g, 12)).toBe('hand'); // put on top at upkeep, then drawn
  });

  it('scry / surveil destinations are checked on the server', () => {
    const { g, ctx } = setup(['opt', 'consider'], [], 'basic_island');
    put(g, ctx, 'a', 'basic_island'); put(g, ctx, 'a', 'basic_island');
    const opt = toZone(g, ctx, 'a', 'opt', 'hand');
    act(g, ctx, 'a', { t: 'cast', iid: opt });
    passUntilQuestion(g, ctx);
    const pk = g.players[0].peek!;
    expect(pk.mode).toBe('scry');
    const none = { top: [], bottom: [], graveyard: [], hand: [], battlefield: [], exile: [], shuffle: false };
    expect(applyAction(g, 'a', { t: 'resolvePeek', ...none, graveyard: [pk.iids[0]] }, ctx)).toMatch(/scry/i);
    expect(applyAction(g, 'a', { t: 'resolvePeek', ...none, hand: [pk.iids[0]] }, ctx)).toMatch(/scry/i);
    expect(applyAction(g, 'a', { t: 'resolvePeek', ...none, shuffle: true }, ctx)).toMatch(/scry/i);
    act(g, ctx, 'a', { t: 'resolvePeek', ...none, bottom: [pk.iids[0]] });
    drain(g, ctx);
    const con = toZone(g, ctx, 'a', 'consider', 'hand');
    act(g, ctx, 'a', { t: 'cast', iid: con });
    passUntilQuestion(g, ctx);
    const pk2 = g.players[0].peek!;
    expect(pk2.mode).toBe('surveil');
    expect(applyAction(g, 'a', { t: 'resolvePeek', ...none, bottom: [pk2.iids[0]] }, ctx)).toMatch(/surveil/i);
    act(g, ctx, 'a', { t: 'resolvePeek', ...none, graveyard: [pk2.iids[0]] });
    expect(g.cards[pk2.iids[0]].zone).toBe('graveyard');
  });
});

describe('6: Nadu, Winged Wisdom', () => {
  const naduTriggers = (g: GameState) => g.stack.filter((s) => /Nadu|becomes the target/.test(s.text)).length;

  it('an Aura spell targeting my creature triggers it; the trigger uses the stack', () => {
    const { g, ctx } = setup(['nadu_winged_wisdom', 'splinter_twin', 'ponder', 'brainstorm']);
    const nadu = put(g, ctx, 'a', 'nadu_winged_wisdom');
    for (let k = 0; k < 4; k++) put(g, ctx, 'a', 'basic_mountain');
    const twin = toZone(g, ctx, 'a', 'splinter_twin', 'hand');
    const [pd] = stackLibrary(g, 'a', ['ponder', 'brainstorm']);
    act(g, ctx, 'a', { t: 'cast', iid: twin, targets: card(nadu) });
    expect(g.stack.length, logTail(g)).toBe(2);
    expect(naduTriggers(g)).toBe(1);
    expect(g.cards[pd].zone).toBe('library'); // not yet: the trigger waits on the stack
    drain(g, ctx);
    expect(g.cards[pd].zone).toBe('hand');
    expect(g.cards[twin].attachedTo).toBe(nadu);
  });

  it("an opponent's activated ability on the opponent's turn triggers it (I control the trigger); a land goes onto the battlefield", () => {
    const { g, ctx } = setup(['nadu_winged_wisdom', 'giver_of_runes', 'basic_forest'], ['jace_the_mind_sculptor'], 'basic_mountain', 'basic_island', 'b');
    put(g, ctx, 'a', 'nadu_winged_wisdom');
    const giver = put(g, ctx, 'a', 'giver_of_runes');
    const jace = put(g, ctx, 'b', 'jace_the_mind_sculptor');
    const [forest] = stackLibrary(g, 'a', ['basic_forest']);
    expect(g.activePlayer).toBe('b');
    act(g, ctx, 'b', { t: 'activate', iid: jace, text: '', ability: loyalty('jace_the_mind_sculptor', 2), targets: card(giver) });
    expect(g.stack.length, logTail(g)).toBe(2);
    expect(g.stack[1].controller).toBe('a');
    drain(g, ctx);
    expect(g.cards[forest].zone).toBe('battlefield');
    expect(g.cards[forest].controller).toBe('a');
    expect(g.cards[giver].zone).toBe('hand');
  });

  it('one spell targeting two of my creatures: two triggers', () => {
    const { g, ctx } = setup(['nadu_winged_wisdom', 'giver_of_runes', 'fire_covenant', 'ponder', 'brainstorm', 'basic_swamp']);
    const nadu = put(g, ctx, 'a', 'nadu_winged_wisdom');
    const giver = put(g, ctx, 'a', 'giver_of_runes');
    put(g, ctx, 'a', 'basic_swamp');
    for (let k = 0; k < 2; k++) put(g, ctx, 'a', 'basic_mountain');
    const fc = toZone(g, ctx, 'a', 'fire_covenant', 'hand');
    const [c1, c2] = stackLibrary(g, 'a', ['ponder', 'brainstorm']);
    const targets = [[{ kind: 'card' as const, iid: nadu }, { kind: 'card' as const, iid: giver }]];
    act(g, ctx, 'a', { t: 'cast', iid: fc, x: 2, targets, division: { [nadu]: 1, [giver]: 1 } });
    expect(naduTriggers(g), logTail(g)).toBe(2);
    drain(g, ctx);
    expect(g.cards[c1].zone).toBe('hand');
    expect(g.cards[c2].zone).toBe('hand');
  });

  it('twice per turn for each creature, counted separately; again next turn', () => {
    const { g, ctx } = setup(['nadu_winged_wisdom', 'giver_of_runes', 'giver_of_runes']);
    put(g, ctx, 'a', 'nadu_winged_wisdom');
    const g1 = put(g, ctx, 'a', 'giver_of_runes');
    const g2 = put(g, ctx, 'a', 'giver_of_runes');
    const prot = (q: Q) => (q.options.find((o) => /red/i.test(o.value + o.label)) ?? q.options[0]).value;
    const target = (src: string, tgt: string) => {
      g.cards[src].tapped = false;
      act(g, ctx, 'a', { t: 'activate', iid: src, text: '', ability: 0, targets: card(tgt) });
      const n = naduTriggers(g);
      drain(g, ctx, prot);
      return n;
    };
    expect([target(g1, g2), target(g1, g2), target(g1, g2)]).toEqual([1, 1, 0]);
    expect([target(g2, g1), target(g2, g1), target(g2, g1)]).toEqual([1, 1, 0]);
    // next turn of mine: the count starts over
    for (let k = 0; k < 300 && !(g.turn >= 3 && g.step === 'main1'); k++) {
      const q = g.pending[0];
      if (q) { act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options[0].value }); continue; }
      act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(g.activePlayer).toBe('a');
    expect(target(g1, g2)).toBe(1);
  });
});

describe('7: Figure of Fable', () => {
  const FIG = 'figure_of_fable';
  function figure(fill = 'basic_forest', lands = 9, opp: string[] = []) {
    const { g, ctx } = setup([FIG], opp, fill, 'basic_mountain');
    const fig = put(g, ctx, 'a', FIG);
    for (let k = 0; k < lands; k++) put(g, ctx, 'a', fill);
    return { g, ctx, fig };
  }
  const level = (g: GameState, ctx: Ctx, fig: string, k: number) => {
    const err = applyAction(g, 'a', { t: 'activate', iid: fig, text: '', ability: activatedAbilitiesOf(FIG, 0)[k].index }, ctx);
    if (err) throw new Error(err);
    drain(g, ctx);
  };
  const subtypes = (g: GameState, fig: string) => faceOf(g.cards[fig], getCard).typeLine.split('—')[1]?.trim().split(/\s+/) ?? [];
  const untapAll = (g: GameState) => { for (const i of g.battlefield) g.cards[i].tapped = false; };

  it('step 1 ({G/W}, paid with G): a Kithkin Scout with base 2/3, other creature types gone', () => {
    const { g, ctx, fig } = figure();
    expect(effectivePT(g.cards[fig], getCard, g)).toEqual([1, 1]);
    level(g, ctx, fig, 0);
    expect(effectivePT(g.cards[fig], getCard, g), logTail(g)).toEqual([2, 3]);
    expect(subtypes(g, fig).sort()).toEqual(['Kithkin', 'Scout']);
    expect(g.battlefield.filter((i) => g.cards[i].tapped).length, logTail(g, 10)).toBe(1);
  });

  it('the hybrid cost can be paid with W', () => {
    const { g, ctx, fig } = figure('basic_plains', 1);
    level(g, ctx, fig, 0);
    expect(g.battlefield.filter((i) => g.cards[i].tapped).length, logTail(g)).toBe(1);
    expect(effectivePT(g.cards[fig], getCard, g), logTail(g)).toEqual([2, 3]);
  });

  it('step 2 on a Scout: Kithkin Soldier 4/5; step 3 on a Soldier: Kithkin Avatar 7/8 with protection from opponents', () => {
    const { g, ctx, fig } = figure('basic_forest', 12, ['lightning_bolt']);
    level(g, ctx, fig, 0);
    untapAll(g);
    level(g, ctx, fig, 1);
    expect(effectivePT(g.cards[fig], getCard, g), logTail(g)).toEqual([4, 5]);
    expect(subtypes(g, fig).sort()).toEqual(['Kithkin', 'Soldier']);
    untapAll(g);
    level(g, ctx, fig, 2);
    expect(effectivePT(g.cards[fig], getCard, g), logTail(g)).toEqual([7, 8]);
    expect(subtypes(g, fig).sort()).toEqual(['Avatar', 'Kithkin']);
    // the opponent can't target it
    put(g, ctx, 'b', 'basic_mountain');
    const bolt = toZone(g, ctx, 'b', 'lightning_bolt', 'hand');
    g.priority = 'b';
    expect(applyAction(g, 'b', { t: 'cast', iid: bolt, targets: card(fig) }, ctx), logTail(g)).toBeTruthy();
    expect(g.cards[bolt].zone).toBe('hand');
  });

  it('a step whose condition fails does nothing (step 2 on a fresh Figure, step 3 on a Scout)', () => {
    const { g, ctx, fig } = figure('basic_forest', 12);
    level(g, ctx, fig, 1);
    expect(effectivePT(g.cards[fig], getCard, g), logTail(g)).toEqual([1, 1]);
    untapAll(g);
    level(g, ctx, fig, 0);
    untapAll(g);
    level(g, ctx, fig, 2);
    expect(effectivePT(g.cards[fig], getCard, g), logTail(g)).toEqual([2, 3]);
    expect(subtypes(g, fig).sort()).toEqual(['Kithkin', 'Scout']);
  });

  it('the latest step wins (no stacking) and it lasts across turns', () => {
    const { g, ctx, fig } = figure('basic_forest', 12);
    level(g, ctx, fig, 0);
    untapAll(g);
    level(g, ctx, fig, 1);
    untapAll(g);
    level(g, ctx, fig, 0); // back to a Scout 2/3
    expect(effectivePT(g.cards[fig], getCard, g)).toEqual([2, 3]);
    expect(subtypes(g, fig).sort()).toEqual(['Kithkin', 'Scout']);
    untapAll(g);
    level(g, ctx, fig, 1);
    for (let k = 0; k < 300 && !(g.turn >= 3 && g.step === 'main1'); k++) {
      const q = g.pending[0];
      if (q) { act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options[0].value }); continue; }
      act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(g.turn).toBeGreaterThanOrEqual(3);
    expect(effectivePT(g.cards[fig], getCard, g)).toEqual([4, 5]);
    expect(subtypes(g, fig).sort()).toEqual(['Kithkin', 'Soldier']);
  });
});
