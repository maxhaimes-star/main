/**
 * Shapes of the full card database built by scripts/build-carddb.ts (data/carddb/) and served by
 * server/src/carddb.ts. Card definitions themselves use CardData (cards.ts) and the engine's
 * ForgeFace (engine/types.ts), so cube cards and database cards are interchangeable.
 */

/** C common, U uncommon, R rare, M mythic, S special/timeshifted, L basic land. */
export type Rarity = 'C' | 'U' | 'R' | 'M' | 'S' | 'L';

/**
 * One printing: [cardId, rarity, collectorNumber, flags, setCode?].
 * flags: 'b' basic land, 'l' land, 'd' double-faced (transform/modal), 'g' legendary.
 * setCode is only present when it differs from the set the list belongs to (print sheets).
 */
export type Print = [id: string, rarity: Rarity, num: string, flags: string, set?: string];

/** One "Replace=" line of a booster slot: with probability p use `expr` instead of the base. */
export interface SlotDef { base: string; replace: [p: number, expr: string][] }

export type BoosterKind = 'play' | 'draft' | 'default';

export interface BoosterTemplate {
  /** Play Booster for 2024+ sets, Draft Booster for older ones, 'default' when Forge has none. */
  kind: BoosterKind;
  /** Forge booster line, e.g. `10 Common, 3 Uncommon, 1 RareMythic, 1 BasicLand`. */
  template: string;
  /** Named slots referenced by the template (Forge "BoosterSlots" sections). */
  slots: Record<string, SlotDef>;
}

export type SetType =
  | 'core' | 'expansion' | 'masters' | 'draft' | 'commander' | 'promo' | 'online' | 'funny'
  | 'duel_deck' | 'starter' | 'boxed' | 'multiplayer' | 'collector' | 'other';

export interface SetSummary {
  code: string;
  name: string;
  /** YYYY-MM-DD */
  date: string;
  type: SetType;
  /** Code Scryfall uses for this set (lower-case), for image URLs. */
  scryfall: string;
  cardCount: number;
  booster?: BoosterKind;
}

export interface SetData extends Omit<SetSummary, 'cardCount' | 'booster'> {
  /** The set's own card list in collector order. */
  cards: Print[];
  booster?: BoosterTemplate;
  /** Extra print sheets referenced by the booster template, by Forge sheet name (lower-case). */
  sheets?: Record<string, Print[]>;
}

export interface FormatData {
  name: string;
  /** Forge type: Sanctioned, Casual, Block … */
  type: string;
  order: number;
  /** Legal set codes; undefined = every set. */
  sets?: string[];
  /** Card ids. */
  banned: string[];
  restricted: string[];
  /** Cards legal regardless of set. */
  additional: string[];
  /** Pauper-style rarity restriction: a card must have a printing at one of these rarities. */
  rarities?: Rarity[];
  /** Deck construction rules derived from the format. */
  minDeck: number;
  maxSideboard: number;
  maxCopies: number;
}

/** A compact search row (search.json): [id, name, typeLine, manaCost, cmc, colors, colorIdentity]. */
export type SearchRow = [id: string, name: string, typeLine: string, manaCost: string, cmc: number, colors: string, identity: string];

export interface CardDbMeta {
  builtAt: string;
  forgeCommit?: string;
  shards: number;
  counts: { cards: number; tokens: number; sets: number; formats: number };
}

export interface BoosterCard {
  id: string;
  set: string;
  num?: string;
  rarity: Rarity;
  foil?: boolean;
}

/** Number of card/script shards; shard file is `<dir>/cards/<n>.json`. */
export const CARDDB_SHARDS = 64;

/** Stable shard index for a card id (FNV-1a). */
export function shardOf(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % CARDDB_SHARDS;
}

/** Image of a specific printing (right art for the set). */
export function printingImage(scryfallSet: string, num: string, back = false, version: 'normal' | 'large' | 'small' = 'normal'): string {
  return `https://api.scryfall.com/cards/${encodeURIComponent(scryfallSet.toLowerCase())}/${encodeURIComponent(num)}?format=image&version=${version}${back ? '&face=back' : ''}`;
}
