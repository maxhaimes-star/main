/**
 * Contract for the automatic card-effects engine (Stage 1).
 *
 * Card behaviour comes from Forge's card scripts (shared/data/scripts.json, built by
 * scripts/build-scripts.ts). The engine interprets the common effect types and leaves
 * everything else to the existing manual tools, logging what it didn't automate.
 */
import type { TokenData } from '../cards.ts';

/** One face of a card's Forge script. Lines keep Forge syntax ("SP$ DealDamage | NumDmg$ 3 | ..."). */
export interface ForgeFace {
  name: string;
  /** A: lines — spells (SP$) and activated abilities (AB$). */
  abilities: string[];
  /** T: lines (Stage 2). */
  triggers: string[];
  /** S: lines (Stage 3). */
  statics: string[];
  /** R: lines (later). */
  replacements: string[];
  /** K: lines. */
  keywords: string[];
  /** SVar name -> value. Sub-abilities ("DB$ ..."), variables ("Count$xPaid"), etc. */
  svars: Record<string, string>;
}

export interface ScriptData {
  /** cardId -> faces (front first). */
  cards: Record<string, ForgeFace[]>;
  /** Forge token script name (e.g. "w_1_1_spirit_flying") -> token. */
  tokens: Record<string, TokenData>;
}

/** A parsed ability line or SVar ("DB$ ...") as key/value params. */
export interface ParsedAbility {
  /** 'SP' spell, 'AB' activated ability, 'DB' sub-ability. */
  kind: 'SP' | 'AB' | 'DB';
  /** Effect type, e.g. "DealDamage", "ChangeZone", "Draw". */
  api: string;
  params: Record<string, string>;
  /** Next ability in the chain (from SubAbility$), already parsed. */
  sub?: ParsedAbility;
  /** Human text (SpellDescription$ / StackDescription$), CARDNAME replaced. */
  description: string;
  /** Charm only: the modes (Choices$ SVars), parsed. Pick with `cast.modes` (SVar names). */
  choices?: { name: string; ability: ParsedAbility }[];
  /** Charm only: how many modes to choose (CharmNum$ / MinCharmNum$). */
  charmMin?: number;
  charmMax?: number;
  /** The face's SVars (for variables like X). */
  svars?: Record<string, string>;
}

/** What a player can pick as a target. */
export type TargetRef =
  | { kind: 'card'; iid: string }
  | { kind: 'player'; pid: string }
  | { kind: 'stack'; id: string };

/** One "target" requirement, from a step of the ability chain that has ValidTgts$. */
export interface TargetSpec {
  /** Index of the step in the chain (0 = the ability itself, 1 = its SubAbility, ...). */
  step: number;
  prompt: string;
  min: number;
  max: number;
  /** Zone the targets must be in. */
  zone: 'battlefield' | 'graveyard' | 'stack' | 'hand' | 'exile' | 'library' | 'any';
  /** Raw Forge ValidTgts$ value, e.g. "Any", "Creature.OppCtrl", "Card" (with TargetType$ Spell). */
  valid: string;
  /** Can target players. */
  players: boolean;
  /** Can target cards/permanents/spells. */
  cards: boolean;
  /** Raw Forge TargetType$ (e.g. "Spell", "Activated,Triggered") when the targets are on the stack. */
  targetType?: string;
}

