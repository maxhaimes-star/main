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
 * - attackRestriction / blockRestriction / castRestriction / activateRestriction   why a static forbids an action (or null)
 * - scriptRef(inst) / scriptFaceOf(inst)    the script an instance uses (a copy: the copied card's; none if it lost all abilities)
 * - abilitiesOfInstance(inst)               activated abilities of a permanent now: script (copy-aware) + granted by animate effects
 *                                           (granted ones have index >= GRANT_BASE; activate them like any A: index)
 * - activeEffects(state)                    Effect records (emblems, "this turn" effects) in the command zone
 * - Animate / Effect / CopyPermanent / Clone / ChooseType / ChooseColor / NameCard / ChoosePlayer: engine/ext.ts
 * - playPermissions / mayPlayFrom          "you may play that card" permissions (impulse draw, Hostage Taker, Lurrus,
 *                                           Snapcaster flashback, Yawgmoth's Will, top of library ...): castOptions marks
 *                                           casting from outside the hand unavailable without one (engine/permissions.ts)
 * - unique.ts / turns.ts                    hard cards: extra turns (state.extraTurns), Mindslaver (state.controlledBy,
 *                                           action.as, controls(state, viewer, pid)), Sagas (sagaOf, lore counters),
 *                                           Balance / votes / piles / hideaway / Oath / Sylvan Library / Dark Depths
 */
import type { Rng } from '../draft.ts';
import type { Lookup } from '../game/rules.ts';

export * from './types.ts';
export { getScript, spellAbility, castSpellAbility, BESTOW_INDEX, activatedAbilitiesOf, isAutomatable, targetSpecs, flatten, parseAbility, scriptRef, scriptFaceOf, GRANT_BASE } from './script.ts';
export { abilitiesOfInstance, grantedAbilities } from './animate.ts';
export { FOREIGN_BASE, foreignAbilities, type ForeignAbility } from './grants.ts';
export { becomeCopy, tokenCopy } from './copy.ts';
export { activeEffects } from './effects.ts';
export { EXT_APIS } from './ext.ts';
export { isValidTarget, matchCard, matchPlayer } from './targets.ts';
export { castableFaces, castOptions, isPrepareCard, parseCost, preparedSpellCast } from './costs.ts';
export { divisionError } from './divide.ts';
export { manaOptionsFor } from './mana.ts';
export { activationError, castTimingError, loyaltyError, sorceryTiming } from './timing.ts';
export { evalCount, conditionTrue } from './counts.ts';
export { turnInfo } from './durations.ts';
export type { ActivatedEntry } from './script.ts';
export { synthAbilities, levelStats, wardCost, KEYWORD_APIS, type LevelStats, type SynthAbility } from './keywords.ts';
export { levelOf, levelStatsOf } from './keyword-play.ts';
export { charmLimits } from './play.ts';
export { cantBeCountered, damagePrevented, replacementGap, replacementsOf } from './replacements.ts';
export { HANDLED_KEYWORDS, keywordGap } from './mechanics.ts';
export { anyColorCost, bestPermission, mayPlayFrom, playPermissions, topCardVisible, type PlayPermission } from './permissions.ts';
export { landPlaysAllowed, untapLimits } from './statics.ts';
export { playerKeywords, protectionsOf } from './protection.ts';
export { canPayMana, payMana, planManaPayment } from './paycost.ts';
export { processTriggers, queuedTriggers, triggerSupport, SUPPORTED_MODES, MAX_TRIGGERS_PER_ACTION } from './triggers.ts';
export {
  activateRestriction, activeStatics, adjustCost, attackRestriction, blockRestriction, castRestriction, combatReminders, effectiveCost, faceManaCost,
  parseStatic, staticGaps, staticMods, staticSupport, type ActiveStatic, type CardMods, type StaticSupport, type StaticsState,
} from './statics.ts';

export { controls, sagaOf, uniqueTriggerSupport } from './turns.ts';
// Strict rules enforcement (state.strict / state.fixMode): Arena-style legality checks and auto-pay.
export {
  abilityUsability, attackError, handClick, autoPayPreview, blockError, blockersError, castability, castManaCost, isLandCard, isStrict, fixModeOn,
  landPlayError, landPlaysLeft, manaSources, MANUAL_ACTIONS, planAutoPay, priorityError, summoningSick,
} from './strict.ts';
export { extraLandPlays, maxHandSize, mayPlayPermission } from './statics.ts';
export { solveMana, parseRequirements, type PayResult, type PaySource } from '../game/manapay.ts';
export { UNIQUE_APIS, uniqueReason } from './unique-support.ts';

export interface EngineCtx { rng: Rng; lookup: Lookup; now: number }
