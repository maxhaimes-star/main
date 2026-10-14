/**
 * Public API of the card-effects engine. The client uses these to offer automatic
 * casting/activation and to drive targeting; the reducer uses them to resolve.
 *
 * - getScript(cardId)                       script faces (Forge data)
 * - spellAbility(cardId, face)              the face's SP$ ability (index -1 = aura spell synthesized from K:Enchant)
 * - activatedAbilitiesOf(cardId, face)      AB$ abilities (no mana abilities), with cost and loyalty
 * - isAutomatable(ability)                  { ok, unsupported[] }
 * - targetSpecs(ability, modes?)            targets needed, in order (pass Charm modes to get their targets)
 * - isValidTarget(state, spec, ref, ...)    legality of one choice (works on GameView too)
 * - processTriggers(state, ctx)             Stage 2: put triggered abilities from recorded events on the stack
 * - triggerSupport(cardId, face, index)     Stage 2: is a T: line detected / its chain automatable
 */
import type { Rng } from '../draft.ts';
import type { Lookup } from '../game/rules.ts';

export * from './types.ts';
export { getScript, spellAbility, activatedAbilitiesOf, isAutomatable, targetSpecs, flatten, parseAbility } from './script.ts';
export { isValidTarget, matchCard, matchPlayer } from './targets.ts';
export { processTriggers, queuedTriggers, triggerSupport, SUPPORTED_MODES, MAX_TRIGGERS_PER_ACTION } from './triggers.ts';

export interface EngineCtx { rng: Rng; lookup: Lookup; now: number }