/** Attached to a stack item that the engine will resolve automatically. */
export interface AutoInfo {
  cardId: string;
  /** Script face index (0 front, 1 back / adventure / second split half). */
  face: number;
  /**
   * 'spell' = the face's SP$ ability; 'ability' = the face's Nth AB$ ability;
   * 'trigger' (Stage 2) = a triggered ability: the chain starts at SVar `svar` (or the synthesized `line`).
   */
  source: 'spell' | 'ability' | 'trigger';
  /** Index into the face's abilities[] array (A: lines); for 'trigger', the T: line index (-1 = delayed / reflexive / keyword trigger). */
  index: number;
  /** 'trigger' only: name of the Execute$ SVar that starts the chain. */
  svar?: string;
  /** 'trigger' only: a synthesized ability line used instead of `svar` (e.g. prowess, "sacrifice it at end of turn"). */
  line?: string;
  /** 'trigger' only: what the trigger saw (Triggered* objects, remembered objects of delayed triggers, intervening-if). */
  trigger?: TriggerContext;
  /** One list of chosen targets per TargetSpec (same order as targetSpecs()). */
  targets: TargetRef[][];
  x?: number;
  /** Chosen modes for Charm effects (SVar names), Stage 1 optional. */
  modes?: string[];
  /** Zone each targeted card was in when chosen, to detect illegal targets on resolution. */
  targetZones?: Record<string, string>;
  /** Cast with kicker (Count$Kicked / Condition$ Kicked). */
  kicked?: boolean;
  /** Colors of mana spent to cast it (Count$Converge). */
  colorsSpent?: string[];
  /** Divided damage (DividedAsYouChoose$): target key (card iid or player pid) -> amount. */
  division?: Record<string, number>;
  /** Id of the cast option used (see castOptions), e.g. 'normal', 'flashback', 'evoke'. */
  costOption?: string;
  /** Keyword-ability data recorded at activation (e.g. Ninjutsu: `attacking` = what the returned creature attacked). */
  extra?: Record<string, string>;
}

/**
 * Keyword-granted (synthesized) activated abilities — Equip, Reconfigure, Cycling, typecycling, Level up,
 * Crew, Ninjutsu — get ability indexes that never collide with A: line indexes:
 *   index = SYNTH_BASE + 10 * (index of the K: line in face.keywords) + variant
 * (variant 0 = the main ability; Reconfigure's "unattach" is variant 1). See engine/keywords.ts.
 */
export const SYNTH_BASE = 1000;


/**
 * Stage 2: the objects a triggered ability refers to (Forge "Triggered*" / "DelayTriggerRemembered").
 * All ids are card iids or player ids.
 */
export interface TriggerContext {
  /** Forge trigger mode (ChangesZone, Phase, Attacks, SpellCast, DamageDone, ..., 'Delayed', 'Immediate'). */
  mode: string;
  /** TriggeredCard (the card that moved / attacked / was cast / was drawn). */
  card?: string;
  /** TriggeredPlayer / TriggeredActivator / TriggeredCardController (whose turn, who cast, who drew ...). */
  player?: string;
  /** TriggeredTarget: damaged player (pid) or permanent (iid). */
  target?: string;
  /** TriggeredDefendingPlayer. */
  defender?: string;
  /** TriggeredSource (damage source iid). */
  source?: string;
  /** Damage amount etc. */
  amount?: number;
  /** TapsForMana: the mana the permanent produced ("G", "UU"). */
  produced?: string;
  /** Triggers of effects (engine/effects.ts): the effect's remembered objects. */
  effectRemembered?: string[];
  /** Delayed / reflexive triggers: the objects the creating effect remembered. */
  remembered?: string[];
  /** Last-known information (e.g. the creature that died). */
  lki?: Record<string, Lki>;
  /** Intervening "if" clause (IsPresent$ / CheckSVar$), re-checked on resolution. */
  condition?: Record<string, string>;
}

/** Stage 2: a triggered ability waiting to be put on the stack (needs a decision / targets first). Engine-internal. */
export interface QueuedTrigger {
  id: string;
  controller: string;
  sourceIid?: string;
  /** Public label, e.g. "Thraben Inspector". */
  sourceName: string;
  /** Stack text. */
  text: string;
  auto: AutoInfo;
  /** OptionalDecider$ ("you may"): asked before it goes on the stack. */
  optional?: boolean;
  /** Set once the controller said yes (optional) / chose targets. */
  accepted?: boolean;
  targetsChosen?: boolean;
  /** Not automatable (e.g. an optional cost): goes on the stack without `auto`, resolved by hand. */
  manual?: boolean;
  /** Exert (OptionalAttackCost Exert<1/CARDNAME>): this attacking creature is exerted when the trigger is used. */
  exert?: string;
}

