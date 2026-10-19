/**
 * Forge counting variables and named conditions that need game state:
 * Count$Revolt / Kicked / Delirium / Threshold / Metalcraft / Hellbent (".A.B" = A if true else B),
 * Count$Converge, Count$TimesKicked, Count$Valid <expr> (and ValidGraveyard / ValidHand / ValidLibrary / ValidExile),
 * Count$Domain, Count$YourStartingLife, Count$CardCounters.<type>, Count$ThisTurnEntered_<To>[_from_<From>]_<Valid>,
 * Count$LeftGraveyardThisTurn <Valid>, with /Plus.N /Minus.N /Times.N /Twice /HalfUp /HalfDown.
 * And Condition$ Kicked / PlayerTurn / NotPlayerTurn / Delirium / Threshold / Metalcraft / Revolt / Hellbent.
 */
import { effectivePT, faceOf, type Lookup } from '../game/rules.ts';
import type { CardInstance, GameState } from '../game/types.ts';
import { isHidden, type ViewCard } from '../game/types.ts';
import { matchCard } from './targets.ts';

/** Enough state to count things (works on GameState; on a GameView hidden cards are skipped). */
export type CountState = Pick<GameState, 'players' | 'battlefield' | 'turn' | 'activePlayer'> & { cards: Record<string, CardInstance | ViewCard>; turnInfo?: GameState['turnInfo']; turnStats?: GameState['turnStats'] };

export interface CountEnv {
  state: CountState;
  lookup: Lookup;
  controller: string;
  sourceIid?: string;
  x?: number;
  kicked?: boolean;
  /** Multikicker: times kicked. */
  timesKicked?: number;
  colorsSpent?: string[];
}

const FLAGS = ['Revolt', 'Kicked', 'Delirium', 'Threshold', 'Metalcraft', 'Hellbent', 'CommittedCrimeThisTurn'];
export const KNOWN_CONDITIONS = new Set([...FLAGS, 'PlayerTurn', 'NotPlayerTurn', 'Blessing', 'Monarch']);
const ZONED = { ValidGraveyard: 'graveyard', ValidHand: 'hand', ValidLibrary: 'library', ValidExile: 'exile' } as const;
const CARD_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Kindred', 'Land', 'Planeswalker', 'Sorcery', 'Tribal'];
const PERMANENT_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'];
const BASIC = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];

/**
 * Count$Valid <expr>[$<aggregate>]: how many match, or an aggregate over them: $Colors (colors among them),
 * $CardTypes(Permanent), $CardPower / $CardToughness / $CardManaCost (sums), $Greatest... / $Least... ,
 * $Different... (distinct values), $CardCounters.<type> (sum).
 */
const VALID_RE = /^(Valid|ValidGraveyard|ValidHand|ValidLibrary|ValidExile) ([^\s$]+)(?:\$(Colors|CardTypes|CardTypesPermanent|(?:Greatest|Least|Different)?Card(?:Power|Toughness|ManaCost)|DifferentCardNames|CardCounters\.\w+))?$/;

const AGG = '(?:\\$(Colors|CardTypes|CardTypesPermanent|(?:Greatest|Least|Different)?Card(?:Power|Toughness|ManaCost)|DifferentCardNames|CardCounters\\.\\w+))?';
/** Count$ThisTurnCast_<valid>[$<aggregate>]: spells cast this turn (their cards as they were cast). */
const CAST_RE = new RegExp(`^ThisTurnCast_([^\\s$]+)${AGG}$`);

function aggregate(cards: CardInstance[], agg: string, env: CountEnv): number {
  const face = (c: CardInstance) => faceOf(c, env.lookup);
  if (agg === 'Colors') return new Set(cards.flatMap((c) => face(c).colors ?? [])).size;
  if (agg.startsWith('CardTypes')) {
    const types = new Set<string>();
    for (const c of cards) for (const t of face(c).types) if (CARD_TYPES.includes(t) && (agg === 'CardTypes' || PERMANENT_TYPES.includes(t))) types.add(t);
    return types.size;
  }
  if (agg === 'DifferentCardNames') return new Set(cards.map((c) => face(c).name)).size;
  const cm = /^CardCounters\.(\w+)$/.exec(agg);
  if (cm) { const k = counterKind(cm[1]); return cards.reduce((a, c) => a + (c.counters[k] ?? 0), 0); }
  const m = /^(Greatest|Least|Different)?Card(Power|Toughness|ManaCost)$/.exec(agg)!;
  const vals = cards.map((c) => {
    if (m[2] === 'ManaCost') return env.lookup(c.cardId ?? '')?.cmc ?? 0;
    const pt = c.zone === 'battlefield' && 'stack' in env.state ? effectivePT(c, env.lookup, env.state as GameState) : [parseInt(face(c).power ?? '0', 10) || 0, parseInt(face(c).toughness ?? '0', 10) || 0];
    return m[2] === 'Power' ? pt[0] : pt[1];
  });
  if (m[1] === 'Greatest') return vals.length ? Math.max(...vals) : 0;
  if (m[1] === 'Least') return vals.length ? Math.min(...vals) : 0;
  if (m[1] === 'Different') return new Set(vals).size;
  return vals.reduce((a, b) => a + b, 0);
}

