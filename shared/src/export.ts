import { BASIC_LANDS, type CardData, type Color } from './cards.ts';
import type { Deck } from './room.ts';

type Lookup = (id: string) => CardData | undefined;

function counted(ids: string[], lookup: Lookup): [number, string][] {
  const m = new Map<string, number>();
  for (const id of ids) {
    const name = lookup(id)?.name;
    if (name) m.set(name, (m.get(name) ?? 0) + 1);
  }
  return [...m.entries()].map(([n, c]) => [c, n]);
}

function basicsList(basics: Record<Color, number>): [number, string][] {
  return (Object.entries(basics) as [Color, number][]).filter(([, n]) => n > 0).map(([c, n]) => [n, BASIC_LANDS[c]]);
}

/** Plain text list (MTGA / MTGO / most sites accept this). */
export function deckToText(deck: Deck, lookup: Lookup): string {
  const main = [...counted(deck.main, lookup), ...basicsList(deck.basics)].map(([n, name]) => `${n} ${name}`);
  const side = counted(deck.side, lookup).map(([n, name]) => `${n} ${name}`);
  return `Deck\n${main.join('\n')}\n\nSideboard\n${side.join('\n')}\n`;
}

/** XMage .dck format. Split cards use XMage's "A // B" naming. */
export function deckToXmage(deck: Deck, lookup: Lookup, name = 'Cube Deck'): string {
  const main = [...counted(deck.main, lookup), ...basicsList(deck.basics)].map(([n, card]) => `${n} ${card}`);
  const side = counted(deck.side, lookup).map(([n, card]) => `SB: ${n} ${card}`);
  return `NAME:${name}\n${main.join('\n')}\n${side.join('\n')}\n`;
}

/** Cockatrice .cod XML. */
export function deckToCockatrice(deck: Deck, lookup: Lookup, name = 'Cube Deck'): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const zone = (zname: string, rows: [number, string][]) =>
    `  <zone name="${zname}">\n${rows.map(([n, c]) => `    <card number="${n}" name="${esc(c)}"/>`).join('\n')}\n  </zone>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<cockatrice_deck version="1">\n  <deckname>${esc(name)}</deckname>\n${zone('main', [...counted(deck.main, lookup), ...basicsList(deck.basics)])}\n${zone('side', counted(deck.side, lookup))}\n</cockatrice_deck>\n`;
}

/** Whole cube as a plain list (CubeCobra / XMage "cube from deck file"). */
export function cubeToText(ids: string[], lookup: Lookup): string {
  return counted(ids, lookup).map(([n, name]) => `${n} ${name}`).join('\n') + '\n';
}
