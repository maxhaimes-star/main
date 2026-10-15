/**
 * Paying costs during a resolution: optional costs of triggered abilities ("you may pay {E}{E}{E}. When you do ..."),
 * "counter it unless its controller pays {X}" (Mana Leak, Daze, Ward), Ward. Mana is paid from the pool first and
 * then by tapping the player's untapped mana sources (Arena-style auto-pay; only sources whose mana ability has no
 * other cost or side effect are tapped automatically).
 *
 * Forge cost tokens understood: mana symbols, Mana<1 W\NumTimes>, PayLife<N>, PayEnergy<N>, AddCounter / SubCounter
 * (on the source), Sac<1/CARDNAME>, T / Q (the source), Draw<N/You>, Mill<N>, Discard<N/valid>, Sac<N/valid>,
 * ExileFromGrave<N/valid>, ExileFromHand<N/valid>, Return<N/valid>, tapXType<N|X/valid>, and the "Mandatory" flag.
 */
import { getCard } from '../cube.ts';
import { cardName, faceOf, hasKeyword, isCreature, type Lookup, payFromPool } from '../game/rules.ts';
import { type Ctx, drawCards, log, moveCard, player } from '../game/state.ts';
import type { GameState } from '../game/types.ts';
import { activateMana, manaOptionsFor } from './mana.ts';
import { matchCard } from './targets.ts';
import { parseManaSymbols } from '../cards.ts';

// ------------------------------------------------------------------ mana

export interface ManaSource { iid: string; options: { id: string; produces: string }[] }

/** Untapped mana sources `pid` can tap without other costs (lands, mana creatures without summoning sickness, rocks). */
export function manaSources(state: GameState, pid: string, lookup: Lookup = getCard, exclude?: string): ManaSource[] {
  const out: ManaSource[] = [];
  for (const iid of state.battlefield) {
    const c = state.cards[iid];
    if (c.controller !== pid || c.tapped || iid === exclude) continue;
    if (isCreature(c, lookup, state) && c.summoningSick && !hasKeyword(c, lookup, 'Haste', state)) continue;
    const opts = manaOptionsFor(state, iid, lookup).filter((o) => o.produces && o.sideEffects.every((s) => !/Pay |Sacrifice|Discard|life|damage|Spend only|by hand/i.test(s)));
    if (opts.length) out.push({ iid, options: opts.map((o) => ({ id: o.id, produces: o.produces })) });
  }
  return out;
}

/** Which sources to tap to pay `cost` (X = x) on top of `pool`; null = it can't be paid. */
export function planManaPayment(cost: string, x: number, pool: Record<string, number>, sources: ManaSource[]): { iid: string; option: string }[] | null {
  const p = { ...pool };
  const colored: string[] = [];
  const hybrids: string[][] = [];
  let generic = 0;
  for (const s of parseManaSymbols(cost)) {
    if (/^\d+$/.test(s)) generic += parseInt(s, 10);
    else if (s === 'X') generic += x;
    else if (/^[WUBRGC]$/.test(s)) colored.push(s);
    else if (/^[WUBRG]\/P$/.test(s)) colored.push(s[0]);
    else if (s.includes('/')) hybrids.push(s.split('/'));
    else if (s === 'S') generic += 1;
  }
  const left = sources.slice().sort((a, b) => a.options.length - b.options.length);
  const used: { iid: string; option: string }[] = [];
  const take = (color: string): boolean => {
    if ((p[color] ?? 0) > 0) { p[color]--; return true; }
    const k = left.findIndex((s) => s.options.some((o) => o.produces.includes(color)));
    if (k < 0) return false;
    const src = left.splice(k, 1)[0];
    const o = src.options.find((op) => op.produces.includes(color))!;
    used.push({ iid: src.iid, option: o.id });
    for (const ch of o.produces) p[ch] = (p[ch] ?? 0) + 1;
    p[color]--;
    return true;
  };
  for (const c of colored) if (!take(c)) return null;
  for (const h of hybrids) if (!h.some((c) => /^[WUBRG]$/.test(c) && take(c))) { if (h[0] === '2') generic += 2; else return null; }
  while (generic > 0) {
    const have = Object.keys(p).find((k) => p[k] > 0);
    if (have) { p[have]--; generic--; continue; }
    const src = left.shift();
    if (!src) return null;
    const o = src.options.slice().sort((a, b) => b.produces.length - a.produces.length)[0];
    used.push({ iid: src.iid, option: o.id });
    for (const ch of o.produces) p[ch] = (p[ch] ?? 0) + 1;
  }
  return used;
}