/** Stage 2: a delayed trigger ("at the beginning of the next end step, return it"). Engine-internal. */
export interface DelayedTrigger {
  id: string;
  controller: string;
  sourceIid?: string;
  sourceName: string;
  text: string;
  /** Step it fires at (start of). */
  step: import('../game/types.ts').Step;
  /** Turn / step it was created in (it fires at the *next* such step). */
  turn: number;
  createdStep: import('../game/types.ts').Step;
  auto: AutoInfo;
  /** Event-based delayed trigger ("when you cast your next instant or sorcery spell this turn"): trigger params (Mode$ ...); `step` is then unused. Fires once. */
  event?: Record<string, string>;
  /** Fires only in this player's turn (rebound: "at the beginning of your next upkeep"). */
  pid?: string;
  /** Expires at the end of the turn it was created in (ThisTurn$ True). */
  thisTurn?: boolean;
}

/** How a spell was cast (alternative / additional costs). Kept on the stack item and on the card while it's on the stack/battlefield. */
export interface CastInfo {
  /** castOptions id: 'normal', 'kicked', 'alt0', 'evoke', 'flashback', 'escape', 'dash', 'buyback', 'overload', ... */
  option: string;
  kicked?: boolean;
  evoked?: boolean;
  dashed?: boolean;
  escaped?: boolean;
  buyback?: boolean;
  overloaded?: boolean;
  /** Flashback / escape (non-permanent): exiled instead of going anywhere else when it leaves the stack. */
  exileOnLeave?: boolean;
  /** Cast with a "you may play that card" permission (engine/permissions.ts key; once-per-turn limits). */
  permission?: string;
  /** Zone it was cast from (when not the hand), e.g. 'exile' for "whenever you cast a spell from exile". */
  from?: string;
  colorsSpent?: string[];
  /** Total mana spent to cast it (Opus: "if five or more mana was spent"; TriggeredCard$CastTotalManaSpent). */
  manaSpent?: number;
  /** X paid (permanents keep it: ravenous). */
  x?: number;
  /** Cast for its bestow cost: an Aura spell / Aura (not a creature) while attached (game/rules.ts faceOf). */
  bestowed?: boolean;
  /** Life paid for Phyrexian mana symbols (Compleated: two fewer loyalty counters per {P} paid with life). */
  phyrexianLife?: number;
  /** Multikicker: times kicked; Replicate: times replicated (engine/castkw.ts). */
  timesKicked?: number;
  replicated?: number;
  /** MayFlashSac: cast when a sorcery couldn't have been — sacrificed at the next cleanup. */
  flashSac?: boolean;
}

/** One way to cast a card (normal cost, alternative cost, kicker ...). */
export interface CastOption {
  id: string;
  label: string;
  /** Mana part, e.g. "{1}{U}{U}" ('' = free). */
  cost: string;
  /** Non-mana parts in human text ("Pay 1 life", "Exile a blue card from your hand"). */
  extra: string[];
  /** Set when the option exists but can't be used right now (wrong zone, condition unmet, not enough cards...). */
  unavailable?: string;
}

/** One way to activate a mana ability. */
export interface ManaOption {
  id: string;
  label: string;
  /** Mana added, e.g. "CC", "GGG" ('' = nothing). */
  produces: string;
  /** What else happens (human text): "Ancient Tomb deals 2 damage to you", "Sacrifice Lotus Petal". */
  sideEffects: string[];
}

/** Per-turn bookkeeping (reset lazily when `turn` changes). */
export interface TurnInfo {
  turn: number;
  /** Players who controlled a permanent that left the battlefield this turn (Revolt). */
  leftBattlefield: string[];
  /** Planeswalkers (iids) that activated a loyalty ability this turn. */
  loyaltyUsed: string[];
  /** "iid|abilityIndex" -> activations this turn (ActivationLimit$). */
  activations: Record<string, number>;
}

