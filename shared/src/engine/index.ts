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
 */
import type { Rng } from '../draft.ts';
import type { Lookup } from '../game/rules.ts';

export * from './types.ts';
export { getScript, spellAbility, activatedAbilitiesOf, isAutomatable, targetSpecs, flatten, parseAbility } from './script.ts';
export { isValidTarget, matchCard, matchPlayer } from './targets.ts';
export type { ActivatedEntry } from './script.ts';
export { synthAbilities, levelStats, wardCost, KEYWORD_APIS, type LevelStats, type SynthAbility } from './keywords.ts';
export { levelOf, levelStatsOf } from './keyword-play.ts';
export { cantBeCountered, damagePrevented, replacementsOf } from './replacements.ts';

export interface EngineCtx { rng: Rng; lookup: Lookup; now: number }