/** Can `pid` pay this mana cost now (pool + untapped sources)? */
export function canPayMana(state: GameState, pid: string, cost: string, x = 0, lookup: Lookup = getCard, exclude?: string): boolean {
  if (!cost) return true;
  const me = state.players.find((p) => p.pid === pid);
  if (!me) return false;
  return planManaPayment(cost, x, me.manaPool, manaSources(state, pid, lookup, exclude)) != null;
}

/** Pay a mana cost: tap sources as needed, then pay from the pool. Returns false (nothing paid) when it can't be paid. */
export function payMana(state: GameState, ctx: Ctx, pid: string, cost: string, x = 0, exclude?: string): boolean {
  if (!cost) return true;
  const me = player(state, pid);
  const plan = planManaPayment(cost, x, me.manaPool, manaSources(state, pid, ctx.lookup, exclude));
  if (!plan) return false;
  for (const u of plan) activateMana(state, ctx, pid, { t: 'activateMana', iid: u.iid, option: u.option });
  const res = payFromPool(cost, me.manaPool, x);
  if (!res) return false;
  me.manaPool = res.pool;
  if (res.lifePaid) me.life -= res.lifePaid;
  return true;
}

/** How many times `pid` can pay this mana cost (up to `max`). */
export function timesPayable(state: GameState, pid: string, cost: string, max: number, lookup: Lookup = getCard): number {
  let n = 0;
  while (n < max && canPayMana(state, pid, cost.repeat(n + 1), 0, lookup)) n++;
  return n;
}

// ------------------------------------------------------------------ Forge cost tokens

export interface CostTok {
  kind: 'mana' | 'manaTimes' | 'life' | 'energy' | 'counter' | 'sacSelf' | 'exileSelf' | 'tapSelf' | 'untapSelf' | 'returnSelf' | 'draw' | 'mill'
    | 'discard' | 'sac' | 'exileGrave' | 'exileHand' | 'return' | 'tapType' | 'discardHand';
  /** Count (number) or 'X'. */
  n: number | 'X';
  valid: string;
  /** mana: "{1}{W}"; counter: counter kind; */
  mana?: string;
  counter?: string;
  /** Signed counter change on the source. */
  delta?: number;
  text: string;
}

function counterKind(forge: string): string {
  const t = forge.trim().toUpperCase();
  if (t === 'P1P1') return '+1/+1';
  if (t === 'M1M1') return '-1/-1';
  if (t === 'LOYALTY') return 'loyalty';
  return t.toLowerCase();
}

