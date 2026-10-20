import type { TokenData } from '../cards.ts';
import type { Rng } from '../draft.ts';
import { afterMove, beforeMove } from '../engine/durations.ts';
import { faceOf, type Lookup } from './rules.ts';
import { drawHooks, moveHooks, type MoveOpts } from './hooks.ts';
import type { CardInstance, GameEvent, GamePlayer, GameState, PlayerZone, Zone } from './types.ts';

/** Low-level state helpers shared by the reducer and the card-effects engine. */

export interface Ctx { rng: Rng; lookup: Lookup; now: number }

export function randomId(rng: Rng): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rng() * 36)];
  return s;
}

export function newInstance(state: GameState, rng: Rng, owner: string, zone: Zone, cardId?: string, token?: TokenData): CardInstance {
  let iid = randomId(rng);
  while (state.cards[iid]) iid = randomId(rng);
  const inst: CardInstance = {
    iid, cardId, token, owner, controller: owner, zone, tapped: false, faceDown: false, transformed: false,
    counters: {}, damage: 0, tempPT: [0, 0], permPT: [0, 0], summoningSick: false, noUntap: false, revealedTo: [],
  };
  state.cards[iid] = inst;
  return inst;
}

export function player(state: GameState, pid: string): GamePlayer {
  const p = state.players.find((x) => x.pid === pid);
  if (!p) throw new Error('Unknown player');
  return p;
}
export function log(state: GameState, ctx: Ctx, pid: string | null, text: string) {
  state.log.push({ at: ctx.now, pid, text });
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
}

/** Stage 2: record an event for trigger detection (only while the game is being played). */
export function emit(state: GameState, ev: GameEvent) {
  if (state.phase !== 'playing') return;
  const evs = (state.events ??= []);
  if (evs.length < 500) evs.push(ev);
}

/** Stage 2: per-turn counters. */
export function turnStats(state: GameState): NonNullable<GameState['turnStats']> {
  return (state.turnStats ??= { cast: {}, drawn: {} });
}

export function shuffleLibrary(state: GameState, p: GamePlayer, rng: Rng) {
  const lib = p.zones.library;
  for (let i = lib.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [lib[i], lib[j]] = [lib[j], lib[i]];
  }
  // Re-key so nobody can follow a card through the shuffle.
  p.zones.library = lib.map((old) => {
    const inst = state.cards[old];
    delete state.cards[old];
    let iid = randomId(rng);
    while (state.cards[iid]) iid = randomId(rng);
    inst.iid = iid;
    inst.revealedTo = [];
    state.cards[iid] = inst;
    return iid;
  });
  if (p.peek) p.peek = null;
}

export function drawCards(state: GameState, p: GamePlayer, n: number): number {
  let drawn = 0;
  const limit = state.phase === 'playing' && n > 0 ? drawHooks.limit?.(state, p.pid) : undefined;
  for (let i = 0; i < n; i++) {
    if (limit && (turnStats(state).drawn[p.pid] ?? 0) >= limit.max) {
      state.log.push({ at: state.log[state.log.length - 1]?.at ?? 0, pid: p.pid, text: `${p.name} can't draw ${n - i === 1 ? 'that card' : `${n - i} more cards`} (${limit.reason}).` });
      break;
    }
    const iid = p.zones.library.shift();
    if (!iid) { if (state.phase === 'playing') p.drewFromEmpty = true; break; }
    const c = state.cards[iid];
    c.zone = 'hand';
    c.revealedTo = [];
    p.zones.hand.push(iid);
    drawn++;
    if (state.phase === 'playing') {
      const st = turnStats(state);
      st.drawn[p.pid] = (st.drawn[p.pid] ?? 0) + 1;
      emit(state, { t: 'drawn', iid, pid: p.pid, nth: st.drawn[p.pid] });
    }
  }
  return drawn;
}

/** Remove a card from wherever it currently is. */
export function detach(state: GameState, inst: CardInstance) {
  if (inst.zone === 'battlefield') {
    state.battlefield = state.battlefield.filter((x) => x !== inst.iid);
    for (const other of state.battlefield) {
      const o = state.cards[other];
      if (o.attachedTo === inst.iid) o.attachedTo = undefined;
      if (o.blocking === inst.iid) o.blocking = undefined;
      if (o.attacking === inst.iid) o.attacking = undefined;
    }
  } else if (inst.zone === 'stack') {
    state.stack = state.stack.filter((s) => s.iid !== inst.iid);
  } else {
    const owner = player(state, inst.owner);
    const z = owner.zones[inst.zone as PlayerZone];
    const i = z.indexOf(inst.iid);
    if (i >= 0) z.splice(i, 1);
  }
}

