/**
 * Card overrides (shared/data/overrides.json): house rules and custom cards layered on top of Forge's scripts.
 *
 * An override keeps the card's id, so its art (the original card's Scryfall image and local crop), deck lists and
 * cube lists keep working; it replaces the name, oracle text and script lines. Applied wherever card data and
 * scripts are loaded: the built-in cube (cube.ts), registered cards (registerCards), the engine's scripts
 * (engine/script.ts SCRIPTS and registerScripts) and the server's card database (server/src/carddb.ts).
 * Applying an override twice is harmless (it sets fixed values).
 */
import data from '../data/overrides.json' with { type: 'json' };
import type { CardData, CardFace } from './cards.ts';
import type { ForgeFace } from './engine/types.ts';

export interface CardOverride {
  /** The printed name; still resolves in deck and cube lists. */
  original: string;
  name?: string;
  oracle?: string;
  /** A house rule (same card, different rules text). */
  houseRule?: boolean;
  /** Per face (multi-faced cards): name / oracle text. */
  faces?: Partial<Pick<CardFace, 'name' | 'oracle'>>[];
  /** Per script face: fields that replace the Forge script's. */
  script?: Partial<ForgeFace>[];
}

export const CARD_OVERRIDES = (data as unknown as { cards: Record<string, CardOverride> }).cards;

export function cardOverride(id: string): CardOverride | undefined {
  return Object.prototype.hasOwnProperty.call(CARD_OVERRIDES, id) ? CARD_OVERRIDES[id] : undefined;
}

/** Card data with its override applied (the same object when there is none). */
export function applyCardOverride<T extends CardData | undefined>(c: T): T {
  if (!c) return c;
  const o = cardOverride(c.id);
  if (!o) return c;
  const out: CardData = { ...c };
  if (o.name) out.name = o.name;
  if (o.oracle != null) out.oracle = o.oracle;
  if (o.faces && c.faces) out.faces = c.faces.map((f, i) => ({ ...f, ...(o.faces![i] ?? {}) }));
  return out as T;
}

/** Script faces with the override's script fields applied (the same array when there is none). */
export function applyScriptOverride(id: string, faces: ForgeFace[]): ForgeFace[];
export function applyScriptOverride(id: string, faces: ForgeFace[] | undefined): ForgeFace[] | undefined;
export function applyScriptOverride(id: string, faces: ForgeFace[] | undefined): ForgeFace[] | undefined {
  const o = cardOverride(id);
  if (!faces || !o?.script) return faces;
  return faces.map((f, i) => {
    const s = o.script![i];
    return s ? { ...f, ...s } : f;
  });
}

/** Lower-case name (printed and new) -> card id, for every overridden card. */
export function overrideNames(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, o] of Object.entries(CARD_OVERRIDES)) {
    if (o.original) out[o.original.toLowerCase()] = id;
    if (o.name) out[o.name.toLowerCase()] = id;
  }
  return out;
}
