/**
 * Builds shared/data/cube.json from cube/orangejuicebox.txt.
 *
 * Card rules data comes from (first that works):
 *   1. Scryfall's API (best; needs internet access to api.scryfall.com)
 *   2. A local checkout of the open-source Forge card database (--forge <path>)
 *
 * Usage:
 *   npm run build-cube                       # try Scryfall
 *   npm run build-cube -- --forge /path/to/forge/forge-gui/res
 *   npm run build-cube -- --list cube/other.txt --name "My Cube"
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  type CardData, type CardFace, type Color, type CubeData, type Layout, type TokenData,
  cmcOf, colorsOfCost, COLORS, parseManaSymbols, scryfallImage, slugify,
} from '../shared/src/cards.ts';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const listPath = arg('--list') ?? 'cube/orangejuicebox.txt';
const cubeName = arg('--name') ?? 'Orangejuicebox';
const forgeRes = arg('--forge');
const outPath = arg('--out') ?? 'shared/data/cube.json';

export function readList(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'))
    .map((l) => l.replace(/^\d+x?\s+/, ''));
}

const SUPERTYPES = ['Legendary', 'Basic', 'Snow', 'World', 'Ongoing'];
const CARD_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Kindred', 'Land', 'Planeswalker', 'Sorcery', 'Tribal', 'Conspiracy'];

function splitTypeLine(typeLine: string) {
  const [left, right = ''] = typeLine.split(/\s+[—-]\s+/);
  const words = left.split(/\s+/).filter(Boolean);
  return {
    supertypes: words.filter((w) => SUPERTYPES.includes(w)),
    types: words.filter((w) => CARD_TYPES.includes(w)),
    subtypes: right.split(/\s+/).filter(Boolean),
  };
}

const BASIC_TYPE_MANA: Record<string, Color> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };

function producedManaOf(oracle: string, subtypes: string[]): string[] {
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

function identityOf(cost: string, oracle: string, colors: Color[]): Color[] {
  const set = new Set<Color>(colors);
  for (const c of colorsOfCost(cost)) set.add(c);
  for (const s of parseManaSymbols(oracle)) for (const c of COLORS) if (s.includes(c)) set.add(c);
  return COLORS.filter((c) => set.has(c));
}

const KEYWORDS = [
  'Flying', 'First strike', 'Double strike', 'Deathtouch', 'Lifelink', 'Trample', 'Vigilance', 'Haste', 'Reach',
  'Menace', 'Hexproof', 'Indestructible', 'Flash', 'Defender', 'Ward', 'Shroud', 'Prowess', 'Protection',
  'Changeling', 'Cascade', 'Convoke', 'Delve', 'Flashback', 'Escape', 'Evoke', 'Unearth', 'Ninjutsu', 'Cycling',
  'Kicker', 'Affinity', 'Storm', 'Annihilator', 'Infect', 'Persist', 'Undying', 'Ravenous', 'Reconfigure',
  'Equip', 'Level up', 'Ascend', 'Investigate', 'Ward', 'Blitz', 'Dash', 'Madness', 'Morph', 'Disguise',
  'Prototype', 'Toxic', 'Mobilize', 'Offspring', 'Bargain', 'Craft', 'Discover', 'Station', 'Waterbend',
  'Firebending', 'Airbend', 'Earthbend', 'Suspend', 'Buyback', 'Entwine', 'Overload', 'Plot', 'Saddle',
];

function keywordsOf(oracle: string): string[] {
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

// ---------------------------------------------------------------- Forge source

interface ForgeFace { fields: Record<string, string[]> }
function parseForge(text: string): { faces: ForgeFace[]; mode?: string } {
  const faces: ForgeFace[] = [{ fields: {} }];
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
const f1 = (f: ForgeFace, k: string) => f.fields[k]?.[0];

function forgeCost(c?: string): string {
  if (!c || c === 'no cost') return '';
  return c.split(/\s+/).filter(Boolean).map((s) => `{${s}}`).join('');
}
function forgeTypeLine(t?: string): string {
  if (!t) return '';
  const words = t.split(/\s+/);
  const left = words.filter((w) => SUPERTYPES.includes(w) || CARD_TYPES.includes(w));
  const right = words.filter((w) => !SUPERTYPES.includes(w) && !CARD_TYPES.includes(w));
  return right.length ? `${left.join(' ')} — ${right.join(' ')}` : left.join(' ');
}
function forgeOracle(f: ForgeFace): string {
  return (f1(f, 'Oracle') ?? '').replace(/\\n/g, '\n').trim();
}
function forgeColors(f: ForgeFace, cost: string): Color[] {
  const explicit = f1(f, 'Colors');
  if (explicit) {
    const map: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
    return COLORS.filter((c) => explicit.split(',').some((e) => map[e.trim()] === c));
  }
  return colorsOfCost(cost);
}
function forgeFace(f: ForgeFace): CardFace {
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

const IMPLICIT_TOKENS: [RegExp, string][] = [
  [/\binvestigate\b/i, 'c_a_clue_draw'],
  [/\bTreasure token/i, 'c_a_treasure_sac'],
  [/\bFood token/i, 'c_a_food_sac'],
  [/\bMap token/i, 'c_a_map_sac_explore'],
  [/\bBlood token/i, 'c_a_blood_draw'],
  [/\bincubate\b/i, 'c_0_0_a_incubator_d_phyrexian'],
];

function buildForgeIndex(res: string) {
  const byName = new Map<string, string>();
  const dir = path.join(res, 'cardsfolder');
  for (const letter of fs.readdirSync(dir)) {
    const sub = path.join(dir, letter);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const file of fs.readdirSync(sub)) {
      const full = path.join(sub, file);
      const text = fs.readFileSync(full, 'utf8');
      const { faces, mode } = parseForge(text);
      const names = faces.map((f) => f1(f, 'Name')).filter(Boolean) as string[];
      if (!names.length) continue;
      const add = (n: string) => { const k = n.toLowerCase(); if (!byName.has(k)) byName.set(k, full); };
      add(names[0]);
      if (mode === 'Split' && names[1]) add(`${names[0]} // ${names[1]}`);
      if (names[1] && mode !== 'Specialize') add(`${names[0]} // ${names[1]}`);
    }
  }
  return byName;
}

function loadToken(res: string, script: string): TokenData | undefined {
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

function fromForge(res: string, names: string[]): { cards: Map<string, CardData>; missing: string[] } {
  console.log('Indexing Forge card database…');
  const index = buildForgeIndex(res);
  const cards = new Map<string, CardData>();
  const missing: string[] = [];
  names.forEach((name, rank) => {
    if (cards.has(name)) return;
    const file = index.get(name.toLowerCase()) ?? index.get(name.split(' // ')[0].toLowerCase());
    if (!file) { missing.push(name); return; }
    const text = fs.readFileSync(file, 'utf8');
    const { faces, mode } = parseForge(text);
    const front = faces[0];
    const layoutMap: Record<string, Layout> = {
      DoubleFaced: 'transform', Modal: 'modal_dfc', Split: 'split', Adventure: 'adventure',
      Omen: 'adventure', Prepare: 'adventure', Flip: 'flip',
    };
    const layout: Layout = (mode && layoutMap[mode]) || 'normal';
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
    const tokenScripts = new Set<string>();
    for (const m of text.matchAll(/TokenScript\$\s*([^|\n]+)/g)) {
      for (const t of m[1].split(',')) tokenScripts.add(t.trim());
    }
    for (const [re, script] of IMPLICIT_TOKENS) if (re.test(allOracle)) tokenScripts.add(script);
    const tokens = [...tokenScripts].map((s) => loadToken(res, s)).filter(Boolean) as TokenData[];
    const uniqTokens = tokens.filter((t, i) => tokens.findIndex((u) => u.name === t.name && u.power === t.power && u.oracle === t.oracle) === i);

    const card: CardData = {
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
    cards.set(name, card);
  });
  return { cards, missing };
}

// ---------------------------------------------------------------- Scryfall source

interface SfFace { name: string; mana_cost?: string; type_line?: string; oracle_text?: string; power?: string; toughness?: string; loyalty?: string; defense?: string; image_uris?: Record<string, string>; colors?: string[] }
interface SfCard extends SfFace {
  layout: string; cmc: number; colors?: string[]; color_identity: string[]; keywords: string[];
  produced_mana?: string[]; card_faces?: SfFace[]; all_parts?: { component: string; name: string; uri: string }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SF_HEADERS = { 'User-Agent': 'OJBCube/1.0', Accept: 'application/json', 'Content-Type': 'application/json' };

async function fromScryfall(names: string[]): Promise<{ cards: Map<string, CardData>; missing: string[] }> {
  const unique = [...new Set(names)];
  const found = new Map<string, SfCard>();
  const missing: string[] = [];
  for (let i = 0; i < unique.length; i += 75) {
    const batch = unique.slice(i, i + 75);
    const res = await fetch('https://api.scryfall.com/cards/collection', {
      method: 'POST', headers: SF_HEADERS,
      body: JSON.stringify({ identifiers: batch.map((name) => ({ name: name.split(' // ')[0] })) }),
    });
    if (!res.ok) throw new Error(`Scryfall ${res.status}`);
    const json = (await res.json()) as { data: SfCard[]; not_found: { name: string }[] };
    for (const c of json.data) {
      const listName = batch.find((n) => n.toLowerCase() === c.name.toLowerCase() || n.split(' // ')[0].toLowerCase() === c.name.split(' // ')[0].toLowerCase());
      if (listName) found.set(listName, c);
    }
    for (const nf of json.not_found) missing.push(nf.name);
    process.stdout.write(`\rScryfall: ${Math.min(i + 75, unique.length)}/${unique.length}`);
    await sleep(120);
  }
  console.log();

  // Fetch token definitions referenced by all_parts.
  const tokenCache = new Map<string, TokenData>();
  const cards = new Map<string, CardData>();
  for (const [rank, name] of names.entries()) {
    const c = found.get(name);
    if (!c || cards.has(name)) continue;
    const tokens: TokenData[] = [];
    for (const part of c.all_parts ?? []) {
      if (part.component !== 'token') continue;
      if (!tokenCache.has(part.uri)) {
        await sleep(100);
        const r = await fetch(part.uri, { headers: SF_HEADERS });
        if (!r.ok) continue;
        const t = (await r.json()) as SfCard;
        tokenCache.set(part.uri, {
          name: t.name, typeLine: t.type_line ?? 'Token', colors: (t.colors ?? []) as Color[],
          power: t.power, toughness: t.toughness, oracle: t.oracle_text ?? '', keywords: t.keywords ?? [],
        });
      }
      tokens.push(tokenCache.get(part.uri)!);
    }
    const layoutMap: Record<string, Layout> = { transform: 'transform', modal_dfc: 'modal_dfc', split: 'split', adventure: 'adventure', flip: 'flip' };
    const layout: Layout = layoutMap[c.layout] ?? 'normal';
    const front: SfFace = c.card_faces?.[0] ?? c;
    const faces = c.card_faces?.map((f): CardFace => ({
      name: f.name, manaCost: f.mana_cost ?? '', typeLine: f.type_line ?? '', oracle: f.oracle_text ?? '',
      ...(f.power ? { power: f.power, toughness: f.toughness } : {}),
      ...(f.loyalty ? { loyalty: f.loyalty } : {}), ...(f.defense ? { defense: f.defense } : {}),
    }));
    const typeLine = layout === 'split' ? (c.type_line ?? '') : (front.type_line ?? '');
    const st = splitTypeLine(front.type_line ?? '');
    const oracle = layout === 'split' ? (c.card_faces ?? []).map((f) => f.oracle_text).join('\n//\n') : (front.oracle_text ?? '');
    const dfc = layout === 'transform' || layout === 'modal_dfc';
    const displayName = layout === 'split' ? c.name : front.name;
    cards.set(name, {
      id: slugify(displayName),
      name: displayName,
      manaCost: layout === 'split' ? (c.mana_cost ?? '') : (front.mana_cost ?? ''),
      cmc: c.cmc,
      colors: ((c.colors ?? front.colors ?? []) as Color[]),
      colorIdentity: c.color_identity as Color[],
      typeLine,
      ...st,
      oracle,
      ...(front.power ? { power: front.power, toughness: front.toughness } : {}),
      ...(front.loyalty ? { loyalty: front.loyalty } : {}),
      ...(front.defense ? { defense: front.defense } : {}),
      keywords: c.keywords ?? [],
      producedMana: c.produced_mana ?? producedManaOf(oracle, st.subtypes),
      layout,
      ...(faces && layout !== 'normal' ? { faces } : {}),
      tokens: tokens.filter((t, i) => tokens.findIndex((u) => u.name === t.name && u.oracle === t.oracle && u.power === t.power) === i),
      image: (dfc ? c.card_faces?.[0].image_uris?.normal : c.image_uris?.normal) ?? scryfallImage(displayName),
      ...(dfc && c.card_faces?.[1].image_uris?.normal ? { backImage: c.card_faces[1].image_uris.normal } : {}),
      rank,
    });
  }
  return { cards, missing };
}

// ---------------------------------------------------------------- main

async function main() {
  const names = readList(listPath);
  console.log(`${names.length} cards in ${listPath}`);
  let result: { cards: Map<string, CardData>; missing: string[] };
  let source: string;
  if (forgeRes) {
    result = fromForge(forgeRes, names);
    source = 'forge';
  } else {
    try {
      result = await fromScryfall(names);
      source = 'scryfall';
    } catch (e) {
      console.error(`Scryfall unavailable (${(e as Error).message}). Re-run with --forge <forge-gui/res path>.`);
      process.exit(1);
    }
  }
  // Attach local PDF crops when present (client/public/cards/<index>.jpg, index = list position).
  const list: string[] = [];
  names.forEach((name, i) => {
    const card = result.cards.get(name);
    if (!card) return;
    const local = `cards/${String(i + 1).padStart(3, '0')}.jpg`;
    if (!card.localImage && fs.existsSync(path.join('client/public', local))) card.localImage = local;
    list.push(card.id);
  });
  const cube: CubeData = {
    name: cubeName,
    source,
    builtAt: new Date().toISOString(),
    cards: [...new Map([...result.cards.values()].map((c) => [c.id, c])).values()],
    list,
    missing: result.missing,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(cube));
  console.log(`Wrote ${outPath}: ${cube.cards.length} unique cards, ${list.length} in list, ${cube.missing.length} missing`);
  if (cube.missing.length) console.log('Missing:', cube.missing.join(', '));
}

main();
