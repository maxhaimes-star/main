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
}

/** A question the engine needs a player to answer (e.g. "Pay {3}?" for Mana Leak). */
export interface Pending {
  id: string;
  /** Player who must answer. */
  pid: string;
  prompt: string;
  options: { value: string; label: string }[];
  /** Engine-internal continuation data. */
  data: Record<string, unknown>;
}
