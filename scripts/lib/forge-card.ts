/**
 * Forge card-script parsing shared by build-cube.ts, build-scripts.ts and build-carddb.ts.
 * Turns a Forge cardsfolder script into the site's CardData shape (shared/src/cards.ts) and
 * into the engine's ForgeFace shape (shared/src/engine/types.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  type CardData, type CardFace, type Color, type Layout, type TokenData,
  cmcOf, colorsOfCost, COLORS, parseManaSymbols, scryfallImage, slugify,
} from '../../shared/src/cards.ts';
import type { ForgeFace as EngineFace } from '../../shared/src/engine/types.ts';

export const SUPERTYPES = ['Legendary', 'Basic', 'Snow', 'World', 'Ongoing'];
export const CARD_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Kindred', 'Land', 'Planeswalker', 'Sorcery', 'Tribal', 'Conspiracy'];

export function splitTypeLine(typeLine: string) {
  const [left, right = ''] = typeLine.split(/\s+[—-]\s+/);
  const words = left.split(/\s+/).filter(Boolean);
  return {
    supertypes: words.filter((w) => SUPERTYPES.includes(w)),
    types: words.filter((w) => CARD_TYPES.includes(w)),
    subtypes: right.split(/\s+/).filter(Boolean),
  };
}

const BASIC_TYPE_MANA: Record<string, Color> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };

export function producedManaOf(oracle: string, subtypes: string[]): string[] {
  const set = new Set<string>();
  for (const st of subtypes) if (BASIC_TYPE_MANA[st]) set.add(BASIC_TYPE_MANA[st]);
  // Look only at "Add ..." clauses.
  const addRe = /\bAdd ([^.]*)/g;
  let m: RegExpExecArray | null;
  while ((m = addRe.exec(oracle))) {
    const clause = m[1];
    if (/any color|any one color|any combination of colors|mana of any type/i.test(clause)) COLORS.forEach((c) => set.add(c));
    for (const s of parseManaSymbols(clause)) {
      if (COLORS.includes(s as Color) || s === 'C') set.add(s);
      else if (/^\d+$/.test(s)) set.add('C');
    }
  }
  return ['W', 'U', 'B', 'R', 'G', 'C'].filter((c) => set.has(c));
}

export function identityOf(cost: string, oracle: string, colors: Color[]): Color[] {
  const set = new Set<Color>(colors);
  for (const c of colorsOfCost(cost)) set.add(c);
  for (const s of parseManaSymbols(oracle)) for (const c of COLORS) if (s.includes(c)) set.add(c);
  return COLORS.filter((c) => set.has(c));
}

export const KEYWORDS = [
  'Flying', 'First strike', 'Double strike', 'Deathtouch', 'Lifelink', 'Trample', 'Vigilance', 'Haste', 'Reach',
  'Menace', 'Hexproof', 'Indestructible', 'Flash', 'Defender', 'Ward', 'Shroud', 'Prowess', 'Protection',
  'Changeling', 'Cascade', 'Convoke', 'Delve', 'Flashback', 'Escape', 'Evoke', 'Unearth', 'Ninjutsu', 'Cycling',
  'Kicker', 'Affinity', 'Storm', 'Annihilator', 'Infect', 'Persist', 'Undying', 'Ravenous', 'Reconfigure',
  'Equip', 'Level up', 'Ascend', 'Investigate', 'Ward', 'Blitz', 'Dash', 'Madness', 'Morph', 'Disguise',
  'Prototype', 'Toxic', 'Mobilize', 'Offspring', 'Bargain', 'Craft', 'Discover', 'Station', 'Waterbend',
  'Firebending', 'Airbend', 'Earthbend', 'Suspend', 'Buyback', 'Entwine', 'Overload', 'Plot', 'Saddle',
];

export function keywordsOf(oracle: string): string[] {
  const lines = oracle.split('\n');
  const found = new Set<string>();
  for (const line of lines) {
    const head = line.replace(/\(.*?\)/g, '');
    for (const part of head.split(/,|;/)) {
      const p = part.trim();
      for (const k of KEYWORDS) {
        if (p.toLowerCase() === k.toLowerCase() || p.toLowerCase().startsWith(k.toLowerCase() + ' ')) found.add(k);
      }
    }
  }
  return [...found];
}

// ---------------------------------------------------------------- raw script fields

export interface RawFace { fields: Record<string, string[]> }
export function parseForge(text: string): { faces: RawFace[]; mode?: string } {
  const faces: RawFace[] = [{ fields: {} }];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === 'ALTERNATE' || line === 'SPECIALIZE:WHITE' || /^SPECIALIZE/.test(line)) { faces.push({ fields: {} }); continue; }
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i);
    const v = line.slice(i + 1);
    (faces[faces.length - 1].fields[k] ??= []).push(v);
  }
  return { faces, mode: faces[0].fields.AlternateMode?.[0] };
}
export const f1 = (f: RawFace, k: string) => f.fields[k]?.[0];

export function forgeCost(c?: string): string {
  if (!c || c === 'no cost') return '';
  return c.split(/\s+/).filter(Boolean).map((s) => `{${s}}`).join('');
}
export function forgeTypeLine(t?: string): string {
  if (!t) return '';
  const words = t.split(/\s+/);
  const left = words.filter((w) => SUPERTYPES.includes(w) || CARD_TYPES.includes(w));
  const right = words.filter((w) => !SUPERTYPES.includes(w) && !CARD_TYPES.includes(w));
  return right.length ? `${left.join(' ')} — ${right.join(' ')}` : left.join(' ');
}
export function forgeOracle(f: RawFace): string {
  return (f1(f, 'Oracle') ?? '').replace(/\\n/g, '\n').trim();
}
export function forgeColors(f: RawFace, cost: string): Color[] {
  const explicit = f1(f, 'Colors');
  if (explicit) {
    const map: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
    return COLORS.filter((c) => explicit.split(',').some((e) => map[e.trim()] === c));
  }
  return colorsOfCost(cost);
}
export function forgeFace(f: RawFace): CardFace {
  const pt = f1(f, 'PT');
  const [power, toughness] = pt ? pt.split('/') : [];
  return {
    name: f1(f, 'Name') ?? '',
    manaCost: forgeCost(f1(f, 'ManaCost')),
    typeLine: forgeTypeLine(f1(f, 'Types')),
    oracle: forgeOracle(f),
    ...(power !== undefined ? { power, toughness } : {}),
    ...(f1(f, 'Loyalty') ? { loyalty: f1(f, 'Loyalty') } : {}),
    ...(f1(f, 'Defense') ? { defense: f1(f, 'Defense') } : {}),
  };
}

export const IMPLICIT_TOKENS: [RegExp, string][] = [
  [/\binvestigate\b/i, 'c_a_clue_draw'],
  [/\bTreasure token/i, 'c_a_treasure_sac'],
  [/\bFood token/i, 'c_a_food_sac'],
  [/\bMap token/i, 'c_a_map_sac_explore'],
  [/\bBlood token/i, 'c_a_blood_draw'],
  [/\bincubate\b/i, 'c_0_0_a_incubator_d_phyrexian'],
];

/** Every card script file under cardsfolder, in the order the cube builder has always used. */
export function listCardFiles(res: string): string[] {
  const out: string[] = [];
  const dir = path.join(res, 'cardsfolder');
  for (const letter of fs.readdirSync(dir)) {
    const sub = path.join(dir, letter);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const file of fs.readdirSync(sub)) out.push(path.join(sub, file));
  }
  return out;
}

