/**
 * Stage 3: static / continuous effects (Forge "S:" lines).
 *
 * Everything here is derived from the game state on demand (never stored), so it stays correct after
 * undo. Results are cached per state object and invalidated by a signature of everything they read.
 *
 * Supported:
 *  - Continuous: P/T (characteristic-defining, Set, Add), keyword grants/removals, "is a creature" type
 *    changes, for Affected$ / AffectedDefined$ (Self, Equipped, Enchanted) permanents on the battlefield,
 *    gated by Condition$ / IsPresent$ / CheckSVar$.
 *  - RaiseCost / ReduceCost for spells (applied when casting) and activated abilities.
 *  - Restrictions: CantBeCast, CantAttack, CantBlock, CantBlockBy (enforced; overridable with `force`).
 *  - Reminders only: MustAttack, MinMaxBlocker, CantDraw, and anything else (listed by activeStatics).
 */
import { parseManaSymbols } from '../cards.ts';
import { effectivePT, faceOf, hasKeyword, type Lookup } from '../game/rules.ts';
import { type CardInstance, type ViewCard, isHidden } from '../game/types.ts';
import { getScript, grantedLines, parseParams, scriptRef } from './script.ts';
import type { EffectRecord, TimedEffect } from './types.ts';
import { type MatchEnv, type Tri, matchCard } from './targets.ts';

// ------------------------------------------------------------------ types

/** The parts of a GameState / GameView statics read. */
export interface StaticsState {
  battlefield: string[];
  cards: Record<string, CardInstance | ViewCard>;
  players: { pid: string; life: number; zones: Record<string, string[]>; handCount?: number }[];
  activePlayer?: string;
  step?: string;
  stack?: unknown[];
  turn?: number;
  /** Effect records (engine/effects.ts): emblems and "this turn" effects with static abilities. */
  effects?: TimedEffect[];
}

/** One static ability of a permanent (or a card being cast, for EffectZone$ All). */
export interface StaticAbility {
  sourceIid: string;
  controller: string;
  /** Mode$ values ("Continuous", "CantAttack", ...). */
  modes: string[];
  params: Record<string, string>;
  svars: Record<string, string>;
  description: string;
  line: string;
  /** Effects (engine/effects.ts): the effect's name ("Emblem — ...") and remembered objects. */
  sourceName?: string;
  remembered?: string[];
}

/** How fully the engine handles a static. */
export type StaticSupport = 'full' | 'partial' | 'none';

export interface ActiveStatic {
  sourceIid: string;
  description: string;
  mode: string;
  /** 'full' = applied/enforced automatically; 'partial' = some parts applied; 'none' = reminder only. */
  support: StaticSupport;
  /** Set for effects / emblems (sourceIid is then "effect:<id>", not a card). */
  sourceName?: string;
}

/** Continuous-effect modifications to one permanent. */
export interface CardMods {
  /** Characteristic-defining P/T (layer 7a). */
  cdaP?: number;
  cdaT?: number;
  /** Set P/T (layer 7b). */
  setP?: number;
  setT?: number;
  /** Modifications (layer 7c). */
  addP: number;
  addT: number;
  addKw: string[];
  removeKw: string[];
  addTypes: string[];
  removeTypes: string[];
}

interface Computed {
  statics: StaticAbility[];
  active: Map<StaticAbility, boolean>;
  mods: Map<string, CardMods>;
}

// ------------------------------------------------------------------ token statics

/** Token scripts don't carry S: lines in scripts.json; the few that matter, keyed by token oracle text. */
const TOKEN_STATICS: Record<string, { statics: string[]; svars: Record<string, string> }> = {
  'This creature gets +1/+1 for each artifact you control.': {
    statics: ['Mode$ Continuous | Affected$ Card.Self | AddPower$ X | AddToughness$ X | Description$ This creature gets +1/+1 for each artifact you control.'],
    svars: { X: 'Count$Valid Artifact.YouCtrl' },
  },
};

// ------------------------------------------------------------------ helpers

const CARD_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Kindred', 'Land', 'Planeswalker', 'Sorcery', 'Tribal'];
const KW_CANON: Record<string, string> = {
  'first strike': 'First strike', 'double strike': 'Double strike', flying: 'Flying', deathtouch: 'Deathtouch', lifelink: 'Lifelink',
  trample: 'Trample', vigilance: 'Vigilance', haste: 'Haste', reach: 'Reach', menace: 'Menace', hexproof: 'Hexproof',
  indestructible: 'Indestructible', defender: 'Defender', infect: 'Infect', shroud: 'Shroud', prowess: 'Prowess',
};

/** Forge keyword ("First Strike", "Ward:1", "Protection:Instant:instants") -> display keyword. */
function canonKeyword(k: string): string {
  const t = k.trim();
  const prot = /^Protection:[^:]*:(.+)$/.exec(t);
  if (prot) return `Protection from ${prot[1]}`;
  const head = t.split(':')[0].trim();
  return KW_CANON[head.toLowerCase()] ?? head;
}

