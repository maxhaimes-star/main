/**
 * Booster generation from Forge booster templates (see SetData.booster in carddb-types.ts).
 *
 * Template: comma-separated "N <expr>" items. <expr> is either a named slot of the set
 * (BoosterTemplate.slots: a Base expression plus probabilistic Replace expressions) or a filter:
 * colon-separated terms such as `Common`, `RareMythic`, `BasicLand`, `fromSheet("DMU lands")`,
 * `!fromSheet("MOM battles")`, `!dfc`, `Any STA` (rarity word + other set code). A trailing `+`
 * marks a foil card (kept as a normal card; foil-ness is only reported).
 * Unknown terms are ignored (best effort); if a filter matches nothing it is relaxed so the
 * pack still has the right number of cards.
 */
import { slugify } from './cards.ts';
import type { BoosterCard, Print, Rarity, SetData } from './carddb-types.ts';

export interface BoosterEnv {
  getSet(code: string): SetData | undefined;
}

/** Chance that a RareMythic slot (without an explicit Replace line) shows a mythic. */
export const MYTHIC_RATE = 1 / 8;

const BASIC_FALLBACK: Print[] = ['plains', 'island', 'swamp', 'mountain', 'forest'].map((id) => [id, 'L', '', 'bl']);

const RARITY_WORDS: Record<string, Rarity[] | 'raremythic' | 'any'> = {
  common: ['C'], uncommon: ['U'], rare: ['R'], mythic: ['M'], raremythic: 'raremythic',
  uncommonrare: ['U', 'R'], uncommonraremythic: ['U', 'R', 'M'], special: ['S'], timeshifted: ['S'],
  any: 'any', foil: 'any', wildcard: 'any',
};