/** Lower-cased name (and "A // B" for two-faced cards) -> script file; first file wins. */
export function buildForgeIndex(res: string) {
  const byName = new Map<string, string>();
  for (const full of listCardFiles(res)) {
    const text = fs.readFileSync(full, 'utf8');
    const { faces, mode } = parseForge(text);
    const names = faces.map((f) => f1(f, 'Name')).filter(Boolean) as string[];
    if (!names.length) continue;
    const add = (n: string) => { const k = n.toLowerCase(); if (!byName.has(k)) byName.set(k, full); };
    add(names[0]);
    if (mode === 'Split' && names[1]) add(`${names[0]} // ${names[1]}`);
    if (names[1] && mode !== 'Specialize') add(`${names[0]} // ${names[1]}`);
  }
  return byName;
}

/** Token as embedded in CardData.tokens (cube builder flavour: keywords limited to KEYWORDS). */
export function loadToken(res: string, script: string): TokenData | undefined {
  const file = path.join(res, 'tokenscripts', `${script}.txt`);
  if (!fs.existsSync(file)) return undefined;
  const { faces } = parseForge(fs.readFileSync(file, 'utf8'));
  const f = faces[0];
  const face = forgeFace(f);
  const keywords = (f.fields.K ?? []).map((k) => k.split(':')[0]).filter((k) => KEYWORDS.includes(k));
  return {
    name: face.name.replace(/ Token$/, ''),
    typeLine: `Token ${face.typeLine}`,
    colors: forgeColors(f, ''),
    power: face.power,
    toughness: face.toughness,
    oracle: [keywords.join(', '), face.oracle].filter(Boolean).join('\n'),
    keywords,
  };
}