export function resetPermanentState(inst: CardInstance) {
  inst.tapped = false;
  inst.counters = {};
  inst.damage = 0;
  inst.tempPT = [0, 0];
  inst.permPT = [0, 0];
  inst.attachedTo = undefined;
  inst.attacking = undefined;
  inst.blocking = undefined;
  inst.summoningSick = false;
  inst.noUntap = false;
  inst.note = undefined;
  inst.tempKeywords = undefined;
}

// Zone-change replacement hook: game/hooks.ts (import-free, so engine modules in import cycles can install it).
export { moveHooks, type MoveOpts } from './hooks.ts';

/** Move a card between zones, applying replacement effects (see moveHooks). */
export function moveCard(state: GameState, ctx: Ctx, iid: string, to: Zone, opts: MoveOpts = {}) {
  const r = state.cards[iid] ? moveHooks.before?.(state, ctx, iid, to, opts) : undefined;
  moveCardRaw(state, ctx, iid, r?.to ?? to, r?.opts ?? opts);
  r?.after?.();
}

/** Move a card between zones without replacement effects. */
export function moveCardRaw(state: GameState, ctx: Ctx, iid: string, to: Zone, opts: MoveOpts = {}) {
  const inst = state.cards[iid];
  const from = inst.zone;
  to = beforeMove(state, inst, to); // engine bookkeeping (Revolt) and flashback -> exile
  // Stage 2: zone-change event with a last-known-information snapshot (taken before anything is reset).
  if (state.phase === 'playing' && from !== to) {
    const snap = JSON.parse(JSON.stringify(inst)) as CardInstance;
    const ev: GameEvent = opts.cause ? { t: 'zone', iid, from, to, snap, cause: opts.cause } : { t: 'zone', iid, from, to, snap };
    // Last-known information: what was attached to it (Skullclamp's "equipped creature dies" looks back to this).
    if (from === 'battlefield') {
      const attached = state.battlefield.filter((o) => o !== iid && state.cards[o]?.attachedTo === iid);
      if (attached.length) (ev as Extract<GameEvent, { t: 'zone' }>).attached = attached;
    }
    emit(state, ev);
  }
  detach(state, inst);
  // Tokens and copies cease to exist outside the battlefield/stack.
  if (inst.token && to !== 'battlefield' && to !== 'stack') {
    delete state.cards[iid];
    afterMove(state, ctx, inst, from, to);
    return;
  }
  if (from === 'battlefield' || to !== 'battlefield') {
    if (from === 'battlefield') resetPermanentState(inst);
  }
  if (to !== 'battlefield') {
    inst.controller = inst.owner;
    inst.transformed = false;
    inst.castAs = to === 'exile' ? inst.castAs : undefined;
    inst.faceDown = !!opts.faceDown;
  }
  inst.revealedTo = [];
  inst.unseen = to === 'exile' && opts.faceDown && opts.unseen ? true : undefined;
  inst.zone = to;
  if (to === 'battlefield') {
    if (from !== 'battlefield') {
      inst.summoningSick = true;
      inst.faceDown = !!opts.faceDown;
      inst.castAs = undefined;
      if (opts.controller) inst.controller = opts.controller;
      // "Return it to the battlefield transformed": it enters back face up (a planeswalker gets the back face's loyalty).
      if (opts.transformed) inst.transformed = true;
      const face = faceOf(inst, ctx.lookup);
      if (face.loyalty && !inst.faceDown) inst.counters.loyalty = parseInt(face.loyalty, 10) || 0;
    }
    inst.tapped = !!opts.tapped;
    state.battlefield.push(iid);
  } else if (to === 'stack') {
    // caller pushes the stack item
  } else {
    const owner = player(state, inst.owner);
    const z = owner.zones[to as PlayerZone];
    if (opts.position === 'bottom') z.push(iid);
    else if (typeof opts.position === 'number') z.splice(opts.position, 0, iid);
    else if (to === 'library' || opts.position === 'top') z.unshift(iid);
    else z.push(iid);
  }
  afterMove(state, ctx, inst, from, to);
}
