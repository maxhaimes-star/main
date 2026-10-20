// Saved deck library, kept in the browser's localStorage (the host's disk is wiped on every deploy). Same pattern as cubelib.ts.
import type { CardData, Color, Deck, RoomSettings } from '@ojb/shared';
import { CUBE } from '@ojb/shared/src/cube.ts';

export interface SavedDeck {
  id: string;
  name: string;
  /** Exact card ids, repeated for counts (cube cards and imported-cube cards alike). Basic lands are in `basics`. */
  main: string[];
  side: string[];
  basics: Record<Color, number>;
  /** id -> card name, so the deck can be listed and exported without the card data being loaded. */
  names: Record<string, string>;
  /** Source cube / event, e.g. "Orangejuicebox Cube" or "Set sealed". */
  cube: string;
  /** Event type, e.g. "Cube draft". */
  format: string;
  auto?: boolean;
  createdAt: number;
  updatedAt: number;
}

export const DECK_LIB_KEY = 'ojb:decks';
export const MAX_DECKS = 100;
const COLOR_KEYS: Color[] = ['W', 'U', 'B', 'R', 'G'];

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

const strs = (x: unknown): x is string[] => Array.isArray(x) && x.every((i) => typeof i === 'string');

function valid(x: unknown): x is SavedDeck {
  const d = x as SavedDeck;
  return !!d && typeof d.id === 'string' && typeof d.name === 'string' && strs(d.main) && strs(d.side)
    && !!d.basics && COLOR_KEYS.every((c) => typeof d.basics[c] === 'number')
    && !!d.names && typeof d.names === 'object' && typeof d.cube === 'string' && typeof d.format === 'string'
    && typeof d.createdAt === 'number' && typeof d.updatedAt === 'number'
    && d.main.length + d.side.length + COLOR_KEYS.reduce((n, c) => n + d.basics[c], 0) > 0;
}

/** Saved decks, newest first. Never throws: unavailable storage or corrupt data gives an empty library. */
export function loadDecks(storage: StorageLike | null = defaultStorage()): SavedDeck[] {
  try {
    const raw = storage?.getItem(DECK_LIB_KEY);
    const arr = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(arr) ? arr.filter(valid).sort((a, b) => b.updatedAt - a.updatedAt) : [];
  } catch { return []; }
}

function persist(decks: SavedDeck[], storage: StorageLike | null): boolean {
  try { if (!storage) return false; storage.setItem(DECK_LIB_KEY, JSON.stringify(decks)); return true; } catch { return false; }
}

export const newDeckId = () => `deck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Content key: same cards + sideboard + basics = same deck, whatever the order. */
export function deckSignature(d: Pick<SavedDeck, 'main' | 'side' | 'basics'>): string {
  return [[...d.main].sort().join(','), [...d.side].sort().join(','), COLOR_KEYS.map((c) => d.basics[c] ?? 0).join('/')].join('|');
}

export function deckSize(d: Pick<SavedDeck, 'main' | 'basics'>): number {
  return d.main.length + COLOR_KEYS.reduce((n, c) => n + (d.basics[c] ?? 0), 0);
}

/** "Orangejuicebox Cube · Cube draft · Oct 17" */
export function defaultDeckName(cube: string, format: string, now = Date.now()): string {
  const date = new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return [cube, format !== cube ? format : '', date].filter(Boolean).join(' · ');
}

export interface DeckInput {
  name?: string;
  main: string[];
  side: string[];
  basics: Record<Color, number>;
  cube: string;
  format: string;
  names?: Record<string, string>;
  auto?: boolean;
}

/**
 * Save a deck. A deck with identical content is not stored twice: its timestamp is refreshed and an explicit save keeps/renames it
 * (an auto-save never overwrites a name the player chose). Over MAX_DECKS the oldest are dropped.
 */
export function saveDeck(input: DeckInput, storage: StorageLike | null = defaultStorage(), now = Date.now()): { decks: SavedDeck[]; deck: SavedDeck; saved: boolean; duplicate: boolean } {
  const decks = loadDecks(storage);
  const probe = { main: input.main, side: input.side, basics: input.basics };
  const dup = decks.find((d) => deckSignature(d) === deckSignature(probe));
  let deck: SavedDeck;
  if (dup) {
    deck = { ...dup, updatedAt: now, ...(input.name?.trim() && !input.auto ? { name: input.name.trim(), auto: false } : {}) };
    decks.splice(decks.indexOf(dup), 1, deck);
  } else {
    deck = {
      id: newDeckId(), name: input.name?.trim() || defaultDeckName(input.cube, input.format, now), main: input.main.slice(), side: input.side.slice(),
      basics: { ...input.basics }, names: input.names ?? {}, cube: input.cube, format: input.format, ...(input.auto ? { auto: true } : {}), createdAt: now, updatedAt: now,
    };
    decks.push(deck);
  }
  const kept = decks.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_DECKS);
  return { decks: kept, deck, saved: persist(kept, storage), duplicate: !!dup };
}

export function renameDeck(id: string, name: string, storage: StorageLike | null = defaultStorage()): SavedDeck[] {
  const decks = loadDecks(storage).map((d) => (d.id === id && name.trim() ? { ...d, name: name.trim().slice(0, 80), auto: false } : d));
  persist(decks, storage);
  return decks;
}

export function deleteDeck(id: string, storage: StorageLike | null = defaultStorage()): SavedDeck[] {
  const decks = loadDecks(storage).filter((d) => d.id !== id);
  persist(decks, storage);
  return decks;
}

/** A shared-code Deck for the export helpers. */
export const asDeck = (d: SavedDeck): Deck => ({ main: d.main, side: d.side, basics: d.basics, ready: true });

/** Card lookup for exports: stored names first, then whatever the client knows. */
export function nameLookup(d: SavedDeck, fallback: (id: string) => CardData | undefined): (id: string) => CardData | undefined {
  return (id) => (d.names[id] ? ({ id, name: d.names[id] } as CardData) : fallback(id));
}

/** Names for the ids of a deck, from the client's card data. */
export function namesFor(ids: string[], lookup: (id: string) => CardData | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) { const n = lookup(id)?.name; if (n) out[id] = n; }
  return out;
}

/** The cube (or set) a room's cards came from, for a deck's label. */
export function sourceName(s: Pick<RoomSettings, 'source' | 'setCodes' | 'customList' | 'customListName' | 'mode'>): string {
  if (s.mode === 'constructed') return 'Constructed';
  if (s.source === 'set' && s.mode !== 'auction') return `Set ${s.setCodes.join('/')}`;
  return s.customList?.length ? s.customListName ?? 'Imported list' : CUBE.name;
}

/** "Cube draft", "Set sealed", "Cube auction". */
export function eventName(s: Pick<RoomSettings, 'source' | 'mode'>): string {
  return `${s.source === 'set' && s.mode !== 'auction' ? 'Set' : 'Cube'} ${s.mode}`;
}
