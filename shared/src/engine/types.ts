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
  /** 'spell' = the face's SP$ ability; 'ability' = the face's Nth AB$ ability. */
  source: 'spell' | 'ability';
  /** Index into the face's abilities[] array (A: lines). */
  index: number;
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
  colorsSpent?: string[];
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
  | { kind: 'dash'; id: string; controller: string; until: 'eot'; iid: string };

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
}

/** Last-known information about a targeted / remembered card (taken before it moves). */
export interface Lki { power: number; toughness: number; mv: number; controller: string; owner: string; name: string }

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
}
