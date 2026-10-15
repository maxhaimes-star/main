/**
 * Full card database (data/carddb, built by scripts/build-carddb.ts). Everything is loaded lazily
 * and cached in memory: card/script shards on first lookup, sets/formats/search index on first use.
 * If the data dir is missing (fetch failed at deploy), `carddbAvailable()` is false and the site
 * runs with only the built-in cube.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CardData, TokenData } from '@ojb/shared/src/cards.ts';
import { slugify } from '@ojb/shared/src/cards.ts';
import type { ForgeFace } from '@ojb/shared/src/engine/types.ts';
import {
  type BoosterCard, type CardDbMeta, type FormatData, type Rarity, type SearchRow, type SetData,
  type SetSummary, shardOf,
} from '@ojb/shared/src/carddb-types.ts';
import { generateBooster } from '@ojb/shared/src/boosters.ts';
import { type DeckLine, type ParsedDeck, type ResolvedEntry, checkLegality, parseDeckList } from '@ojb/shared/src/decklist.ts';

export { parseDeckList };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let DIR = process.env.CARDDB_DIR ?? path.resolve(__dirname, '../../data/carddb');

/** Point the loader at another directory (tests) and drop all caches. */
export function setCardDbDir(dir: string) {
  DIR = dir;
  cache.clear();
  cardShards.clear();
  scriptShards.clear();
  printingsIdx = undefined;
}

const cache = new Map<string, unknown>();
function loadJson<T>(rel: string): T {
  if (!cache.has(rel)) cache.set(rel, JSON.parse(fs.readFileSync(path.join(DIR, rel), 'utf8')));
  return cache.get(rel) as T;
}

export function carddbAvailable(): boolean {
  return fs.existsSync(path.join(DIR, 'meta.json'));
}
export function carddbMeta(): CardDbMeta {
  return loadJson<CardDbMeta>('meta.json');
}

// ------------------------------------------------------------ cards

const cardShards = new Map<number, Record<string, CardData>>();
const scriptShards = new Map<number, Record<string, ForgeFace[]>>();
function shard<T>(map: Map<number, T>, kind: string, id: string): T {
  const n = shardOf(id);
  let s = map.get(n);
  if (!s) { s = JSON.parse(fs.readFileSync(path.join(DIR, kind, `${n}.json`), 'utf8')) as T; map.set(n, s); }
  return s;
}

export function getCardById(id: string): CardData | undefined {
  if (!carddbAvailable()) return undefined;
  return shard(cardShards, 'cards', id)[id];
}
export function cardsByIds(ids: string[]): Record<string, CardData> {
  const out: Record<string, CardData> = {};
  for (const id of new Set(ids)) { const c = getCardById(id); if (c) out[id] = c; }
  return out;
}
/** Forge rules scripts for the engine (ScriptData.cards entry). */
export function getScript(id: string): ForgeFace[] | undefined {
  if (!carddbAvailable()) return undefined;
  return shard(scriptShards, 'scripts', id)[id];
}
export function getToken(script: string): TokenData | undefined {
  return loadJson<Record<string, TokenData>>('tokens.json')[script];
}

/** Card id for a name (exact card or face name, case-insensitive, accents optional). */
export function resolveCardName(name: string): string | undefined {
  const names = loadJson<Record<string, string>>('names.json');
  const n = name.trim().replace(/\s+\/\/?\s+/, ' // ');
  const lower = n.toLowerCase();
  if (names[lower]) return names[lower];
  const slug = slugify(n);
  if (searchIds().has(slug)) return slug;
  return names[lower.split(' // ')[0]];
}

let idSet: Set<string> | undefined;
function searchRows(): SearchRow[] { return loadJson<SearchRow[]>('search.json'); }
function searchIds(): Set<string> {
  if (!idSet || !cache.has('search.json')) idSet = new Set(searchRows().map((r) => r[0]));
  return idSet;
}

// ------------------------------------------------------------ sets & printings

function sets(): SetData[] { return loadJson<SetData[]>('sets.json'); }
let setIdx: Map<string, SetData> | undefined;
export function getSet(code: string): SetData | undefined {
  if (!setIdx || !cache.has('sets.json')) setIdx = new Map(sets().map((s) => [s.code, s]));
  return setIdx.get(code.toUpperCase());
}
export function setList(): SetSummary[] {
  return sets().map((s) => ({
    code: s.code, name: s.name, date: s.date, type: s.type, scryfall: s.scryfall, cardCount: s.cards.length,
    ...(s.booster ? { booster: s.booster.kind } : {}),
  }));
}

let printingsIdx: Map<string, { set: string; rarity: Rarity; num: string }[]> | undefined;
/** Every printing of a card, newest set first. */
export function printingsOf(id: string): { set: string; rarity: Rarity; num: string }[] {
  if (!printingsIdx) {
    printingsIdx = new Map();
    for (const s of sets()) {
      for (const [cid, rarity, num] of s.cards) {
        let list = printingsIdx.get(cid);
        if (!list) printingsIdx.set(cid, (list = []));
        list.push({ set: s.code, rarity, num });
      }
    }
  }
  return printingsIdx.get(id) ?? [];
}

/** One booster of a set using its Forge template (Play Booster for 2024+ sets, Draft Booster before). */
export function boosterFor(setCode: string, rng: () => number = Math.random): BoosterCard[] {
  const set = getSet(setCode);
  if (!set) throw new Error(`Unknown set ${setCode}`);
  if (!set.booster) throw new Error(`${set.name} has no boosters`);
  return generateBooster(set, { getSet }, rng);
}

// ------------------------------------------------------------ formats & decks

