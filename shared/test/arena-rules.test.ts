/** No manual steps in strict (Arena-style) games: user-reported rules bugs, with the real cube scripts. */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import { CUBE } from '../src/cube.ts';
import {
  abilitiesOfInstance, activatedAbilitiesOf, applyAction, castableFaces, castOptions, createGame, type Ctx, type GameAction, type GameState, getScript, isAutomatable,
  moveCard, parseStatic, scriptRef, spellAbility, staticGaps, triggerSupport,
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
  // Fails until item 5 (look-at-top effects as engine questions) lands.
  it.fails('every cube card with a library look is automatable (no by-hand look window)', () => {
    const bad: string[] = [];
    for (const c of CUBE.cards) {
      (getScript(c.id) ?? []).forEach((_f, face) => {
        const abs = [spellAbility(c.id, face)?.ability, ...activatedAbilitiesOf(c.id, face).map((e) => e.ability)];
        for (const ab of abs) if (ab) for (const u of isAutomatable(ab).unsupported) if (/^peek/.test(u)) bad.push(`${c.name}: ${u}`);
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
