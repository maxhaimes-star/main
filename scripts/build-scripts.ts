/**
 * Extracts Forge rules scripts for every cube card into shared/data/scripts.json.
 * These drive the automatic card-effects engine (independent of where card text/images come from).
 *
 * Usage: npx tsx scripts/build-scripts.ts --forge <forge>/forge-gui/res
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CubeData } from '../shared/src/cards.ts';
import type { ScriptData } from '../shared/src/engine/types.ts';
import { engineTokenFromText, expandCopyFaces, parseFaces } from './lib/forge-card.ts';

const args = process.argv.slice(2);
const res = args[args.indexOf('--forge') + 1];
if (!res || args.indexOf('--forge') < 0) { console.error('Pass --forge <forge-gui/res>'); process.exit(1); }
const cube = JSON.parse(fs.readFileSync('shared/data/cube.json', 'utf8')) as CubeData;

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
  const text = expandCopyFaces(fs.readFileSync(file, 'utf8'), res);
  out.cards[card.id] = parseFaces(text);
  for (const m of text.matchAll(/TokenScript\$\s*([^|\n]+)/g)) for (const t of m[1].split(',')) tokenNames.add(t.trim());
}
for (const t of ['c_a_clue_draw', 'c_a_treasure_sac', 'c_a_food_sac', 'c_a_blood_draw', 'c_a_map_sac_explore']) tokenNames.add(t);

for (const name of tokenNames) {
  const file = path.join(res, 'tokenscripts', `${name}.txt`);
  if (!fs.existsSync(file)) continue;
  out.tokens[name] = engineTokenFromText(fs.readFileSync(file, 'utf8'), name);
}
fs.writeFileSync('shared/data/scripts.json', JSON.stringify(out));
console.log(`scripts.json: ${Object.keys(out.cards).length} cards, ${Object.keys(out.tokens).length} tokens, ${missing} missing`);
