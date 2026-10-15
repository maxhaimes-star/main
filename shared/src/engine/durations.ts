/**
 * Durations and per-turn bookkeeping:
 * - TurnInfo (Revolt, loyalty-ability / ActivationLimit$ counters), reset lazily when the turn changes.
 * - Timed effects the engine reverts: "until your next turn" pumps, "until end of turn" control (Threaten),
 *   "until CARDNAME leaves the battlefield" exile / control, Dash's return to hand.
 * - moveCard hooks (beforeMove / afterMove): Revolt tracking, flashback/escape spells exiled when they leave
 *   the stack, cast info cleanup, host-left effects.
 */
import { cardName } from '../game/rules.ts';
import { type Ctx, log, moveCard, randomId } from '../game/state.ts';
import type { CardInstance, GameState, Zone } from '../game/types.ts';
import type { TimedEffect, TurnInfo } from './types.ts';
import { extAfterMove, extAtCleanup, extAtTurnStart } from './ext.ts';

export function turnInfo(state: GameState): TurnInfo {
  if (!state.turnInfo || state.turnInfo.turn !== state.turn) {
    state.turnInfo = { turn: state.turn, leftBattlefield: [], loyaltyUsed: [], activations: {} };
  }
  return state.turnInfo;
}

/** Revolt: did a permanent `pid` controlled leave the battlefield this turn? */
export function revolt(state: GameState, pid: string): boolean {
  return turnInfo(state).leftBattlefield.includes(pid);
}

type NewEffect = TimedEffect extends infer E ? E extends TimedEffect ? Omit<E, 'id'> : never : never;

export function addEffect(state: GameState, ctx: Ctx, e: NewEffect) {
  (state.effects ??= []).push({ ...e, id: randomId(ctx.rng) } as TimedEffect);
}

// ------------------------------------------------------------------ moveCard hooks

/** Called by moveCard before anything moves. Returns the (possibly replaced) destination. */
export function beforeMove(state: GameState, inst: CardInstance, to: Zone): Zone {
  if (inst.zone === 'battlefield' && to !== 'battlefield') {
    const ti = turnInfo(state);
    if (!ti.leftBattlefield.includes(inst.controller)) ti.leftBattlefield.push(inst.controller);
    // A permanent that leaves and comes back is a new object: its limits start over.
    ti.loyaltyUsed = ti.loyaltyUsed.filter((x) => x !== inst.iid);
    for (const k of Object.keys(ti.activations)) if (k.startsWith(`${inst.iid}|`)) delete ti.activations[k];
  }
  // Flashback / escape: "If that spell would be put anywhere else, exile it instead."
  if (inst.zone === 'stack' && inst.castInfo?.exileOnLeave && to !== 'battlefield' && to !== 'stack') return 'exile';
  return to;
}

let reverting = 0;

/** Called by moveCard after the card moved. */
export function afterMove(state: GameState, ctx: Ctx, inst: CardInstance, from: Zone, to: Zone) {
  if (inst.castInfo && to !== 'stack' && !(from === 'stack' && to === 'battlefield') && from !== to) inst.castInfo = undefined;
  extAfterMove(state, ctx, inst, from, to); // animations / copies / effects (engine/ext.ts)
  if (from !== to && state.effects?.some((e) => e.kind === 'grant' && e.iid === inst.iid)) state.effects = state.effects.filter((e) => !(e.kind === 'grant' && e.iid === inst.iid));
  if (from === 'battlefield' && to !== 'battlefield' && state.effects?.length && reverting < 10) {
    reverting++;
    try { leftBattlefield(state, ctx, inst.iid); } finally { reverting--; }
  }
}

