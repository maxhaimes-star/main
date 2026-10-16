/** No manual steps in strict (Arena-style) games: user-reported rules bugs, with the real cube scripts. */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import { CUBE } from '../src/cube.ts';
import {
  activatedAbilitiesOf, applyAction, castableFaces, castOptions, createGame, type Ctx, type GameAction, type GameState, getScript, isAutomatable, moveCard, spellAbility,
} from '../src/index.ts';
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
