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
 * - castOptions(state, iid, face?)          ways to cast a card: normal / kicker / alternative costs (cast.costOption)
 * - manaOptionsFor(state, iid)              mana abilities of a permanent (activateMana action)
 * - castTimingError / activationError       timing checks (cast / activate `force: true` skips them)
 */
import type { Rng } from '../draft.ts';
import type { Lookup } from '../game/rules.ts';

export * from './types.ts';
export { getScript, spellAbility, activatedAbilitiesOf, isAutomatable, targetSpecs, flatten, parseAbility } from './script.ts';
export { isValidTarget, matchCard, matchPlayer } from './targets.ts';
export { castOptions, parseCost } from './costs.ts';
export { divisionError } from './divide.ts';
export { manaOptionsFor } from './mana.ts';
export { activationError, castTimingError, loyaltyError, sorceryTiming } from './timing.ts';
export { evalCount, conditionTrue } from './counts.ts';
export { turnInfo } from './durations.ts';

export interface EngineCtx { rng: Rng; lookup: Lookup; now: number }
