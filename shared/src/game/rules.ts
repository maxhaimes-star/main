import { type CardData, type CardFace, type TokenData, parseManaSymbols } from '../cards.ts';
import type { CardInstance, GameState, ViewCard } from './types.ts';
import { isHidden } from './types.ts';
import { type StaticsState, staticMods } from '../engine/statics.ts';
import { layerFace } from '../engine/layers.ts';
import { poolAfter, poolSources, solveMana } from './manapay.ts';

export type Lookup = (id: string) => CardData | undefined;

/** What a card instance currently "is": its visible face or token definition. */
export interface Face {
  name: string;
  manaCost: string;
  typeLine: string;
  oracle: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  types: string[];
  keywords: string[];
  isToken: boolean;
  image?: string;
  localImage?: string;
  /** Colors (WUBRG letters), when known: card / token colors, after copy and animate effects. */
  colors?: string[];
  /** "Has all creature types" (Mutavault, changeling-like animate effects). */
  allCreatureTypes?: boolean;
}

const KW = ['Flying', 'First strike', 'Double strike', 'Deathtouch', 'Lifelink', 'Trample', 'Vigilance', 'Haste', 'Reach',
  'Menace', 'Hexproof', 'Indestructible', 'Flash', 'Defender', 'Infect', 'Shroud', 'Ward', 'Prowess', 'Unblockable'];

export function parseKeywords(oracle: string): string[] {
  const out = new Set<string>();
  for (const line of oracle.split('\n')) {
    const head = line.replace(/\(.*?\)/g, '').trim();
    for (const part of head.split(/,|;/)) {
      const p = part.trim().toLowerCase();
      for (const k of KW) if (p === k.toLowerCase() || p.startsWith(k.toLowerCase() + ' ')) out.add(k);
    }
  }
  return [...out];
}