function counterKind(forge: string): string {
  const u = forge.toUpperCase();
  return u === 'P1P1' ? '+1/+1' : u === 'M1M1' ? '-1/-1' : forge.toLowerCase();
}

function splitMods(v: string): [string, string[]] {
  const parts = v.split('/');
  return [parts[0], parts.slice(1)];
}

const MOD_RE = /^(Plus\.-?\d+|Minus\.-?\d+|Times\.-?\d+|LimitMax\.-?\d+|LimitMin\.-?\d+|Twice|HalfUp|HalfDown|Negative)$/;

/** Is this a Count$ value evalCount understands? (static check, no state) */
export function supportedCount(v: string): boolean {
  const m = /^Count\$(.+)$/.exec(v.trim());
  if (!m) return false;
  const [body, mods] = splitMods(m[1]);
  if (!mods.every((x) => MOD_RE.test(x))) return false;
  if (new RegExp(`^(${FLAGS.join('|')})\\.-?\\d+\\.-?\\d+$`).test(body)) return true;
  if (/^(Converge|TimesKicked|Domain|YourStartingLife)$/.test(body)) return true;
  if (/^CardCounters\.\w+$/.test(body)) return true;
  if (/^ThisTurnEntered_[A-Za-z]+(_from_[A-Za-z]+)?_\S+$/.test(body) || /^LeftGraveyardThisTurn \S+$/.test(body)) return true;
  if (VALID_RE.test(body) || CAST_RE.test(body)) return true;
  return false;
}

function mine(s: CountState, pid: string): CardInstance[] {
  return s.battlefield.map((i) => s.cards[i]).filter((c): c is CardInstance => !!c && !isHidden(c) && c.controller === pid);
}

function zoneCards(s: CountState, pid: string, zone: 'graveyard' | 'hand' | 'library' | 'exile'): CardInstance[] {
  const p = s.players.find((x) => x.pid === pid);
  if (!p) return [];
  return p.zones[zone].map((i) => s.cards[i]).filter((c): c is CardInstance => !!c && !isHidden(c));
}

/** Named condition (Condition$ value / Count$<Flag>). undefined = unknown. */
export function conditionTrue(name: string, env: CountEnv): boolean | undefined {
  const s = env.state;
  switch (name) {
    case 'Kicked': return !!env.kicked;
    case 'PlayerTurn': return s.activePlayer === env.controller;
    case 'NotPlayerTurn': return s.activePlayer !== env.controller;
    case 'Revolt': return !!s.turnInfo && s.turnInfo.turn === s.turn && s.turnInfo.leftBattlefield.includes(env.controller);
    case 'Threshold': return zoneCards(s, env.controller, 'graveyard').length >= 7;
    case 'CommittedCrimeThisTurn': return !!s.turnInfo && s.turnInfo.turn === s.turn && (s.turnInfo.activations[`crime|${env.controller}`] ?? 0) > 0; // triggers.ts trackTurnEvents
    case 'Hellbent': return zoneCards(s, env.controller, 'hand').length === 0;
    case 'Blessing': case 'Monarch': {
      const p = s.players.find((x) => x.pid === env.controller) as { designations?: string[] } | undefined;
      return !!p?.designations?.includes(name === 'Blessing' ? "City's Blessing" : 'Monarch');
    }
    case 'Metalcraft': return mine(s, env.controller).filter((c) => faceOf(c, env.lookup).types.includes('Artifact')).length >= 3;
    case 'Delirium': {
      const types = new Set<string>();
      for (const c of zoneCards(s, env.controller, 'graveyard')) for (const t of faceOf(c, env.lookup).types) if (CARD_TYPES.includes(t)) types.add(t);
      return types.size >= 4;
    }
  }
  return undefined;
}