const LAYOUT_MAP: Record<string, Layout> = {
  DoubleFaced: 'transform', Modal: 'modal_dfc', Split: 'split', Adventure: 'adventure',
  Omen: 'adventure', Prepare: 'adventure', Flip: 'flip',
};

/** Token script names a card script references (explicit TokenScript$ plus implicit Clue/Treasure/…). */
export function tokenScriptsOf(text: string, allOracle: string): string[] {
  const tokenScripts = new Set<string>();
  for (const m of text.matchAll(/TokenScript\$\s*([^|\n]+)/g)) {
    for (const t of m[1].split(',')) tokenScripts.add(t.trim());
  }
  for (const [re, script] of IMPLICIT_TOKENS) if (re.test(allOracle)) tokenScripts.add(script);
  return [...tokenScripts];
}

/** Converts one Forge card script into CardData. Returns undefined for scripts without a name. */
export function cardFromForgeText(
  text: string, rank: number, tokenLoader: (script: string) => TokenData | undefined,
): CardData | undefined {
  const { faces, mode } = parseForge(text);
  const front = faces[0];
  if (!f1(front, 'Name')) return undefined;
  const layout: Layout = (mode && LAYOUT_MAP[mode]) || 'normal';
  const ff = forgeFace(front);
  const back = layout !== 'normal' && faces[1] ? forgeFace(faces[1]) : undefined;
  const isSplit = layout === 'split';
  const displayName = isSplit && back ? `${ff.name} // ${back.name}` : ff.name;
  const manaCost = isSplit && back ? `${ff.manaCost} // ${back.manaCost}` : ff.manaCost;
  const typeLine = isSplit && back && back.typeLine !== ff.typeLine ? `${ff.typeLine} // ${back.typeLine}` : ff.typeLine;
  const oracle = ff.oracle;
  const colors = isSplit && back
    ? COLORS.filter((c) => forgeColors(front, ff.manaCost).includes(c) || forgeColors(faces[1], back.manaCost).includes(c))
    : forgeColors(front, ff.manaCost);
  const st = splitTypeLine(ff.typeLine);
  const allOracle = [ff.oracle, back?.oracle ?? ''].join('\n');
  const tokens = tokenScriptsOf(text, allOracle).map(tokenLoader).filter(Boolean) as TokenData[];
  const uniqTokens = tokens.filter((t, i) => tokens.findIndex((u) => u.name === t.name && u.power === t.power && u.oracle === t.oracle) === i);

  return {
    id: slugify(displayName),
    name: displayName,
    manaCost,
    cmc: isSplit && back ? cmcOf(ff.manaCost) + cmcOf(back.manaCost) : cmcOf(ff.manaCost),
    colors,
    colorIdentity: identityOf(isSplit && back ? ff.manaCost + back.manaCost : ff.manaCost, allOracle, colors),
    typeLine,
    ...st,
    oracle: isSplit && back ? `${ff.oracle}\n//\n${back.oracle}` : oracle,
    ...(ff.power !== undefined ? { power: ff.power, toughness: ff.toughness } : {}),
    ...(ff.loyalty ? { loyalty: ff.loyalty } : {}),
    ...(ff.defense ? { defense: ff.defense } : {}),
    keywords: keywordsOf(ff.oracle),
    producedMana: producedManaOf(ff.oracle, st.subtypes),
    layout,
    ...(back ? { faces: [ff, back] } : {}),
    tokens: uniqTokens,
    image: scryfallImage(isSplit ? displayName : ff.name),
    ...(layout === 'transform' || layout === 'modal_dfc' ? { backImage: scryfallImage(ff.name, true) } : {}),
    rank,
  };
}