/** Keywords we can't represent (chosen players, zone keywords, player keywords). */
function keywordSupported(k: string): boolean {
  return !/ChosenPlayer|PlayerUID|^Escape|^UntapAdjust|^Retrace|^HIDDEN/.test(k.trim());
}

function counterKind(forge: string): string {
  const t = forge.trim().toUpperCase();
  if (t === 'P1P1') return '+1/+1';
  if (t === 'M1M1') return '-1/-1';
  return t.toLowerCase();
}

function nameText(text: string, cardName: string): string {
  return text.replace(/CARDNAME/g, cardName).replace(/NICKNAME/g, cardName.split(',')[0]).trim();
}

function visible(st: StaticsState, iid: string): CardInstance | undefined {
  const c = st.cards[iid];
  return c && !isHidden(c) ? c : undefined;
}

function handSize(st: StaticsState, pid: string): number {
  const p = st.players.find((x) => x.pid === pid);
  if (!p) return 0;
  return p.handCount ?? p.zones.hand?.length ?? 0;
}

function hasWord(typeLine: string, w: string): boolean {
  return typeLine.split(/[\s—-]+/).some((x) => x.toLowerCase() === w.toLowerCase());
}

function cmp(a: number, op: string, b: number): boolean {
  switch (op) {
    case 'LT': return a < b;
    case 'LE': return a <= b;
    case 'EQ': return a === b;
    case 'NE': return a !== b;
    case 'GE': return a >= b;
    case 'GT': return a > b;
  }
  return false;
}

// ------------------------------------------------------------------ static abilities in play

function staticsOfCard(c: CardInstance, lookup: Lookup): StaticAbility[] {
  if (c.faceDown) return [];
  let lines: string[] = [], svars: Record<string, string> = {}, name = '';
  const ref = scriptRef(c); // copies use the copied card's script (engine/copy.ts)
  const tok = c.zone === 'battlefield' && c.copyToken ? c.copyToken : c.token && !c.cardId ? c.token : undefined;
  if (ref) {
    const face = getScript(ref.cardId)?.[ref.face];
    if (face) { lines = face.statics; svars = face.svars; name = face.name; }
  } else if (tok && !c.animations?.some((a) => a.removeAllAbilities)) {
    const t = TOKEN_STATICS[tok.oracle.trim()];
    if (t) { lines = t.statics; svars = t.svars; name = tok.name; }
  }
  void lookup;
  const make = (line: string, sv: Record<string, string>, nm: string): StaticAbility => {
    const { params } = parseParams(line);
    return {
      sourceIid: c.iid, controller: c.controller, modes: (params.Mode ?? '').split(',').map((m) => m.trim()).filter(Boolean),
      params, svars: sv, line, description: nameText(params.Description ?? params.Mode ?? 'Static ability', nm),
    };
  };
  // + statics granted by animate effects (engine/animate.ts)
  return [...lines.map((line) => make(line, svars, name)), ...grantedLines(c, 'statics').map((g) => make(g.line, g.svars, g.faceName))];
}

/** Static abilities functioning on the battlefield. */
function battlefieldStatics(st: StaticsState, lookup: Lookup): StaticAbility[] {
  const out: StaticAbility[] = [];
  for (const iid of st.battlefield) {
    const c = visible(st, iid);
    if (!c) continue;
    for (const s of staticsOfCard(c, lookup)) {
      const ez = s.params.EffectZone;
      if (ez && ez !== 'All' && !ez.split(',').includes('Battlefield')) continue;
      if (s.params.ExcludeZone?.split(',').includes('Battlefield')) continue;
      out.push(s);
    }
  }
  out.push(...effectStatics(st));
  return out;
}

/** Static abilities of Effect records (emblems, "this turn" effects), engine/effects.ts. */
function effectStatics(st: StaticsState): StaticAbility[] {
  const out: StaticAbility[] = [];
  for (const e of st.effects ?? []) {
    if (e.kind !== 'effect' || !e.statics.length) continue;
    const f = getScript(e.cardId)?.[e.face];
    if (!f) continue;
    for (const name of e.statics) {
      const line = f.svars[name];
      if (!line) continue;
      const { params } = parseParams(line);
      out.push({
        sourceIid: `effect:${e.id}`, controller: e.controller, modes: (params.Mode ?? '').split(',').map((m) => m.trim()).filter(Boolean),
        params, svars: f.svars, line, description: nameText((params.Description ?? e.text).replace(/EFFECTSOURCE/g, f.name), f.name), sourceName: e.name, remembered: e.remembered,
      });
    }
  }
  return out;
}

/** Effect records without static abilities (trigger-only emblems ...), for the active effects list. */
function effectEntries(st: StaticsState): ActiveStatic[] {
  return (st.effects ?? []).filter((e): e is EffectRecord => e.kind === 'effect' && !e.statics.length)
    .map((e) => ({ sourceIid: `effect:${e.id}`, description: e.text, mode: e.emblem ? 'Emblem' : 'Effect', support: 'full' as const, sourceName: e.name }));
}

// ------------------------------------------------------------------ variables & conditions

