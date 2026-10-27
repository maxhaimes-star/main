import { basicLandCard, type CardData, type Color, type CubeData } from './cards.ts';
import cubeJson from '../data/cube.json' with { type: 'json' };
import { applyCardOverride } from './overrides.ts';

/** The lookup plus the five basic lands (same as game/reducer.ts withBasics; kept here so cube.ts has no engine imports). */
function withBasics(lookup: (id: string) => CardData | undefined): (id: string) => CardData | undefined {
  const basics: Record<string, CardData> = {};
  for (const c of ['W', 'U', 'B', 'R', 'G'] as Color[]) { const b = basicLandCard(c); basics[b.id] = b; }
  return (id) => basics[id] ?? lookup(id);
}

const RAW_CUBE = cubeJson as unknown as CubeData;
/** The built-in cube, with card overrides (shared/data/overrides.json) applied. */
export const CUBE: CubeData = { ...RAW_CUBE, cards: RAW_CUBE.cards.map((c) => applyCardOverride(c)) };
const byId = new Map<string, CardData>(CUBE.cards.map((c) => [c.id, c]));

// ------------------------------------------------------------ registry for cards outside the cube

/**
 * Cards from the full card database (set drafts, imported cubes, constructed decks). The server
 * registers what it loads; the client registers what the server sends with each room view.
 * Registered entries win over cube entries so a set draft can show the right printing's art.
 */
const registry = new Map<string, CardData>();
let resolver: ((id: string) => CardData | undefined) | undefined;
const listeners = new Set<() => void>();
let version = 0;

export function registerCards(cards: CardData[] | Record<string, CardData>) {
  const list = Array.isArray(cards) ? cards : Object.values(cards);
  let changed = false;
  for (const raw of list) {
    if (!raw?.id) continue;
    const c = applyCardOverride(raw);
    const cur = registry.get(c.id);
    if (cur && cur.image === c.image && cur.rank === c.rank) continue;
    registry.set(c.id, c);
    changed = true;
  }
  if (changed) {
    version++;
    listeners.forEach((l) => l());
  }
}

/** Fallback for ids that are neither cube cards nor registered (server: the card DB; client: a fetch queue). */
export function setCardResolver(fn: ((id: string) => CardData | undefined) | undefined) {
  resolver = fn;
}

/** True when the card is a cube card or already registered (no resolver call). */
export function isKnownCard(id: string): boolean {
  return byId.has(id) || registry.has(id) || id.startsWith('basic_');
}
export function isCubeCard(id: string): boolean {
  return byId.has(id);
}

export function onCardsRegistered(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
export function cardRegistryVersion(): number {
  return version;
}

function lookup(id: string): CardData | undefined {
  const c = registry.get(id) ?? byId.get(id);
  if (c || !resolver) return c;
  const r = applyCardOverride(resolver(id));
  if (r && !registry.has(id)) registry.set(id, r);
  return r;
}

/** Look up any cube card, basic land or registered database card by id. */
export const getCard = withBasics(lookup);
export const ALL_CARDS = CUBE.cards;
