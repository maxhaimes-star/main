/**
 * Mana payment solver (pure, no game state): pays a mana cost from a set of sources, each of which can be used
 * once with one of its options (a mana ability: "add {R}", "add {C}{C}", "add one mana of any color" = 5 options).
 * Floating mana is modelled as one source per unit with a negative penalty, so it is always spent first.
 *
 * Arena-style preferences: colored symbols are paid with the least flexible, cheapest source first (a basic before a
 * dual, a land before a creature, nothing with a drawback unless needed); generic mana is paid with leftover units
 * first, then the cheapest / least flexible sources. Phyrexian symbols are paid with mana when possible, else 2 life;
 * {2/W} with the color, else two generic. Backtracking guarantees a payment is found whenever one exists
 * (bounded search); the search then goes on a little for the cheapest payment (see the scoring below), so a source
 * that makes several mana (Mana Crypt, Sol Ring, Grim Monolith) pays with all of it rather than tapping extra lands.
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
/** Extra search after the first payment is found, for a cheaper one (fewer taps, no wasted mana). */
const OPT_NODES = 200;
/**
 * Scoring a payment (lower is better). Each permanent used costs its option's penalty + TAP_COST, plus FLEX_COST per
 * color it could make (keep flexible sources untapped); each unit of mana a used permanent makes that the cost doesn't
 * spend costs WASTE_COST (it floats). So Mana Crypt pays {2} alone rather than two lands, but a land pays {1} rather
 * than the Crypt. A Phyrexian symbol paid against the preference (life when mana was possible, or with mana when the
 * player chose life) costs LIFE_COST. Floating mana is free (and always spent first).
 */
