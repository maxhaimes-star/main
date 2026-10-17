/**
 * Deck list parsing (MTGA / MTGO / plain text) and constructed-format legality checks.
 * Pure: card lookups are passed in, so this works with any card source.
 */
import type { CardData } from './cards.ts';
import type { FormatData, Rarity } from './carddb-types.ts';

export type DeckSection = 'main' | 'side' | 'commander';

export interface DeckLine {
  count: number;
  name: string;
  set?: string;
  num?: string;
  section: DeckSection;
  /** 1-based source line, for error messages. */
  line: number;
}

export interface ParsedDeck {
  name?: string;
  lines: DeckLine[];
  /** Lines that could not be understood. */
  errors: string[];
}

const SECTION_HEADERS: Record<string, DeckSection | 'skip'> = {
  deck: 'main', main: 'main', maindeck: 'main', mainboard: 'main',
  sideboard: 'side', side: 'side',
  commander: 'commander', companion: 'side',
  maybeboard: 'skip', considering: 'skip', tokens: 'skip',
};

/**
 * Parses MTGA exports ("Deck"/"Sideboard" headers, "4 Card Name (SET) 123"), MTGO .txt (blank line
 * before the sideboard, "SB: 2 Card"), and loose lists ("4x Card", "Card" = 1 copy).
 */
export function parseDeckList(text: string): ParsedDeck {
  const out: ParsedDeck = { lines: [], errors: [] };
  let section: DeckSection | 'skip' = 'main';
  let sawHeader = false;
  let sawMain = false;
  const raw = text.replace(/\r/g, '').split('\n');
  raw.forEach((src, i) => {
    let line = src.trim();
    if (!line) {
      // MTGO: a blank line after the main deck starts the sideboard (only when no explicit headers).
      if (!sawHeader && sawMain && section === 'main') section = 'side';
      return;
    }
    if (line.startsWith('#') || line.startsWith('//')) return;
    const nameM = /^(?:name|title)\s*[:\s]\s*(.+)$/i.exec(line);
    if (nameM && !/^\d/.test(line)) { out.name = nameM[1].trim(); return; }
    if (/^about$/i.test(line)) return;
    const header = SECTION_HEADERS[line.replace(/[:\s]+$/, '').toLowerCase()];
    if (header) { section = header; sawHeader = true; return; }
    let lineSection: DeckSection | 'skip' = section;
    const sb = /^SB:\s*(.*)$/i.exec(line);
    if (sb) { lineSection = 'side'; line = sb[1]; }
    const m = /^(\d+)\s*x?\s+(.+)$/i.exec(line);
    let count = 1;
    let rest = line;
    if (m) { count = Number(m[1]); rest = m[2]; }
    // "Name (SET) 123", "Name [SET] 123", "Name (SET)"; strip foil/markers like *F*.
    rest = rest.replace(/\s+\*[A-Z]+\*\s*$/i, '').trim();
    let set: string | undefined;
    let num: string | undefined;
    const sm = /^(.*?)\s+[([]([A-Za-z0-9]{2,6})[)\]](?:\s+(\S+))?\s*$/.exec(rest);
    if (sm) { rest = sm[1]; set = sm[2].toUpperCase(); num = sm[3]; }
    const name = rest.replace(/\s+\/\/?\s+/, ' // ').trim();
    if (!name || count <= 0) { out.errors.push(`Line ${i + 1}: can't read "${src.trim()}"`); return; }
    if (lineSection === 'skip') return;
    if (lineSection === 'main') sawMain = true;
    out.lines.push({ count, name, ...(set ? { set } : {}), ...(num ? { num } : {}), section: lineSection, line: i + 1 });
  });
  return out;
}

export interface ResolvedEntry { id: string; count: number; section: DeckSection }

export interface LegalityEnv {
  getCard(id: string): CardData | undefined;
  /** Every printing of a card: set code + rarity. */
  printings(id: string): { set: string; rarity: Rarity }[];
}

/** "A deck can have any number of cards named …" / "up to seven" (Seven Dwarves) etc. */
export function copyLimitOf(card: CardData, formatMax: number): number {
  if (card.supertypes.includes('Basic') && card.types.includes('Land')) return Infinity;
  const o = card.oracle;
  if (/A deck can have any number of cards named/i.test(o)) return Infinity;
  const m = /A deck can have up to (\w+) cards named/i.exec(o);
  if (m) {
    const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    return words[m[1].toLowerCase()] ?? (Number(m[1]) || formatMax);
  }
  return formatMax;
}

/** Returns human-readable legality errors (empty = legal). */
export function checkLegality(entries: ResolvedEntry[], format: FormatData, env: LegalityEnv): string[] {
  const errors: string[] = [];
  const main = entries.filter((e) => e.section !== 'side').reduce((n, e) => n + e.count, 0);
  const side = entries.filter((e) => e.section === 'side').reduce((n, e) => n + e.count, 0);
  if (main < format.minDeck) errors.push(`Deck has ${main} cards; ${format.name} requires at least ${format.minDeck}.`);
  if (format.maxCopies === 1 && format.minDeck === 100 && main > 100) errors.push(`Deck has ${main} cards; ${format.name} decks are exactly 100.`);
  if (side > format.maxSideboard) errors.push(`Sideboard has ${side} cards; maximum is ${format.maxSideboard}.`);

  const totals = new Map<string, number>();
  for (const e of entries) totals.set(e.id, (totals.get(e.id) ?? 0) + e.count);
  const banned = new Set(format.banned);
  const restricted = new Set(format.restricted);
  const additional = new Set(format.additional);
  const legalSets = format.sets ? new Set(format.sets) : undefined;
  for (const [id, n] of totals) {
    const card = env.getCard(id);
    if (!card) { errors.push(`Unknown card: ${id}`); continue; }
    if (banned.has(id)) { errors.push(`${card.name} is banned in ${format.name}.`); continue; }
    if (restricted.has(id) && n > 1) errors.push(`${card.name} is restricted in ${format.name} (max 1, found ${n}).`);
    const limit = copyLimitOf(card, format.maxCopies);
    if (n > limit) errors.push(`${n} copies of ${card.name} (max ${limit}).`);
    const isBasic = card.supertypes.includes('Basic') && card.types.includes('Land');
    if (!isBasic && !additional.has(id)) {
      const prints = env.printings(id);
      const inSets = legalSets ? prints.filter((p) => legalSets.has(p.set)) : prints;
      if (!inSets.length) { errors.push(`${card.name} is not legal in ${format.name} (not printed in a legal set).`); continue; }
      if (format.rarities && !inSets.some((p) => format.rarities!.includes(p.rarity))) {
        errors.push(`${card.name} is not legal in ${format.name} (never printed at ${format.rarities.join('/')} rarity).`);
      }
    }
  }
  return errors;
}
