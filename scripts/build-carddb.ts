/**
 * Builds the full card database (every Forge card, set and format) into a directory of sharded JSON.
 *
 * Usage: npx tsx scripts/build-carddb.ts --forge <forge>/forge-gui/res [--out data/carddb] [--commit <sha>]
 *
 * Output (all compact JSON):
 *   meta.json            build info + counts
 *   names.json           lower-case card/face name -> card id
 *   search.json          SearchRow[] for every card (name/type/cost/colors)
 *   cards/<n>.json       { [id]: CardData }        n = shardOf(id)
 *   scripts/<n>.json     { [id]: ForgeFace[] }     engine rules scripts
 *   tokens.json          { [tokenScript]: TokenData }
 *   sets.json            SetData[] (card lists with rarity + collector number, booster templates)
 *   formats.json         FormatData[]
 *
 * Card ids are slugify(name), exactly as in the cube (shared/data/cube.json).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { type CardData, type TokenData, slugify } from '../shared/src/cards.ts';
import type { ForgeFace } from '../shared/src/engine/types.ts';
import {
  type BoosterTemplate, type CardDbMeta, type FormatData, type Print, type Rarity, type SearchRow,
  type SetData, type SetType, type SlotDef, CARDDB_SHARDS, shardOf,
} from '../shared/src/carddb-types.ts';
import { cardFromForgeText, engineTokenFromText, expandCopyFaces, f1, listCardFiles, loadToken, parseFaces, parseForge } from './lib/forge-card.ts';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const res = arg('--forge');
const outDir = arg('--out') ?? 'data/carddb';
const commit = arg('--commit');
if (!res) { console.error('Pass --forge <forge-gui/res>'); process.exit(1); }

const t0 = Date.now();

// ---------------------------------------------------------------- cards + scripts

const cards = new Map<string, CardData>();
const scripts = new Map<string, ForgeFace[]>();
const names = new Map<string, string>();
const tokenCache = new Map<string, TokenData | undefined>();
const cachedToken = (s: string) => {
  if (!tokenCache.has(s)) tokenCache.set(s, loadToken(res, s));
  return tokenCache.get(s);
};
let collisions = 0;
for (const file of listCardFiles(res)) {
  if (!file.endsWith('.txt')) continue;
  const text = expandCopyFaces(fs.readFileSync(file, 'utf8'), res);
  const card = cardFromForgeText(text, 9999, cachedToken);
  if (!card || !card.id) continue;
  const prev = cards.get(card.id);
  if (prev) {
    if (prev.name !== card.name) collisions++;
    continue; // first file wins, like the cube builder's index
  }
  cards.set(card.id, card);
  scripts.set(card.id, parseFaces(text));
  const alias = (n: string | undefined) => { if (n) { const k = n.toLowerCase(); if (!names.has(k)) names.set(k, card.id); } };
  alias(card.name);
  const { faces, mode } = parseForge(text);
  const faceNames = faces.map((f) => f1(f, 'Name')).filter(Boolean) as string[];
  alias(faceNames[0]);
  if (faceNames[1] && mode !== 'Specialize') alias(`${faceNames[0]} // ${faceNames[1]}`);
}
// Face names last, so a real card name always wins over another card's back face.
for (const c of cards.values()) for (const f of c.faces ?? []) if (!names.has(f.name.toLowerCase())) names.set(f.name.toLowerCase(), c.id);
console.log(`cards: ${cards.size} (${collisions} slug collisions skipped)`);

function resolveName(name: string): string | undefined {
  const n = name.trim().replace(/\+$/, '');
  return names.get(n.toLowerCase()) ?? (cards.has(slugify(n)) ? slugify(n) : undefined)
    ?? names.get(n.split(' // ')[0].toLowerCase());
}

function flagsOf(id: string): string {
  const c = cards.get(id)!;
  let f = '';
  if (c.supertypes.includes('Basic') && c.types.includes('Land')) f += 'b';
  if (c.types.includes('Land')) f += 'l';
  if (c.layout === 'transform' || c.layout === 'modal_dfc') f += 'd';
  if (c.supertypes.includes('Legendary')) f += 'g';
  return f;
}

// ---------------------------------------------------------------- tokens

const tokens: Record<string, TokenData> = {};
for (const f of fs.readdirSync(path.join(res, 'tokenscripts'))) {
  if (!f.endsWith('.txt')) continue;
  const name = f.slice(0, -4);
  tokens[name] = engineTokenFromText(fs.readFileSync(path.join(res, 'tokenscripts', f), 'utf8'), name);
}

// ---------------------------------------------------------------- editions

interface Edition { meta: Record<string, string>; sections: Map<string, string[]> }
function parseSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let cur: string[] = [];
  sections.set('', cur);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) { cur = []; sections.set(m[1].toLowerCase(), cur); continue; }
    cur.push(line);
  }
  return sections;
}
function kv(lines: string[] = [], sep = '='): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lines) { const i = l.indexOf(sep); if (i > 0 && !(l.slice(0, i) in out)) out[l.slice(0, i)] = l.slice(i + 1).trim(); }
  return out;
}

const editions = new Map<string, Edition>();
const editionDir = path.join(res, 'editions');
for (const f of fs.readdirSync(editionDir)) {
  if (!f.endsWith('.txt')) continue;
  const sections = parseSections(fs.readFileSync(path.join(editionDir, f), 'utf8'));
  const meta = kv(sections.get('metadata'));
  if (!meta.Code) continue;
  editions.set(meta.Code.toUpperCase(), { meta, sections });
}

const printSheets = parseSections(fs.readFileSync(path.join(res, 'blockdata', 'printsheets.txt'), 'utf8'));

let unresolved = 0;
const unresolvedNames = new Set<string>();
const RARITIES = new Set(['C', 'U', 'R', 'M', 'S', 'L']);

/** Edition-style line: "123 R Name @Artist ${…}". */
function parseEditionLine(line: string): { num: string; rarity: Rarity; name: string } | undefined {
  const clean = line.replace(/\s*\$\{.*\}\s*$/, '');
  const m = /^(\S+)\s+([A-Z])\s+(.+?)(?:\s+@.*)?$/.exec(clean);
  if (!m || !RARITIES.has(m[2])) return undefined;
  return { num: m[1], rarity: m[2] as Rarity, name: m[3].trim() };
}

