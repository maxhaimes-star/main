/**
 * Public API of the card-effects engine. The client uses these to offer automatic
 * casting/activation and to drive targeting; the reducer uses them to resolve.
 *
 * - getScript(cardId)                       script faces (Forge data)
 * - spellAbility(cardId, face)              the face's SP$ ability (index -1 = aura spell synthesized from K:Enchant)
 * - activatedAbilitiesOf(cardId, face)      AB$ abilities (no mana abilities), with cost and loyalty, plus keyword
 *                                           abilities (Equip, Cycling, Crew ...; index >= SYNTH_BASE) and `zone` (hand/graveyard)
 * - replacements.ts                         R: lines: enters tapped, shocklands, can't be countered, doesn't untap ...
 * - isAutomatable(ability)                  { ok, unsupported[] }
 * - targetSpecs(ability, modes?)            targets needed, in order (pass Charm modes to get their targets)
 * - isValidTarget(state, spec, ref, ...)    legality of one choice (works on GameView too)
 * - castOptions(state, iid, face?)          ways to cast a card: normal / kicker / alternative costs (cast.costOption)
 * - manaOptionsFor(state, iid)              mana abilities of a permanent (activateMana action)
 * - castTimingError / activationError       timing checks (cast / activate `force: true` skips them)
 * - processTriggers(state, ctx)             Stage 2: put triggered abilities from recorded events on the stack
 * - triggerSupport(cardId, face, index)     Stage 2: is a T: line detected / its chain automatable
 * - activeStatics(state, lookup)            static abilities in effect, for an "Active effects" panel
 * - effectiveCost(state, iid, face, lookup) mana cost after cost increases / reductions (Thalia ...)
 * - attackRestriction / blockRestriction / castRestriction   why a static forbids an action (or null)
 * - unique.ts / turns.ts                    hard cards: extra turns (state.extraTurns), Mindslaver (state.controlledBy,
 *                                           action.as, controls(state, viewer, pid)), Sagas (sagaOf, lore counters),
 *                                           Balance / votes / piles / hideaway / Oath / Sylvan Library / Dark Depths
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
export type { ActivatedEntry } from './script.ts';
export { synthAbilities, levelStats, wardCost, KEYWORD_APIS, type LevelStats, type SynthAbility } from './keywords.ts';
export { levelOf, levelStatsOf } from './keyword-play.ts';
export { cantBeCountered, damagePrevented, replacementsOf } from './replacements.ts';
export { processTriggers, queuedTriggers, triggerSupport, SUPPORTED_MODES, MAX_TRIGGERS_PER_ACTION } from './triggers.ts';
export {
  activeStatics, adjustCost, attackRestriction, blockRestriction, castRestriction, combatReminders, effectiveCost, faceManaCost,
  parseStatic, staticGaps, staticMods, staticSupport, type ActiveStatic, type CardMods, type StaticSupport, type StaticsState,
} from './statics.ts';

export { controls, sagaOf, uniqueTriggerSupport } from './turns.ts';
export { UNIQUE_APIS, uniqueReason } from './unique-support.ts';

export interface EngineCtx { rng: Rng; lookup: Lookup; now: number }