function typesOf(typeLine: string): string[] {
  const left = typeLine.split(/\s+[—-]\s+/)[0];
  return left.split(/\s+/).filter((w) => ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Kindred', 'Land', 'Planeswalker', 'Sorcery', 'Tribal'].includes(w));
}

export function tokenFace(t: TokenData): Face {
  return {
    name: t.name, manaCost: '', typeLine: t.typeLine, oracle: t.oracle, power: t.power, toughness: t.toughness,
    types: typesOf(t.typeLine.replace(/^Token\s+/, '')), keywords: t.keywords.length ? t.keywords : parseKeywords(t.oracle), isToken: true,
    colors: [...t.colors],
  };
}

/**
 * The face a card instance currently shows: copy effects (copyOf / copyToken, engine/copy.ts), then copy exceptions
 * and animate effects (engine/layers.ts) on top of the printed face / token.
 */
export function faceOf(inst: CardInstance, lookup: Lookup): Face {
  let f: Face;
  if (inst.copyToken && inst.zone === 'battlefield') f = { ...tokenFace(inst.copyToken), isToken: !!inst.token };
  else if (inst.copyOf && inst.zone === 'battlefield') f = printedFace({ ...inst, cardId: inst.copyOf, token: undefined, transformed: inst.copyFace === 1, castAs: undefined }, lookup, !!inst.token);
  else f = printedFace(inst, lookup, !!inst.token);
  return inst.copyExtra || inst.animations?.length ? layerFace(f, inst) : f;
}

function printedFace(inst: CardInstance, lookup: Lookup, isToken: boolean): Face {
  if (inst.token && !inst.cardId) return tokenFace(inst.token);
  const card = inst.cardId ? lookup(inst.cardId) : undefined;
  if (!card) return { name: 'Unknown card', manaCost: '', typeLine: '', oracle: '', types: [], keywords: [], isToken };
  const back: CardFace | undefined = inst.transformed && card.faces?.[1] && (card.layout === 'transform' || card.layout === 'modal_dfc' || card.layout === 'flip') ? card.faces[1] : undefined;
  const adventure: CardFace | undefined = inst.castAs && card.faces ? card.faces.find((f) => f.name === inst.castAs) : undefined;
  const f = back ?? adventure;
  if (f) {
    return {
      name: f.name, manaCost: f.manaCost, typeLine: f.typeLine, oracle: f.oracle, power: f.power, toughness: f.toughness,
      loyalty: f.loyalty, types: typesOf(f.typeLine), keywords: parseKeywords(f.oracle), isToken,
      image: back ? card.backImage : card.image, localImage: back ? undefined : card.localImage, colors: [...card.colors],
    };
  }
  return {
    name: card.name, manaCost: card.manaCost, typeLine: card.typeLine, oracle: card.oracle, power: card.power,
    toughness: card.toughness, loyalty: card.loyalty, types: card.types,
    keywords: card.keywords.length ? [...new Set([...card.keywords, ...parseKeywords(card.oracle)])] : parseKeywords(card.oracle),
    isToken, image: card.image, localImage: card.localImage, colors: [...card.colors],
  };
}

/** Pass `state` (GameState or GameView) to include keywords granted / removed by static abilities. */
export function hasKeyword(inst: CardInstance, lookup: Lookup, kw: string, state?: StaticsState): boolean {
  if (inst.tempKeywords?.some((k) => k.toLowerCase() === kw.toLowerCase())) return true;
  const mods = state ? staticMods(state, inst.iid, lookup) : undefined;
  if (mods) {
    if (mods.removeKw.some((k) => k.toLowerCase() === kw.toLowerCase())) return false;
    if (mods.addKw.some((k) => k.toLowerCase() === kw.toLowerCase())) return true;
  }
  if (inst.faceDown) return false;
  const f = faceOf(inst, lookup);
  if (f.keywords.some((k) => k.toLowerCase() === kw.toLowerCase())) return true;
  return !!inst.note && inst.note.toLowerCase().includes(kw.toLowerCase());
}

function num(v: string | undefined): number {
  if (v == null) return 0;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}

export function isCreature(inst: CardInstance, lookup: Lookup, state?: StaticsState): boolean {
  if (inst.faceDown) return true; // morph / manifest / disguise
  const mods = state ? staticMods(state, inst.iid, lookup) : undefined;
  const f = faceOf(inst, lookup);
  // Reconfigure: an Equipment creature attached to something isn't a creature.
  if (inst.attachedTo && f.types.includes('Creature') && /\bEquipment\b/.test(f.typeLine)) return false;
  if (mods?.addTypes.includes('Creature')) return true;
  if (mods?.removeTypes.includes('Creature')) return false;
  // 'Crewed': a Vehicle crewed this turn (engine/keyword-play.ts).
  return f.types.includes('Creature') || (inst.counters['animated'] ?? 0) > 0 || !!inst.tempKeywords?.includes('Crewed');
}

/**
 * Power / toughness including counters and manual modifiers. Pass `state` (GameState or GameView) to apply
 * static abilities: characteristic-defining P/T, then set P/T, then modifications (anthems), then counters.
 */
export function effectivePT(inst: CardInstance, lookup: Lookup, state?: StaticsState): [number, number] {
  let p: number, t: number;
  if (inst.faceDown) { p = 2; t = 2; } else {
    const f = faceOf(inst, lookup);
    p = num(f.power); t = num(f.toughness);
  }
  const mods = state ? staticMods(state, inst.iid, lookup) : undefined;
  if (mods) {
    if (!inst.faceDown) { if (mods.cdaP != null) p = mods.cdaP; if (mods.cdaT != null) t = mods.cdaT; }
    if (mods.setP != null) p = mods.setP;
    if (mods.setT != null) t = mods.setT;
    p += mods.addP; t += mods.addT;
  }
  const plus = inst.counters['+1/+1'] ?? 0;
  const minus = inst.counters['-1/-1'] ?? 0;
  return [p + plus - minus + inst.tempPT[0] + inst.permPT[0], t + plus - minus + inst.tempPT[1] + inst.permPT[1]];
}

export function cardName(inst: CardInstance | ViewCard | undefined, lookup: Lookup): string {
  if (!inst) return 'a card';
  if (isHidden(inst)) return inst.faceDown ? 'a face-down card' : 'a card';
  if (inst.faceDown) return 'a face-down card';
  return faceOf(inst, lookup).name;
}

/** Loyalty-ability lines like "[+2]: ..." or "[−3]: ...". */
export function loyaltyAbilities(oracle: string): { cost: number; text: string }[] {
  const out: { cost: number; text: string }[] = [];
  for (const line of oracle.split('\n')) {
    const m = /^\[([+−\-]?)(\d+|X)\]:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const sign = m[1] === '+' ? 1 : m[1] === '' ? 0 : -1;
    const n = m[2] === 'X' ? 0 : parseInt(m[2], 10);
    out.push({ cost: sign === 0 ? 0 : sign * n, text: m[3] });
  }
  return out;
}

/** Activated-ability lines ("cost: effect"), excluding loyalty abilities. */
export function activatedAbilities(oracle: string): string[] {
  return oracle.split('\n').map((l) => l.trim()).filter((l) => {
    if (/^\[/.test(l)) return false;
    const stripped = l.replace(/\(.*?\)/g, '');
    const i = stripped.indexOf(':');
    if (i <= 0) return false;
    const cost = stripped.slice(0, i);
    // Heuristic: costs contain mana symbols, {T}, or words like Sacrifice/Pay/Discard/Exile/Remove.
    return /\{|Sacrifice|Pay|Discard|Exile|Remove|Tap|Return/i.test(cost) && cost.length < 120;
  });
}

/** Trigger lines ("When/Whenever/At ..."). */
export function triggeredAbilities(oracle: string): string[] {
  return oracle.split('\n').map((l) => l.trim()).filter((l) => /^(When|Whenever|At )/.test(l));
}

/**
 * Try to pay a mana cost from a pool. Returns the new pool, or null if it can't be paid.
 * Phyrexian symbols are paid with colored mana when possible, otherwise 2 life (reported in lifePaid).
 * Uses the backtracking solver (game/manapay.ts), so symbol order never makes a payable cost fail.
 */
export function payFromPool(cost: string, pool: Record<string, number>, x = 0): { pool: Record<string, number>; lifePaid: number } | null {
  const r = solveMana(cost, x, poolSources(pool));
  if (!r) return null;
  return { pool: poolAfter(pool, r.picks), lifePaid: r.lifePaid };
}

export function opponentsOf(state: GameState, pid: string): string[] {
  return state.players.filter((p) => p.pid !== pid).map((p) => p.pid);
}
