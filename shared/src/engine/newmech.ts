/**
 * Newer set mechanics (Outlaws of Thunder Junction, Aetherdrift, Edge of Eternities, TMNT ...):
 *
 *  - Plot (702.170): a special action at sorcery speed — pay the plot cost, exile the card from your hand face up. On a
 *    later turn you may cast it without paying its mana cost, at sorcery speed (cast option 'plot', castkw.ts).
 *  - Warp (702.185): cast it from your hand for its warp cost (cast option 'warp'); at the beginning of the next end
 *    step it's exiled, and on a later turn it may be cast from exile (option 'warpExile') for its mana cost.
 *  - Saddle N (702.171): tap other untapped creatures with total power N or more (as Crew, keyword-play.ts): the Mount
 *    becomes saddled until end of turn (property IsSaddled; SaddledThisTurn for the creatures that saddled). Sorcery speed.
 *  - Station (702.184): tap another untapped creature you control: put charge counters equal to its power on this
 *    Spacecraft. Sorcery speed.
 *  - Start your engines! / speed (702.179): a player who controls a permanent with it and has no speed gets speed 1.
 *    Once each turn, when an opponent of the active player loses life during that player's turn, the active player's
 *    speed goes up by one (to 4 at most). "Max speed" (Condition$ MaxSpeed) is speed 4; Count$YourSpeed. Kept in the
 *    player's counters ("speed").
 *  - Sneak (TMNT): cast it for its sneak cost by returning an unblocked attacker you control to its owner's hand, during
 *    the declare blockers step (option 'sneak'); a permanent spell enters tapped and attacking.
 */
import { cardName, effectivePT } from '../game/rules.ts';
import { type Ctx, log, moveCard, player, randomId } from '../game/state.ts';
import type { CardInstance, GameState, StackItem } from '../game/types.ts';
import { turnInfo } from './durations.ts';
import { canPayMana, payMana } from './paycost.ts';
import { scriptFaceOf } from './script.ts';
import type { ParsedAbility } from './types.ts';
import { costText } from './keywords.ts';

export const MAX_SPEED = 4;

const pname = (state: GameState, pid: string) => state.players.find((p) => p.pid === pid)?.name ?? 'someone';

// ------------------------------------------------------------------ plot

/** Was `iid` plotted on an earlier turn (and still in exile)? undefined = not plotted. */
export function plottedTurn(state: GameState, c: CardInstance): number | undefined {
  const t = state.remembered?.[`plotted|${c.iid}`]?.[0];
  return t != null && c.zone === 'exile' && !c.faceDown ? parseInt(t, 10) : undefined;
}

/** Plot a card from `pid`'s hand (special action, or an effect's "plot it"). */
export function plotCard(state: GameState, ctx: Ctx, pid: string, c: CardInstance) {
  moveCard(state, ctx, c.iid, 'exile');
  if (state.cards[c.iid]?.zone !== 'exile') return;
  (state.remembered ??= {})[`plotted|${c.iid}`] = [String(state.turn)];
  (state.events ??= []).push({ t: 'plotted', iid: c.iid, pid } as never);
}

/** Plot special action (synthesized AB$ _Plot, keyword-play.ts specialAction). Returns an error or null. */
export function plotAction(state: GameState, ctx: Ctx, pid: string, c: CardInstance, ab: ParsedAbility): string | null {
  if (c.zone !== 'hand' || c.owner !== pid) return 'Plot: the card must be in your hand';
  const cost = costText(ab.params.Cost ?? '0');
  if (!/^(\{[^}]+\})+$/.test(cost)) return `Plot: can't pay ${cost} automatically`;
  if (!canPayMana(state, pid, cost, 0, ctx.lookup)) return `Plot: you need ${cost}`;
  payMana(state, ctx, pid, cost);
  const name = cardName(c, ctx.lookup);
  plotCard(state, ctx, pid, c);
  log(state, ctx, pid, `${pname(state, pid)} pays ${cost} and plots ${name} (exiled; cast it for free on a later turn as a sorcery).`);
  return null;
}

// ------------------------------------------------------------------ warp

const WARP_LINE = 'DB$ _WarpExile | Defined$ Self | SpellDescription$ Warp: exile it. You may cast it from exile on a later turn.';