class Evaluator {
  constructor(private st: StaticsState, private lookup: Lookup, private withPT: boolean) {}

  env(s: StaticAbility): MatchEnv {
    const env: MatchEnv = { controller: s.controller, sourceIid: s.sourceIid, lookup: this.lookup, num: (n) => this.value(s, n) };
    const src = visible(this.st, s.sourceIid);
    if (src) env.chosen = src.chosen ?? {};
    if (s.remembered) env.remembered = s.remembered;
    if (this.withPT) {
      env.pt = (c) => effectivePT(c, this.lookup, this.st);
      env.kw = (c, k) => hasKeyword(c, this.lookup, k, this.st);
    }
    return env;
  }

  /** Cards in a zone across all players (hidden cards skipped). */
  zoneCards(zone: string): CardInstance[] {
    if (zone === 'battlefield') return this.st.battlefield.map((i) => visible(this.st, i)).filter((c): c is CardInstance => !!c);
    return this.st.players.flatMap((p) => (p.zones[zone] ?? []).map((i) => visible(this.st, i)).filter((c): c is CardInstance => !!c));
  }

  count(s: StaticAbility, zone: string, valid: string): number {
    const env = this.env(s);
    return this.zoneCards(zone).filter((c) => matchCard(c, valid, env) === true).length;
  }

  cardTypes(s: StaticAbility, zone: string, valid: string): number {
    const env = this.env(s);
    const types = new Set<string>();
    for (const c of this.zoneCards(zone)) {
      if (matchCard(c, valid, env) !== true) continue;
      const data = c.cardId ? this.lookup(c.cardId) : undefined;
      // Split cards have both halves' types in every zone but the stack; other multi-face cards use the front face.
      const lines = data?.layout === 'split' && data.faces ? data.faces.map((f) => f.typeLine) : [data?.typeLine ?? faceOf(c, this.lookup).typeLine];
      for (const line of lines) for (const t of CARD_TYPES) if (hasWord(line.split(/\s+[—-]\s+/)[0], t)) types.add(t === 'Tribal' ? 'Kindred' : t);
    }
    return types.size;
  }

  /** Evaluate a number, SVar name or Forge count expression. undefined = unsupported. */
  value(s: StaticAbility, raw: string | undefined, depth = 0): number | undefined {
    if (raw == null || depth > 8) return undefined;
    let v = raw.trim();
    let sign = 1;
    if (v.startsWith('+')) v = v.slice(1);
    else if (v.startsWith('-')) { sign = -1; v = v.slice(1); }
    if (/^\d+$/.test(v)) return sign * parseInt(v, 10);
    if (s.svars[v] != null) { const n = this.value(s, s.svars[v], depth + 1); return n == null ? undefined : sign * n; }
    const n = this.expr(s, v, depth);
    return n == null ? undefined : sign * n;
  }

  private expr(s: StaticAbility, e: string, depth: number): number | undefined {
    const math = /^(.*?)\/(Plus|Minus|Times|Twice|Negative|HalfUp|HalfDown)(?:\.(-?\w+))?$/.exec(e);
    if (math) {
      const base = this.expr(s, math[1], depth);
      if (base == null) return undefined;
      const arg = math[3] != null ? this.value(s, math[3], depth + 1) : 0;
      if (arg == null) return undefined;
      switch (math[2]) {
        case 'Plus': return base + arg;
        case 'Minus': return base - arg;
        case 'Times': return base * arg;
        case 'Twice': return base * 2;
        case 'Negative': return -base;
        case 'HalfUp': return Math.ceil(base / 2);
        case 'HalfDown': return Math.floor(base / 2);
      }
    }
    let m: RegExpExecArray | null;
    if ((m = /^Number\$(-?\d+)$/.exec(e))) return parseInt(m[1], 10);
    if ((m = /^SVar\$(\w+)$/.exec(e))) return this.value(s, m[1], depth + 1);
    const src = visible(this.st, s.sourceIid);
    if ((m = /^(Count|Equipped|Enchanted)\$CardCounters\.(\w+)$/.exec(e))) {
      const c = m[1] === 'Count' ? src : src?.attachedTo ? visible(this.st, src.attachedTo) : undefined;
      if (!c) return 0;
      if (m[2] === 'ALL') return Object.entries(c.counters).reduce((a, [, n]) => a + Math.max(0, n), 0);
      return c.counters[counterKind(m[2])] ?? 0;
    }
    if ((m = /^Count\$Valid(Graveyard|Exile|Battlefield)? (.+?)(\$CardTypes)?$/.exec(e))) {
      const zone = (m[1] ?? 'Battlefield').toLowerCase();
      return m[3] ? this.cardTypes(s, zone, m[2]) : this.count(s, zone, m[2]);
    }
    if ((m = /^Count\$ValidHand (.+)$/.exec(e))) {
      if (m[1] === 'Card.YouOwn' || m[1] === 'Card.YouCtrl') return handSize(this.st, s.controller);
      const p = this.st.players.find((x) => x.pid === s.controller);
      const ids = p?.zones.hand ?? [];
      if (ids.some((i) => !visible(this.st, i))) return undefined;
      const env = this.env(s);
      return ids.filter((i) => matchCard(visible(this.st, i)!, m![1], env) === true).length;
    }
    switch (e) {
      case 'Count$CardsInYourHand': return handSize(this.st, s.controller);
      case 'Count$YourLifeTotal': return this.st.players.find((p) => p.pid === s.controller)?.life;
      case 'Count$Domain': {
        const env = this.env(s);
        const lands = this.zoneCards('battlefield').filter((c) => c.controller === s.controller && matchCard(c, 'Land', env) === true);
        return ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'].filter((b) => lands.some((c) => hasWord(faceOf(c, this.lookup).typeLine, b))).length;
      }
      case 'PlayerCountOpponents$LowestLifeTotal':
      case 'PlayerCountOpponents$HighestLifeTotal': {
        const lifes = this.st.players.filter((p) => p.pid !== s.controller).map((p) => p.life);
        if (!lifes.length) return 0;
        return e.endsWith('Lowest') || e.endsWith('LowestLifeTotal') ? Math.min(...lifes) : Math.max(...lifes);
      }
    }
    return undefined;
  }