function leftBattlefield(state: GameState, ctx: Ctx, iid: string) {
  const effects = state.effects ?? [];
  const keep: TimedEffect[] = [];
  const todo: TimedEffect[] = [];
  for (const e of effects) {
    if ((e.kind === 'exiled' || e.kind === 'control') && e.until === 'hostLeaves' && e.hostIid === iid) todo.push(e);
    else if ((e.kind === 'control' || e.kind === 'dash') && e.iid === iid) continue; // the affected permanent is gone
    else if (e.kind === 'pump' && e.cards.includes(iid)) { const cards = e.cards.filter((x) => x !== iid); if (cards.length) keep.push({ ...e, cards }); }
    else keep.push(e);
  }
  state.effects = keep;
  for (const e of todo) {
    if (e.kind === 'exiled') {
      for (const x of e.cards) {
        const c = state.cards[x.iid];
        if (!c || c.zone !== 'exile') continue;
        const dest = (x.from === 'battlefield' ? 'battlefield' : x.from === 'hand' ? 'hand' : 'graveyard') as Zone;
        moveCard(state, ctx, x.iid, dest, dest === 'battlefield' ? { controller: x.owner } : {});
        log(state, ctx, null, `${cardName(c, ctx.lookup)} returns ${dest === 'battlefield' ? 'to the battlefield' : `to its owner's ${dest}`}.`);
      }
    } else if (e.kind === 'control') revertControl(state, ctx, e.iid, e.previous);
  }
}

function revertControl(state: GameState, ctx: Ctx, iid: string, previous: string) {
  const c = state.cards[iid];
  if (!c || c.zone !== 'battlefield' || c.controller === previous) return;
  c.controller = previous;
  c.attacking = undefined;
  c.blocking = undefined;
  const p = state.players.find((x) => x.pid === previous);
  log(state, ctx, null, `${p?.name ?? 'Its owner'} regains control of ${cardName(c, ctx.lookup)}.`);
}

// ------------------------------------------------------------------ turn structure hooks

/** Cleanup step, after "until end of turn" effects were cleared. */
export function durationsAtCleanup(state: GameState, ctx: Ctx) {
  extAtCleanup(state, ctx);
  if (!state.effects?.length) return;
  const keep: TimedEffect[] = [];
  for (const e of state.effects) {
    if (e.kind === 'control' && e.until === 'eot') { revertControl(state, ctx, e.iid, e.previous); continue; }
    if (e.kind === 'grant') continue; // "until end of turn" keyword grants (Snapcaster Mage)
    if (e.kind === 'dash') {
      const c = state.cards[e.iid];
      if (c?.zone === 'battlefield') { moveCard(state, ctx, e.iid, 'hand'); log(state, ctx, e.controller, `${cardName(c, ctx.lookup)} returns to its owner's hand (dash).`); }
      continue;
    }
    if (e.kind === 'pump') {
      // Re-apply what cleanup just removed: it lasts until its controller's next turn.
      for (const iid of e.cards) {
        const c = state.cards[iid];
        if (!c || c.zone !== 'battlefield') continue;
        c.tempPT = [c.tempPT[0] + e.pt[0], c.tempPT[1] + e.pt[1]];
        if (e.keywords.length) c.tempKeywords = [...new Set([...(c.tempKeywords ?? []), ...e.keywords])];
      }
    }
    keep.push(e);
  }
  state.effects = keep;
}

/** Start of `pid`'s turn: "until your next turn" effects of `pid` end. */
export function durationsAtTurnStart(state: GameState, ctx: Ctx, pid: string) {
  extAtTurnStart(state, ctx, pid);
  if (!state.effects?.length) return;
  const keep: TimedEffect[] = [];
  for (const e of state.effects) {
    if (e.kind === 'pump' && e.controller === pid) {
      const names: string[] = [];
      for (const iid of e.cards) {
        const c = state.cards[iid];
        if (!c || c.zone !== 'battlefield') continue;
        c.tempPT = [c.tempPT[0] - e.pt[0], c.tempPT[1] - e.pt[1]];
        if (c.tempKeywords) { c.tempKeywords = c.tempKeywords.filter((k) => !e.keywords.includes(k)); if (!c.tempKeywords.length) c.tempKeywords = undefined; }
        names.push(cardName(c, ctx.lookup));
      }
      if (names.length) log(state, ctx, null, `"Until your next turn" effect ends for ${names.join(', ')}.`);
      continue;
    }
    keep.push(e);
  }
  state.effects = keep;
}