/** A spell cast for its warp cost resolved onto the battlefield: exile it at the beginning of the next end step. */
export function warpResolved(state: GameState, ctx: Ctx, item: StackItem, c: CardInstance) {
  if (c.zone !== 'battlefield') return;
  const name = cardName(c, ctx.lookup);
  (state.delayedTriggers ??= []).push({
    id: randomId(ctx.rng), controller: item.controller, sourceIid: c.iid, sourceName: name, text: `${name}: Warp — exile ${name}; it may be cast from exile on a later turn.`,
    step: 'end', turn: state.turn, createdStep: state.step,
    auto: { cardId: c.cardId ?? '', face: 0, source: 'trigger', index: -1, targets: [], line: WARP_LINE, trigger: { mode: 'Delayed', card: c.iid } },
  });
}

/** The warp delayed trigger: exile the permanent (if it's still the same object) and let its owner cast it later. */
export function warpExile(state: GameState, ctx: Ctx, controller: string, iid: string | undefined) {
  const c = iid ? state.cards[iid] : undefined;
  if (!c || c.zone !== 'battlefield' || !c.castInfo?.warped) return;
  const name = cardName(c, ctx.lookup);
  moveCard(state, ctx, c.iid, 'exile');
  if (state.cards[c.iid]?.zone !== 'exile') return;
  (state.remembered ??= {})[`warped|${c.iid}`] = [String(state.turn)];
  log(state, ctx, controller, `${name} is exiled (warp); it may be cast from exile on a later turn.`);
}

/** Exiled by its warp trigger on an earlier turn (castable from exile now)? */
export function warpCastable(state: GameState, c: CardInstance): boolean {
  const t = state.remembered?.[`warped|${c.iid}`]?.[0];
  return t != null && c.zone === 'exile' && !c.faceDown && parseInt(t, 10) < state.turn;
}

// ------------------------------------------------------------------ saddle / station

/** Saddle resolved: the Mount is saddled until end of turn; the creatures that saddled it are remembered for the turn. */
export function saddle(state: GameState, ctx: Ctx, controller: string, src: CardInstance, saddlers: string[]) {
  src.tempKeywords = [...new Set([...(src.tempKeywords ?? []), 'Saddled'])];
  const ti = turnInfo(state);
  for (const s of saddlers) ti.activations[`saddled|${s}`] = 1;
  ti.activations[`saddledMount|${src.iid}`] = (ti.activations[`saddledMount|${src.iid}`] ?? 0) + 1;
  log(state, ctx, controller, `${cardName(src, ctx.lookup)} becomes saddled until end of turn.`);
}

/** Station resolved: charge counters equal to the tapped creature's power. */
export function station(state: GameState, ctx: Ctx, controller: string, src: CardInstance, power: number) {
  if (power > 0) src.counters.charge = (src.counters.charge ?? 0) + power;
  log(state, ctx, controller, `${cardName(src, ctx.lookup)} gets ${Math.max(0, power)} charge counter${power === 1 ? '' : 's'} (station; now ${src.counters.charge ?? 0}).`);
}

export const powerOf = (state: GameState, ctx: Ctx, iid: string) => Math.max(0, effectivePT(state.cards[iid], ctx.lookup, state)[0]);

// ------------------------------------------------------------------ speed

/** `pid`'s speed (0 = none). */
export function speedOf(state: Pick<GameState, 'players'>, pid: string): number {
  return state.players.find((p) => p.pid === pid)?.counters.speed ?? 0;
}

/** Players who control a permanent with "Start your engines!" and have no speed get speed 1. */
export function startEngines(state: GameState, ctx: Ctx) {
  for (const iid of state.battlefield) {
    const c = state.cards[iid];
    if (!c || c.faceDown) continue;
    const p = player(state, c.controller);
    if ((p.counters.speed ?? 0) > 0) continue;
    if (!scriptFaceOf(c)?.keywords.includes('Start your engines')) continue;
    p.counters.speed = 1;
    log(state, ctx, p.pid, `${p.name}'s speed is 1 (start your engines!).`);
  }
}

/** An opponent of the active player lost life: the active player's speed goes up (once per turn, to 4 at most). */
export function speedOnLifeLoss(state: GameState, ctx: Ctx, loser: string) {
  const active = state.activePlayer;
  if (!active || loser === active) return;
  const p = player(state, active);
  const s = p.counters.speed ?? 0;
  if (s <= 0 || s >= MAX_SPEED) return;
  const ti = turnInfo(state);
  if (ti.activations[`speedUp|${active}`]) return;
  ti.activations[`speedUp|${active}`] = 1;
  p.counters.speed = s + 1;
  log(state, ctx, active, `${p.name}'s speed increases to ${s + 1}${s + 1 === MAX_SPEED ? ' (max speed)' : ''}.`);
}