  /** Is the static's condition met? 'unknown' if it can't be evaluated. */
  active(s: StaticAbility): Tri {
    const p = s.params;
    let r: Tri = true;
    if (p.Condition) {
      const gy = this.st.players.find((x) => x.pid === s.controller)?.zones.graveyard ?? [];
      switch (p.Condition) {
        case 'PlayerTurn': r = this.st.activePlayer == null ? 'unknown' : this.st.activePlayer === s.controller; break;
        case 'NotPlayerTurn': r = this.st.activePlayer == null ? 'unknown' : this.st.activePlayer !== s.controller; break;
        case 'Delirium': r = this.cardTypes(s, 'graveyard', 'Card.YouOwn') >= 4; break;
        case 'Threshold': r = gy.length >= 7; break;
        default: return 'unknown';
      }
      if (r === false) return false;
    }
    if (p.IsPresent) {
      const zone = (p.PresentZone ?? 'Battlefield').toLowerCase();
      const n = this.count(s, zone, p.IsPresent);
      const cm = /^(LT|LE|EQ|NE|GE|GT)(.+)$/.exec(p.PresentCompare ?? 'GE1');
      const right = cm ? this.value(s, cm[2]) : undefined;
      if (!cm || right == null) return 'unknown';
      if (!cmp(n, cm[1], right)) return false;
    }
    if (p.CheckSVar) {
      const left = this.value(s, p.CheckSVar);
      const cm = /^(LT|LE|EQ|NE|GE|GT)(.+)$/.exec(p.SVarCompare ?? 'GE1');
      const right = cm ? this.value(s, cm[2]) : undefined;
      if (left == null || right == null || !cm) return 'unknown';
      if (!cmp(left, cm[1], right)) return false;
    }
    return r;
  }
}

// ------------------------------------------------------------------ continuous effects

const PLAYER_AFFECTED = /^(You|Player|Opponent)(\.|$|,)/;

function affectedCards(st: StaticsState, ev: Evaluator, s: StaticAbility): CardInstance[] {
  const p = s.params;
  const src = visible(st, s.sourceIid);
  let cands: CardInstance[];
  if (!p.AffectedDefined && !p.Affected && p.CharacteristicDefining === 'True') return src ? [src] : [];
  if (p.AffectedDefined) {
    if (p.AffectedDefined === 'Self') cands = src ? [src] : [];
    else if (p.AffectedDefined === 'Equipped' || p.AffectedDefined === 'Enchanted') {
      const t = src?.attachedTo ? visible(st, src.attachedTo) : undefined;
      cands = t && t.zone === 'battlefield' ? [t] : [];
    } else return [];
  } else cands = ev.zoneCards('battlefield');
  if (!p.Affected) return p.AffectedDefined ? cands : [];
  if (PLAYER_AFFECTED.test(p.Affected)) return [];
  const env = ev.env(s);
  return cands.filter((c) => matchCard(c, p.Affected, env) === true);
}

function emptyMods(): CardMods { return { addP: 0, addT: 0, addKw: [], removeKw: [], addTypes: [], removeTypes: [] }; }