/** Split on ':' outside quotes/parentheses. */
function splitTerms(expr: string): string[] {
  const out: string[] = [];
  let cur = '', depth = 0, q = false;
  for (const ch of expr) {
    if (ch === '"') q = !q;
    else if (!q && ch === '(') depth++;
    else if (!q && ch === ')') depth--;
    if (ch === ':' && !q && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((t) => t.trim()).filter(Boolean);
}

/** Split a template on ',' outside quotes/parentheses. */
function splitItems(template: string): string[] {
  const out: string[] = [];
  let cur = '', depth = 0, q = false;
  for (const ch of template) {
    if (ch === '"') q = !q;
    else if (!q && ch === '(') depth++;
    else if (!q && ch === ')') depth--;
    if (ch === ',' && !q && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((t) => t.trim()).filter(Boolean);
}

const quoted = (s: string) => [...s.matchAll(/"([^"]*)"/g)].map((m) => m[1]);

interface Picked { print: Print; set: string }

class Generator {
  used = new Set<string>();
  constructor(private set: SetData, private env: BoosterEnv, private rng: () => number) {}

  sheet(name: string): { prints: Print[]; set: string } | undefined {
    const key = name.toLowerCase();
    const own = this.set.sheets?.[key];
    if (own) return { prints: own, set: this.set.code };
    const m = /^(\S+) cards$/i.exec(name);
    if (m) {
      const s = m[1].toUpperCase() === this.set.code ? this.set : this.env.getSet(m[1].toUpperCase());
      if (s) return { prints: s.cards, set: s.code };
    }
    return undefined;
  }

  /** Candidate prints for a filter expression (rarity choice for RareMythic is made here). */
  pool(expr: string, relax = 0): Picked[] {
    let source: Picked[] | undefined;
    const filters: ((p: Print) => boolean)[] = [];
    let rarities: Rarity[] | 'raremythic' | 'any' | undefined;
    for (let term of splitTerms(expr)) {
      term = term.replace(/\+$/, '');
      const neg = term.startsWith('!');
      if (neg) term = term.slice(1);
      const lower = term.toLowerCase();
      if (lower.startsWith('fromsheet(')) {
        const sh = this.sheet(quoted(term)[0] ?? '');
        if (neg) {
          if (sh) { const ids = new Set(sh.prints.map((p) => p[0])); filters.push((p) => !ids.has(p[0])); }
        } else if (sh && relax < 1) source = sh.prints.map((print) => ({ print, set: print[4] ?? sh.set }));
        continue;
      }
      if (lower.startsWith('name(')) {
        const ids = new Set(quoted(term).map(slugify));
        filters.push((p) => ids.has(p[0]) !== neg);
        continue;
      }
      if (lower.startsWith('promo(')) {
        source = quoted(term).map((s) => {
          const [n, code] = s.split('|');
          return { print: [slugify(n), 'S', '', ''] as Print, set: (code ?? this.set.code).toUpperCase() };
        });
        continue;
      }
      // "<Word>" or "<Word> <SETCODE>"
      const [word, code] = term.split(/\s+/);
      const w = word.toLowerCase();
      if (code && !neg) {
        const other = this.env.getSet(code.toUpperCase());
        if (other) source = other.cards.map((print) => ({ print, set: other.code }));
      }
      if (w === 'basicland') filters.push((p) => p[3].includes('b') !== neg);
      else if (w === 'land') filters.push((p) => p[3].includes('l') !== neg);
      else if (w === 'dfc') filters.push((p) => p[3].includes('d') !== neg);
      else if (w === 'nonlegendary') filters.push((p) => !p[3].includes('g'));
      else if (w === 'legendary') filters.push((p) => p[3].includes('g') !== neg);
      else if (RARITY_WORDS[w]) {
        const r = RARITY_WORDS[w];
        if (neg) { if (Array.isArray(r)) filters.push((p) => !r.includes(p[1])); } else if (relax < 2) rarities = r;
      }
    }
    source ??= this.set.cards.map((print) => ({ print, set: this.set.code }));
    let pool = source.filter((x) => filters.every((f) => f(x.print)));
    if (rarities === 'raremythic') {
      const rares = pool.filter((x) => x.print[1] === 'R');
      const mythics = pool.filter((x) => x.print[1] === 'M');
      pool = mythics.length && (!rares.length || this.rng() < MYTHIC_RATE) ? mythics : rares;
    } else if (Array.isArray(rarities)) {
      const r = rarities;
      pool = pool.filter((x) => r.includes(x.print[1]));
    }
    return pool;
  }

  pickOne(expr: string): BoosterCard | undefined {
    const foil = /\+\s*$/.test(expr) || /\)\+/.test(expr);
    for (let relax = 0; relax <= 2; relax++) {
      let pool = this.pool(expr, relax);
      if (!pool.length && relax === 2) {
        pool = /basicland/i.test(expr)
          ? BASIC_FALLBACK.map((print) => ({ print, set: this.set.code }))
          : this.set.cards.filter((p) => p[1] === 'C').map((print) => ({ print, set: this.set.code }));
      }
      if (!pool.length) continue;
      const fresh = pool.filter((x) => x.print[3].includes('b') || !this.used.has(x.print[0]));
      const from = fresh.length ? fresh : pool;
      const { print, set } = from[Math.floor(this.rng() * from.length)];
      this.used.add(print[0]);
      return { id: print[0], set, ...(print[2] ? { num: print[2] } : {}), rarity: print[1], ...(foil ? { foil: true } : {}) };
    }
    return undefined;
  }

  slotExpr(name: string): string | undefined {
    const def = this.set.booster?.slots[name];
    if (!def) return undefined;
    const r = this.rng();
    let acc = 0;
    for (const [p, expr] of def.replace) {
      acc += p;
      if (r < acc) return expr;
    }
    return def.base;
  }

  run(): BoosterCard[] {
    const out: BoosterCard[] = [];
    for (const item of splitItems(this.set.booster!.template)) {
      const m = /^(\d+)\s+(.*)$/.exec(item);
      const n = m ? Number(m[1]) : 1;
      const expr = m ? m[2] : item;
      const foil = expr.endsWith('+');
      const slotName = expr.replace(/\+$/, '');
      for (let i = 0; i < n; i++) {
        const e = this.slotExpr(slotName) ?? expr;
        const card = this.pickOne(foil && !e.endsWith('+') ? e + '+' : e);
        if (card) out.push(card);
      }
    }
    return out;
  }
}

/** One booster of `set` (which must have a booster template). */
export function generateBooster(set: SetData, env: BoosterEnv, rng: () => number = Math.random): BoosterCard[] {
  if (!set.booster) throw new Error(`${set.code} has no booster template`);
  return new Generator(set, env, rng).run();
}

/** Small deterministic PRNG (mulberry32) for reproducible packs. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
