/**
 * Non-cube mechanics with real Forge scripts (fixtures/mechanics.ts): face-down permanents (disguise, cloak, manifest
 * dread), plot, warp, saddle, station, speed, sneak and granted numbered keywords. Strict (rules-enforced) games.
 */
import { describe, expect, it } from 'vitest';
import { getCard, registerCards } from '../src/cube.ts';
import { applyAction, createGame, type CardData, type Ctx, type GameAction, type GameState, type TargetRef, effectivePT, hasKeyword, moveCard, viewFor, castOptions, abilitiesOfInstance, activatedAbilitiesOf, isCreature } from '../src/index.ts';
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

/** Advance to `pid`'s next main phase 1 (passing priority; the stack must be empty). */
function nextMain(g: GameState, ctx: Ctx, pid: string) {
  const turn = g.turn;
  for (let i = 0; i < 200 && !(g.turn > turn && g.activePlayer === pid && g.step === 'main1'); i++) {
    const q = g.pending[0];
    if (q?.options.length) act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options[0].value });
    else act(g, ctx, g.priority, { t: 'pass' });
  }
}
const life = (g: GameState, pid: string) => g.players.find((p) => p.pid === pid)!.life;
const speed = (g: GameState, pid: string) => g.players.find((p) => p.pid === pid)!.counters.speed ?? 0;

describe('plot, warp', () => {
  it('Plot (Outcaster Trailblazer): plotted from hand as a special action, cast free on a later turn at sorcery speed', () => {
    const { g, ctx } = setup(['outcaster_trailblazer'], []);
    const ot = toHand(g, ctx, 'outcaster_trailblazer');
    lands(g, ctx, 3);
    const plot = abilitiesOfInstance(g.cards[ot], g, getCard).length ? undefined : undefined; void plot;
    const ab = activatedAbilitiesOf('outcaster_trailblazer', 0).find((e) => e.keyword === 'Plot')!;
    expect(ab).toBeDefined();
    act(g, ctx, 'a', { t: 'activate', iid: ot, ability: ab.index, text: 'Plot', targets: [] });
    expect(g.cards[ot].zone).toBe('exile');
    expect(g.stack.length).toBe(0); // a special action
    expect(castOptions(g, ot, undefined, getCard).find((o) => o.id === 'plot')?.unavailable).toMatch(/turn you plotted/);
    nextMain(g, ctx, 'a');
    const untapped = g.battlefield.filter((i) => g.cards[i].controller === 'a' && !g.cards[i].tapped).length;
    act(g, ctx, 'a', { t: 'cast', iid: ot, costOption: 'plot', targets: [] });
    resolveAll(g, ctx);
    expect(g.cards[ot].zone).toBe('battlefield');
    expect(g.battlefield.filter((i) => g.cards[i].controller === 'a' && !g.cards[i].tapped).length).toBe(untapped + 1); // nothing tapped to cast it
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Warp (Quantum Riddler): cast for its warp cost, exiled at the next end step, cast from exile on a later turn', () => {
    const { g, ctx } = setup(['quantum_riddler'], []);
    const qr = toHand(g, ctx, 'quantum_riddler');
    lands(g, ctx, 10);
    const opt = castOptions(g, qr, undefined, getCard).find((o) => o.id === 'warp')!;
    expect(opt.cost).toBe('{1}{U}');
    act(g, ctx, 'a', { t: 'cast', iid: qr, costOption: 'warp', targets: [] });
    resolveAll(g, ctx);
    expect(g.cards[qr].zone).toBe('battlefield');
    // To the end step: the warp trigger exiles it.
    for (let i = 0; i < 40 && g.step !== 'end'; i++) act(g, ctx, g.priority, { t: 'pass' });
    resolveAll(g, ctx);
    expect(g.cards[qr].zone).toBe('exile');
    nextMain(g, ctx, 'a');
    const again = castOptions(g, qr, undefined, getCard).find((o) => o.id === 'warpExile')!;
    expect(again.unavailable).toBeUndefined();
    act(g, ctx, 'a', { t: 'cast', iid: qr, costOption: 'warpExile', targets: [] });
    resolveAll(g, ctx);
    expect(g.cards[qr].zone).toBe('battlefield');
    expect(logText(g)).not.toMatch(MANUAL);
  });
});