function compute(st: StaticsState, lookup: Lookup): Computed {
  const statics = battlefieldStatics(st, lookup);
  const ev = new Evaluator(st, lookup, false);
  const active = new Map<StaticAbility, boolean>();
  const mods = new Map<string, CardMods>();
  for (const s of statics) {
    const on = ev.active(s) === true;
    active.set(s, on);
    if (!on || !s.modes.includes('Continuous')) continue;
    const p = s.params;
    if (p.AffectedZone && p.AffectedZone !== 'Battlefield') continue;
    const targets = affectedCards(st, ev, s);
    if (!targets.length) continue;
    const num = (k: string) => (p[k] != null ? ev.value(s, p[k]) : undefined);
    const ap = num('AddPower'), at = num('AddToughness'), sp = num('SetPower'), stt = num('SetToughness');
    const cda = p.CharacteristicDefining === 'True';
    const addKw = p.AddKeyword ? p.AddKeyword.split('&').filter(keywordSupported).map(canonKeyword) : [];
    const rmKw = p.RemoveKeyword ? p.RemoveKeyword.split('&').map(canonKeyword) : [];
    const addTypes = p.AddType ? p.AddType.split('&').map((x) => x.trim()) : [];
    const rmTypes = p.RemoveType ? p.RemoveType.split('&').map((x) => x.trim()) : [];
    for (const c of targets) {
      const m = mods.get(c.iid) ?? emptyMods();
      if (cda) { if (sp != null) m.cdaP = sp; if (stt != null) m.cdaT = stt; } else { if (sp != null) m.setP = sp; if (stt != null) m.setT = stt; }
      m.addP += ap ?? 0; m.addT += at ?? 0;
      m.addKw.push(...addKw); m.removeKw.push(...rmKw);
      m.addTypes.push(...addTypes); m.removeTypes.push(...rmTypes);
      if (p.RemoveCardTypes === 'True') m.removeTypes.push(...CARD_TYPES.filter((t) => !addTypes.includes(t)));
      mods.set(c.iid, m);
    }
  }
  return { statics, active, mods };
}

const cache = new WeakMap<object, { sig: string; lookup: Lookup; result: Computed }>();

function signature(st: StaticsState): string {
  const bf = st.battlefield.map((i) => {
    const c = st.cards[i];
    if (!c || isHidden(c)) return `${i}:h:${c?.controller}`;
    return [i, c.cardId ?? c.token?.name, c.controller, c.owner, c.tapped ? 1 : 0, c.faceDown ? 1 : 0, c.transformed ? 1 : 0, c.attachedTo ?? '',
      JSON.stringify(c.counters), c.tempPT.join(','), c.permPT.join(','), c.attacking ?? '', c.blocking ?? '', (c.tempKeywords ?? []).join(','), c.note ?? '',
      c.copyOf ?? c.copyToken?.name ?? '', (c.animations ?? []).map((a) => a.id).join(','), c.chosen ? JSON.stringify(c.chosen) : '', c.copyExtra ? JSON.stringify(c.copyExtra) : ''].join(':');
  });
  const pl = st.players.map((p) => `${p.pid}:${p.life}:${handSize(st, p.pid)}:${(p.zones.graveyard ?? []).join(',')}:${(p.zones.exile ?? []).length}`);
  const fx = (st.effects ?? []).map((e) => (e.kind === 'effect' ? `${e.id}:${e.remembered.join(',')}` : '')).join(',');
  return `${st.activePlayer}|${st.turn}|${bf.join(';')}|${pl.join(';')}|${fx}`;
}

function computed(st: StaticsState, lookup: Lookup): Computed {
  const sig = signature(st);
  const hit = cache.get(st);
  if (hit && hit.sig === sig && hit.lookup === lookup) return hit.result;
  const result = compute(st, lookup);
  cache.set(st, { sig, lookup, result });
  return result;
}

/** Continuous-effect modifications to a permanent (undefined when none apply). */
export function staticMods(st: StaticsState, iid: string, lookup: Lookup): CardMods | undefined {
  const c = st.cards[iid];
  if (!c || isHidden(c) || c.zone !== 'battlefield') return undefined;
  return computed(st, lookup).mods.get(iid);
}

// ------------------------------------------------------------------ support classification

const HANDLED_CONDITIONS = new Set(['PlayerTurn', 'NotPlayerTurn', 'Delirium', 'Threshold']);
const CONT_HANDLED_KEYS = new Set([
  'Mode', 'Affected', 'AffectedDefined', 'AddPower', 'AddToughness', 'SetPower', 'SetToughness', 'CharacteristicDefining',
  'AddKeyword', 'RemoveKeyword', 'AddType', 'RemoveType', 'RemoveCardTypes', 'Condition', 'IsPresent', 'PresentCompare', 'PresentZone',
  'CheckSVar', 'SVarCompare', 'EffectZone', 'Description', 'AddSVar', 'Secondary', 'AffectedZone',
]);
const ENFORCED_MODES = new Set(['CantBeCast', 'CantAttack', 'CantBlock', 'CantBlockBy', 'RaiseCost', 'ReduceCost', 'CantPreventDamage', 'CantBeActivated']);
/** Modes that are listed and logged as reminders. */
const REMINDER_MODES = new Set(['MustAttack', 'MinMaxBlocker', 'CantDraw']);

function exprSupported(s: StaticAbility, raw: string | undefined): boolean {
  if (raw == null) return true;
  const st: StaticsState = { battlefield: [], cards: {}, players: [], activePlayer: '' };
  return new Evaluator(st, () => undefined, false).value(s, raw) != null;
}