/** Rarity of a card in a given set's main list (for print-sheet entries that don't carry one). */
const rarityIndex = new Map<string, Map<string, [Rarity, string]>>();
function setRarity(code: string, id: string): [Rarity, string] | undefined {
  const ed = editions.get(code);
  if (!ed) return undefined;
  let idx = rarityIndex.get(code);
  if (!idx) {
    idx = new Map();
    for (const l of ed.sections.get('cards') ?? []) {
      const p = parseEditionLine(l);
      const pid = p && resolveName(p.name);
      if (pid && !idx.has(pid)) idx.set(pid, [p.rarity, p.num]);
    }
    rarityIndex.set(code, idx);
  }
  return idx.get(id);
}

/** Parses sheet lines; `sheetSet` is the set the section belongs to, `owner` the set whose data this is. */
function parseSheetLines(lines: string[], sheetSet: string, owner: string): Print[] {
  const out: Print[] = [];
  for (const line of lines) {
    if (line.includes('|')) {
      const m = /^(?:(\d+)\s+)?([^|]+)\|([^|]+)(?:\|(.*))?$/.exec(line);
      if (!m) continue;
      const id = resolveName(m[2]);
      if (!id) { unresolved++; unresolvedNames.add(m[2]); continue; }
      const set = m[3].trim().toUpperCase();
      const known = setRarity(set, id);
      const numM = /\[([^\]]+)\]/.exec(m[4] ?? '');
      const p: Print = [id, known?.[0] ?? 'S', numM?.[1] ?? known?.[1] ?? '', flagsOf(id)];
      if (set !== owner) p.push(set);
      const weight = Math.min(Number(m[1] ?? 1) || 1, 8);
      for (let i = 0; i < weight; i++) out.push(p);
    } else {
      const p = parseEditionLine(line);
      if (!p) continue;
      const id = resolveName(p.name);
      if (!id) { unresolved++; unresolvedNames.add(p.name); continue; }
      const pr: Print = [id, p.rarity, p.num, flagsOf(id)];
      if (sheetSet && sheetSet !== owner) pr.push(sheetSet);
      out.push(pr);
    }
  }
  return out;
}

