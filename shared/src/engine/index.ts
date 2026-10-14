/**
 * Public API of the card-effects engine. The client uses these to offer automatic
 * casting/activation and to drive targeting; the reducer uses them to resolve.
 *
 * STUBS: implemented by the engine work (see engine/types.ts for the contract).
 */
import type { GameState } from '../game/types.ts';
import type { Lookup } from '../game/rules.ts';
import type { ForgeFace, ParsedAbility, TargetRef, TargetSpec } from './types.ts';
import type { Rng } from '../draft.ts';

export * from './types.ts';

export interface EngineCtx { rng: Rng; lookup: Lookup; now: number }

/** Script faces for a card id, or undefined if the card has no script. */
export function getScript(_cardId: string): ForgeFace[] | undefined {
  throw new Error('not implemented');
}

/** The face's spell ability (first SP$ line), parsed with its sub-ability chain. */
export function spellAbility(_cardId: string, _face: number): { index: number; ability: ParsedAbility } | undefined {
  throw new Error('not implemented');
}

/** The face's activated abilities (AB$ lines), excluding mana abilities. `index` is the A: line index. */
export function activatedAbilitiesOf(_cardId: string, _face: number): { index: number; ability: ParsedAbility; cost: string; loyalty?: number }[] {
  throw new Error('not implemented');
}

/** Whether the engine can fully automate this ability chain (all steps supported). */
export function isAutomatable(_ability: ParsedAbility): { ok: boolean; unsupported: string[] } {
  throw new Error('not implemented');
}

/** Targets this chain needs, in order. */
export function targetSpecs(_ability: ParsedAbility): TargetSpec[] {
  throw new Error('not implemented');
}

/**
 * Is `ref` a legal choice for `spec`, for a spell/ability controlled by `controller`
 * whose source card is `sourceIid`? Works on full state and on GameView-shaped state
 * (hidden cards are never legal).
 */
export function isValidTarget(_state: Pick<GameState, 'cards' | 'players' | 'stack' | 'battlefield'>, _spec: TargetSpec, _ref: TargetRef, _controller: string, _sourceIid: string | undefined, _lookup: Lookup): boolean {
  throw new Error('not implemented');
}
