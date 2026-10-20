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
  scryfallImage, slugify,
} from '../shared/src/cards.ts';
import { buildForgeIndex, cardFromForgeText, loadToken, producedManaOf, splitTypeLine } from './lib/forge-card.ts';

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

// ---------------------------------------------------------------- Forge source

function fromForge(res: string, names: string[]): { cards: Map<string, CardData>; missing: string[] } {
  console.log('Indexing Forge card database…');
  const index = buildForgeIndex(res);
  const cards = new Map<string, CardData>();
  const missing: string[] = [];
  names.forEach((name, rank) => {
    if (cards.has(name)) return;
    const file = index.get(name.toLowerCase()) ?? index.get(name.split(' // ')[0].toLowerCase());
    if (!file) { missing.push(name); return; }
    const card = cardFromForgeText(fs.readFileSync(file, 'utf8'), rank, (s) => loadToken(res, s));
    if (card) cards.set(name, card);
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