/** Forge sheet name like "DMU cards", "DSK thirteen lands" or a printsheets.txt section. */
function getSheet(name: string, owner: string): Print[] | undefined {
  const m = /^(\S+)\s+(.+)$/.exec(name.trim());
  if (m) {
    const ed = editions.get(m[1].toUpperCase());
    const sec = ed?.sections.get(m[2].toLowerCase());
    if (ed && sec) return parseSheetLines(sec, m[1].toUpperCase(), owner);
  }
  const ps = printSheets.get(name.trim().toLowerCase());
  if (ps) return parseSheetLines(ps, '', owner);
  return undefined;
}

const TYPE_MAP: Record<string, SetType> = {
  Core: 'core', Expansion: 'expansion', Reprint: 'masters', Draft: 'draft', Commander: 'commander', Promo: 'promo',
  Online: 'online', Funny: 'funny', Duel_Deck: 'duel_deck', Starter: 'starter', Boxed_Set: 'boxed',
  Multiplayer: 'multiplayer', Collector_Edition: 'collector', Other: 'other',
};
const PLAY_BOOSTER_START = '2024-02-09'; // Murders at Karlov Manor

const sets: SetData[] = [];
let sheetMisses = 0;
for (const [code, ed] of editions) {
  const { meta, sections } = ed;
  const list = parseSheetLines(sections.get('cards') ?? [], code, code);
  if (!list.length) continue;
  const type = TYPE_MAP[meta.Type] ?? 'other';
  const set: SetData = {
    code, name: meta.Name ?? code, date: meta.Date ?? '', type,
    scryfall: (meta.ScryfallCode ?? code).toLowerCase(), cards: list,
  };

  let template = meta.DraftBooster ?? meta.Booster;
  let kind: BoosterTemplate['kind'] = !meta.DraftBooster && set.date >= PLAY_BOOSTER_START ? 'play' : 'draft';
  if (!template && ['core', 'expansion', 'masters', 'draft'].includes(type) && list.filter((p) => p[1] === 'C').length >= 30) {
    template = `10 Common, 3 Uncommon, 1 RareMythic${list.some((p) => p[3].includes('b')) ? ', 1 BasicLand' : ''}`;
    kind = 'default';
  }
  if (template) {
    const slots: Record<string, SlotDef> = {};
    for (const item of template.split(',')) {
      const slot = item.trim().replace(/^\d+\s+/, '').replace(/\+$/, '');
      const sec = sections.get(slot.toLowerCase());
      if (!sec || slots[slot]) continue;
      const def: SlotDef = { base: '', replace: [] };
      for (const l of sec) {
        const b = /^Base=(.*)$/.exec(l);
        if (b) def.base = b[1].trim();
        const r = /^Replace=\s*([\d.]+)F?\s+(.*)$/.exec(l);
        if (r) def.replace.push([parseFloat(r[1]), r[2].trim()]);
      }
      if (def.base) slots[slot] = def;
    }
    set.booster = { kind, template, slots };
    const exprs = [template, ...Object.values(slots).flatMap((s) => [s.base, ...s.replace.map((r) => r[1])])].join(',');
    const sheets: Record<string, Print[]> = {};
    for (const m of exprs.matchAll(/fromsheet\("([^"]+)"\)/gi)) {
      const key = m[1].toLowerCase();
      if (key === `${code.toLowerCase()} cards` || sheets[key]) continue;
      const sheet = getSheet(m[1], code);
      if (sheet?.length) sheets[key] = sheet; else sheetMisses++;
    }
    if (Object.keys(sheets).length) set.sheets = sheets;
  }
  sets.push(set);
}
sets.sort((a, b) => (b.date.localeCompare(a.date)) || a.code.localeCompare(b.code));
console.log(`sets: ${sets.length} (${sets.filter((s) => s.booster).length} with boosters), ${unresolved} unresolved print lines, ${sheetMisses} missing sheets`);

// ---------------------------------------------------------------- formats