const WORDS = ['no', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const num = (n: number | 'X') => (n === 'X' ? 'X' : WORDS[n] ?? String(n));

/** Parse a Forge cost. `unknown` lists tokens this module can't pay. */
export function parseCostTokens(cost: string): { toks: CostTok[]; mandatory: boolean; unknown: string[] } {
  const toks: CostTok[] = [];
  const unknown: string[] = [];
  let mandatory = false;
  let mana = '';
  for (const tok of cost.trim().match(/\S+<[^>]*>|\S+/g) ?? []) {
    if (tok === 'Mandatory') { mandatory = true; continue; }
    if (/^(\d+|[WUBRGCX]|[WUBRG2]\/[WUBRGP])$/.test(tok)) { mana += `{${tok}}`; continue; }
    if (/^[WUBRG]{2}$/.test(tok)) { mana += `{${tok[0]}/${tok[1]}}`; continue; }
    if (/^XMin\d+$/.test(tok)) continue;
    if (tok === 'T') { toks.push({ kind: 'tapSelf', n: 1, valid: '', text: 'tap it' }); continue; }
    if (tok === 'Q') { toks.push({ kind: 'untapSelf', n: 1, valid: '', text: 'untap it' }); continue; }
    const m = /^(\w+)<([^/>]+)(?:\/([^/>]+))?(?:\/([^>]+))?>$/.exec(tok);
    if (!m) { unknown.push(tok); continue; }
    const [, kind, rawN, valid = 'Card', desc] = m;
    const n: number | 'X' = /^\d+$/.test(rawN) ? parseInt(rawN, 10) : rawN === 'X' ? 'X' : NaN;
    const self = /^(CARDNAME|Self|NICKNAME)$/.test(valid);
    const what = desc ?? valid.split('.')[0].toLowerCase().replace(/;/g, ' or ');
    switch (kind) {
      case 'Mana': {
        const mt = /^(.*)\\NumTimes$/.exec(rawN);
        const sym = (mt ? mt[1] : rawN).trim().split(/\s+/).map((s) => `{${s}}`).join('');
        if (mt) toks.push({ kind: 'manaTimes', n: 'X', valid: '', mana: sym, text: `pay ${sym} any number of times` });
        else mana += sym;
        continue;
      }
      case 'PayLife': toks.push({ kind: 'life', n, valid: '', text: `pay ${rawN} life` }); continue;
      case 'PayEnergy': toks.push({ kind: 'energy', n, valid: '', text: `pay ${'{E}'.repeat(typeof n === 'number' ? n : 1)}` }); continue;
      case 'AddCounter': case 'SubCounter': {
        const k = counterKind(valid);
        toks.push({ kind: 'counter', n, valid: '', counter: k, delta: kind === 'AddCounter' ? 1 : -1, text: `${kind === 'AddCounter' ? 'put' : 'remove'} ${num(n)} ${k} counter${n === 1 ? '' : 's'} ${kind === 'AddCounter' ? 'on' : 'from'} it` });
        continue;
      }
      case 'Draw': toks.push({ kind: 'draw', n, valid: '', text: `draw ${n === 1 ? 'a card' : `${num(n)} cards`}` }); continue;
      case 'Mill': toks.push({ kind: 'mill', n, valid: '', text: `mill ${num(n)}` }); continue;
      case 'Sac': toks.push(self ? { kind: 'sacSelf', n: 1, valid, text: 'sacrifice it' } : { kind: 'sac', n, valid: valid.replace(/;/g, ','), text: `sacrifice ${num(n)} ${what}` }); continue;
      case 'Exile': if (self) { toks.push({ kind: 'exileSelf', n: 1, valid, text: 'exile it' }); continue; } break;
      case 'Discard':
        if (valid === 'Hand') { toks.push({ kind: 'discardHand', n: 1, valid, text: 'discard your hand' }); continue; }
        toks.push({ kind: 'discard', n, valid: valid.replace(/;/g, ','), text: `discard ${num(n)} ${what}` }); continue;
      case 'ExileFromGrave': toks.push({ kind: 'exileGrave', n, valid: valid.replace(/;/g, ','), text: `exile ${num(n)} ${desc ?? `card${n === 1 ? '' : 's'}`} from your graveyard` }); continue;
      case 'ExileFromHand': toks.push({ kind: 'exileHand', n, valid: valid.replace(/;/g, ','), text: `exile ${num(n)} ${what} from your hand` }); continue;
      case 'Return': toks.push(self ? { kind: 'returnSelf', n: 1, valid, text: 'return it to its owner\'s hand' } : { kind: 'return', n, valid: valid.replace(/;/g, ','), text: `return ${num(n)} ${what} you control to its owner's hand` }); continue;
      case 'tapXType': toks.push({ kind: 'tapType', n, valid: valid.replace(/;/g, ','), text: `tap ${num(n)} untapped ${what} you control` }); continue;
    }
    if (Number.isNaN(n)) { unknown.push(tok); continue; }
    unknown.push(tok);
  }
  if (mana) toks.unshift({ kind: 'mana', n: 1, valid: '', mana, text: `pay ${mana}` });
  return { toks, mandatory, unknown };
}

export function costText(toks: CostTok[]): string {
  const t = toks.map((x) => x.text).join(', ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Cards that could pay a choice token. */
export function costCandidates(state: GameState, ctx: Ctx, pid: string, srcIid: string | undefined, t: CostTok): string[] {
  const me = player(state, pid);
  const env = { controller: pid, sourceIid: srcIid, lookup: ctx.lookup };
  const ok = (iid: string) => iid !== srcIid && !!state.cards[iid] && matchCard(state.cards[iid], t.valid || 'Card', env) !== false;
  switch (t.kind) {
    case 'discard': case 'exileHand': return me.zones.hand.filter(ok);
    case 'exileGrave': return me.zones.graveyard.filter(ok);
    case 'sac': case 'return': return state.battlefield.filter((iid) => state.cards[iid].controller === pid && ok(iid));
    case 'tapType': return state.battlefield.filter((iid) => state.cards[iid].controller === pid && !state.cards[iid].tapped && ok(iid));
  }
  return [];
}

const count = (n: number | 'X', x: number) => (n === 'X' ? x : n);

/** Can these tokens be paid (X = x)? `times` multiplies a manaTimes token. */
export function canPayCost(state: GameState, ctx: Ctx, pid: string, srcIid: string | undefined, toks: CostTok[], x = 0): boolean {
  const me = player(state, pid);
  const src = srcIid ? state.cards[srcIid] : undefined;
  let mana = '';
  for (const t of toks) {
    const n = count(t.n, x);
    switch (t.kind) {
      case 'mana': mana += t.mana ?? ''; break;
      case 'manaTimes': break; // zero times is always possible
      case 'life': if (me.life < n) return false; break;
      case 'energy': if ((me.counters.energy ?? 0) < n) return false; break;
      case 'counter': if (!src || (t.delta! < 0 && (src.counters[t.counter!] ?? 0) < n)) return false; break;
      case 'sacSelf': case 'exileSelf': case 'returnSelf': if (!src || src.zone !== 'battlefield') return false; break;
      case 'tapSelf': if (!src || src.zone !== 'battlefield' || src.tapped) return false; break;
      case 'untapSelf': if (!src || !src.tapped) return false; break;
      case 'draw': case 'mill': case 'discardHand': break;
      case 'tapType': if (t.n !== 'X' && costCandidates(state, ctx, pid, srcIid, t).length < n) return false; break;
      default: if (costCandidates(state, ctx, pid, srcIid, t).length < n) return false;
    }
  }
  return canPayMana(state, pid, mana, x, ctx.lookup, toks.some((t) => t.kind === 'tapSelf') ? srcIid : undefined);
}

/** A choice the player still has to make to finish paying (resolve.ts turns it into a pick Pending). */
export interface CostChoice { kind: 'discard' | 'sac' | 'exileGrave' | 'exileHand' | 'return' | 'tapType'; candidates: string[]; n: number; upTo: boolean; text: string }

/**
 * Pay everything that needs no choice (mana, life, energy, counters, the source itself, draws) and return the
 * choices left (discard / sacrifice / exile cards ...). Call canPayCost first.
 */
export function payCostNow(state: GameState, ctx: Ctx, pid: string, srcIid: string | undefined, toks: CostTok[], x = 0, times = 1): CostChoice[] {
  const me = player(state, pid);
  const src = srcIid ? state.cards[srcIid] : undefined;
  const srcName = src ? cardName(src, ctx.lookup) : 'it';
  const choices: CostChoice[] = [];
  const done: string[] = [];
  for (const t of toks) {
    const n = count(t.n, x);
    switch (t.kind) {
      case 'mana': if (payMana(state, ctx, pid, t.mana ?? '', x, toks.some((k) => k.kind === 'tapSelf') ? srcIid : undefined)) done.push(t.mana ?? ''); break;
      case 'manaTimes': if (times > 0 && payMana(state, ctx, pid, (t.mana ?? '').repeat(times), 0)) done.push(`${t.mana} ×${times}`); break;
      case 'life': me.life -= n; done.push(`${n} life`); break;
      case 'energy': me.counters.energy = (me.counters.energy ?? 0) - n; done.push(`${'{E}'.repeat(n)}`); break;
      case 'counter':
        if (src) { src.counters[t.counter!] = (src.counters[t.counter!] ?? 0) + t.delta! * n; if (!src.counters[t.counter!] && t.counter !== 'loyalty') delete src.counters[t.counter!]; done.push(t.text); }
        break;
      case 'sacSelf': if (src?.zone === 'battlefield') { moveCard(state, ctx, src.iid, 'graveyard', { cause: 'sacrifice' }); done.push(`sacrificed ${srcName}`); } break;
      case 'exileSelf': if (src?.zone === 'battlefield') { moveCard(state, ctx, src.iid, 'exile'); done.push(`exiled ${srcName}`); } break;
      case 'returnSelf': if (src?.zone === 'battlefield') { moveCard(state, ctx, src.iid, 'hand'); done.push(`returned ${srcName}`); } break;
      case 'tapSelf': if (src) { src.tapped = true; done.push(`tapped ${srcName}`); } break;
      case 'untapSelf': if (src) { src.tapped = false; done.push(`untapped ${srcName}`); } break;
      case 'draw': { const got = drawCards(state, me, n); done.push(`drew ${got}`); break; }
      case 'mill': { let k = 0; for (; k < n && me.zones.library.length; k++) moveCard(state, ctx, me.zones.library[0], 'graveyard'); done.push(`milled ${k}`); break; }
      case 'discardHand': { const hand = [...me.zones.hand]; for (const iid of hand) moveCard(state, ctx, iid, 'graveyard', { cause: 'discard' }); done.push(`discarded ${hand.length}`); break; }
      default: {
        const cands = costCandidates(state, ctx, pid, srcIid, t);
        choices.push({ kind: t.kind as CostChoice['kind'], candidates: cands, n: t.n === 'X' && t.kind === 'tapType' ? cands.length : Math.min(n, cands.length), upTo: t.n === 'X' && t.kind === 'tapType', text: t.text });
      }
    }
  }
  if (done.length) log(state, ctx, pid, `${me.name} pays: ${done.join(', ')}.`);
  return choices;
}

/** Display name of a permanent for prompts. */
export function permName(state: GameState, ctx: Ctx, iid: string): string {
  const c = state.cards[iid];
  return c ? faceOf(c, ctx.lookup).name : 'it';
}