/** Why parts of a static aren't handled (empty = fully handled). */
export function staticGaps(s: Pick<StaticAbility, 'params' | 'svars' | 'modes'> & Partial<StaticAbility>): string[] {
  const full = { sourceIid: '', controller: '', description: '', line: '', ...s } as StaticAbility;
  const p = s.params;
  const gaps: string[] = [];
  if (p.Condition && !HANDLED_CONDITIONS.has(p.Condition)) gaps.push(`Condition$ ${p.Condition}`);
  if (p.CheckSVar && !exprSupported(full, p.CheckSVar)) gaps.push(`CheckSVar$ ${p.CheckSVar}`);
  for (const mode of s.modes) {
    if (mode === 'Continuous') {
      for (const k of Object.keys(p)) if (!CONT_HANDLED_KEYS.has(k)) gaps.push(k);
      if (p.AffectedZone && p.AffectedZone !== 'Battlefield') gaps.push(`AffectedZone$ ${p.AffectedZone}`);
      if (p.Affected && PLAYER_AFFECTED.test(p.Affected)) gaps.push('player effect');
      if (p.Affected && /ChosenPlayer|ChosenCard|Remembered|ExiledWith|TopLibrary/.test(p.Affected)) gaps.push(`Affected$ ${p.Affected}`);
      if (p.AffectedDefined && !['Self', 'Equipped', 'Enchanted'].includes(p.AffectedDefined)) gaps.push(`AffectedDefined$ ${p.AffectedDefined}`);
      if (p.AddKeyword?.split('&').some((k) => !keywordSupported(k))) gaps.push('AddKeyword (special)');
      else if (p.AddKeyword && /Protection|Ward/.test(p.AddKeyword)) gaps.push('Protection/Ward (shown, not enforced)');
      if (p.AddType && p.AddType.split('&').some((t) => t.trim() !== 'Creature' && !/^[A-Z][a-z]+$/.test(t.trim()))) gaps.push(`AddType$ ${p.AddType}`);
      if (p.AddType && /AllBasicLandType/.test(p.AddType)) gaps.push('AddType$ AllBasicLandType');
      for (const k of ['AddPower', 'AddToughness', 'SetPower', 'SetToughness']) if (!exprSupported(full, p[k])) gaps.push(`${k}$ ${p[k]}`);
    } else if (mode === 'RaiseCost' || mode === 'ReduceCost') {
      if (!['Spell', 'Ability'].includes(costKind(p))) gaps.push(`Type$ ${p.Type}`);
      if (p.Cost || p.Color) gaps.push('colored cost change');
      if (!exprSupported(full, p.Amount ?? '1')) gaps.push(`Amount$ ${p.Amount}`);
    } else if (mode === 'CantBeCast') {
      if (p.Caster && !['You', 'Opponent'].includes(p.Caster)) gaps.push(`Caster$ ${p.Caster}`);
    } else if (!ENFORCED_MODES.has(mode)) gaps.push(REMINDER_MODES.has(mode) ? `${mode} (reminder)` : mode);
  }
  return gaps;
}

export function staticSupport(s: Pick<StaticAbility, 'params' | 'svars' | 'modes'>): StaticSupport {
  const gaps = staticGaps(s);
  if (!gaps.length) return 'full';
  const applied = s.modes.some((m) => m === 'Continuous' && (s.params.AddPower || s.params.AddToughness || s.params.SetPower || s.params.SetToughness || s.params.AddKeyword))
    && !gaps.some((g) => /^Condition|^CheckSVar|^AffectedZone|player effect|^Affected\$|^AffectedDefined/.test(g));
  return applied ? 'partial' : 'none';
}

/** Parse a Forge S: line (for coverage tools / tests). */
export function parseStatic(line: string, svars: Record<string, string> = {}): Pick<StaticAbility, 'params' | 'svars' | 'modes' | 'line'> {
  const { params } = parseParams(line);
  return { params, svars, line, modes: (params.Mode ?? '').split(',').map((m) => m.trim()).filter(Boolean) };
}

// ------------------------------------------------------------------ public queries

/** Static abilities currently in effect (conditions met), for an "Active effects" panel. */
export function activeStatics(st: StaticsState, lookup: Lookup): ActiveStatic[] {
  const c = computed(st, lookup);
  return [...c.statics.filter((s) => c.active.get(s) !== false).map((s) => ({
    sourceIid: s.sourceIid, description: s.description, mode: s.modes.join(','), support: staticSupport(s), ...(s.sourceName ? { sourceName: s.sourceName } : {}),
  })), ...effectEntries(st)];
}

function active(st: StaticsState, lookup: Lookup, mode: string): { s: StaticAbility; ev: Evaluator }[] {
  const c = computed(st, lookup);
  const ev = new Evaluator(st, lookup, true);
  return c.statics.filter((s) => s.modes.includes(mode) && ev.active(s) === true).map((s) => ({ s, ev }));
}

function srcName(st: StaticsState, s: StaticAbility, lookup: Lookup): string {
  if (s.sourceName) return s.sourceName;
  const c = visible(st, s.sourceIid);
  return c ? faceOf(c, lookup).name : 'A static ability';
}