export function formatList(): FormatData[] { return loadJson<FormatData[]>('formats.json'); }
export function getFormat(name: string): FormatData | undefined {
  return formatList().find((f) => f.name.toLowerCase() === name.trim().toLowerCase());
}

export interface ResolvedDeck {
  name?: string;
  entries: (ResolvedEntry & { name: string; set?: string; num?: string })[];
  errors: string[];
}

/** Parse a deck list (string) and resolve every line to a card id. Unknown names become errors. */
export function resolveDeck(input: string | ParsedDeck): ResolvedDeck {
  const parsed = typeof input === 'string' ? parseDeckList(input) : input;
  const out: ResolvedDeck = { ...(parsed.name ? { name: parsed.name } : {}), entries: [], errors: [...parsed.errors] };
  for (const l of parsed.lines as DeckLine[]) {
    const id = resolveCardName(l.name);
    if (!id) { out.errors.push(`Line ${l.line}: unknown card "${l.name}"`); continue; }
    out.entries.push({ id, count: l.count, section: l.section, name: getCardById(id)?.name ?? l.name, ...(l.set ? { set: l.set } : {}), ...(l.num ? { num: l.num } : {}) });
  }
  return out;
}

/** Legality errors for a deck in a format (empty = legal). Accepts deck text or resolved entries. */
export function formatLegality(deck: string | ResolvedEntry[], formatName: string): string[] {
  const format = getFormat(formatName);
  if (!format) return [`Unknown format: ${formatName}`];
  let entries: ResolvedEntry[];
  const errors: string[] = [];
  if (typeof deck === 'string') {
    const r = resolveDeck(deck);
    errors.push(...r.errors);
    entries = r.entries;
  } else entries = deck;
  return [...errors, ...checkLegality(entries, format, { getCard: getCardById, printings: printingsOf })];
}

// ------------------------------------------------------------ search

export interface SearchFilters {
  /** Card must include all these colors (W U B R G); 'C' = colorless. */
  colors?: string;
  /** Color identity must be a subset of this (commander-style). */
  identity?: string;
  type?: string;
  set?: string;
  format?: string;
  rarity?: Rarity;
  cmc?: number;
  oracle?: string;
  limit?: number;
  offset?: number;
}

/**
 * Name search with Scryfall-ish shorthands inside the query: t:creature c:wu id:wub s:dmu f:modern
 * r:mythic cmc:3 o:"draw a card". Returns full CardData, best (prefix) matches first.
 */
export function searchCards(query: string, filters: SearchFilters = {}): { total: number; cards: CardData[] } {
  const f: SearchFilters = { ...filters };
  const words: string[] = [];
  for (const m of query.matchAll(/(\w+):("[^"]*"|\S+)|"([^"]*)"|(\S+)/g)) {
    if (m[1]) {
      const v = m[2].replace(/^"|"$/g, '');
      const k = m[1].toLowerCase();
      if (k === 't' || k === 'type') f.type = v;
      else if (k === 'c' || k === 'color') f.colors = v;
      else if (k === 'id' || k === 'ci') f.identity = v;
      else if (k === 's' || k === 'set' || k === 'e') f.set = v;
      else if (k === 'f' || k === 'format') f.format = v;
      else if (k === 'r' || k === 'rarity') f.rarity = ({ common: 'C', uncommon: 'U', rare: 'R', mythic: 'M' } as Record<string, Rarity>)[v.toLowerCase()] ?? (v.toUpperCase()[0] as Rarity);
      else if (k === 'cmc' || k === 'mv') f.cmc = Number(v);
      else if (k === 'o' || k === 'oracle') f.oracle = v;
      else words.push(m[0]);
    } else words.push((m[3] ?? m[4]).toLowerCase());
  }
  const text = words.join(' ').toLowerCase();
  const format = f.format ? getFormat(f.format) : undefined;
  const fmtSets = format?.sets ? new Set(format.sets) : undefined;
  const banned = format ? new Set(format.banned) : undefined;
  const setCode = f.set?.toUpperCase();
  const colors = f.colors?.toUpperCase();
  const identity = f.identity?.toUpperCase();
  const type = f.type?.toLowerCase();

  let rows = searchRows().filter((r) => {
    if (text && !r[1].toLowerCase().includes(text)) return false;
    if (type && !r[2].toLowerCase().includes(type)) return false;
    if (f.cmc !== undefined && r[4] !== f.cmc) return false;
    if (colors) {
      if (colors === 'C') { if (r[5]) return false; } else if (![...colors].every((c) => r[5].includes(c))) return false;
    }
    if (identity && ![...r[6]].every((c) => identity.includes(c))) return false;
    if (setCode || f.rarity || format) {
      const prints = printingsOf(r[0]);
      if (setCode && !prints.some((p) => p.set === setCode && (!f.rarity || p.rarity === f.rarity))) return false;
      if (!setCode && f.rarity && !prints.some((p) => p.rarity === f.rarity)) return false;
      if (format) {
        if (banned!.has(r[0])) return false;
        if (fmtSets && !prints.some((p) => fmtSets.has(p.set))) return false;
      }
    }
    return true;
  });
  if (f.oracle) {
    const o = f.oracle.toLowerCase();
    rows = rows.filter((r) => getCardById(r[0])?.oracle.toLowerCase().includes(o));
  }
  if (text) rows = [...rows].sort((a, b) => Number(!a[1].toLowerCase().startsWith(text)) - Number(!b[1].toLowerCase().startsWith(text)) || a[1].localeCompare(b[1]));
  const offset = f.offset ?? 0;
  const limit = Math.min(f.limit ?? 50, 200);
  return { total: rows.length, cards: rows.slice(offset, offset + limit).map((r) => getCardById(r[0])!).filter(Boolean) };
}