/** An effect with a duration the engine reverts later. */
export type TimedEffect =
  | { kind: 'pump'; id: string; controller: string; until: 'yourNextTurn'; cards: string[]; pt: [number, number]; keywords: string[] }
  | { kind: 'control'; id: string; controller: string; until: 'eot' | 'hostLeaves'; iid: string; previous: string; hostIid?: string }
  | { kind: 'exiled'; id: string; controller: string; until: 'hostLeaves'; hostIid: string; cards: { iid: string; from: string; owner: string }[] }
  | { kind: 'dash'; id: string; controller: string; until: 'eot'; iid: string }
  /** A keyword granted to a card outside the battlefield until end of turn (Snapcaster Mage: flashback), engine/permissions.ts. */
  | { kind: 'grant'; id: string; controller: string; until: 'eot' | 'permanent'; iid: string; zone: string; keyword: string; source: string }
  /** Keywords a player has for a while ("you gain protection from everything until your next turn"), engine/protection.ts. */
  | { kind: 'playerKw'; id: string; controller: string; until: 'eot' | 'yourNextTurn'; pid: string; keywords: string[]; turn: number }
  | EffectRecord;

/** When an Effect / animation ends. */
export type EffectDuration = 'eot' | 'permanent' | 'yourNextTurn' | 'hostLeaves' | 'endOfCombat' | 'yourNextEndStep' | 'endOfYourNextTurn';

/**
 * Forge "Effect" (engine/effects.ts): an effect object — emblem, "this turn ..." rule, "you may play that card" —
 * with static / triggered abilities from the creating card's SVars. Lives in the command zone (state.effects).
 */
export interface EffectRecord {
  kind: 'effect';
  id: string;
  controller: string;
  until: EffectDuration;
  /** The permanent that created it (UntilHostLeavesPlay). */
  hostIid?: string;
  /** The card whose ability created it (EFFECTSOURCE: Gideon's "attacks Gideon if able"). */
  source?: string;
  /** Script that holds the SVars (statics / triggers / their Execute$ chains). */
  cardId: string;
  face: number;
  /** "Emblem — Elspeth, Sun's Champion" or the creating card's name. */
  name: string;
  emblem?: boolean;
  image?: string;
  /** Human text (the creating ability's description). */
  text: string;
  /** SVar names. */
  statics: string[];
  triggers: string[];
  /** RememberObjects$ (card iids and player ids). */
  remembered: string[];
  /** ForgetOnMoved$ / ExileOnMoved$: zone the remembered cards must stay in; the effect ends when none is left there. */
  watchZone?: string;
  /** ReplacementEffects$ SVar names (replacements.ts applies them like a permanent's R: lines, e.g. Yawgmoth's Will). */
  replacements?: string[];
  /** SetChosenNumber$ (Count$ChosenNumber in its replacements: Wildgrowth Archaic's counters). */
  chosenNumber?: number;
  turn: number;
}

/** Copy-effect exceptions (copiable values, engine/copy.ts). */
export interface CopyExtra {
  name?: string;
  addTypes?: string[];
  power?: number;
  toughness?: number;
  keywords?: string[];
  nonLegendary?: boolean;
  /** The copy effect ends at cleanup (Saheeli, Sublime Artificer). */
  until?: 'eot';
  /** "Except it has this ability" (Thespian's Stage): A: lines of other scripts the copy also has (engine/copy.ts KEPT_BASE). */
  abilities?: { cardId: string; face: number; index: number }[];
}

/** An Animate effect on a permanent (engine/animate.ts). Applied by faceOf(); ends per `until`. */
export interface Animation {
  id: string;
  controller: string;
  until: EffectDuration;
  hostIid?: string;
  /** Turn it was created (for "until your next turn"). */
  turn: number;
  power?: number;
  toughness?: number;
  /** Card types and subtypes added (Types$). */
  addTypes?: string[];
  removeTypes?: string[];
  removeCardTypes?: boolean;
  removeCreatureTypes?: boolean;
  allCreatureTypes?: boolean;
  /** New colors (OverwriteColors$) or added colors, as WUBRG letters. */
  colors?: string[];
  overwriteColors?: boolean;
  keywords?: string[];
  removeKeywords?: string[];
  removeAllAbilities?: boolean;
  /** Abilities / triggers / statics granted from a card script's SVars. */
  grant?: { cardId: string; face: number; abilities?: string[]; triggers?: string[]; statics?: string[] };
}