describe('saddle, station', () => {
  it('Saddle 3 (Brightfield Glider): tap other creatures with power 3; it attacks saddled and its trigger fires', () => {
    const { g, ctx } = setup(['brightfield_glider', 'grizzly_bears', 'savannah_lions']);
    const glider = put(g, ctx, 'brightfield_glider');
    const bear = put(g, ctx, 'grizzly_bears');
    const lion = put(g, ctx, 'savannah_lions');
    const ab = abilitiesOfInstance(g.cards[glider], g, getCard).find((e) => e.keyword === 'Saddle')!;
    act(g, ctx, 'a', { t: 'activate', iid: glider, ability: ab.index, text: 'Saddle', targets: [] });
    for (const iid of [bear, lion]) { const q = g.pending[0]; act(g, ctx, 'a', { t: 'choose', id: q.id, value: iid }); }
    expect(g.cards[bear].tapped && g.cards[lion].tapped).toBe(true);
    resolveAll(g, ctx);
    expect(g.cards[glider].tempKeywords).toContain('Saddled');
    for (let i = 0; i < 10 && g.step !== 'attackers'; i++) act(g, ctx, g.priority, { t: 'pass' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: glider, target: 'b' });
    act(g, ctx, 'a', { t: 'pass' });
    resolveAll(g, ctx);
    expect(hasKeyword(g.cards[glider], getCard, 'Flying', g)).toBe(true);
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Station (Galvanizing Sawship): tap another creature, charge counters equal to its power; at 3 it is a flying creature', () => {
    const { g, ctx } = setup(['galvanizing_sawship', 'serra_angel']);
    const ship = put(g, ctx, 'galvanizing_sawship');
    const angel = put(g, ctx, 'serra_angel');
    const ab = abilitiesOfInstance(g.cards[ship], g, getCard).find((e) => e.keyword === 'Station')!;
    act(g, ctx, 'a', { t: 'activate', iid: ship, ability: ab.index, text: 'Station', targets: [] });
    act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: angel });
    resolveAll(g, ctx);
    expect(g.cards[angel].tapped).toBe(true);
    expect(g.cards[ship].counters.charge).toBe(4);
    expect(isCreature(g.cards[ship], getCard, g)).toBe(true);
    expect(hasKeyword(g.cards[ship], getCard, 'Flying', g)).toBe(true);
    expect(logText(g)).not.toMatch(MANUAL);
  });
});

