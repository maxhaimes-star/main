/**
 * Timing restrictions and activation limits. The table is player-driven, so every check can be skipped
 * with `force: true` on the action (fixing mistakes, effects the engine doesn't model).
 *
 * - Sorcery-speed casting for everything but instants, Flash (keyword or a CastWithFlash static), and
 *   Teferi, Time Raveler-style "opponents only at sorcery speed".
 * - Loyalty abilities: once per turn per planeswalker, sorcery speed.
 * - SorcerySpeed$ True, PlayerTurn$ True, ActivationLimit$ N on activated abilities.
 */
import { faceOf, type Lookup } from '../game/rules.ts';
import type { CardInstance, GameState } from '../game/types.ts';
import { turnInfo } from './durations.ts';
import { getScript, loyaltyOf, parseParams, scriptFaceOf } from './script.ts';
import { matchCard } from './targets.ts';
import { grantsFlash } from './statics.ts';
import type { ParsedAbility } from './types.ts';

export const SORCERY_SPEED = 'your main phase, while the stack is empty';

/** Could `pid` do something at sorcery speed right now? */
export function sorceryTiming(state: GameState, pid: string): boolean {
  return state.activePlayer === pid && (state.step === 'main1' || state.step === 'main2') && state.stack.length === 0;
}

function staticsOn(state: GameState): { c: CardInstance; params: Record<string, string> }[] {
  const out: { c: CardInstance; params: Record<string, string> }[] = [];
  for (const iid of state.battlefield) {
    const c = state.cards[iid];
    if (!c || c.faceDown) continue;
    const f = scriptFaceOf(c);
    for (const line of f?.statics ?? []) out.push({ c, params: parseParams(line).params });
  }
  return out;
}

/** The type line of the face being cast. */
function castTypeLine(c: CardInstance, face: number | undefined, lookup: Lookup): string {
  if (c.faceDown) return 'Creature';
  const data = c.cardId ? lookup(c.cardId) : undefined;
  if (data?.faces && face != null && data.faces[face]) return data.faces[face].typeLine;
  if (data?.layout === 'adventure' || data?.layout === 'split' || data?.layout === 'modal_dfc' || data?.layout === 'transform') return data.faces?.[0]?.typeLine ?? data.typeLine;
  return data?.typeLine ?? faceOf(c, lookup).typeLine;
}

/** Error if `pid` can't cast this card now, else null. */
export function castTimingError(state: GameState, c: CardInstance, pid: string, face: number | undefined, lookup: Lookup, faceDown = false): string | null {
  if (state.phase !== 'playing') return null;
  const now = sorceryTiming(state, pid);
  if (now) return null;
  const name = faceDown ? 'A face-down spell' : (c.cardId && lookup(c.cardId)?.faces && face != null ? lookup(c.cardId)!.faces![face]?.name : undefined) ?? faceOf(c, lookup).name;
  const statics = staticsOn(state);
  // Teferi, Time Raveler: each opponent can cast spells only any time they could cast a sorcery.
  const lock = statics.find(({ c: src, params: p }) => p.Mode === 'CantBeCast' && p.OnlySorcerySpeed === 'True' && (p.Caster === 'Opponent' ? src.controller !== pid : p.Caster === 'You' ? src.controller === pid : true));
  if (lock) return `${name} can only be cast at sorcery speed (${faceOf(lock.c, lookup).name}) — ${SORCERY_SPEED}`;
  const typeLine = faceDown ? 'Creature' : castTypeLine(c, face, lookup);
  if (/\bInstant\b/.test(typeLine)) return null;
  if (!faceDown) {
    const script = c.cardId ? getScript(c.cardId)?.[face ?? 0] : undefined;
    if (script?.keywords.some((k) => k === 'Flash')) return null;
    const data = c.cardId ? lookup(c.cardId) : undefined;
    const oracle = data?.faces && face != null ? data.faces[face]?.oracle ?? '' : data?.oracle ?? '';
    if (/^Flash\b/m.test(oracle)) return null;
    // "You may cast ... as though they had flash" (Teferi +1 effect is not modelled: use force).
    for (const { c: src, params: p } of statics) {
      if (p.Mode !== 'CastWithFlash' || !p.ValidCard) continue;
      if (p.Caster === 'You' && src.controller !== pid) continue;
      if (p.Caster === 'Opponent' && src.controller === pid) continue;
      if (matchCard(c, p.ValidCard,{ controller: pid, sourceIid: src.iid, lookup }) === true) return null;
    }
    if (grantsFlash(state, c, pid, lookup) || script?.keywords.includes('MayFlashSac')) return null; // also from effects (Teferi, Time Raveler +1), engine/statics.ts
    // The card's own "as though it had flash" static (e.g. conditional flash) — trust the player.
    if (script?.statics.some((l) => /Mode\$ CastWithFlash/.test(l) && /ValidCard\$ Card\.Self/.test(l))) return null;
  }
  return `${name} can only be cast at sorcery speed — ${SORCERY_SPEED} (it doesn't have flash)`;
}

/** Error if this activated ability can't be activated now, else null. */
export function activationError(state: GameState, c: CardInstance, pid: string, ab: ParsedAbility, index: number, name: string): string | null {
  if (state.phase !== 'playing') return null;
  const p = ab.params;
  const loyalty = p.Planeswalker === 'True' || loyaltyOf(p.Cost ?? '') != null;
  if (loyalty) return loyaltyError(state, c, pid, name);
  if (p.SorcerySpeed === 'True' && !sorceryTiming(state, pid)) return `${name}: activate only as a sorcery — ${SORCERY_SPEED} (use force to override)`;
  if (p.PlayerTurn === 'True' && state.activePlayer !== pid) return `${name}: activate only during your turn (use force to override)`;
  if (p.Boast === 'True') {
    // Boast: only if this creature attacked this turn, and only once each turn (rule 702.142).
    const ti = turnInfo(state);
    if (!c.attacking && !(ti.activations[`attacked|${c.iid}`] ?? 0)) return `${name}: boast — activate only if this creature attacked this turn (use force to override)`;
    if ((ti.activations[`${c.iid}|${index}`] ?? 0) >= 1) return `${name}: boast — only once each turn (use force to override)`;
  }
  const limit = p.ActivationLimit ? parseInt(p.ActivationLimit, 10) : NaN;
  if (!Number.isNaN(limit) && (turnInfo(state).activations[`${c.iid}|${index}`] ?? 0) >= limit) return `${name}: this ability can be activated only ${limit === 1 ? 'once' : `${limit} times`} each turn (use force to override)`;
  return null;
}

/** Loyalty abilities: sorcery speed, one per planeswalker per turn. */
export function loyaltyError(state: GameState, c: CardInstance, pid: string, name: string): string | null {
  if (state.phase !== 'playing') return null;
  if (turnInfo(state).loyaltyUsed.includes(c.iid)) return `${name} already activated a loyalty ability this turn (use force to override)`;
  if (!sorceryTiming(state, pid)) return `Loyalty abilities can only be activated at sorcery speed — ${SORCERY_SPEED} (use force to override)`;
  return null;
}

/** Record an activation (call after it succeeded). */
export function recordActivation(state: GameState, c: CardInstance, ab: ParsedAbility | undefined, index: number | undefined, loyalty: boolean) {
  const ti = turnInfo(state);
  if (loyalty || ab?.params.Planeswalker === 'True') { if (!ti.loyaltyUsed.includes(c.iid)) ti.loyaltyUsed.push(c.iid); }
  if (index != null) ti.activations[`${c.iid}|${index}`] = (ti.activations[`${c.iid}|${index}`] ?? 0) + 1;
}