/** Why `iid` can't attack right now (static restrictions + defender), or null. */
export function attackRestriction(st: StaticsState, iid: string, lookup: Lookup): string | null {
  const c = visible(st, iid);
  if (!c) return null;
  if (hasKeyword(c, lookup, 'Defender', st)) return `${faceOf(c, lookup).name} has defender and can't attack`;
  for (const mode of ['CantAttack']) {
    for (const { s, ev } of active(st, lookup, mode)) {
      if (s.params.ValidCard && matchCard(c, s.params.ValidCard, ev.env(s)) === true) {
        return `${faceOf(c, lookup).name} can't attack (${srcName(st, s, lookup)}: ${s.description})`;
      }
    }
  }
  return null;
}

/** Why `blocker` can't block `attacker` (static restrictions), or null. */
export function blockRestriction(st: StaticsState, blocker: string, attacker: string, lookup: Lookup): string | null {
  const b = visible(st, blocker);
  const a = visible(st, attacker);
  if (!b) return null;
  const bn = faceOf(b, lookup).name;
  for (const { s, ev } of active(st, lookup, 'CantBlock')) {
    if (s.params.ValidCard && matchCard(b, s.params.ValidCard, ev.env(s)) === true) return `${bn} can't block (${srcName(st, s, lookup)}: ${s.description})`;
  }
  if (!a) return null;
  for (const { s, ev } of active(st, lookup, 'CantBlockBy')) {
    const env = ev.env(s);
    const okA = !s.params.ValidAttacker || matchCard(a, s.params.ValidAttacker, env) === true;
    const okB = !s.params.ValidBlocker || matchCard(b, s.params.ValidBlocker, env) === true;
    if (okA && okB) return `${bn} can't block ${faceOf(a, lookup).name} (${srcName(st, s, lookup)}: ${s.description})`;
  }
  return null;
}

/**
 * Why `pid` can't activate an ability of `iid` (CantBeActivated statics, e.g. Phyrexian Revoker's chosen name), or null.
 * `mana`: the ability is a mana ability (NonMana$ True statics don't stop those).
 */
export function activateRestriction(st: StaticsState, iid: string, pid: string, lookup: Lookup, mana = false): string | null {
  const c = visible(st, iid);
  if (!c) return null;
  for (const { s, ev } of active(st, lookup, 'CantBeActivated')) {
    const p = s.params;
    if (mana && p.NonMana === 'True') continue;
    if (p.Activator === 'Opponent' && pid === s.controller) continue;
    if (p.Activator === 'You' && pid !== s.controller) continue;
    if (p.ValidCard && matchCard(c, p.ValidCard, ev.env(s)) !== true) continue;
    return `${srcName(st, s, lookup)}: ${s.description || "that ability can't be activated"}`;
  }
  return null;
}

/** Why `pid` can't cast `iid` right now (CantBeCast statics), or null. */
export function castRestriction(st: StaticsState, iid: string, pid: string, lookup: Lookup): string | null {
  const c = visible(st, iid);
  if (!c) return null;
  for (const { s, ev } of active(st, lookup, 'CantBeCast')) {
    const p = s.params;
    if (p.Caster === 'Opponent' && pid === s.controller) continue;
    if (p.Caster === 'You' && pid !== s.controller) continue;
    if (p.ValidCard && matchCard(c, p.ValidCard, ev.env(s)) !== true) continue;
    if (p.OnlySorcerySpeed === 'True') {
      const sorcery = st.activePlayer === pid && (st.step === 'main1' || st.step === 'main2') && !(st.stack?.length);
      if (sorcery) continue;
      return `${srcName(st, s, lookup)}: you can cast spells only any time you could cast a sorcery`;
    }
    return `${srcName(st, s, lookup)}: ${s.description || "you can't cast that spell"}`;
  }
  return null;
}

