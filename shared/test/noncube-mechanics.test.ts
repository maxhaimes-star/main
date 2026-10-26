/**
 * Non-cube mechanics with real Forge scripts (fixtures/mechanics.ts): face-down permanents (disguise, cloak, manifest
 * dread), plot, warp, saddle, station, speed, sneak and granted numbered keywords. Strict (rules-enforced) games.
 */
import { describe, expect, it } from 'vitest';
import { getCard, registerCards } from '../src/cube.ts';
import { applyAction, createGame, type CardData, type Ctx, type GameAction, type GameState, type TargetRef, effectivePT, hasKeyword, moveCard, viewFor, castOptions } from '../src/index.ts';
import { registerScripts } from '../src/engine/script.ts';
import { seeded } from './helpers.ts';
import { MECH } from './fixtures/mechanics.ts';
import { REAL, REAL_TOKENS } from './fixtures/noncube-cards.ts';

const ALL = { ...REAL, ...MECH };
registerCards(Object.values(ALL).map((r) => ({ tokens: [], keywords: [], producedMana: [], colorIdentity: [], supertypes: [], subtypes: [], image: '', rank: 9999, ...r.card }) as unknown as CardData));
registerScripts(Object.fromEntries(Object.entries(ALL).map(([id, r]) => [id, r.script])) as never, REAL_TOKENS as never);

const BASICS = ['basic_forest', 'basic_island', 'basic_mountain', 'basic_swamp', 'basic_plains'];
const deck = (extra: string[]) => [...extra, ...Array.from({ length: 40 - extra.length }, (_, i) => BASICS[i % 5])];
function setup(a: string[], b: string[] = []) {
  const ctx: Ctx = { rng: seeded(9), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(a), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(b), side: [] },
  ], 'a', ctx, { strict: true });
  act(g, ctx, 'a', { t: 'keep' });
  act(g, ctx, 'b', { t: 'keep' });
  while (g.step !== 'main1') act(g, ctx, g.priority, { t: 'pass' });
  return { g, ctx };
}
function act(g: GameState, ctx: Ctx, pid: string, action: GameAction) {
  const err = applyAction(g, pid, action, ctx);
  if (err) throw new Error(err);
}
function find(g: GameState, pid: string, cardId: string): string {
  const p = g.players.find((x) => x.pid === pid)!;
  const iid = [...p.zones.hand, ...p.zones.library].find((i) => g.cards[i].cardId === cardId);
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}
function toHand(g: GameState, ctx: Ctx, cardId: string, pid = 'a'): string {
  const iid = find(g, pid, cardId);
  if (g.cards[iid].zone !== 'hand') moveCard(g, ctx, iid, 'hand');
  return iid;
}
function toTop(g: GameState, ctx: Ctx, cardId: string, pid = 'a'): string {
  const iid = find(g, pid, cardId);
  moveCard(g, ctx, iid, 'library', { position: 'top' });
  return iid;
}
function put(g: GameState, ctx: Ctx, cardId: string, pid = 'a'): string {
  const iid = find(g, pid, cardId);
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  g.events = []; g.triggerQueue = [];
  return iid;
}
/** Lands for `pid` (untapped basics of each type in turn). */
function lands(g: GameState, ctx: Ctx, n: number, pid = 'a') {
  const p = g.players.find((x) => x.pid === pid)!;
  for (let i = 0; i < n; i++) {
    const kind = BASICS[i % 5];
    const iid = [...p.zones.library, ...p.zones.hand].find((x) => g.cards[x].cardId === kind)!;
    moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  }
}
/** Resolve the stack, answering questions with the option matching `pick` (else the first). */
function resolveAll(g: GameState, ctx: Ctx, pick?: (labels: string[]) => number, targets?: TargetRef[][]) {
  for (let i = 0; i < 60 && (g.stack.length || g.pending.length); i++) {
    const q = g.pending[0];
    if (q?.targets && targets) act(g, ctx, q.pid, { t: 'chooseTargets', id: q.id, targets });
    else if (q?.options.length) act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options[Math.max(0, pick ? pick(q.options.map((o) => o.label)) : 0)].value });
    else if (q) throw new Error(`unanswerable: ${q.prompt}`);
    else act(g, ctx, g.priority, { t: 'pass' });
  }
}
const logText = (g: GameState) => g.log.map((l) => l.text).join('\n');
const MANUAL = /by hand|Not automated/;