describe('start your engines, sneak, granted numbered keywords', () => {
  it('Speed (Walking Sarcophagus): starts at 1, +1 once per turn when an opponent loses life on your turn; max speed at 4', () => {
    const { g, ctx } = setup(['walking_sarcophagus', 'lightning_bolt', 'lightning_bolt']);
    const sarc = put(g, ctx, 'walking_sarcophagus');
    lands(g, ctx, 3);
    act(g, ctx, 'a', { t: 'pass' }); resolveAll(g, ctx);
    expect(speed(g, 'a')).toBe(1);
    const base = effectivePT(g.cards[sarc], getCard, g);
    g.players.find((p) => p.pid === 'a')!.counters.speed = 3;
    const bolts = Object.keys(g.cards).filter((i) => g.cards[i].cardId === 'lightning_bolt' && g.cards[i].owner === 'a');
    for (const b of bolts) if (g.cards[b].zone !== 'hand') moveCard(g, ctx, b, 'hand');
    act(g, ctx, 'a', { t: 'cast', iid: bolts[0], targets: [[{ kind: 'player', pid: 'b' }]] });
    resolveAll(g, ctx);
    expect(life(g, 'b')).toBe(17);
    expect(speed(g, 'a')).toBe(4);
    expect(effectivePT(g.cards[sarc], getCard, g)).toEqual([base[0] + 1, base[1] + 2]); // max speed
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Speed goes up only once per turn', () => {
    const { g, ctx } = setup(['walking_sarcophagus', 'lightning_bolt', 'lightning_bolt']);
    put(g, ctx, 'walking_sarcophagus');
    lands(g, ctx, 8);
    const bolts = Object.keys(g.cards).filter((i) => g.cards[i].cardId === 'lightning_bolt' && g.cards[i].owner === 'a');
    for (const b of bolts) if (g.cards[b].zone !== 'hand') moveCard(g, ctx, b, 'hand');
    for (const b of bolts) { act(g, ctx, 'a', { t: 'cast', iid: b, targets: [[{ kind: 'player', pid: 'b' }]] }); resolveAll(g, ctx); }
    expect(life(g, 'b')).toBe(14);
    expect(speed(g, 'a')).toBe(2);
  });

  it('Sneak (Leonardo, Leader in Blue): cast in the declare blockers step by returning an unblocked attacker; enters tapped and attacking', () => {
    const { g, ctx } = setup(['leonardo_leader_in_blue', 'grizzly_bears']);
    const leo = toHand(g, ctx, 'leonardo_leader_in_blue');
    const bear = put(g, ctx, 'grizzly_bears');
    lands(g, ctx, 10);
    g.players.find((p) => p.pid === 'a')!.stops.own.push('blockers');
    expect(castOptions(g, leo, undefined, getCard).find((o) => o.id === 'sneak')?.unavailable).toBeTruthy();
    for (let i = 0; i < 10 && g.step !== 'attackers'; i++) act(g, ctx, g.priority, { t: 'pass' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: bear, target: 'b' });
    for (let i = 0; i < 10 && !(g.step === 'blockers' && g.combat.blockersDeclared && g.priority === 'a'); i++) act(g, ctx, g.priority, { t: 'pass' });
    act(g, ctx, 'a', { t: 'cast', iid: leo, costOption: 'sneak', targets: [] });
    resolveAll(g, ctx, (labels) => labels.findIndex((l) => /Grizzly/.test(l)));
    expect(g.cards[bear].zone).toBe('hand');
    expect(g.cards[leo].zone).toBe('battlefield');
    expect(g.cards[leo].tapped).toBe(true);
    expect(g.cards[leo].attacking).toBe('b');
    expect(logText(g)).toMatch(/creatures you control get \+2\/\+0|get \+2\/\+0/);
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Granted firebending (Fire Nation Palace): the creature gains firebending 4 and adds {R}{R}{R}{R} when it attacks', () => {
    const { g, ctx } = setup(['fire_nation_palace', 'grizzly_bears']);
    const palace = put(g, ctx, 'fire_nation_palace');
    const bear = put(g, ctx, 'grizzly_bears');
    g.cards[palace].tapped = false;
    lands(g, ctx, 3);
    act(g, ctx, 'a', { t: 'activate', iid: palace, ability: 1, text: 'firebending', targets: [[{ kind: 'card', iid: bear }]] });
    resolveAll(g, ctx);
    expect(g.cards[bear].tempKeywords).toContain('Firebending:4');
    for (let i = 0; i < 10 && g.step !== 'attackers'; i++) act(g, ctx, g.priority, { t: 'pass' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: bear, target: 'b' });
    act(g, ctx, 'a', { t: 'pass' });
    for (let i = 0; i < 5 && g.stack.length; i++) act(g, ctx, g.priority, { t: 'pass' });
    expect(logText(g)).toMatch(/Firebending 4/);
    expect(logText(g)).toMatch(/\{R\}\{R\}\{R\}\{R\}|4 \{R\}|R ×4|adds/);
    expect(logText(g)).not.toMatch(MANUAL);
  });
});