function applyMods(n: number, mods: string[]): number {
  for (const m of mods) {
    const [k, a] = m.split('.');
    const v = parseInt(a ?? '0', 10);
    if (k === 'Plus') n += v;
    else if (k === 'Minus') n -= v;
    else if (k === 'Times') n *= v;
    else if (k === 'Twice') n *= 2;
    else if (k === 'HalfUp') n = Math.ceil(n / 2);
    else if (k === 'HalfDown') n = Math.floor(n / 2);
    else if (k === 'Negative') n = -n;
    else if (k === 'LimitMax') n = Math.min(n, v);
    else if (k === 'LimitMin') n = Math.max(n, v);
  }
  return n;
}

/** Evaluate a Count$ value. undefined = not understood. */
export function evalCount(v: string, env: CountEnv): number | undefined {
  if (!supportedCount(v)) return undefined;
  const [body, mods] = splitMods(v.trim().slice('Count$'.length));
  const s = env.state;
  let n: number | undefined;
  let m: RegExpExecArray | null;
  if ((m = /^(\w+)\.(-?\d+)\.(-?\d+)$/.exec(body)) && FLAGS.includes(m[1])) {
    const t = conditionTrue(m[1], env);
    if (t == null) return undefined;
    n = parseInt(t ? m[2] : m[3], 10);
  } else if (body === 'Converge') n = new Set((env.colorsSpent ?? []).filter((c) => 'WUBRG'.includes(c))).size;
  else if (body === 'TimesKicked') n = env.timesKicked ?? (env.kicked ? 1 : 0);
  else if (body === 'YourStartingLife') n = 20;
  else if (body === 'Domain') {
    const types = new Set<string>();
    for (const c of mine(s, env.controller)) { const tl = faceOf(c, env.lookup).typeLine; for (const b of BASIC) if (tl.includes(b)) types.add(b); }
    n = types.size;
  } else if ((m = /^ThisTurnEntered_([A-Za-z]+)(?:_from_([A-Za-z]+))?_(\S+)$/.exec(body)) || (m = /^LeftGraveyardThisTurn (\S+)$/.exec(body))) {
    // Zone changes this turn (GameState.turnStats.moves; unknown on a client view, which doesn't have them).
    if (!('history' in s)) return undefined; // a GameView: no move history
    const moves = s.turnStats?.moves;
    const left = body.startsWith('Left');
    const to = left ? undefined : m[1].toLowerCase();
    const from = left ? 'graveyard' : m[2]?.toLowerCase();
    const valid = left ? m[1] : m[3];
    const menv = { controller: env.controller, sourceIid: env.sourceIid, lookup: env.lookup };
    let count = 0;
    for (const mv of moves ?? []) {
      if ((to && mv.to !== to) || (from && mv.from !== from) || (left && mv.to === 'graveyard')) continue;
      const r = matchCard(mv.snap, valid, menv);
      if (r === 'unknown') return undefined;
      if (r) count++;
    }
    n = count;
  } else if ((m = /^CardCounters\.(\w+)$/.exec(body))) {
    const src = env.sourceIid ? s.cards[env.sourceIid] : undefined;
    const kind = m[1].toUpperCase() === 'P1P1' ? '+1/+1' : m[1].toUpperCase() === 'M1M1' ? '-1/-1' : m[1].toLowerCase();
    n = src && !isHidden(src) ? src.counters[kind] ?? 0 : 0;
  } else if ((m = CAST_RE.exec(body))) {
    if (!('history' in s)) return undefined; // a GameView: no move history
    const menv = { controller: env.controller, sourceIid: env.sourceIid, lookup: env.lookup };
    const hits: CardInstance[] = [];
    for (const c of s.turnStats?.castCards ?? []) {
      const r = matchCard(c, m[1], menv);
      if (r === 'unknown') return undefined;
      if (r) hits.push(c);
    }
    n = m[2] ? aggregate(hits, m[2], env) : hits.length;
  } else if ((m = VALID_RE.exec(body))) {
    const menv = { controller: env.controller, sourceIid: env.sourceIid, lookup: env.lookup };
    let pool: CardInstance[];
    if (m[1] === 'Valid') pool = s.battlefield.map((i) => s.cards[i]).filter((c): c is CardInstance => !!c && !isHidden(c));
    else pool = s.players.flatMap((p) => zoneCards(s, p.pid, ZONED[m![1] as keyof typeof ZONED]));
    const hits: CardInstance[] = [];
    for (const c of pool) {
      const r = matchCard(c, m[2], menv);
      if (r === 'unknown') return undefined;
      if (r) hits.push(c);
    }
    n = m[3] ? aggregate(hits, m[3], env) : hits.length;
  }
  return n == null ? undefined : applyMods(n, mods);
}