const TAP_COST = 1.5;
const FLEX_COST = 0.05;
const WASTE_COST = 0.5;
const LIFE_COST = 100;

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
  const isPool = (key: string) => !!byKey.get(key)?.pool;
  const tapCost = (key: string, o: PayOption) => o.penalty + TAP_COST + FLEX_COST * flex.get(key)!;
  /** Interchangeable sources (several basic Islands) are tried once per step. */
  const shape = new Map(sources.map((s) => [s.key, s.pool ? 'pool' : s.options.map((o) => `${o.produces}/${o.penalty}/${o.helper ? 1 : 0}`).join(',')]));
  /** Committed sources: key -> chosen option and unspent units. */
  const used = new Map<string, { option: PayOption; left: string[]; paid?: string[] }>();
  const spent: string[] = [];
  let nodes = 0;
  let stopAt = MAX_NODES;
  /** Phyrexian symbols paid against the preference. */
  let against = 0;
  let best: { score: number; result: PayResult } | null = null;

  const usedScore = () => {
    let s = against * LIFE_COST;
    for (const [key, u] of used) if (!isPool(key)) s += tapCost(key, u.option);
    return s;
  };
  // Free sources for generic mana, in preference order (ties keep the first): floating mana, then cheap / inflexible.
  const order = (a: { s: PaySource; o: PayOption }, b: { s: PaySource; o: PayOption }) =>
    a.o.penalty - b.o.penalty || (flex.get(a.s.key)! - flex.get(b.s.key)!) || b.o.produces.length - a.o.produces.length;
  const bestOption = (s: PaySource) => [...s.options].sort((a, b) => a.penalty - b.penalty || b.produces.length - a.produces.length)[0];

  // Untapped permanents for generic mana, in preference order, with the options that make mana.
  const genericSources = sources.filter((s) => !s.pool).map((s) => ({ s, o: bestOption(s) })).filter((e) => e.o && e.o.produces.length > 0).sort(order)
    .map(({ s }) => ({ key: s.key, opts: s.options.filter((o) => o.produces.length > 0).sort((a, b) => a.penalty - b.penalty || b.produces.length - a.produces.length) }));
  const multi = sources.some((s) => !s.pool && s.options.some((o) => o.produces.length > 1));
  const memo = new Map<string, { cost: number; picks: { key: string; option: PayOption }[] } | null>();
  /**
   * The cheapest set of unused permanents making `need` generic mana (dynamic programming over units paid and helpers
   * used; ties keep the earlier, preferred sources). Memoized per set of used permanents.
   */
  const cheapest = (need: number) => {
    let mk = `${need}|`;
    for (const g of genericSources) if (used.has(g.key)) mk += `${g.key},`;
    if (memo.has(mk)) return memo.get(mk)!;
    const free = genericSources.filter((g) => !used.has(g.key));
    const capHelp = Math.min(maxHelp, free.filter((g) => g.opts.some((o) => o.produces === '*')).length);
    const W = capHelp + 1;
    const size = (need + 1) * W;
    // cost[u * W + h]; per layer, the option taken (or -1: carried over) and the previous state, to rebuild the picks
    let cost = new Float64Array(size).fill(Infinity);
    cost[0] = 0;
    const choice = new Int16Array(free.length * size).fill(-1);
    const prev = new Int32Array(free.length * size);
    let next = new Float64Array(size);
    free.forEach((g, l) => {
      next.set(cost);
      const base = l * size;
      for (let st = 0; st < size; st++) {
        const c0 = cost[st];
        if (c0 === Infinity) continue;
        const u = Math.floor(st / W), h = st % W;
        if (u >= need) continue;
        for (let oi = 0; oi < g.opts.length; oi++) {
          const o = g.opts[oi];
          const helper = o.produces === '*';
          if (helper && h + 1 > capHelp) continue;
          const units = o.produces.length;
          const c = c0 + tapCost(g.key, o) + Math.max(0, u + units - need) * WASTE_COST;
          const to = Math.min(need, u + units) * W + h + (helper ? 1 : 0);
          if (c < next[to] - 1e-9) { next[to] = c; choice[base + to] = oi; prev[base + to] = st; }
        }
      }
      [cost, next] = [next, cost];
    });
    let at = -1;
    for (let h = 0; h < W; h++) if (cost[need * W + h] < (at < 0 ? Infinity : cost[at]) - 1e-9) at = need * W + h;
    let res: { cost: number; picks: { key: string; option: PayOption }[] } | null = null;
    if (at >= 0) {
      const picks: { key: string; option: PayOption }[] = [];
      const total = cost[at];
      for (let l = free.length - 1; l >= 0; l--) {
        const oi = choice[l * size + at];
        if (oi < 0) continue;
        picks.unshift({ key: free[l].key, option: free[l].opts[oi] });
        at = prev[l * size + at];
      }
      res = { cost: total, picks };
    }
    memo.set(mk, res);
    return res;
  };

  /** Pay `n` generic and score the whole payment; records it when it is the best so far. */
  const leaf = (n: number, life: number) => {
    // leftover units of committed sources are free (pool units first: they're committed only when chosen)
    let need = n;
    const take: { key: string; units: number }[] = [];
    let waste = 0;
    for (const [key, u] of used) {
      const k = Math.min(Math.max(need, 0), u.left.length);
      if (k > 0) { take.push({ key, units: k }); need -= k; }
      if (!isPool(key)) waste += u.left.length - k;
    }
    // then floating mana
    const extra: { key: string; option: PayOption }[] = [];
    if (need > 0) {
      const pool = sources.filter((s) => s.pool && !used.has(s.key)).map((s) => ({ s, o: bestOption(s) })).filter((e) => e.o?.produces.length).sort(order);
      for (const { s, o } of pool) {
        if (need <= 0) break;
        extra.push({ key: s.key, option: o });
        need -= o.produces.length;
      }
    }
    let score = usedScore() + waste * WASTE_COST;
    // then the cheapest set of untapped sources
    if (need > 0) {
      const done = cheapest(need);
      if (!done) return;
      score += done.cost;
      extra.push(...done.picks);
      need = 0;
    }
    if (need > 0) return;
    if (best && score >= best.score - 1e-9) return;
    // Build the result.
    const out = new Map<string, { option: PayOption; left: string[]; paid?: string[] }>();
    const paidUnits = [...spent];
    for (const [key, u] of used) out.set(key, { option: u.option, left: [...u.left], ...(u.paid ? { paid: [...u.paid] } : {}) });
    for (const t of take) paidUnits.push(...out.get(t.key)!.left.splice(0, t.units));
    let left = n - take.reduce((a, t) => a + t.units, 0);
    for (const e of extra) {
      const units = e.option.produces.split('');
      const k = Math.min(left, units.length);
      paidUnits.push(...units.slice(0, k));
      left -= k;
      out.set(e.key, { option: e.option, left: units.slice(k) });
    }
    const picks = [...out.entries()].map(([key, u]) => ({ key, option: u.option.id, produces: u.option.produces, ...(isPool(key) ? { pool: true } : {}), ...(u.paid ? { paid: [...u.paid] } : {}) }));
    best = { score, result: { picks, lifePaid: life, spent: paidUnits } };
    // Only a permanent making several mana can make another payment cheaper: otherwise the first one is it.
    if (stopAt === MAX_NODES) stopAt = multi ? nodes + OPT_NODES : 0;
  };

  /** Sources (and options) that can pay a symbol, cheapest / least flexible first (per accepted colors). */
  const candCache = new Map<string, { s: PaySource; o: PayOption; sig: string }[]>();
  const candidates = (req: Req) => {
    const k = req.accept.join('');
    let list = candCache.get(k);
    if (!list) {
      list = [];
      for (const s of sources) for (const o of s.options) if (o.produces.split('').some((m) => req.accept.includes(m))) list.push({ s, o, sig: `${shape.get(s.key)}:${o.produces}:${o.penalty}` });
      list.sort((a, b) => a.o.penalty - b.o.penalty || flex.get(a.s.key)! - flex.get(b.s.key)! || a.o.produces.length - b.o.produces.length || minPen(a.s) - minPen(b.s));
      candCache.set(k, list);
    }
    return list;
  };

  const rec = (i: number, life: number, extraGeneric: number): void => {
    if (++nodes > stopAt) return;
    if (best && usedScore() >= best.score - 1e-9) return;
    if (i === reqs.length) { leaf(generic + extraGeneric, life); return; }
    const req = reqs[i];
    const lifeOk = req.alt === 'life' && life + 2 <= maxLife;
    // with mana, a Phyrexian symbol the player chose to pay with life is paid against the preference
    const manaAgainst = preferLife && lifeOk ? 1 : 0;
    // the player chose to pay Phyrexian symbols with life: try that first
    if (preferLife && lifeOk) rec(i + 1, life + 2, extraGeneric);
    against += manaAgainst;
    // a) a unit left over from a source already used
    const tried = new Set<string>();
    for (const [key, u] of used) {
      const idx = u.left.findIndex((m) => req.accept.includes(m));
      if (idx < 0) continue;
      const sig = `${isPool(key) ? 'p' : key}:${u.left[idx]}`;
      if (tried.has(sig)) continue;
      tried.add(sig);
      const [m] = u.left.splice(idx, 1);
      spent.push(m);
      rec(i + 1, life, extraGeneric);
      spent.pop();
      u.left.splice(idx, 0, m);
    }
    // b) a new source
    const seen = new Set<string>();
    for (const { s, o, sig } of candidates(req)) {
      if (used.has(s.key)) continue;
      // identical pool units / identical permanents (basic lands) are interchangeable
      if (seen.has(sig)) continue;
      seen.add(sig);
      const units = o.produces.split('');
      const idx = units.findIndex((m) => req.accept.includes(m));
      const [m] = units.splice(idx, 1);
      used.set(s.key, { option: o, left: units, ...(o.helper ? { paid: [req.sym] } : {}) });
      spent.push(m);
      rec(i + 1, life, extraGeneric);
      spent.pop();
      used.delete(s.key);
    }
    against -= manaAgainst;
    // c) alternatives
    if (lifeOk && !preferLife) { against++; rec(i + 1, life + 2, extraGeneric); against--; }
    if (req.alt === 'generic2') rec(i + 1, life, extraGeneric + 2);
  };
  rec(0, 0, 0);
  return (best as { result: PayResult } | null)?.result ?? null;
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
