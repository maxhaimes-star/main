export type Color = 'W' | 'U' | 'B' | 'R' | 'G';
export const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];
export const COLOR_NAMES: Record<Color, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };

export type Layout = 'normal' | 'transform' | 'modal_dfc' | 'split' | 'adventure' | 'flip';

export interface CardFace {
  name: string;
  manaCost: string;
  typeLine: string;
  oracle: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  defense?: string;
}

export interface TokenData {
  name: string;
  typeLine: string;
  colors: Color[];
  power?: string;
  toughness?: string;
  oracle: string;
  keywords: string[];
}

export interface CardData {
  /** Stable slug, unique per card name. */
  id: string;
  name: string;
  manaCost: string;
  cmc: number;
  colors: Color[];
  colorIdentity: Color[];
  typeLine: string;
  supertypes: string[];
  types: string[];
  subtypes: string[];
  oracle: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  defense?: string;
  keywords: string[];
  /** Mana symbols this permanent can produce (W U B R G C). */
  producedMana: string[];
  layout: Layout;
  /** Only for multi-faced cards: [front, back]. */
  faces?: CardFace[];
  tokens: TokenData[];
  /** Remote high-res image (works in any browser with internet). */
  image: string;
  backImage?: string;
  /** Image cropped from the print-and-play PDF, served by this site. */
  localImage?: string;
  /** Position in the cube list (lower = listed earlier); used by bots as a weak power signal. */
  rank: number;
}

export interface CubeData {
  name: string;
  source: string;
  builtAt: string;
  /** Unique card definitions. */
  cards: CardData[];
  /** The cube list as card ids, in list order (duplicates allowed). */
  list: string[];
  /** Names in the list that could not be resolved. */
  missing: string[];
}

export const BASIC_LANDS: Record<Color, string> = {
  W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest',
};

export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’,!.]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function basicLandCard(color: Color): CardData {
  const name = BASIC_LANDS[color];
  return {
    id: `basic_${name.toLowerCase()}`,
    name,
    manaCost: '',
    cmc: 0,
    colors: [],
    colorIdentity: [color],
    typeLine: `Basic Land — ${name}`,
    supertypes: ['Basic'],
    types: ['Land'],
    subtypes: [name],
    oracle: `({T}: Add {${color}}.)`,
    keywords: [],
    producedMana: [color],
    layout: 'normal',
    tokens: [],
    image: scryfallImage(name),
    rank: 9999,
  };
}

export function scryfallImage(name: string, back = false, version: 'normal' | 'large' | 'small' = 'normal'): string {
  return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=${version}${back ? '&face=back' : ''}`;
}

export function isType(card: { types: string[] }, t: string): boolean {
  return card.types.includes(t);
}

export function isPermanentCard(card: CardData): boolean {
  return card.types.some((t) => ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'].includes(t));
}

/** Parse "{2}{W}{U/P}" into ["2","W","U/P"]. */
export function parseManaSymbols(cost: string): string[] {
  const out: string[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cost))) out.push(m[1]);
  return out;
}

export function cmcOf(cost: string): number {
  let total = 0;
  for (const s of parseManaSymbols(cost)) {
    if (/^\d+$/.test(s)) total += parseInt(s, 10);
    else if (s === 'X' || s === 'Y') continue;
    else if (/^2\//.test(s)) total += 2;
    else total += 1;
  }
  return total;
}

export function colorsOfCost(cost: string): Color[] {
  const set = new Set<Color>();
  for (const s of parseManaSymbols(cost)) for (const c of COLORS) if (s.includes(c)) set.add(c);
  return COLORS.filter((c) => set.has(c));
}

/** Coarse color bucket for sorting/display. */
export function colorBucket(card: CardData): string {
  if (card.types.includes('Land')) return 'Land';
  if (card.colors.length === 0) return 'Colorless';
  if (card.colors.length > 1) return 'Multicolor';
  return COLOR_NAMES[card.colors[0]];
}

export const BUCKET_ORDER = ['White', 'Blue', 'Black', 'Red', 'Green', 'Multicolor', 'Colorless', 'Land'];

export function mainType(card: CardData): string {
  for (const t of ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land']) {
    if (card.types.includes(t)) return t;
  }
  return card.types[0] ?? 'Other';
}