/** Choices made for a permanent as it entered (Plague Engineer, Phyrexian Revoker, True-Name Nemesis ...). */
export interface Chosen { type?: string; color?: string; name?: string; player?: string }

/** A question the engine needs a player to answer (e.g. "Pay {3}?" for Mana Leak). */
export interface Pending {
  id: string;
  /** Player who must answer. */
  pid: string;
  prompt: string;
  options: { value: string; label: string }[];
  /** Engine-internal continuation data. */
  data: Record<string, unknown>;
  /**
   * Present when the question is "choose targets" (e.g. a triggered ability that targets).
   * The player answers with the 'chooseTargets' action instead of 'choose'.
   * `options` may then hold e.g. a "no target / skip" option answerable with 'choose'.
   */
  targets?: { specs: TargetSpec[]; sourceIid?: string; controller: string; label: string };
  /**
   * Cards revealed to the answering player for this question (e.g. the opponent's hand for Duress / Thoughtseize /
   * Tidehollow Sculler). `options` hold only the legal choices; every revealed card is listed here with `legal`
   * telling whether it can be chosen, so the UI can show the whole hand with the illegal cards disabled.
   * The revealed cards also have the answering player in their `revealedTo` until they change zones / end of turn.
   * Only sent to the answering player (like `options`).
   */
  revealed?: { iid: string; label: string; legal: boolean }[];
  /**
   * Divided damage / counters (DividedAsYouChoose$): answer with 'choose' and a JSON value
   * `{"<target key>": amount, ...}` (keys = card iid or player id from `targets`) that sums to `total`, each target getting
   * at least `min` (usually 1). `options` then holds one suggested split (even division) the UI can offer as a default.
   */
  divide?: { total: number; min: number; targets: { key: string; label: string }[] };
  /**
   * Choose a number (ChooseNumber$, "pay X life", Intrepid Adversary's "any number of times"): answer with 'choose' and
   * the number as a string, from `min` to `max`. `options` also lists every allowed value when there are few.
   */
  number?: { min: number; max: number };
}

/** Last-known information about a targeted / remembered card (taken before it moves). */
export interface Lki { power: number; toughness: number; mv: number; controller: string; owner: string; name: string; counters?: Record<string, number> }

/**
 * Engine-internal continuation: an automated resolution paused for a player decision
 * (a Pending answer or a library peek) and resumes from step `next`.
 */
export interface AutoCont {
  item: import('../game/types.ts').StackItem;
  next: number;
  targets: TargetRef[][];
  lki: Record<string, Lki>;
  remembered: string[];
  /** The triggered ability's optional cost (AB$ ... Cost$) was paid: step 0 runs without asking again. */
  costPaid?: boolean;
  /**
   * Sub-chains inserted while resolving (Branch, RepeatEach, GenericChoice, modes chosen on resolution ...), re-applied
   * in order when the resolution resumes: the flattened chain of SVar `svar` (or the synthesized `line`) goes after
   * step `at`, preceded by a step that sets the remembered objects to `remember` (RepeatEach) when given.
   */
  splices?: { at: number; svar: string; remember?: string[]; modes?: string[]; line?: string }[];
  /** Targets chosen while resolving (steps added by splices / modes chosen on resolution), by step index. */
  lateTargets?: Record<number, TargetRef[]>;
  /** "Unless" costs already decided this resolution: step index -> the step runs. */
  unless?: Record<number, boolean>;
  /** ChooseCard / ChooseNumber / ChooseType results of this resolution (Defined$ ChosenCard ...), imprinted cards. */
  chosen?: { cards?: string[]; number?: number; players?: string[]; type?: string; color?: string; imprinted?: string[] };
}