/** Reminder lines for statics that aren't enforced (MustAttack, MinMaxBlocker) at the given combat point. */
export function combatReminders(st: StaticsState, lookup: Lookup, when: 'attackers' | 'blockers'): string[] {
  const out: string[] = [];
  if (when === 'attackers') {
    for (const { s, ev } of active(st, lookup, 'MustAttack')) {
      const env = ev.env(s);
      for (const iid of st.battlefield) {
        const c = visible(st, iid);
        if (!c || c.attacking || c.tapped || c.controller !== st.activePlayer) continue;
        if (s.params.ValidCreature && matchCard(c, s.params.ValidCreature, env) === true) out.push(`Reminder: ${faceOf(c, lookup).name} attacks each combat if able.`);
      }
    }
  } else {
    for (const { s, ev } of active(st, lookup, 'MinMaxBlocker')) {
      const env = ev.env(s);
      const min = parseInt(s.params.Min ?? '0', 10) || 0;
      for (const iid of st.battlefield) {
        const c = visible(st, iid);
        if (!c?.attacking || !s.params.ValidCard || matchCard(c, s.params.ValidCard, env) !== true) continue;
        const n = st.battlefield.filter((b) => visible(st, b)?.blocking === iid).length;
        if (n > 0 && n < min) out.push(`Reminder: ${faceOf(c, lookup).name} can't be blocked except by ${min} or more creatures.`);
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ costs

/** RaiseCost / ReduceCost applies to spells or activated abilities (Type$, or ValidSpell$ Activated...). */
function costKind(p: Record<string, string>): string {
  return p.Type ?? (/^Activated/.test(p.ValidSpell ?? '') ? 'Ability' : 'Spell');
}

function changeGeneric(cost: string, delta: number, minMana: number): string {
  const syms = parseManaSymbols(cost);
  let generic = 0;
  const rest: string[] = [];
  for (const s of syms) {
    if (/^\d+$/.test(s)) generic += parseInt(s, 10);
    else rest.push(s);
  }
  let g = Math.max(0, generic + delta);
  if (delta < 0) {
    const others = rest.filter((s) => s !== 'X').length;
    g = Math.max(g, Math.min(generic, Math.max(0, minMana - others)));
  }
  const xs = rest.filter((s) => s === 'X');
  const colored = rest.filter((s) => s !== 'X');
  return [...xs, ...(g > 0 || (!colored.length && !xs.length) ? [String(g)] : []), ...colored].map((s) => `{${s}}`).join('');
}

/**
 * Apply RaiseCost / ReduceCost statics to a mana cost.
 * kind 'Spell': `inst` is the spell being cast (its own EffectZone$ All statics count too). 'Ability': `inst` is the source.
 */
export function adjustCost(st: StaticsState, inst: CardInstance, pid: string, cost: string, kind: 'Spell' | 'Ability', lookup: Lookup): { cost: string; notes: string[] } {
  const c = computed(st, lookup);
  const ev = new Evaluator(st, lookup, true);
  const sources = [...c.statics];
  if (kind === 'Spell' && inst.zone !== 'battlefield') {
    for (const s of staticsOfCard({ ...inst, controller: pid }, lookup)) if (s.params.EffectZone === 'All') sources.push(s);
  }
  let delta = 0;
  let minMana = 0;
  const notes: string[] = [];
  for (const s of sources) {
    const raise = s.modes.includes('RaiseCost');
    if (!raise && !s.modes.includes('ReduceCost')) continue;
    const p = s.params;
    if (costKind(p) !== kind || p.Cost || p.Color) continue;
    if (ev.active(s) !== true) continue;
    if (p.Activator === 'You' && pid !== s.controller) continue;
    if (p.Activator === 'Opponent' && pid === s.controller) continue;
    if (p.ValidCard && matchCard(inst, p.ValidCard, ev.env(s)) !== true) continue;
    const n = ev.value(s, p.Amount ?? '1');
    if (!n) continue;
    delta += raise ? n : -n;
    if (p.MinMana) minMana = Math.max(minMana, parseInt(p.MinMana, 10) || 0);
    notes.push(`${srcName(st, s, lookup)} ${raise ? '+' : '-'}{${n}}`);
  }
  if (!delta) return { cost, notes: [] };
  return { cost: changeGeneric(cost, delta, minMana), notes };
}

/** Printed mana cost of a face (0 front, 1 back / adventure / second half). */
export function faceManaCost(inst: CardInstance, face: number, lookup: Lookup): string {
  const data = inst.cardId ? lookup(inst.cardId) : undefined;
  if (!data) return '';
  if (data.faces && face > 0 && data.faces[face]) return data.faces[face].manaCost;
  if (data.faces && data.layout === 'split') return data.faces[0].manaCost;
  if (data.faces && ['modal_dfc', 'transform', 'adventure'].includes(data.layout ?? '')) return data.faces[0].manaCost || data.manaCost;
  return data.manaCost;
}

/** The mana cost a player would pay to cast `iid` (as `face`) right now, after cost increases/reductions. */
export function effectiveCost(st: StaticsState, iid: string, face: number, lookup: Lookup, pid?: string): string {
  const c = visible(st, iid);
  if (!c) return '';
  const base = faceManaCost(c, face, lookup);
  if (!base) return base;
  const data = c.cardId ? lookup(c.cardId) : undefined;
  let as: CardInstance = c;
  if (data?.faces && face > 0 && data.faces[face]) {
    as = data.layout === 'modal_dfc' || data.layout === 'transform' ? { ...c, transformed: true } : { ...c, castAs: data.faces[face].name };
  }
  return adjustCost(st, as, pid ?? c.controller, base, 'Spell', lookup).cost;
}

/**
 * True when a permanent's toughness comes from its own fully handled static abilities (CDA or self P/T
 * statics such as a goyf or the Construct token), so a 0 toughness result can be trusted for state-based actions.
 */
export function staticsDefineToughness(st: StaticsState, iid: string, lookup: Lookup): boolean {
  const c = visible(st, iid);
  if (!c || c.faceDown) return false;
  const own = staticsOfCard(c, lookup).filter((s) => s.modes.includes('Continuous') && (s.params.SetToughness || s.params.AddToughness)
    && (s.params.AffectedDefined === 'Self' || /^Card\.Self$/.test(s.params.Affected ?? '') || (s.params.CharacteristicDefining === 'True' && !s.params.Affected)));
  return own.length > 0 && own.every((s) => staticGaps(s).length === 0);
}