// ---------------------------------------------------------------- engine scripts

/** Card script -> engine faces (front first), as consumed by shared/src/engine. */
export function parseFaces(text: string): EngineFace[] {
  const faces: EngineFace[] = [];
  let cur: EngineFace | null = null;
  const start = () => { cur = { name: '', abilities: [], triggers: [], statics: [], replacements: [], keywords: [], svars: {} }; faces.push(cur); };
  start();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === 'ALTERNATE' || /^SPECIALIZE/.test(line)) { start(); continue; }
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i), v = line.slice(i + 1);
    const f = cur!;
    if (k === 'Name') f.name = v;
    else if (k === 'A') f.abilities.push(v);
    else if (k === 'T') f.triggers.push(v);
    else if (k === 'S') f.statics.push(v);
    else if (k === 'R') f.replacements.push(v);
    else if (k === 'K') f.keywords.push(v);
    else if (k === 'SVar') { const j = v.indexOf(':'); if (j > 0) f.svars[v.slice(0, j)] = v.slice(j + 1); }
  }
  return faces;
}

const TOKEN_COLOR: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const TOKEN_SUPER = ['Legendary', 'Basic', 'Snow'];
const TOKEN_TYPES = ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle', 'Kindred', 'Tribal'];

/** Token as stored in ScriptData.tokens (engine flavour: all keywords kept). */
export function engineTokenFromText(text: string, scriptName: string): TokenData {
  const lines = text.split(/\r?\n/);
  const get = (k: string) => lines.find((l) => l.startsWith(k + ':'))?.slice(k.length + 1);
  const words = (get('Types') ?? '').split(/\s+/);
  const left = words.filter((w) => TOKEN_SUPER.includes(w) || TOKEN_TYPES.includes(w));
  const right = words.filter((w) => !TOKEN_SUPER.includes(w) && !TOKEN_TYPES.includes(w));
  const pt = get('PT')?.split('/');
  const kws = lines.filter((l) => l.startsWith('K:')).map((l) => l.slice(2).split(':')[0]);
  return {
    name: (get('Name') ?? scriptName).replace(/ Token$/, ''),
    typeLine: `Token ${left.join(' ')}${right.length ? ' — ' + right.join(' ') : ''}`,
    colors: (get('Colors') ?? '').split(',').map((c) => TOKEN_COLOR[c.trim()]).filter(Boolean),
    power: pt?.[0], toughness: pt?.[1],
    oracle: [kws.join(', '), (get('Oracle') ?? '').replace(/\\n/g, '\n')].filter(Boolean).join('\n'),
    keywords: kws,
  };
}
