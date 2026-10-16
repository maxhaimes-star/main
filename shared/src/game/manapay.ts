/**
 * Mana payment solver (pure, no game state): pays a mana cost from a set of sources, each of which can be used
 * once with one of its options (a mana ability: "add {R}", "add {C}{C}", "add one mana of any color" = 5 options).
 * Floating mana is modelled as one source per unit with a negative penalty, so it is always spent first.
 *
 * Arena-style preferences: colored symbols are paid with the least flexible, cheapest source first (a basic before a
 * dual, a land before a creature, nothing with a drawback unless needed); generic mana is paid with leftover units
 * first, then the cheapest / least flexible sources. Phyrexian symbols are paid with mana when possible, else 2 life;
 * {2/W} with the color, else two generic. Backtracking guarantees a payment is found whenever one exists
 * (bounded search).
 */
import { parseManaSymbols } from '../cards.ts';

/** helper: a permanent tapped to pay one colored symbol (Convoke with a creature of that color) — not mana. */
export interface PayOption { id: string; produces: string; penalty: number; helper?: boolean }
export interface PaySource { key: string; options: PayOption[]; pool?: boolean }
export interface PayPick {
  key: string; option: string; produces: string; pool?: boolean;
  /** For a helper option: the cost symbol it paid (e.g. 'G', 'G/W', 'G/P'), as parseManaSymbols spells it. */
  paid?: string[];
}
export interface PayResult {
  /** Sources used (pool units included, with pool: true). */
  picks: PayPick[];
  lifePaid: number;
  /** Mana symbols actually spent on the cost (W/U/B/R/G/C letters). */
  spent: string[];
}

interface Req { accept: string[]; alt?: 'life' | 'generic2'; sym: string }

const COLORS = ['W', 'U', 'B', 'R', 'G', 'C'];

export function parseRequirements(cost: string, x = 0): { reqs: Req[]; generic: number } | null {
  const reqs: Req[] = [];
  let generic = 0;
  for (const s of parseManaSymbols(cost)) {
    if (/^\d+$/.test(s)) generic += parseInt(s, 10);
    else if (s === 'X' || s === 'Y' || s === 'Z') generic += s === 'X' ? x : 0;
    else if (s === 'S') generic += 1;
    else if (/^[WUBRGC]$/.test(s)) reqs.push({ accept: [s], sym: s });
    else if (s.includes('/') || /^[WUBRGCP2]{2,3}$/.test(s)) {
      // "{W/U}", "{B/P}", "{2/W}" — or the slash-less card-data spelling "{WU}", "{BP}", "{2W}"
      const parts = s.includes('/') ? s.split('/') : s.split('');
      const colors = parts.filter((p) => /^[WUBRGC]$/.test(p));
      if (parts.includes('P')) reqs.push({ accept: colors, alt: 'life', sym: s });
      else if (parts.includes('2')) reqs.push({ accept: colors, alt: 'generic2', sym: s });
      else if (colors.length) reqs.push({ accept: colors, sym: s });
      else return null;
    } else if (s === 'H' || s === 'HW') generic += 0; // half mana (un-cards): ignore
    else return null;
  }
  // Single-color symbols first, then hybrids, then symbols with an alternative (paid last so they don't steal).
  const rank = (r: Req) => (r.alt === 'life' ? 3 : r.alt ? 2 : r.accept.length > 1 ? 1 : 0);
  reqs.sort((a, b) => rank(a) - rank(b));
  return { reqs, generic };
}

const MAX_NODES = 20000;

/**
 * Find a payment. `maxLife`: life that may be paid for Phyrexian symbols (`preferLife`: pay them with life whenever
 * possible instead of mana first). `maxHelp`: how many "helper" units
 * (produces '*': an artifact / creature tapped for Improvise, Convoke or Waterbend — generic mana) may be used.
 * Options flagged `helper` (Convoke: a creature paying one colored symbol of one of its colors) report the symbol they
 * paid in PayPick.paid.
 */
