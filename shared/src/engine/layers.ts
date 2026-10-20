/**
 * Copy and animate effects as layers on a card's face (pure functions, used by rules.ts faceOf).
 *
 * Everything is derived from data stored on the CardInstance (copyOf / copyToken / copyExtra / animations),
 * so the result is the same on the server, in the client view and after undo.
 *  - Layer 1 (copy): the copied card / token face, then the copy exceptions (copyExtra).
 *  - Layers 4-7b (animate): types, colors, keywords / abilities, base P/T — in timestamp (array) order.
 */
import type { Face } from '../game/rules.ts';
import type { CardInstance } from '../game/types.ts';
import type { Animation, CopyExtra } from './types.ts';

const CARD_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Kindred', 'Land', 'Planeswalker', 'Sorcery', 'Tribal'];
const SUPERTYPES = ['Legendary', 'Basic', 'Snow', 'World', 'Ongoing', 'Token'];
/** Subtypes that aren't creature types (kept by "loses its other creature types"). */
const NON_CREATURE_SUBTYPES = new Set([
  'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Desert', 'Gate', 'Lair', 'Locus', 'Mine', 'Power-Plant', 'Tower', 'Urza\'s', 'Cave', 'Sphere', 'Town',
  'Equipment', 'Vehicle', 'Treasure', 'Clue', 'Food', 'Blood', 'Gold', 'Fortification', 'Contraption', 'Powerstone', 'Map', 'Incubator', 'Attraction',
  'Aura', 'Saga', 'Class', 'Case', 'Room', 'Curse', 'Shrine', 'Cartouche', 'Rune', 'Background', 'Role', 'Shard', 'Siege',
]);

const KW_CANON: Record<string, string> = {
  'first strike': 'First strike', 'double strike': 'Double strike', flying: 'Flying', deathtouch: 'Deathtouch', lifelink: 'Lifelink',
  trample: 'Trample', vigilance: 'Vigilance', haste: 'Haste', reach: 'Reach', menace: 'Menace', hexproof: 'Hexproof',
  indestructible: 'Indestructible', defender: 'Defender', infect: 'Infect', shroud: 'Shroud', prowess: 'Prowess', flash: 'Flash',
};

/** Forge keyword ("First Strike", "Protection:Player.Opponent:each of your opponents") -> display keyword ('' = not shown). */
export function canonKeyword(k: string): string {
  const t = k.trim();
  const prot = /^Protection:[^:]*:(.+)$/.exec(t) ?? /^Protection from (.+)$/i.exec(t);
  if (prot) return `Protection from ${prot[1]}`;
  if (t.includes(':')) return /^Ward:/.test(t) ? 'Ward' : '';
  return KW_CANON[t.toLowerCase()] ?? t;
}

export interface TypeLineParts { supers: string[]; types: string[]; subs: string[] }

export function splitTypeLine(line: string): TypeLineParts {
  const [left, right] = line.split(/\s+[—-]\s+/);
  const supers: string[] = [], types: string[] = [];
  for (const w of (left ?? '').split(/\s+/).filter(Boolean)) (CARD_TYPES.includes(w) ? types : supers).push(w);
  return { supers, types, subs: (right ?? '').split(/\s+/).filter(Boolean) };
}

export function joinTypeLine(p: TypeLineParts): string {
  const left = [...p.supers, ...p.types].join(' ');
  return p.subs.length ? `${left} — ${p.subs.join(' ')}` : left;
}

const uniq = <T>(xs: T[]) => [...new Set(xs)];

function addTypesTo(p: TypeLineParts, add: string[]) {
  for (const t of add) {
    if (CARD_TYPES.includes(t)) { if (!p.types.includes(t)) p.types.push(t); } else if (SUPERTYPES.includes(t)) { if (!p.supers.includes(t)) p.supers.push(t); } else if (!p.subs.includes(t)) p.subs.push(t);
  }
}

function withTypes(f: Face, p: TypeLineParts): Face {
  const typeLine = joinTypeLine(p);
  return { ...f, typeLine, types: p.types.filter((t) => CARD_TYPES.includes(t)) };
}

/** Copy exceptions (layer 1). */
export function applyCopyExtra(f: Face, x: CopyExtra): Face {
  let out = { ...f };
  if (x.name) out.name = x.name;
  if (x.addTypes?.length || x.nonLegendary) {
    const p = splitTypeLine(out.typeLine);
    if (x.addTypes) addTypesTo(p, x.addTypes);
    if (x.nonLegendary) p.supers = p.supers.filter((s) => s !== 'Legendary');
    out = withTypes(out, p);
  }
  if (x.power != null) out.power = String(x.power);
  if (x.toughness != null) out.toughness = String(x.toughness);
  if (x.keywords?.length) out.keywords = uniq([...out.keywords, ...x.keywords.map(canonKeyword).filter(Boolean)]);
  return out;
}

/** One animate effect (layers 4-7b). */
export function applyAnimation(f: Face, a: Animation): Face {
  let out = { ...f };
  if (a.addTypes?.length || a.removeTypes?.length || a.removeCardTypes || a.removeCreatureTypes) {
    const p = splitTypeLine(out.typeLine);
    if (a.removeCardTypes) p.types = [];
    if (a.removeCreatureTypes) p.subs = p.subs.filter((s) => NON_CREATURE_SUBTYPES.has(s) && !a.removeCardTypes);
    if (a.removeTypes?.length) { p.types = p.types.filter((t) => !a.removeTypes!.includes(t)); p.subs = p.subs.filter((t) => !a.removeTypes!.includes(t)); p.supers = p.supers.filter((t) => !a.removeTypes!.includes(t)); }
    addTypesTo(p, a.addTypes ?? []);
    out = withTypes(out, p);
  }
  if (a.allCreatureTypes) out.allCreatureTypes = true;
  if (a.colors) out.colors = a.overwriteColors ? [...a.colors] : uniq([...(out.colors ?? []), ...a.colors]);
  if (a.removeAllAbilities) { out.keywords = []; out.oracle = ''; out.allCreatureTypes = undefined; }
  if (a.removeKeywords?.length) {
    const rm = a.removeKeywords.map((k) => canonKeyword(k).toLowerCase());
    out.keywords = out.keywords.filter((k) => !rm.includes(k.toLowerCase()));
  }
  if (a.keywords?.length) out.keywords = uniq([...out.keywords, ...a.keywords.map(canonKeyword).filter(Boolean)]);
  if (a.power != null) out.power = String(a.power);
  if (a.toughness != null) out.toughness = String(a.toughness);
  return out;
}

/** Apply copy exceptions and animations stored on the instance. */
export function layerFace(f: Face, inst: Pick<CardInstance, 'copyExtra' | 'animations' | 'zone'>): Face {
  let out = f;
  if (inst.copyExtra) out = applyCopyExtra(out, inst.copyExtra);
  if (inst.zone === 'battlefield') for (const a of inst.animations ?? []) out = applyAnimation(out, a);
  return out;
}

/** Has an animation made this permanent lose all its abilities (Oko's Elk)? */
export function lostAllAbilities(inst: Pick<CardInstance, 'animations'>): boolean {
  return !!inst.animations?.some((a) => a.removeAllAbilities);
}
