/**
 * Extracts Forge rules scripts for every cube card into shared/data/scripts.json.
 * These drive the automatic card-effects engine (independent of where card text/images come from).
 *
 * Usage: npx tsx scripts/build-scripts.ts --forge <forge>/forge-gui/res
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CubeData, TokenData, Color } from '../shared/src/cards.ts';
import type { ForgeFace, ScriptData } from '../shared/src/engine/types.ts';

const args = process.argv.slice(2);
const res = args[args.indexOf('--forge') + 1];
if (!res || args.indexOf('--forge') < 0) { console.error('Pass --forge <forge-gui/res>'); process.exit(1); }
const cube = JSON.parse(fs.readFileSync('shared/data/cube.json', 'utf8')) as CubeData;

function parseFaces(text: string): ForgeFace[] {
  const faces: ForgeFace[] = [];
  let cur: ForgeFace | null = null;
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

const index = new Map<string, string>();
for (const letter of fs.readdirSync(path.join(res, 'cardsfolder'))) {
  const dir = path.join(res, 'cardsfolder', letter);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    const m = /^Name:(.*)$/m.exec(fs.readFileSync(full, 'utf8'));
    if (m && !index.has(m[1].trim().toLowerCase())) index.set(m[1].trim().toLowerCase(), full);
  }
}

const out: ScriptData = { cards: {}, tokens: {} };
const tokenNames = new Set<string>();
let missing = 0;
for (const card of cube.cards) {
  const front = (card.faces?.[0]?.name ?? card.name).toLowerCase();
  const file = index.get(front);
  if (!file) { missing++; continue; }
  const text = fs.readFileSync(file, 'utf8');
  out.cards[card.id] = parseFaces(text);
  for (const m of text.matchAll(/TokenScript\$\s*([^|\n]+)/g)) for (const t of m[1].split(',')) tokenNames.add(t.trim());
}
for (const t of ['c_a_clue_draw', 'c_a_treasure_sac', 'c_a_food_sac', 'c_a_blood_draw', 'c_a_map_sac_explore']) tokenNames.add(t);

const COLOR: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const SUPER = ['Legendary', 'Basic', 'Snow'];
const TYPES = ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle', 'Kindred', 'Tribal'];
for (const name of tokenNames) {
  const file = path.join(res, 'tokenscripts', `${name}.txt`);
  if (!fs.existsSync(file)) continue;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const get = (k: string) => lines.find((l) => l.startsWith(k + ':'))?.slice(k.length + 1);
  const words = (get('Types') ?? '').split(/\s+/);
  const left = words.filter((w) => SUPER.includes(w) || TYPES.includes(w));
  const right = words.filter((w) => !SUPER.includes(w) && !TYPES.includes(w));
  const pt = get('PT')?.split('/');
  const kws = lines.filter((l) => l.startsWith('K:')).map((l) => l.slice(2).split(':')[0]);
  const t: TokenData = {
    name: (get('Name') ?? name).replace(/ Token$/, ''),
    typeLine: `Token ${left.join(' ')}${right.length ? ' — ' + right.join(' ') : ''}`,
    colors: (get('Colors') ?? '').split(',').map((c) => COLOR[c.trim()]).filter(Boolean),
    power: pt?.[0], toughness: pt?.[1],
    oracle: [kws.join(', '), (get('Oracle') ?? '').replace(/\\n/g, '\n')].filter(Boolean).join('\n'),
    keywords: kws,
  };
  out.tokens[name] = t;
}
fs.writeFileSync('shared/data/scripts.json', JSON.stringify(out));
console.log(`scripts.json: ${Object.keys(out.cards).length} cards, ${Object.keys(out.tokens).length} tokens, ${missing} missing`);