export function solveMana(cost: string, x: number, sources: PaySource[], maxLife = Infinity, maxHelp = Infinity, preferLife = false): PayResult | null {
  const parsed = parseRequirements(cost, x);
  if (!parsed) return null;
  const { reqs, generic } = parsed;
  if (!reqs.length && generic <= 0) return { picks: [], lifePaid: 0, spent: [] };
  const flex = new Map<string, number>();
  for (const s of sources) flex.set(s.key, new Set(s.options.flatMap((o) => o.produces.split(''))).size + (s.options.some((o) => o.produces.length > 1) ? 0.5 : 0));
  const minPen = (s: PaySource) => Math.min(...s.options.map((o) => o.penalty));
  const byKey = new Map(sources.map((s) => [s.key, s]));
  /** Committed sources: key -> chosen option and unspent units. */
  const used = new Map<string, { option: PayOption; left: string[]; paid?: string[] }>();
  const spent: string[] = [];
  let nodes = 0;

  const genericFrom = (n: number): PayPick[] | null => {
    // leftover units of committed sources are free (pool units first: they're committed only when chosen)
    let need = n;
    const extra: { key: string; option: PayOption }[] = [];
    const take: { key: string; units: number }[] = [];
    if (need > 0) {
      for (const [key, u] of used) {
        if (need <= 0) break;
        const k = Math.min(need, u.left.length);
        if (k > 0) { take.push({ key, units: k }); need -= k; }
      }
    }
    if (need > 0) {
      const free = sources.filter((s) => !used.has(s.key))
        .map((s) => ({ s, o: [...s.options].sort((a, b) => a.penalty - b.penalty || b.produces.length - a.produces.length)[0] }))
        .filter((e) => e.o && e.o.produces.length > 0)
        .sort((a, b) => a.o.penalty - b.o.penalty || (flex.get(a.s.key)! - flex.get(b.s.key)!) || b.o.produces.length - a.o.produces.length);
      let helped = 0;
      for (const { s, o } of free) {
        if (need <= 0) break;
        if (o.produces === '*') { if (helped >= maxHelp) continue; helped++; }
        extra.push({ key: s.key, option: o });
        need -= o.produces.length;
      }
    }
    if (need > 0) return null;
    // Commit (callers return straight away, so no need to roll back).
    for (const t of take) { const u = used.get(t.key)!; spent.push(...u.left.splice(0, t.units)); }
    let left = n - take.reduce((a, t) => a + t.units, 0);
    for (const e of extra) {
      const units = e.option.produces.split('');
      const k = Math.min(left, units.length);
      spent.push(...units.slice(0, k));
      left -= k;
      used.set(e.key, { option: e.option, left: units.slice(k) });
    }
    return [...used.entries()].map(([key, u]) => ({ key, option: u.option.id, produces: u.option.produces, ...(byKey.get(key)?.pool ? { pool: true } : {}), ...(u.paid ? { paid: [...u.paid] } : {}) }));
  };

  const rec = (i: number, life: number, extraGeneric: number): PayResult | null => {
    if (++nodes > MAX_NODES) return null;
    if (i === reqs.length) {
      const picks = genericFrom(generic + extraGeneric);
      return picks ? { picks, lifePaid: life, spent: [...spent] } : null;
    }
    const req = reqs[i];
    // the player chose to pay Phyrexian symbols with life: try that first
    if (preferLife && req.alt === 'life' && life + 2 <= maxLife) { const r = rec(i + 1, life + 2, extraGeneric); if (r) return r; }
    // a) a unit left over from a source already used
    const tried = new Set<string>();
    for (const [key, u] of used) {
      const idx = u.left.findIndex((m) => req.accept.includes(m));
      if (idx < 0) continue;
      const sig = `${byKey.get(key)?.pool ? 'p' : key}:${u.left[idx]}`;
      if (tried.has(sig)) continue;
      tried.add(sig);
      const [m] = u.left.splice(idx, 1);
      spent.push(m);
      const r = rec(i + 1, life, extraGeneric);
      if (r) return r;
      spent.pop();
      u.left.splice(idx, 0, m);
    }
    // b) a new source
    const cands: { s: PaySource; o: PayOption }[] = [];
    for (const s of sources) {
      if (used.has(s.key)) continue;
      for (const o of s.options) if (o.produces.split('').some((m) => req.accept.includes(m))) cands.push({ s, o });
    }
    cands.sort((a, b) => a.o.penalty - b.o.penalty || flex.get(a.s.key)! - flex.get(b.s.key)! || a.o.produces.length - b.o.produces.length || minPen(a.s) - minPen(b.s));
    const seen = new Set<string>();
    for (const { s, o } of cands) {
      // identical pool units are interchangeable
      const sig = s.pool ? `pool:${o.produces}` : `${s.key}:${o.produces}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const units = o.produces.split('');
      const idx = units.findIndex((m) => req.accept.includes(m));
      const [m] = units.splice(idx, 1);
      used.set(s.key, { option: o, left: units, ...(o.helper ? { paid: [req.sym] } : {}) });
      spent.push(m);
      const r = rec(i + 1, life, extraGeneric);
      if (r) return r;
      spent.pop();
      used.delete(s.key);
    }
    // c) alternatives
    if (req.alt === 'life' && !preferLife && life + 2 <= maxLife) { const r = rec(i + 1, life + 2, extraGeneric); if (r) return r; }
    if (req.alt === 'generic2') { const r = rec(i + 1, life, extraGeneric + 2); if (r) return r; }
    return null;
  };
  return rec(0, 0, 0);
}

/** Pool units as sources (colorless first, then the most plentiful color, for generic costs). */
export function poolSources(pool: Record<string, number>): PaySource[] {
  const out: PaySource[] = [];
  for (const m of COLORS) {
    const n = pool[m] ?? 0;
    for (let i = 0; i < n; i++) out.push({ key: `pool:${m}:${i}`, pool: true, options: [{ id: m, produces: m, penalty: m === 'C' ? -1000 : -100 - n }] });
  }
  return out;
}

/** The pool after spending the pool units a payment picked. */
export function poolAfter(pool: Record<string, number>, picks: PayPick[]): Record<string, number> {
  const p = { ...pool };
  for (const pk of picks) if (pk.pool) p[pk.produces] = (p[pk.produces] ?? 0) - 1;
  return p;
}