const formats: FormatData[] = [];
const fmtRoot = path.join(res, 'formats');
const COMMANDER_LIKE: Record<string, number> = { Commander: 100, Oathbreaker: 60, Brawl: 60, PreDH: 100 };
let fmtMisses = 0;
const toIds = (s?: string) => (s ?? '').split(';').map((n) => n.trim()).filter(Boolean)
  .map((n) => { const id = resolveName(n); if (!id) fmtMisses++; return id; }).filter(Boolean) as string[];
for (const dir of fs.readdirSync(fmtRoot)) {
  if (dir === 'Archived' || !fs.statSync(path.join(fmtRoot, dir)).isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(fmtRoot, dir))) {
    const lines = fs.readFileSync(path.join(fmtRoot, dir, f), 'utf8').split(/\r?\n/).map((l) => l.trim());
    const m = kv(lines, ':');
    if (!m.Name) continue;
    const cmd = COMMANDER_LIKE[m.Name];
    formats.push({
      name: m.Name,
      type: m.Type ?? dir,
      order: Number(m.Order ?? 999),
      ...(m.Sets ? { sets: m.Sets.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) } : {}),
      banned: toIds(m.Banned),
      restricted: toIds(m.Restricted),
      additional: toIds(m.Additional),
      ...(m.Rarities ? { rarities: m.Rarities.split(',').map((r) => r.trim()).filter((r) => RARITIES.has(r)) as Rarity[] } : {}),
      minDeck: cmd ?? 60,
      maxSideboard: cmd ? 0 : 15,
      maxCopies: cmd ? 1 : 4,
    });
  }
}
formats.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
console.log(`formats: ${formats.length} (${fmtMisses} unresolved banned/restricted names)`);

// ---------------------------------------------------------------- write

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'cards'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'scripts'), { recursive: true });
const sizes: Record<string, [number, number]> = {};
function write(rel: string, data: unknown) {
  const buf = Buffer.from(JSON.stringify(data));
  fs.writeFileSync(path.join(outDir, rel), buf);
  const group = rel.includes('/') ? rel.split('/')[0] + '/*' : rel;
  const s = (sizes[group] ??= [0, 0]);
  s[0] += buf.length;
  s[1] += zlib.gzipSync(buf).length;
}
const cardShards: Record<string, CardData>[] = Array.from({ length: CARDDB_SHARDS }, () => ({}));
const scriptShards: Record<string, ForgeFace[]>[] = Array.from({ length: CARDDB_SHARDS }, () => ({}));
for (const [id, c] of cards) cardShards[shardOf(id)][id] = c;
for (const [id, s] of scripts) scriptShards[shardOf(id)][id] = s;
cardShards.forEach((s, i) => write(`cards/${i}.json`, s));
scriptShards.forEach((s, i) => write(`scripts/${i}.json`, s));
write('names.json', Object.fromEntries(names));
const search: SearchRow[] = [...cards.values()].map((c) => [c.id, c.name, c.typeLine, c.manaCost, c.cmc, c.colors.join(''), c.colorIdentity.join('')]);
write('search.json', search);
write('tokens.json', tokens);
write('sets.json', sets);
write('formats.json', formats);
const meta: CardDbMeta = {
  builtAt: new Date().toISOString(), ...(commit ? { forgeCommit: commit } : {}), shards: CARDDB_SHARDS,
  counts: { cards: cards.size, tokens: Object.keys(tokens).length, sets: sets.length, formats: formats.length },
};
write('meta.json', meta);

const mb = (n: number) => `${(n / 1048576).toFixed(1)}MB`;
let tot = [0, 0];
for (const [k, [raw, gz]] of Object.entries(sizes)) { console.log(`  ${k.padEnd(14)} ${mb(raw).padStart(8)} raw ${mb(gz).padStart(8)} gzip`); tot = [tot[0] + raw, tot[1] + gz]; }
console.log(`Wrote ${outDir}: ${mb(tot[0])} raw, ${mb(tot[1])} gzip in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (unresolvedNames.size) console.log(`Unresolved print names (sample): ${[...unresolvedNames].slice(0, 15).join('; ')}`);