describe('face-down permanents', () => {
  it('Disguise (Alley Assailant): cast face down for {3}, a hidden 2/2 with ward {2}; turned face up for its disguise cost, its trigger fires', () => {
    const { g, ctx } = setup(['alley_assailant']);
    const ali = toHand(g, ctx, 'alley_assailant');
    lands(g, ctx, 10);
    expect(castOptions(g, ali, undefined, getCard).map((o) => o.id)).toContain('faceDown');
    act(g, ctx, 'a', { t: 'cast', iid: ali, costOption: 'faceDown', targets: [] });
    resolveAll(g, ctx);
    const c = g.cards[ali];
    expect(c.zone).toBe('battlefield');
    expect(c.faceDown).toBe(true);
    expect(c.faceDownAs).toBe('disguise');
    expect(effectivePT(c, getCard, g)).toEqual([2, 2]);
    expect(hasKeyword(c, getCard, 'Ward', g)).toBe(true);
    // Bob can't see what it is.
    const seen = viewFor(g, 'b').cards[ali] as { hidden?: boolean; cardId?: string; faceDownAs?: string };
    expect(seen.hidden).toBe(true);
    expect(seen.cardId).toBeUndefined();
    expect(seen.faceDownAs).toBe('disguise');
    expect(viewFor(g, 'b').log.map((l) => l.text).join('\n')).not.toMatch(/Alley Assailant/);
    // Turn it face up ({4}{B}{B}) as a special action: "when it's turned face up, target opponent loses 3 life and you gain 3".
    act(g, ctx, 'a', { t: 'turnFaceUp', iid: ali });
    expect(c.faceDown).toBe(false);
    resolveAll(g, ctx, undefined, [[{ kind: 'player', pid: 'b' }]]);
    expect(g.players.find((p) => p.pid === 'b')!.life).toBe(17);
    expect(g.players.find((p) => p.pid === 'a')!.life).toBe(23);
    expect(logText(g)).toMatch(/turns Alley Assailant face up/);
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Manifest dread (Growing Dread): look at two, one face down, the other into the graveyard; turning it up adds a counter', () => {
    const { g, ctx } = setup(['growing_dread', 'grizzly_bears', 'culvert_ambusher']);
    const dread = toHand(g, ctx, 'growing_dread');
    const amb = toTop(g, ctx, 'culvert_ambusher');
    const bear = toTop(g, ctx, 'grizzly_bears');
    lands(g, ctx, 6);
    act(g, ctx, 'a', { t: 'cast', iid: dread, targets: [] });
    resolveAll(g, ctx, (labels) => labels.indexOf('Grizzly Bears'));
    expect(g.cards[dread].zone).toBe('battlefield');
    expect(g.cards[bear].zone).toBe('battlefield');
    expect(g.cards[bear].faceDown).toBe(true);
    expect(g.cards[bear].faceDownAs).toBe('manifest');
    expect(g.cards[amb].zone).toBe('graveyard');
    expect(hasKeyword(g.cards[bear], getCard, 'Ward', g)).toBe(false);
    // A manifested creature card turns face up for its mana cost; Growing Dread puts a +1/+1 counter on it.
    act(g, ctx, 'a', { t: 'turnFaceUp', iid: bear });
    resolveAll(g, ctx);
    expect(g.cards[bear].faceDown).toBe(false);
    expect(g.cards[bear].counters['+1/+1']).toBe(1);
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Cloak (Cryptic Coat): the top card enters face down with ward {2} and the Coat attaches to it', () => {
    const { g, ctx } = setup(['cryptic_coat', 'grizzly_bears']);
    const coat = toHand(g, ctx, 'cryptic_coat');
    const bear = toTop(g, ctx, 'grizzly_bears');
    lands(g, ctx, 4);
    act(g, ctx, 'a', { t: 'cast', iid: coat, targets: [] });
    resolveAll(g, ctx);
    expect(g.cards[bear].zone).toBe('battlefield');
    expect(g.cards[bear].faceDownAs).toBe('cloak');
    expect(hasKeyword(g.cards[bear], getCard, 'Ward', g)).toBe(true);
    expect(g.cards[coat].attachedTo).toBe(bear);
    expect(logText(g)).not.toMatch(MANUAL);
  });
});
