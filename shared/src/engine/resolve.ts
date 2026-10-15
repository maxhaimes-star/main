/**
 * Runs automated stack items: target legality, the effect chain, player decisions (Pending / peek
 * continuations) and state-based actions.
 */
import { cardName, effectivePT, faceOf, hasKeyword, isCreature, payFromPool } from '../game/rules.ts';
import { type Ctx, drawCards, emit, log, moveCard, newInstance, player, randomId, shuffleLibrary } from '../game/state.ts';
import type { CardInstance, GamePlayer, GameState, StackItem, Step, Zone } from '../game/types.ts';
import type { TokenData } from '../cards.ts';
import { chainOf, describe, flatten, PHASES, SCRIPTS, specIndexByStep, supportedVar, targetSpecs, unsupportedReason } from './script.ts';
import { isValidTarget, matchCard, matchPlayer, type MatchEnv, type Tri } from './targets.ts';
import { staticsDefineToughness } from './statics.ts';
import type { AutoCont, AutoInfo, Lki, ParsedAbility, Pending, TargetRef, TargetSpec, TriggerContext } from './types.ts';
import { KEYWORD_APIS } from './keywords.ts';
import { answerKeywordPending, execKeywordStep } from './keyword-play.ts';
import { answerReplacementPending, cantBeCountered, counterAmount, damagePrevented, replaceDraws, tokenEntered, tokenMultiplier } from './replacements.ts';
import { answerCostPending, type CostData } from './costs.ts';
import { conditionTrue, type CountEnv, evalCount } from './counts.ts';
import { addEffect } from './durations.ts';
import { execUniqueStep, type UniqueRun, uniqueVar, answerUniquePending, type PickSpec } from './unique.ts';
import { isSimpleAnimate, uniqueReason } from './unique-support.ts';
import { answerTapCost } from './turns.ts';

// ------------------------------------------------------------------ run context

interface Run extends AutoCont {
  steps: ParsedAbility[];
  specOf: (number | undefined)[];
  svars: Record<string, string>;
  controller: string;
  sourceIid?: string;
  sourceName: string;
  /** Creatures dealt damage by a deathtouch source during this run. */
  deathtouched: string[];
  /** Stage 2: what the trigger saw (triggered abilities only). */
  trig?: TriggerContext;
}

export function abilityFor(auto: AutoInfo): ParsedAbility | undefined {
  return chainOf(auto);
}

function makeRun(state: GameState, ctx: Ctx, cont: AutoCont): Run | undefined {
  const auto = cont.item.auto!;
  const ab = abilityFor(auto);
  if (!ab) return undefined;
  const steps = flatten(ab, auto.modes);
  const sourceIid = cont.item.iid ?? cont.item.sourceIid;
  const src = sourceIid ? state.cards[sourceIid] : undefined;
  const face = SCRIPTS.cards[auto.cardId]?.[auto.face];
  const trig = auto.trigger;
  const lki = trig?.lki ? { ...trig.lki, ...cont.lki } : cont.lki;
  return {
    ...cont, lki, steps, specOf: specIndexByStep(steps), svars: face?.svars ?? {}, controller: cont.item.controller, sourceIid,
    sourceName: src ? cardName(src, ctx.lookup) : face?.name ?? 'It', deathtouched: [], trig,
  };
}

function contAt(r: Run, next: number): AutoCont {
  return JSON.parse(JSON.stringify({ item: r.item, next, targets: r.targets, lki: r.lki, remembered: r.remembered })) as AutoCont;
}

export function lkiOf(c: CardInstance, ctx: Ctx, state?: GameState): Lki {
  const [power, toughness] = effectivePT(c, ctx.lookup, state);
  const data = c.cardId ? ctx.lookup(c.cardId) : undefined;
  return { power, toughness, mv: c.token && !c.cardId ? 0 : data?.cmc ?? 0, controller: c.controller, owner: c.owner, name: cardName(c, ctx.lookup) };
}

const ZONE: Record<string, Zone> = { battlefield: 'battlefield', hand: 'hand', graveyard: 'graveyard', exile: 'exile', library: 'library', stack: 'stack', command: 'command' };
const zoneOf = (forge: string | undefined): Zone | undefined => (forge ? ZONE[forge.trim().toLowerCase()] : undefined);

function names(state: GameState, ctx: Ctx, iids: string[]): string {
  return iids.map((i) => (state.cards[i] ? cardName(state.cards[i], ctx.lookup) : 'a card')).join(', ') || 'nothing';
}

function pname(state: GameState, pid: string): string {
  return state.players.find((p) => p.pid === pid)?.name ?? 'someone';
}

function manual(state: GameState, ctx: Ctx, r: Run, step: ParsedAbility) {
  const what = step.description === step.api ? `${r.sourceName} (${step.api})` : step.description;
  log(state, ctx, r.controller, `Not automated: ${what} — resolve it by hand.`);
}

// ------------------------------------------------------------------ targets & defined objects

function ownTargets(r: Run, i: number): TargetRef[] | undefined {
  const s = r.specOf[i];
  return s == null ? undefined : r.targets[s] ?? [];
}

/** Targets of the nearest step at or before `i` that has targets. */
function parentTargets(r: Run, i: number): TargetRef[] {
  for (let j = i; j >= 0; j--) { const t = ownTargets(r, j); if (t) return t; }
  return [];
}

function split(state: GameState, refs: TargetRef[]): { cards: string[]; players: string[] } {
  const cards: string[] = [], players: string[] = [];
  for (const ref of refs) {
    if (ref.kind === 'card') cards.push(ref.iid);
    else if (ref.kind === 'player') players.push(ref.pid);
    else { const it = state.stack.find((s) => s.id === ref.id); if (it?.iid) cards.push(it.iid); }
  }
  return { cards, players };
}

interface Objs { cards: string[]; players: string[] }

function defined(state: GameState, r: Run, i: number, value: string | undefined): Objs | undefined {
  const live = state.players.filter((p) => !p.conceded).map((p) => p.pid);
  const tgt = () => split(state, parentTargets(r, i));
  const ctrlOf = (iid: string) => r.lki[iid]?.controller ?? state.cards[iid]?.controller;
  const ownerOf = (iid: string) => r.lki[iid]?.owner ?? state.cards[iid]?.owner;
  const src = r.sourceIid ? state.cards[r.sourceIid] : undefined;
  switch (value) {
    case 'You': return { cards: [], players: [r.controller] };
    case 'Self': case 'Parent': return { cards: r.sourceIid && src ? [r.sourceIid] : [], players: [] };
    case 'Targeted': case 'TargetedCard': return tgt();
    case 'ParentTarget': return split(state, i > 0 ? parentTargets(r, i - 1) : []);
    case 'TargetedPlayer': return { cards: [], players: tgt().players };
    case 'TargetedAndYou': return { cards: [], players: [...new Set([...tgt().players, r.controller])] };
    case 'TargetedController': {
      const t = parentTargets(r, i);
      const ps = t.map((ref) => (ref.kind === 'card' ? ctrlOf(ref.iid) : ref.kind === 'player' ? ref.pid : r.lki[ref.id]?.controller ?? state.stack.find((s) => s.id === ref.id)?.controller));
      return { cards: [], players: [...new Set(ps.filter((x): x is string => !!x))] };
    }
    case 'TargetedOwner': {
      const ps = tgt().cards.map(ownerOf);
      return { cards: [], players: [...new Set(ps.filter((x): x is string => !!x))] };
    }
    case 'Player': return { cards: [], players: live };
    case 'Opponent': case 'Player.Opponent': return { cards: [], players: live.filter((p) => p !== r.controller) };
    case 'Remembered': case 'RememberedLKI': {
      // The run's own memory, else what the permanent remembered earlier (e.g. Journey to Nowhere's exiled card).
      const mem = r.remembered.length ? r.remembered : (r.sourceIid && r.item.kind !== 'spell' ? state.remembered?.[r.sourceIid] ?? [] : []);
      return { cards: [...mem], players: [] };
    }
    case 'Enchanted': case 'Equipped': return { cards: src?.attachedTo ? [src.attachedTo] : [], players: [] };
  }
  // Stage 2: objects the trigger saw.
  const t = r.trig;
  if (t && value?.startsWith('Triggered')) {
    const isPlayer = (id: string | undefined) => !!id && state.players.some((p) => p.pid === id);
    const cardIds = (id: string | undefined) => (id && !isPlayer(id) && (state.cards[id] || r.lki[id]) ? [id] : []);
    const players = (...ids: (string | undefined)[]) => [...new Set(ids.filter((x): x is string => !!x && isPlayer(x)))];
    const ctrl = (id: string | undefined) => (id ? (r.lki[id]?.controller ?? state.cards[id]?.controller) : undefined);
    switch (value) {
      case 'TriggeredCard': case 'TriggeredCardLKICopy': case 'TriggeredNewCardLKICopy': return { cards: cardIds(t.card).filter((x) => state.cards[x]), players: [] };
      case 'TriggeredSource': return { cards: cardIds(t.source).filter((x) => state.cards[x]), players: [] };
      case 'TriggeredCardController': return { cards: [], players: players(t.card ? ctrl(t.card) : t.player) };
      case 'TriggeredCardOwner': return { cards: [], players: players(t.card ? (r.lki[t.card]?.owner ?? state.cards[t.card]?.owner) : undefined) };
      case 'TriggeredPlayer': case 'TriggeredActivator': case 'TriggeredAttackingPlayer': return { cards: [], players: players(t.player) };
      case 'TriggeredDefendingPlayer': return { cards: [], players: players(t.defender) };
      case 'TriggeredSourceController': return { cards: [], players: players(ctrl(t.source)) };
      case 'TriggeredTarget': return isPlayer(t.target) ? { cards: [], players: players(t.target) } : { cards: cardIds(t.target), players: [] };
    }
  }
  if (value === 'DelayTriggerRemembered' || value === 'DelayTriggerRememberedLKI') return { cards: [...(t?.remembered ?? [])], players: [] };
  return undefined;
}

/** Objects a step acts on: its own targets, else Defined$, else the default. */
function objects(state: GameState, r: Run, i: number, dflt: 'You' | 'Self'): Objs | undefined {
  const step = r.steps[i];
  const own = ownTargets(r, i);
  if (own) return split(state, own);
  return defined(state, r, i, step.params.Defined ?? dflt);
}

// ------------------------------------------------------------------ amounts & conditions

function firstCardTarget(r: Run): string | undefined {
  for (const list of r.targets) for (const ref of list) if (ref.kind === 'card') return ref.iid;
  for (const list of r.targets) for (const ref of list) if (ref.kind === 'stack' && r.lki[ref.id]) return ref.id;
  return undefined;
}

function countEnv(state: GameState, ctx: Ctx, r: Run): CountEnv {
  const src = r.sourceIid ? state.cards[r.sourceIid] : undefined;
  const auto = r.item.auto;
  return {
    state, lookup: ctx.lookup, controller: r.controller, sourceIid: r.sourceIid, x: auto?.x ?? r.item.x,
    kicked: auto?.kicked ?? r.item.castInfo?.kicked ?? src?.castInfo?.kicked,
    colorsSpent: auto?.colorsSpent ?? r.item.castInfo?.colorsSpent ?? src?.castInfo?.colorsSpent,
  };
}

function evalVar(state: GameState, ctx: Ctx, r: Run, v: string): number | undefined {
  if (!supportedVar(v)) return undefined;
  if (v === 'Count$xPaid') return r.item.auto?.x ?? r.item.x ?? 0;
  const uv = uniqueVar(state, ctx, r.controller, r.remembered, v);
  if (uv !== undefined) return uv;
  const counted = evalCount(v, countEnv(state, ctx, r));
  if (counted !== undefined) return counted;
  let m = /^Number\$(-?\d+)$/.exec(v);
  if (m) return parseInt(m[1], 10);
  m = /^(Targeted|TargetedLKI|Remembered|RememberedLKI)\$Card(Power|Toughness|ManaCost)$/.exec(v);
  if (m) {
    const iid = m[1].startsWith('Remembered') ? r.remembered[0] ?? firstCardTarget(r) : firstCardTarget(r);
    if (!iid) return 0;
    const l = r.lki[iid] ?? (state.cards[iid] ? lkiOf(state.cards[iid], ctx, state) : undefined);
    if (!l) return 0;
    return m[2] === 'Power' ? l.power : m[2] === 'Toughness' ? l.toughness : l.mv;
  }
  const src = r.sourceIid ? state.cards[r.sourceIid] : undefined;
  const valid = /^Count\$Valid (.+)$/.exec(v);
  if (valid) {
    let n = 0;
    for (const iid of state.battlefield) {
      const m = matchCard(state.cards[iid], valid[1], { controller: r.controller, sourceIid: r.sourceIid, lookup: ctx.lookup });
      if (m === 'unknown') return undefined;
      if (m) n++;
    }
    return n;
  }
  switch (v) {
    case 'Count$CardPower': return src ? effectivePT(src, ctx.lookup, state)[0] : undefined;
    case 'Count$CardToughness': return src ? effectivePT(src, ctx.lookup, state)[1] : undefined;
    case 'Count$CardManaCost': return src ? lkiOf(src, ctx, state).mv : undefined;
    case 'Count$YourLifeTotal': return player(state, r.controller).life;
    case 'Count$CardsInYourHand': return player(state, r.controller).zones.hand.length;
  }
  return undefined;
}

function amount(state: GameState, ctx: Ctx, r: Run, raw: string | undefined, dflt: number): number | undefined {
  if (raw == null) return dflt;
  let s = raw.trim();
  let sign = 1;
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('-')) { sign = -1; s = s.slice(1); }
  if (/^\d+$/.test(s)) return sign * parseInt(s, 10);
  const sv = r.svars[s];
  const n = sv ? evalVar(state, ctx, r, sv) : undefined;
  return n == null ? undefined : sign * n;
}

function env(state: GameState, ctx: Ctx, r: Run): MatchEnv {
  return { controller: r.controller, sourceIid: r.sourceIid, lookup: ctx.lookup, num: (name) => amount(state, ctx, r, name, 0) };
}

function compare(state: GameState, ctx: Ctx, r: Run, left: number, expr: string): Tri {
  const m = /^(LT|LE|EQ|NE|GE|GT)(.+)$/.exec(expr);
  if (!m) return 'unknown';
  const right = amount(state, ctx, r, m[2], 0);
  if (right == null) return 'unknown';
  switch (m[1]) {
    case 'LT': return left < right;
    case 'LE': return left <= right;
    case 'EQ': return left === right;
    case 'NE': return left !== right;
    case 'GE': return left >= right;
    default: return left > right;
  }
}

function condition(state: GameState, ctx: Ctx, r: Run, i: number): Tri {
  const p = r.steps[i].params;
  let result: Tri = true;
  if (p.Condition) {
    const t = conditionTrue(p.Condition, countEnv(state, ctx, r));
    if (t === false) return false;
    if (t === undefined) result = 'unknown';
  }
  if (p.ConditionDefined || p.ConditionPresent) {
    let cards: string[];
    if (p.ConditionDefined) {
      const d = defined(state, r, i, p.ConditionDefined);
      if (!d) return 'unknown';
      cards = d.cards.filter((c) => state.cards[c]);
    } else cards = [...state.battlefield];
    let count = 0;
    let unknown = false;
    for (const iid of cards) {
      const m = matchCard(state.cards[iid], p.ConditionPresent ?? 'Card', env(state, ctx, r));
      if (m === true) count++;
      else if (m === 'unknown') unknown = true;
    }
    const c = compare(state, ctx, r, count, p.ConditionCompare ?? 'GE1');
    const c2: Tri = unknown && c !== 'unknown' ? 'unknown' : c;
    if (c2 === false) return false;
    if (c2 === 'unknown') result = 'unknown';
  }
  if (p.ConditionCheckSVar) {
    const v = amount(state, ctx, r, p.ConditionCheckSVar, 0);
    const c: Tri = v == null ? 'unknown' : compare(state, ctx, r, v, p.ConditionSVarCompare ?? 'GE1');
    if (c === false) return false;
    if (c === 'unknown' && result === true) result = 'unknown';
  }
  return result;
}

// ------------------------------------------------------------------ effects helpers

function counterKind(forge: string): string {
  const t = forge.trim().toUpperCase();
  if (t === 'P1P1') return '+1/+1';
  if (t === 'M1M1') return '-1/-1';
  if (t === 'LOYALTY') return 'loyalty';
  return t.toLowerCase();
}

function onBattlefield(state: GameState, iid: string): CardInstance | undefined {
  const c = state.cards[iid];
  return c && c.zone === 'battlefield' ? c : undefined;
}

function damageCard(state: GameState, ctx: Ctx, r: Run, c: CardInstance, n: number, deathtouch: boolean) {
  const f = faceOf(c, ctx.lookup);
  if (isCreature(c, ctx.lookup, state)) {
    c.damage += n;
    if (deathtouch && n > 0) r.deathtouched.push(c.iid);
  } else if (f.types.includes('Planeswalker')) {
    c.counters.loyalty = Math.max(0, (c.counters.loyalty ?? 0) - n);
  } else if (f.types.includes('Battle')) {
    c.counters.defense = Math.max(0, (c.counters.defense ?? 0) - n);
  }
}

function libraryIndex(state: GameState, ctx: Ctx, r: Run, raw: string | undefined): 'top' | 'bottom' | number {
  if (raw == null) return 'top';
  const n = amount(state, ctx, r, raw, 0) ?? 0;
  if (n === 0) return 'top';
  if (n < 0) return 'bottom';
  return n;
}

function moveTo(state: GameState, ctx: Ctx, r: Run, iid: string, dest: Zone, p: Record<string, string>) {
  const c = state.cards[iid];
  if (!c) return;
  if (dest === 'library') moveCard(state, ctx, iid, 'library', { position: libraryIndex(state, ctx, r, p.LibraryPosition) });
  else if (dest === 'battlefield') {
    moveCard(state, ctx, iid, 'battlefield', { tapped: p.Tapped === 'True', controller: p.GainControl === 'True' ? r.controller : c.zone === 'battlefield' ? c.controller : c.owner });
    // Transformed$ True: "return it to the battlefield transformed" (Fable of the Mirror-Breaker).
    if (p.Transformed === 'True' && state.cards[iid]?.zone === 'battlefield') state.cards[iid].transformed = true;
  } else moveCard(state, ctx, iid, dest, dest === 'exile' && p.ExileFaceDown === 'True' ? { faceDown: true } : {});
}

/** Duration$ UntilHostLeavesPlay on an exile: the host iid, 'gone' if the host already left, else undefined. */
function untilHostLeaves(state: GameState, r: Run, p: Record<string, string>, dest: Zone): string | undefined {
  if (p.Duration !== 'UntilHostLeavesPlay' || dest !== 'exile' || !r.sourceIid) return undefined;
  return state.cards[r.sourceIid]?.zone === 'battlefield' ? r.sourceIid : 'gone';
}

function manaString(cost: string, x: number): string | undefined {
  const parts = cost.trim().split(/\s+/);
  let out = '';
  for (const s of parts) {
    if (/^\d+$/.test(s) || /^[WUBRGC]$/.test(s)) out += `{${s}}`;
    else if (s === 'X') out += `{${x}}`;
    else return undefined;
  }
  return out;
}

function openPeek(state: GameState, ctx: Ctx, r: Run, i: number, p: GamePlayer, mode: 'scry' | 'surveil' | 'look' | 'search', n: number) {
  const lib = p.zones.library;
  p.peek = { mode, iids: mode === 'search' ? lib.slice() : lib.slice(0, Math.max(0, n)), label: `${r.sourceName}: ${r.steps[i].description}`, then: contAt(r, i + 1) };
}

// ------------------------------------------------------------------ picks (Pending)

interface PickData {
  kind: 'pick';
  action: 'move' | 'discard' | 'sacrifice';
  chooser: string;
  candidates: string[];
  left: number;
  optional: boolean;
  dest?: Zone;
  params?: Record<string, string>;
  label: string;
  queue: Omit<PickData, 'queue' | 'cont'>[];
  cont?: AutoCont;
  /** Exiled "until <this permanent> leaves the battlefield". */
  untilHost?: string;
}

interface ColorData {
  kind: 'color';
  n: number;
  cont?: AutoCont;
}

interface UnlessData {
  kind: 'unless';
  stackId: string;
  cost: string;
  dest?: string;
  params: Record<string, string>;
  cont?: AutoCont;
}

function pickPending(state: GameState, ctx: Ctx, d: PickData): boolean {
  const cands = d.candidates.filter((iid) => state.cards[iid]);
  if (!cands.length || d.left <= 0) return false;
  const options = cands.map((iid) => ({ value: iid, label: cardName(state.cards[iid], ctx.lookup) }));
  if (d.optional) options.push({ value: 'none', label: 'Done' });
  const pending: Pending = {
    id: randomId(ctx.rng), pid: d.chooser, prompt: `${d.label}${d.left > 1 ? ` (${d.left} left)` : ''}`, options,
    data: { ...d, candidates: cands } as unknown as Record<string, unknown>,
  };
  state.pending.push(pending);
  return true;
}

/** Start a pick (with queued follow-ups). Returns true when a Pending was created. */
function startPicks(state: GameState, ctx: Ctx, picks: Omit<PickData, 'queue' | 'cont'>[], cont: AutoCont | undefined): boolean {
  for (let k = 0; k < picks.length; k++) {
    if (pickPending(state, ctx, { ...picks[k], queue: picks.slice(k + 1), cont })) return true;
  }
  return false;
}


/** Scry / Surveil / Dig (look at the top N, choose by hand) / RearrangeTopOfLibrary: open the player's peek window. */
function peekStep(state: GameState, ctx: Ctx, r: Run, i: number, me: GamePlayer): StepResult {
  const step = r.steps[i];
  const p = step.params;
  const raw = step.api === 'Scry' ? p.ScryNum : step.api === 'Surveil' ? p.Amount : step.api === 'Dig' ? p.DigNum : p.NumCards;
  const n = amount(state, ctx, r, raw, 1);
  const o = objects(state, r, i, 'You');
  if (n == null || !o || o.players.length !== 1 || o.players[0] !== r.controller) { manual(state, ctx, r, step); return 'ok'; }
  const mode = step.api === 'Scry' ? 'scry' : step.api === 'Surveil' ? 'surveil' : 'look';
  openPeek(state, ctx, r, i, me, mode, n);
  const verb = mode === 'scry' ? `scries ${n}` : mode === 'surveil' ? `surveils ${n}` : `looks at the top ${n}`;
  log(state, ctx, r.controller, `${me.name} ${verb} (${r.sourceName}${mode === 'look' ? `: ${step.description}` : ''}).`);
  return 'wait';
}

/** Stage 2: a permanent's abilities remember objects across resolutions (Journey to Nowhere, Tidehollow Sculler ...). */
function rememberOnCard(state: GameState, item: StackItem, iids: string[]) {
  const src = item.sourceIid ?? item.iid;
  if (!src || item.kind === 'spell') return;
  (state.remembered ??= {})[src] = [...iids];
}

/** Create a token on the battlefield (Stage 2: emits an "enters the battlefield" event). */
export function createTokenInstance(state: GameState, ctx: Ctx, owner: string, token: TokenData, tapped: boolean, cardId?: string): CardInstance {
  const inst = newInstance(state, ctx.rng, owner, 'battlefield', cardId, token);
  inst.tapped = tapped;
  inst.summoningSick = true;
  state.battlefield.push(inst.iid);
  tokenEntered(state, ctx, inst); // ETB replacements from other permanents (e.g. "enters tapped")
  emit(state, { t: 'zone', iid: inst.iid, from: 'none', to: 'battlefield', snap: JSON.parse(JSON.stringify(inst)) as CardInstance });
  return inst;
}

/** Register a delayed trigger created by the resolving ability. */
function addDelayed(state: GameState, ctx: Ctx, r: Run, at: Step, chain: { svar?: string; line?: string }, remembered: string[], text: string) {
  const auto = r.item.auto!;
  const lki: Record<string, Lki> = {};
  for (const iid of remembered) {
    if (r.lki[iid]) lki[iid] = r.lki[iid];
    else if (state.cards[iid]) lki[iid] = lkiOf(state.cards[iid], ctx);
  }
  const info: AutoInfo = { cardId: auto.cardId, face: auto.face, source: 'trigger', index: -1, targets: [], trigger: { mode: 'Delayed', remembered: [...remembered], lki } };
  if (chain.svar) info.svar = chain.svar;
  if (chain.line) info.line = chain.line;
  (state.delayedTriggers ??= []).push({
    id: randomId(ctx.rng), controller: r.controller, sourceIid: r.sourceIid, sourceName: r.sourceName, text: `${r.sourceName}: ${text}`,
    step: at, turn: state.turn, createdStep: state.step, auto: info,
  });
  log(state, ctx, r.controller, `${r.sourceName}: delayed trigger set up (${text}).`);
}

/** AtEOT$ Sacrifice / Exile / ExileCombat: "sacrifice it at the beginning of the next end step". */
function atEndOf(state: GameState, ctx: Ctx, r: Run, iids: string[], what: string) {
  const dest = what === 'Sacrifice' ? 'Graveyard' : 'Exile';
  const line = `DB$ ChangeZone | Defined$ DelayTriggerRemembered | Origin$ Battlefield | Destination$ ${dest} | SpellDescription$ ${what === 'Sacrifice' ? 'Sacrifice' : 'Exile'} the token${iids.length === 1 ? '' : 's'}.`;
  addDelayed(state, ctx, r, what === 'ExileCombat' ? 'endCombat' : 'end', { line }, iids, `${what === 'Sacrifice' ? 'sacrifice' : 'exile'} ${names(state, ctx, iids)} at ${what === 'ExileCombat' ? 'end of combat' : 'the beginning of the next end step'}`);
}

// ------------------------------------------------------------------ steps

type StepResult = 'ok' | 'wait';

function execStep(state: GameState, ctx: Ctx, r: Run, i: number): StepResult {
  const step = r.steps[i];
  const p = step.params;
  const me = player(state, r.controller);
  const reason = unsupportedReason(step);
  if (step.api === 'Effect' && !reason) return 'ok'; // e.g. "can't be regenerated": nothing to do
  if (reason) {
    if (step.api !== 'Cleanup') manual(state, ctx, r, step);
    return 'ok';
  }
  const cond = condition(state, ctx, r, i);
  if (cond === false) {
    log(state, ctx, r.controller, `${r.sourceName}: condition not met — skipped (${step.description}).`);
    return 'ok';
  }
  if (cond === 'unknown') log(state, ctx, r.controller, `Check by hand: ${p.ConditionDescription ?? step.description} (condition not verified).`);
  // Unique / hard cards (engine/unique.ts). Simple Animate is only a fallback (see the end of this function).
  if (uniqueReason(step) !== undefined && !isSimpleAnimate(step)) {
    const res = execUniqueStep(state, ctx, uniqueRun(state, ctx, r, i, cond === 'unknown'));
    if (res) return res;
  }
  const remember = (iids: string[]) => {
    if (Object.keys(p).some((k) => k.startsWith('Remember'))) {
      for (const iid of iids) if (state.cards[iid] && !r.lki[iid]) r.lki[iid] = lkiOf(state.cards[iid], ctx, state);
      r.remembered = [...iids];
      rememberOnCard(state, r.item, iids);
    }
  };
  const bad = () => { manual(state, ctx, r, step); return 'ok' as const; };
  const E = env(state, ctx, r);

  switch (step.api) {
    case 'Cleanup': {
      if (p.ClearRemembered) {
        r.remembered = [];
        const src = r.item.sourceIid ?? r.item.iid;
        if (src && state.remembered) delete state.remembered[src];
      }
      return 'ok';
    }
    case 'DealDamage': {
      const n = amount(state, ctx, r, p.NumDmg, 0);
      const o = objects(state, r, i, 'You');
      if (n == null || !o || (!ownTargets(r, i) && !p.Defined)) return bad();
      const division = p.DividedAsYouChoose ? r.item.auto?.division : undefined;
      const many = o.cards.length + o.players.length > 1;
      if (p.DividedAsYouChoose && many && !division) return bad();
      // Divided damage: each object gets its share (a single target gets it all).
      const dmgOf = (key: string) => (division && many ? division[key] ?? 0 : n);
      const srcObj = p.DamageSource ? defined(state, r, i, p.DamageSource)?.cards[0] : r.sourceIid;
      const src = srcObj ? state.cards[srcObj] : undefined;
      const srcName = src ? cardName(src, ctx.lookup) : r.sourceName;
      const deathtouch = !!src && hasKeyword(src, ctx.lookup, 'Deathtouch', state);
      const hit: string[] = [];
      let dealt = 0;
      for (const iid of o.cards) {
        const c = onBattlefield(state, iid);
        const k = dmgOf(iid);
        if (!c || k <= 0) continue;
        damageCard(state, ctx, r, c, k, deathtouch);
        hit.push(division && many ? `${cardName(c, ctx.lookup)} (${k})` : cardName(c, ctx.lookup));
        dealt += k;
        if (srcObj) emit(state, { t: 'damage', source: srcObj, target: iid, amount: k, combat: false });
      }
      for (const pid of o.players) {
        const k = dmgOf(pid);
        if (k <= 0) continue;
        const prev = damagePrevented(state, ctx.lookup, pid);
        if (prev) { log(state, ctx, pid, `Damage to ${pname(state, pid)} is prevented (${prev}).`); continue; }
        player(state, pid).life -= k;
        hit.push(division && many ? `${pname(state, pid)} (${k})` : pname(state, pid));
        dealt += k;
        if (srcObj) emit(state, { t: 'damage', source: srcObj, target: pid, amount: k, combat: false });
      }
      log(state, ctx, r.controller, `${srcName} deals ${division && many ? '' : `${n} `}damage to ${hit.join(', ') || 'nothing'}.`);
      if (src && hasKeyword(src, ctx.lookup, 'Lifelink', state) && hit.length) {
        const gain = dealt;
        player(state, src.controller).life += gain;
        log(state, ctx, src.controller, `${pname(state, src.controller)} gains ${gain} life (lifelink).`);
      }
      return 'ok';
    }
    case 'DamageAll': {
      const n = amount(state, ctx, r, p.NumDmg, 0);
      if (n == null) return bad();
      const hit: string[] = [];
      if (p.ValidCards) {
        const cs = state.battlefield.map((x) => state.cards[x]);
        const ms = cs.map((c) => matchCard(c, p.ValidCards, E));
        if (ms.includes('unknown')) return bad();
        cs.forEach((c, k) => { if (ms[k]) { damageCard(state, ctx, r, c, n, false); hit.push(cardName(c, ctx.lookup)); } });
      }
      if (p.ValidPlayers) for (const pl of state.players) if (!pl.conceded && matchPlayer(pl.pid, p.ValidPlayers, E) !== false && !damagePrevented(state, ctx.lookup, pl.pid)) { pl.life -= n; hit.push(pl.name); }
      log(state, ctx, r.controller, `${r.sourceName} deals ${n} damage to ${hit.join(', ') || 'nothing'}.`);
      return 'ok';
    }
    case 'Draw': {
      const n = amount(state, ctx, r, p.NumCards, 1);
      const o = objects(state, r, i, 'You');
      if (n == null || !o) return bad();
      for (const pid of o.players) {
        const got = drawCards(state, player(state, pid), replaceDraws(state, ctx, pid, n));
        log(state, ctx, pid, `${pname(state, pid)} draws ${got} card${got === 1 ? '' : 's'}.`);
      }
      return 'ok';
    }
    case 'Destroy': {
      const o = objects(state, r, i, 'Self');
      if (!o) return bad();
      const done: string[] = [];
      for (const iid of o.cards) {
        const c = onBattlefield(state, iid);
        if (!c) continue;
        if (hasKeyword(c, ctx.lookup, 'Indestructible', state)) { log(state, ctx, null, `${cardName(c, ctx.lookup)} is indestructible.`); continue; }
        r.lki[iid] ??= lkiOf(c, ctx, state);
        const nm = cardName(c, ctx.lookup);
        moveCard(state, ctx, iid, 'graveyard');
        done.push(nm);
        remember([iid]);
      }
      log(state, ctx, r.controller, `${r.sourceName} destroys ${done.join(', ') || 'nothing'}.`);
      return 'ok';
    }
    case 'DestroyAll': case 'SacrificeAll': {
      const valid = p.ValidCards ?? (step.api === 'SacrificeAll' && p.Defined ? undefined : 'Card');
      let list: string[];
      if (!valid) {
        const d = defined(state, r, i, p.Defined);
        if (!d) return bad();
        list = d.cards.filter((x) => onBattlefield(state, x));
      } else {
        const ms = state.battlefield.map((x) => [x, matchCard(state.cards[x], valid, E)] as const);
        if (ms.some(([, m]) => m === 'unknown')) return bad();
        list = ms.filter(([, m]) => m).map(([x]) => x);
      }
      const done: string[] = [];
      for (const iid of list) {
        const c = state.cards[iid];
        if (step.api === 'DestroyAll' && hasKeyword(c, ctx.lookup, 'Indestructible', state)) continue;
        done.push(cardName(c, ctx.lookup));
        moveCard(state, ctx, iid, 'graveyard', step.api === 'SacrificeAll' ? { cause: 'sacrifice' } : {});
      }
      log(state, ctx, r.controller, `${r.sourceName}: ${step.api === 'DestroyAll' ? 'destroyed' : 'sacrificed'} ${done.length ? done.join(', ') : 'nothing'}.`);
      return 'ok';
    }
    case 'ChangeZone': {
      const dest = zoneOf(p.Destination);
      if (!dest) return bad();
      const origins = (p.Origin ?? '').split(',').map((z) => zoneOf(z)).filter((z): z is Zone => !!z);
      let cards: string[] | undefined;
      const own = ownTargets(r, i);
      const targetPlayers = own ? split(state, own) : undefined;
      // Targets a player and picks a card from their zone (Tidehollow Sculler, Mesmeric Fiend, Vendilion Clique ...).
      const pickFromPlayer = !!targetPlayers && !targetPlayers.cards.length && (!!p.ChangeType || !!p.Hidden || !!p.DefinedPlayer);
      if (own && pickFromPlayer && !targetPlayers!.players.length) { log(state, ctx, r.controller, `${r.sourceName}: no target player.`); return 'ok'; }
      if (own && !pickFromPlayer) cards = targetPlayers!.cards;
      else if (p.Defined) {
        const d = defined(state, r, i, p.Defined);
        if (!d) return bad();
        cards = d.cards;
      } else if (!own && origins.length === 1 && origins[0] === 'stack' && !p.ChangeType && r.item.kind === 'spell' && r.item.iid) {
        // "Exile CARDNAME" on a resolving spell (Temporal Mastery, Alrund's Epiphany, Time Spiral).
        cards = state.cards[r.item.iid]?.zone === 'stack' ? [r.item.iid] : [];
      } else if (!own && !p.ChangeType && !p.Hidden && !p.ChangeNum && origins.length && origins.every((z) => z === 'graveyard' || z === 'battlefield' || z === 'exile')) {
        // Forge: a known-origin ChangeZone without targets / Defined$ moves the card itself (e.g. Bloodghast, Kytheon).
        cards = r.sourceIid && state.cards[r.sourceIid] ? [r.sourceIid] : [];
      }
      if (!cards) {
        // Hidden choice: search the library, or pick from hand / graveyard / battlefield.
        const ownerPid = p.DefinedPlayer ? defined(state, r, i, p.DefinedPlayer)?.players[0] : pickFromPlayer ? targetPlayers!.players[0] : r.controller;
        if (!ownerPid) return bad();
        const chooser = player(state, ownerPid);
        const chooserPid = p.Chooser === 'You' ? r.controller : ownerPid;
        if (origins.includes('library')) {
          if (chooserPid !== ownerPid) return bad();
          openPeek(state, ctx, r, i, chooser, 'search', 0);
          log(state, ctx, chooserPid, `${chooser.name} searches their library (${r.sourceName}: ${step.description}) — choose the card.`);
          return 'wait';
        }
        const origin = origins[0];
        if (!origin || origins.length > 1) return bad();
        const changeType = p.ChangeType ?? 'Card';
        const pool = origin === 'battlefield' ? state.battlefield : origin === 'stack' ? [] : chooser.zones[origin as 'hand'];
        const cands = pool.filter((x) => {
          const c = state.cards[x];
          if (origin === 'battlefield' && !/YouCtrl|OppCtrl|YouOwn/.test(changeType) && c.controller !== chooserPid) return false;
          return matchCard(c, changeType, E) !== false;
        });
        const n = p.ChangeNum === 'All' ? cands.length : amount(state, ctx, r, p.ChangeNum, 1);
        if (n == null) return bad();
        if (!cands.length) { log(state, ctx, chooserPid, `${r.sourceName}: no card to choose.`); return 'ok'; }
        const host = untilHostLeaves(state, r, p, dest);
        if (host === 'gone') { log(state, ctx, r.controller, `${r.sourceName} already left the battlefield — nothing is exiled.`); return 'ok'; }
        const yours = ownerPid === chooserPid ? 'your' : `${chooser.name}'s`;
        if (origin === 'hand' && ownerPid !== chooserPid) log(state, ctx, r.controller, `${chooser.name} reveals their hand to ${pname(state, chooserPid)}.`);
        const where = dest === 'library' ? (p.LibraryPosition === '-1' ? `on the bottom of ${yours} library` : `on top of ${yours} library`) : `to ${dest === 'battlefield' ? 'the battlefield' : dest === 'exile' ? 'exile' : `${yours} ${dest}`}`;
        const created = startPicks(state, ctx, [{
          kind: 'pick', action: 'move', chooser: chooserPid, candidates: cands, left: Math.min(n, cands.length), optional: p.Mandatory !== 'True' && (origin !== 'hand' || p.Optional === 'True' || !/^\d+$/.test(p.ChangeNum ?? '1')),
          dest, params: p, ...(host ? { untilHost: host } : {}), label: `${r.sourceName}: choose a card to put ${where}${dest === 'library' && n > 1 ? ' (the last one you choose ends up on top)' : ''}`,
        }], contAt(r, i + 1));
        return created ? 'wait' : 'ok';
      }
      const moved: string[] = [];
      const untilHost = untilHostLeaves(state, r, p, dest);
      if (untilHost === 'gone') { log(state, ctx, r.controller, `${r.sourceName} already left the battlefield — nothing is exiled.`); return 'ok'; }
      const exiled: { iid: string; from: string; owner: string }[] = [];
      for (const iid of cards) {
        const c = state.cards[iid];
        if (!c) continue;
        const self = iid === r.sourceIid && (p.Defined === 'Self' || p.Defined === 'Parent');
        if (!self && origins.length && !origins.includes(c.zone) && !p.Origin?.includes('Any')) continue;
        r.lki[iid] ??= lkiOf(c, ctx, state);
        const nm = cardName(c, ctx.lookup);
        const from = c.zone;
        moveTo(state, ctx, r, iid, dest, p);
        moved.push(nm);
        if (untilHost && state.cards[iid]?.zone === 'exile') exiled.push({ iid, from, owner: c.owner });
      }
      if (untilHost && exiled.length) addEffect(state, ctx, { kind: 'exiled', controller: r.controller, until: 'hostLeaves', hostIid: untilHost, cards: exiled });
      remember(cards.filter((x) => state.cards[x]));
      if (p.Shuffle === 'True') for (const pid of new Set(cards.map((x) => state.cards[x]?.owner).filter(Boolean) as string[])) shuffleLibrary(state, player(state, pid), ctx.rng);
      const destLabel = dest === 'library' ? 'its owner\'s library' : dest === 'battlefield' ? 'the battlefield' : `${dest}`;
      log(state, ctx, r.controller, moved.length ? `${r.sourceName}: ${moved.join(', ')} → ${destLabel}.` : `${r.sourceName}: nothing to move.`);
      return 'ok';
    }
    case 'ChangeZoneAll': {
      const dest = zoneOf(p.Destination);
      const origins = (p.Origin ?? '').split(',').map((z) => zoneOf(z));
      if (!dest || !origins.length || origins.some((z) => !z || z === 'stack')) return bad();
      const valid = p.ChangeType ?? p.ValidCards ?? 'Card';
      const pool: string[] = [];
      for (const origin of origins as Zone[]) {
        if (origin === 'battlefield') { pool.push(...state.battlefield); continue; }
        const own = ownTargets(r, i);
        const ps = own ? split(state, own).players : p.Defined ? defined(state, r, i, p.Defined)?.players : state.players.filter((x) => !x.conceded).map((x) => x.pid);
        if (!ps) return bad();
        pool.push(...ps.flatMap((pid) => [...player(state, pid).zones[origin as 'hand']]));
      }
      // "Card.IsRemembered": the cards this chain remembered (Scroll Rack puts the exiled cards back).
      const ms = valid === 'Card.IsRemembered' ? pool.map((x) => [x, r.remembered.includes(x)] as const) : pool.map((x) => [x, matchCard(state.cards[x], valid, E)] as const);
      if (ms.some(([, m]) => m === 'unknown')) return bad();
      const list = ms.filter(([, m]) => m).map(([x]) => x);
      const owners = new Set(list.map((x) => state.cards[x].owner));
      for (const iid of list) moveTo(state, ctx, r, iid, dest, p);
      remember(list.filter((x) => state.cards[x]));
      if (p.Shuffle === 'True') for (const pid of owners) shuffleLibrary(state, player(state, pid), ctx.rng);
      log(state, ctx, r.controller, `${r.sourceName}: ${list.length} card${list.length === 1 ? '' : 's'} → ${dest}${p.Shuffle === 'True' ? ' (shuffled)' : ''}.`);
      return 'ok';
    }
    case 'Token': {
      const n = amount(state, ctx, r, p.TokenAmount, 1);
      const owners = p.TokenOwner ? defined(state, r, i, p.TokenOwner)?.players : [r.controller];
      if (n == null || !owners) return bad();
      const made: string[] = [];
      for (const script of (p.TokenScript ?? '').split(',').map((s) => s.trim())) {
        const token = SCRIPTS.tokens[script];
        if (!token) continue;
        for (const owner of owners) {
          const count = n * tokenMultiplier(state, ctx, owner);
          for (let k = 0; k < count; k++) {
            const inst = createTokenInstance(state, ctx, owner, token, p.TokenTapped === 'True');
            made.push(inst.iid);
          }
          log(state, ctx, owner, `${pname(state, owner)} creates ${count} ${token.name}${token.power != null ? ` ${token.power}/${token.toughness}` : ''} token${count === 1 ? '' : 's'}.`);
        }
      }
      remember(made);
      if (p.TokenAttacking) log(state, ctx, r.controller, 'Reminder: the token enters attacking — declare it by hand.');
      if (p.AtEOT && made.length) atEndOf(state, ctx, r, made, p.AtEOT);
      return 'ok';
    }
    case 'Investigate': {
      const n = amount(state, ctx, r, p.Num, 1);
      const clue = SCRIPTS.tokens.c_a_clue_draw;
      if (n == null || !clue) return bad();
      for (let k = 0; k < n; k++) createTokenInstance(state, ctx, r.controller, clue, false);
      log(state, ctx, r.controller, `${me.name} investigates (creates ${n} Clue token${n === 1 ? '' : 's'}).`);
      return 'ok';
    }
    case 'CopyPermanent': {
      const o = objects(state, r, i, 'Self');
      if (!o) return bad();
      const made: string[] = [];
      for (const iid of o.cards) {
        const src = state.cards[iid];
        if (!src?.cardId || src.zone !== 'battlefield') continue;
        const f = faceOf(src, ctx.lookup);
        const inst = createTokenInstance(state, ctx, r.controller, {
          name: f.name, typeLine: f.typeLine, colors: ctx.lookup(src.cardId)?.colors ?? [], oracle: f.oracle, keywords: f.keywords, power: f.power, toughness: f.toughness,
        }, false, src.cardId);
        inst.transformed = src.transformed;
        if (f.loyalty) inst.counters.loyalty = parseInt(f.loyalty, 10) || 0;
        if (p.AddKeywords) inst.tempKeywords = p.AddKeywords.split('&').map((k) => k.trim());
        made.push(inst.iid);
        log(state, ctx, r.controller, `${me.name} creates a token copy of ${f.name}${p.AddKeywords ? ` with ${p.AddKeywords.replace(/&/g, ', ').toLowerCase()}` : ''}.`);
      }
      remember(made);
      if (p.AtEOT && made.length) atEndOf(state, ctx, r, made, p.AtEOT);
      return 'ok';
    }
    case 'DelayedTrigger': {
      const at = PHASES[p.Phase ?? ''];
      if (!at || !p.Execute) return bad();
      const objs = p.RememberObjects ? defined(state, r, i, p.RememberObjects) : undefined;
      const rememberedNow = objs ? objs.cards : [];
      addDelayed(state, ctx, r, at, { svar: p.Execute }, rememberedNow, describe(p.TriggerDescription ?? p.SpellDescription ?? 'Delayed trigger', r.sourceName));
      return 'ok';
    }
    case 'ImmediateTrigger': {
      if (!p.Execute) return bad();
      const auto = r.item.auto!;
      const text = describe(p.TriggerDescription ?? p.SpellDescription ?? 'Reflexive trigger', r.sourceName);
      (state.triggerQueue ??= []).push({
        id: randomId(ctx.rng), controller: r.controller, sourceIid: r.sourceIid, sourceName: r.sourceName, text: `${r.sourceName}: ${text}`,
        auto: { cardId: auto.cardId, face: auto.face, source: 'trigger', index: -1, svar: p.Execute, targets: [], trigger: { ...(r.trig ?? {}), mode: 'Immediate', remembered: [...r.remembered], lki: { ...r.lki } } },
      });
      return 'ok';
    }
    case 'PutCounter': case 'PutCounterAll': {
      const n = amount(state, ctx, r, p.Adapt ?? p.CounterNum, 1);
      if (n == null || !(p.CounterType || p.Adapt)) return bad();
      const kind = counterKind(p.CounterType ?? 'P1P1');
      if (p.Adapt) {
        const self = r.sourceIid ? onBattlefield(state, r.sourceIid) : undefined;
        if (self && (self.counters['+1/+1'] ?? 0) > 0) { log(state, ctx, r.controller, `${r.sourceName} already has +1/+1 counters — adapt does nothing.`); return 'ok'; }
      }
      let o: Objs | undefined;
      if (step.api === 'PutCounterAll') {
        const ms = state.battlefield.map((x) => [x, matchCard(state.cards[x], p.ValidCards ?? 'Card', E)] as const);
        if (ms.some(([, m]) => m === 'unknown')) return bad();
        o = { cards: ms.filter(([, m]) => m).map(([x]) => x), players: [] };
      } else o = objects(state, r, i, 'Self');
      if (!o) return bad();
      for (const iid of o.cards) {
        const c = state.cards[iid];
        if (!c) continue;
        const m = counterAmount(state, ctx, c, kind, n);
        c.counters[kind] = (c.counters[kind] ?? 0) + m;
        log(state, ctx, r.controller, `${cardName(c, ctx.lookup)} gets ${m} ${kind} counter${m === 1 ? '' : 's'} (now ${c.counters[kind]}).`);
      }
      for (const pid of o.players) {
        const pl = player(state, pid);
        pl.counters[kind] = (pl.counters[kind] ?? 0) + n;
        log(state, ctx, pid, `${pl.name} gets ${n} ${kind} counter${n === 1 ? '' : 's'} (now ${pl.counters[kind]}).`);
      }
      return 'ok';
    }
    case 'GainLife': case 'LoseLife': case 'SetLife': {
      const n = amount(state, ctx, r, p.LifeAmount, 0);
      const o = objects(state, r, i, 'You');
      if (n == null || !o) return bad();
      for (const pid of o.players) {
        const pl = player(state, pid);
        if (step.api === 'GainLife') pl.life += n;
        else if (step.api === 'LoseLife') pl.life -= n;
        else pl.life = n;
        const verb = step.api === 'GainLife' ? `gains ${n} life` : step.api === 'LoseLife' ? `loses ${n} life` : `has their life total set to ${n}`;
        log(state, ctx, pid, `${pl.name} ${verb} (${pl.life}).`);
      }
      return 'ok';
    }
    case 'Counter': {
      const refs = ownTargets(r, i) ?? (p.Defined ? (defined(state, r, i, p.Defined)?.cards ?? []).map((iid) => ({ kind: 'card', iid }) as TargetRef) : []);
      for (const ref of refs) {
        const item = ref.kind === 'stack' ? state.stack.find((s) => s.id === ref.id) : ref.kind === 'card' ? state.stack.find((s) => s.iid === ref.iid) : undefined;
        if (!item) continue;
        const uncounterable = cantBeCountered(state, ctx, item);
        if (uncounterable) { log(state, ctx, r.controller, `${item.text} can't be countered — ${uncounterable}`); continue; }
        if (p.UnlessCost) {
          const x = amount(state, ctx, r, 'X', 0) ?? 0;
          const cost = manaString(p.UnlessCost, x);
          if (!cost) return bad();
          const data: UnlessData = { kind: 'unless', stackId: item.id, cost, dest: p.Destination, params: p, cont: contAt(r, i + 1) };
          state.pending.push({
            id: randomId(ctx.rng), pid: item.controller,
            prompt: `${r.sourceName}: pay ${cost} or ${item.text} is countered.`,
            options: [{ value: 'pay', label: `Pay ${cost}` }, { value: 'decline', label: "Don't pay" }],
            data: data as unknown as Record<string, unknown>,
          });
          log(state, ctx, r.controller, `${r.sourceName}: ${pname(state, item.controller)} may pay ${cost} to keep ${item.text} on the stack.`);
          return 'wait';
        }
        counterItem(state, ctx, item, p, r.sourceName, r);
      }
      return 'ok';
    }
    case 'Pump': case 'PumpAll': {
      const a = amount(state, ctx, r, p.NumAtt, 0);
      const d = amount(state, ctx, r, p.NumDef, 0);
      if (a == null || d == null) return bad();
      const kws = p.KW ? p.KW.split('&').map((k) => k.trim()).filter(Boolean) : [];
      let cards: string[];
      if (step.api === 'PumpAll') {
        const ms = state.battlefield.map((x) => [x, matchCard(state.cards[x], p.ValidCards ?? 'Creature', E)] as const);
        if (ms.some(([, m]) => m === 'unknown')) return bad();
        cards = ms.filter(([, m]) => m).map(([x]) => x);
      } else {
        const o = objects(state, r, i, 'Self');
        if (!o) return bad();
        cards = o.cards;
      }
      const hit: string[] = [];
      for (const iid of cards) {
        const c = onBattlefield(state, iid);
        if (!c) continue;
        c.tempPT = [c.tempPT[0] + a, c.tempPT[1] + d];
        if (kws.length) c.tempKeywords = [...new Set([...(c.tempKeywords ?? []), ...kws])];
        hit.push(cardName(c, ctx.lookup));
      }
      const bits = [(a || d) ? `get${hit.length === 1 ? 's' : ''} ${a >= 0 ? '+' : ''}${a}/${d >= 0 ? '+' : ''}${d}` : '', kws.length ? `gain${hit.length === 1 ? 's' : ''} ${kws.join(', ')}` : ''].filter(Boolean).join(' and ');
      if (hit.length) log(state, ctx, r.controller, `${hit.join(', ')} ${bits || 'is pumped'} until end of turn.`);
      else log(state, ctx, r.controller, `${r.sourceName}: nothing to pump.`);
      if (p.Duration === 'UntilYourNextTurn') {
        const live = cards.filter((x) => onBattlefield(state, x));
        if (live.length) addEffect(state, ctx, { kind: 'pump', controller: r.controller, until: 'yourNextTurn', cards: live, pt: [a, d], keywords: kws });
      } else if (p.Duration && p.Duration !== 'UntilEndOfTurn') log(state, ctx, r.controller, `Reminder: this lasts ${p.Duration.replace(/([A-Z])/g, ' $1').trim().toLowerCase()} — the engine removes it at end of turn; re-apply by hand.`);
      return 'ok';
    }
    case 'Tap': case 'Untap': case 'TapAll': case 'UntapAll': {
      let cards: string[];
      if (step.api.endsWith('All')) {
        const ms = state.battlefield.map((x) => [x, matchCard(state.cards[x], p.ValidCards ?? 'Permanent', E)] as const);
        if (ms.some(([, m]) => m === 'unknown')) return bad();
        cards = ms.filter(([, m]) => m).map(([x]) => x);
      } else {
        const o = objects(state, r, i, 'Self');
        if (!o) return bad();
        cards = o.cards;
      }
      const tap = step.api.startsWith('Tap');
      const hit: string[] = [];
      for (const iid of cards) { const c = onBattlefield(state, iid); if (c) { c.tapped = tap; hit.push(cardName(c, ctx.lookup)); } }
      log(state, ctx, r.controller, `${r.sourceName}: ${tap ? 'taps' : 'untaps'} ${hit.join(', ') || 'nothing'}.`);
      return 'ok';
    }
    case 'Discard': {
      const o = objects(state, r, i, 'You');
      const n = p.Mode === 'Hand' ? 0 : amount(state, ctx, r, p.NumCards, 1);
      if (!o || n == null) return bad();
      const picks: Omit<PickData, 'queue' | 'cont'>[] = [];
      for (const pid of o.players) {
        const pl = player(state, pid);
        if (p.Mode === 'Hand' || p.Mode === 'Random') {
          let ids = [...pl.zones.hand];
          if (p.Mode === 'Random') {
            const chosen: string[] = [];
            while (chosen.length < n && ids.length) { const k = Math.floor(ctx.rng() * ids.length); chosen.push(ids[k]); ids.splice(k, 1); }
            ids = chosen;
          }
          const nm = names(state, ctx, ids);
          for (const iid of ids) moveCard(state, ctx, iid, 'graveyard', { cause: 'discard' });
          remember(ids);
          log(state, ctx, pid, `${pl.name} discards ${ids.length ? nm : 'nothing'}${p.Mode === 'Random' ? ' at random' : ''}.`);
          continue;
        }
        const valid = p.DiscardValid ?? 'Card';
        const cands = pl.zones.hand.filter((x) => matchCard(state.cards[x], valid, E) !== false);
        if (p.Mode === 'RevealYouChoose') {
          if (pid !== r.controller) me.viewingHandOf = pid;
          log(state, ctx, r.controller, `${pl.name} reveals their hand: ${names(state, ctx, pl.zones.hand)}. ${me.name} chooses a card to discard.`);
          if (!cands.length) { log(state, ctx, r.controller, 'No valid card to choose.'); continue; }
          picks.push({ kind: 'pick', action: 'discard', chooser: r.controller, candidates: cands, left: Math.min(n, cands.length), optional: false, label: `${r.sourceName}: choose a card for ${pl.name} to discard` });
        } else {
          if (!cands.length) { log(state, ctx, pid, `${pl.name} has nothing to discard.`); continue; }
          log(state, ctx, pid, `${pl.name} chooses ${n} card${n === 1 ? '' : 's'} to discard.`);
          picks.push({ kind: 'pick', action: 'discard', chooser: pid, candidates: cands, left: Math.min(n, cands.length), optional: p.Optional === 'True', params: p, label: `${r.sourceName}: choose a card to discard` });
        }
      }
      return startPicks(state, ctx, picks, contAt(r, i + 1)) ? 'wait' : 'ok';
    }
    case 'Mill': {
      const n = amount(state, ctx, r, p.NumCards, 1);
      const o = objects(state, r, i, 'You');
      if (n == null || !o) return bad();
      const all: string[] = [];
      for (const pid of o.players) {
        const pl = player(state, pid);
        const ids = pl.zones.library.slice(0, n);
        for (const iid of ids) moveCard(state, ctx, iid, 'graveyard');
        all.push(...ids);
        log(state, ctx, pid, `${pl.name} mills ${names(state, ctx, ids)}.`);
      }
      remember(all);
      return 'ok';
    }
    case 'Dig': if (p.ChangeNum !== 'All') return peekStep(state, ctx, r, i, me);
    {
      const n = amount(state, ctx, r, p.DigNum, 1);
      const o = objects(state, r, i, 'You');
      const dest = zoneOf(p.DestinationZone ?? 'Hand');
      const dest2 = zoneOf(p.DestinationZone2 ?? 'Library');
      if (n == null || !o || !dest || !dest2 || dest === 'stack' || dest2 === 'stack') return bad();
      const valid = p.ChangeValid ?? 'Card';
      const tops = o.players.map((pid) => player(state, pid).zones.library.slice(0, n));
      const ms = tops.flat().map((x) => [x, matchCard(state.cards[x], valid, E)] as const);
      if (ms.some(([, m]) => m === 'unknown')) return bad();
      const hits = new Set(ms.filter(([, m]) => m).map(([x]) => x));
      const moved: string[] = [];
      o.players.forEach((pid, k) => {
        const top = tops[k];
        const pl = player(state, pid);
        const reveal = p.Reveal === 'True';
        const nm = names(state, ctx, top);
        const into = top.filter((x) => hits.has(x));
        const rest = top.filter((x) => !hits.has(x));
        for (const iid of into) {
          if (dest === 'library') moveCard(state, ctx, iid, 'library', { position: libraryIndex(state, ctx, r, p.LibraryPosition) });
          else if (dest === 'battlefield') moveCard(state, ctx, iid, 'battlefield', { controller: r.controller });
          else moveCard(state, ctx, iid, dest, { faceDown: dest === 'exile' && p.ExileFaceDown === 'True' });
          moved.push(iid);
        }
        for (const iid of [...rest].reverse()) {
          if (dest2 === 'library') moveCard(state, ctx, iid, 'library', { position: p.LibraryPosition2 != null && parseInt(p.LibraryPosition2, 10) >= 0 ? 'top' : 'bottom' });
          else moveCard(state, ctx, iid, dest2);
        }
        const publicDest = (z: Zone) => z === 'graveyard' || z === 'battlefield' || (z === 'exile' && p.ExileFaceDown !== 'True');
        const shown = reveal || (publicDest(dest) && (!rest.length || publicDest(dest2)));
        if (!top.length) log(state, ctx, pid, `${pl.name}'s library is empty (${r.sourceName}).`);
        else log(state, ctx, r.controller, `${r.sourceName}: ${reveal ? `${pl.name} reveals ${nm}; ` : ''}${into.length ? `${shown || publicDest(dest) ? names(state, ctx, into) : `${into.length} card${into.length === 1 ? '' : 's'}`} → ${dest === 'hand' ? `${pname(state, state.cards[into[0]]?.owner ?? pid)}'s hand` : dest}` : 'nothing taken'}${rest.length ? `; ${shown ? names(state, ctx, rest) : `${rest.length} card${rest.length === 1 ? '' : 's'}`} → ${dest2 === 'library' ? (p.LibraryPosition2 != null && parseInt(p.LibraryPosition2, 10) >= 0 ? 'top of library' : 'bottom of library') : dest2}` : ''}.`);
      });
      remember(moved);
      return 'ok';
    }
    case 'Scry': case 'Surveil': case 'RearrangeTopOfLibrary': return peekStep(state, ctx, r, i, me);
    case 'GainControl': {
      const o = objects(state, r, i, 'Self');
      const to = p.NewController ? defined(state, r, i, p.NewController)?.players[0] : r.controller;
      if (!o || !to) return bad();
      const kws = p.AddKWs ? p.AddKWs.split('&').map((k) => k.trim()) : [];
      for (const iid of o.cards) {
        const c = onBattlefield(state, iid);
        if (!c) continue;
        const previous = c.controller;
        const eot = /EOT|EndOfTurn/.test(p.LoseControl ?? '') || p.Duration === 'UntilEndOfTurn';
        if (eot) addEffect(state, ctx, { kind: 'control', controller: to, until: 'eot', iid: c.iid, previous });
        else if ((/LeavesPlay/.test(p.LoseControl ?? '') || p.Duration === 'UntilHostLeavesPlay') && r.sourceIid) addEffect(state, ctx, { kind: 'control', controller: to, until: 'hostLeaves', iid: c.iid, previous, hostIid: r.sourceIid });
        c.controller = to;
        c.summoningSick = true;
        c.attacking = undefined;
        c.blocking = undefined;
        if (p.Untap === 'True') c.tapped = false;
        if (kws.length) c.tempKeywords = [...new Set([...(c.tempKeywords ?? []), ...kws])];
        log(state, ctx, to, `${pname(state, to)} gains control of ${cardName(c, ctx.lookup)}${eot ? ' until end of turn' : ''}.`);
      }
      return 'ok';
    }
    case 'Sacrifice': {
      const sacValid = p.SacValid ?? 'Card';
      // No SacValid$ / Defined$ (e.g. City of Traitors' "DB$ Sacrifice"): Forge defaults to sacrificing the source itself.
      if (p.Defined === 'Self' || sacValid === 'Self' || sacValid === 'Card.Self' || (!p.SacValid && !p.Defined && !step.params.ValidTgts)) {
        const c = r.sourceIid ? onBattlefield(state, r.sourceIid) : undefined;
        if (c) { const nm = cardName(c, ctx.lookup); moveCard(state, ctx, c.iid, 'graveyard', { cause: 'sacrifice' }); log(state, ctx, r.controller, `${pname(state, c.controller)} sacrifices ${nm}.`); remember([c.iid]); }
        return 'ok';
      }
      const own = ownTargets(r, i);
      const ps = own ? split(state, own).players : defined(state, r, i, p.Defined ?? 'You')?.players;
      const n = amount(state, ctx, r, p.Amount, 1);
      if (!ps || n == null) return bad();
      const picks: Omit<PickData, 'queue' | 'cont'>[] = [];
      for (const pid of ps) {
        const cands = state.battlefield.filter((x) => state.cards[x].controller === pid && matchCard(state.cards[x], sacValid, { ...E, controller: pid }) !== false);
        if (!cands.length) { log(state, ctx, pid, `${pname(state, pid)} has nothing to sacrifice.`); continue; }
        picks.push({ kind: 'pick', action: 'sacrifice', chooser: pid, candidates: cands, left: Math.min(n, cands.length), optional: false, label: `${r.sourceName}: choose a permanent to sacrifice` });
      }
      return startPicks(state, ctx, picks, contAt(r, i + 1)) ? 'wait' : 'ok';
    }
    case 'Attach': {
      const objIid = p.Object ? defined(state, r, i, p.Object)?.cards[0] : r.sourceIid;
      const own = ownTargets(r, i);
      const to = own ? split(state, own).cards[0] : p.Defined ? defined(state, r, i, p.Defined)?.cards[0] : undefined;
      const obj = objIid ? onBattlefield(state, objIid) : undefined;
      const host = to ? onBattlefield(state, to) : undefined;
      if (!obj || !host || obj === host) { if (!own) return bad(); return 'ok'; }
      obj.attachedTo = host.iid;
      log(state, ctx, r.controller, `${cardName(obj, ctx.lookup)} is attached to ${cardName(host, ctx.lookup)}.`);
      return 'ok';
    }
    case 'Mana': {
      const n = amount(state, ctx, r, p.Amount, 1);
      if (n == null) return bad();
      if (n <= 0) return 'ok';
      if (p.Produced === 'Any') {
        const data: ColorData = { kind: 'color', n, cont: contAt(r, i + 1) };
        state.pending.push({
          id: randomId(ctx.rng), pid: r.controller, prompt: `${r.sourceName}: add ${n} mana of any one color`,
          options: ['W', 'U', 'B', 'R', 'G'].map((c) => ({ value: c, label: `{${c}}` })), data: data as unknown as Record<string, unknown>,
        });
        return 'wait';
      }
      const syms = (p.Produced ?? '').split(' ');
      for (let k = 0; k < n; k++) for (const s of syms) me.manaPool[s] = (me.manaPool[s] ?? 0) + 1;
      log(state, ctx, r.controller, `${me.name} adds ${Array(n).fill(syms.map((s) => `{${s}}`).join('')).join('')}.`);
      return 'ok';
    }
    case 'Charm': {
      log(state, ctx, r.controller, `Not automated: ${r.sourceName} — no modes were chosen; resolve the chosen modes by hand.`);
      return 'ok';
    }
    case 'Shuffle': {
      const o = objects(state, r, i, 'You');
      if (!o) return bad();
      for (const pid of o.players) { shuffleLibrary(state, player(state, pid), ctx.rng); log(state, ctx, pid, `${pname(state, pid)} shuffles their library.`); }
      return 'ok';
    }
    case 'BecomeMonarch': case 'TakeInitiative': {
      const name = step.api === 'BecomeMonarch' ? 'Monarch' : 'Initiative';
      for (const pl of state.players) pl.designations = pl.designations.filter((d) => d !== name);
      me.designations.push(name);
      log(state, ctx, r.controller, `${me.name} ${step.api === 'BecomeMonarch' ? 'becomes the monarch' : 'takes the initiative'}.`);
      return 'ok';
    }
    case 'RevealHand': {
      const o = objects(state, r, i, 'You');
      if (!o) return bad();
      for (const pid of o.players) {
        if (pid !== r.controller) me.viewingHandOf = pid;
        log(state, ctx, r.controller, `${pname(state, pid)} reveals their hand: ${names(state, ctx, player(state, pid).zones.hand)}.`);
      }
      return 'ok';
    }
  }
  if (KEYWORD_APIS.has(step.api)) { execKeywordStep(state, ctx, step, r); return 'ok'; }
  if (isSimpleAnimate(step)) return execUniqueStep(state, ctx, uniqueRun(state, ctx, r, i, cond === 'unknown')) ?? bad();
  return bad();
}

/** The running chain as engine/unique.ts sees it. */
function uniqueRun(state: GameState, ctx: Ctx, r: Run, i: number, uncertain: boolean): UniqueRun {
  const step = r.steps[i];
  return {
    step, controller: r.controller, sourceIid: r.sourceIid, sourceName: r.sourceName, item: r.item, remembered: r.remembered, lki: r.lki, svars: r.svars, trig: r.trig, uncertain,
    amount: (raw, dflt) => amount(state, ctx, r, raw, dflt),
    objects: (dflt) => objects(state, r, i, dflt),
    defined: (value) => defined(state, r, i, value),
    ownTargets: () => ownTargets(r, i),
    cont: () => contAt(r, i + 1),
    picks: (list: PickSpec[]) => startPicks(state, ctx, list, contAt(r, i + 1)),
    remember: (iids) => {
      for (const iid of iids) if (state.cards[iid] && !r.lki[iid]) r.lki[iid] = lkiOf(state.cards[iid], ctx, state);
      r.remembered = [...iids];
      rememberOnCard(state, r.item, iids);
    },
    atEndOf: (iids, what) => atEndOf(state, ctx, r, iids, what),
    manual: () => manual(state, ctx, r, step),
  };
}

function counterItem(state: GameState, ctx: Ctx, item: StackItem, p: Record<string, string>, by: string, r?: Run) {
  if (item.iid && state.cards[item.iid]) {
    const nm = cardName(state.cards[item.iid], ctx.lookup);
    if (r) r.lki[item.id] = lkiOf(state.cards[item.iid], ctx, state);
    const dest = zoneOf(p.Destination) ?? 'graveyard';
    if (dest === 'library') moveCard(state, ctx, item.iid, 'library', { position: p.LibraryPosition === '-1' ? 'bottom' : 'top' });
    else moveCard(state, ctx, item.iid, dest === 'battlefield' || dest === 'stack' ? 'graveyard' : dest);
    state.stack = state.stack.filter((s) => s !== item);
    log(state, ctx, item.controller, `${nm} is countered by ${by}${dest !== 'graveyard' ? ` (→ ${dest})` : ''}.`);
  } else {
    state.stack = state.stack.filter((s) => s !== item);
    log(state, ctx, item.controller, `${item.text} is countered by ${by}.`);
  }
}

// ------------------------------------------------------------------ driving

function runFrom(state: GameState, ctx: Ctx, cont: AutoCont): void {
  const r = makeRun(state, ctx, cont);
  if (!r) return;
  for (let i = cont.next; i < r.steps.length; i++) {
    if (execStep(state, ctx, r, i) === 'wait') break;
  }
  stateBasedActions(state, ctx, r.deathtouched);
}

/** Continue an automated resolution that was waiting on a peek (scry / search ...). */
export function resumeAuto(state: GameState, ctx: Ctx, cont: AutoCont) {
  runFrom(state, ctx, cont);
}

function stillLegal(state: GameState, ctx: Ctx, item: StackItem, spec: TargetSpec | undefined, ref: TargetRef): boolean {
  if (ref.kind === 'player') { const p = state.players.find((x) => x.pid === ref.pid); return !!p && !p.conceded; }
  if (ref.kind === 'stack') return state.stack.some((s) => s.id === ref.id);
  const c = state.cards[ref.iid];
  if (!c) return false;
  const zone = item.auto?.targetZones?.[ref.iid];
  if (zone && c.zone !== zone) return false;
  if (!spec) return true;
  return isValidTarget(state, spec, ref, item.controller, item.iid ?? item.sourceIid, ctx.lookup);
}

/**
 * Resolve an automated stack item. `finish` puts a spell card where it goes after resolving
 * (battlefield / graveyard / exile) without logging.
 */
export function resolveAuto(state: GameState, ctx: Ctx, item: StackItem, isPermanentSpell: boolean, finish: () => void): boolean {
  const auto = item.auto!;
  state.stack = state.stack.filter((s) => s !== item);
  const ab = abilityFor(auto);
  const src = item.iid ? state.cards[item.iid] : item.sourceIid ? state.cards[item.sourceIid] : undefined;
  const name = item.kind === 'spell' && src ? cardName(src, ctx.lookup) : item.text;
  if (!ab) {
    log(state, ctx, item.controller, `${name} resolves (not automated — resolve it by hand).`);
    if (item.iid && state.cards[item.iid]?.zone === 'stack') finish();
    return true;
  }
  const specs = targetSpecs(ab, auto.modes);
  const legal = auto.targets.map((list, k) => list.filter((ref) => stillLegal(state, ctx, item, specs[k], ref)));
  const total = auto.targets.reduce((n, l) => n + l.length, 0);
  const left = legal.reduce((n, l) => n + l.length, 0);
  if (total > 0 && left === 0) {
    if (item.iid && state.cards[item.iid]?.zone === 'stack') moveCard(state, ctx, item.iid, 'graveyard');
    log(state, ctx, item.controller, `${name} fizzles — its target${total === 1 ? ' is' : 's are'} no longer legal.`);
    return false;
  }
  if (left < total) log(state, ctx, item.controller, `${name}: ${total - left} target${total - left === 1 ? ' is' : 's are'} no longer legal.`);
  const lki: Record<string, Lki> = {};
  for (const ref of legal.flat()) {
    if (ref.kind === 'card' && state.cards[ref.iid]) lki[ref.iid] = lkiOf(state.cards[ref.iid], ctx, state);
    if (ref.kind === 'stack') {
      const it = state.stack.find((s) => s.id === ref.id);
      if (it?.iid && state.cards[it.iid]) lki[ref.id] = lkiOf(state.cards[it.iid], ctx, state);
      else if (it) lki[ref.id] = { power: 0, toughness: 0, mv: 0, controller: it.controller, owner: it.controller, name: it.text };
    }
  }
  log(state, ctx, item.controller, item.kind === 'spell' ? `${name} resolves.` : `Resolved: ${item.text}`);
  const isSpellCard = item.kind === 'spell' && !!item.iid;
  if (isSpellCard && isPermanentSpell) finish();
  const cont: AutoCont = { item, next: 0, targets: legal, lki, remembered: [] };
  const r = makeRun(state, ctx, cont)!;
  for (let i = 0; i < r.steps.length; i++) {
    if (execStep(state, ctx, r, i) === 'wait') break;
  }
  if (isSpellCard && !isPermanentSpell && state.cards[item.iid!]?.zone === 'stack') finish();
  stateBasedActions(state, ctx, r.deathtouched);
  return true;
}

/** Answer a Pending question. Returns an error string or null. */
export function answerPending(state: GameState, ctx: Ctx, pid: string, id: string, value: string): string | null {
  const pend = state.pending.find((p) => p.id === id);
  if (!pend) return 'That question is no longer open';
  if (pend.pid !== pid) return 'That question is for another player';
  if (!pend.options.some((o) => o.value === value)) return 'Not one of the options';
  state.pending = state.pending.filter((p) => p !== pend);
  if ((pend.data as { kind?: string }).kind === 'cost') return answerCostPending(state, ctx, pid, pend.data as unknown as CostData, value);
  let ext = answerReplacementPending(state, ctx, pend, value);
  if (ext === undefined) ext = answerKeywordPending(state, ctx, pend, value);
  if (ext === undefined) ext = answerUniquePending(state, ctx, pend, value);
  if (ext === undefined) ext = answerTapCost(state, ctx, pend, value);
  if (ext !== undefined) return ext;
  const data = pend.data as unknown as PickData | UnlessData | ColorData;
  const who = player(state, pid);
  if (data.kind === 'color') {
    who.manaPool[value] = (who.manaPool[value] ?? 0) + data.n;
    log(state, ctx, pid, `${who.name} adds ${Array(data.n).fill(`{${value}}`).join('')}.`);
    if (data.cont) runFrom(state, ctx, data.cont);
    return null;
  }
  if (data.kind === 'unless') {
    const item = state.stack.find((s) => s.id === data.stackId);
    if (item) {
      if (value === 'pay') {
        const res = payFromPool(data.cost, who.manaPool);
        if (res) { who.manaPool = res.pool; if (res.lifePaid) who.life -= res.lifePaid; log(state, ctx, pid, `${who.name} pays ${data.cost}.`); }
        else log(state, ctx, pid, `${who.name} pays ${data.cost} (mana not deducted — pool did not cover it).`);
      } else {
        log(state, ctx, pid, `${who.name} doesn't pay ${data.cost}.`);
        counterItem(state, ctx, item, data.params, 'it');
      }
    }
    if (data.cont) runFrom(state, ctx, data.cont);
    return null;
  }
  // pick
  let left = data.left;
  let candidates = data.candidates;
  if (value !== 'none') {
    const c = state.cards[value];
    if (c) {
      const nm = cardName(c, ctx.lookup);
      if (data.action === 'discard') {
        moveCard(state, ctx, value, 'graveyard', { cause: 'discard' });
        log(state, ctx, pid, `${pname(state, c.owner)} discards ${nm}.`);
        if (data.cont && Object.keys(data.params ?? {}).some((k) => k.startsWith('Remember'))) data.cont.remembered = [...data.cont.remembered, value];
      } else if (data.action === 'sacrifice') {
        moveCard(state, ctx, value, 'graveyard', { cause: 'sacrifice' });
        log(state, ctx, pid, `${who.name} sacrifices ${nm}.`);
      } else {
        const p = data.params ?? {};
        const from = c.zone;
        if (data.dest === 'library') moveCard(state, ctx, value, 'library', { position: p.LibraryPosition === '-1' ? 'bottom' : 'top' });
        else if (data.dest === 'battlefield') moveCard(state, ctx, value, 'battlefield', { tapped: p.Tapped === 'True', controller: pid });
        else moveCard(state, ctx, value, data.dest ?? 'hand');
        if (data.untilHost && state.cards[value]?.zone === 'exile') addEffect(state, ctx, { kind: 'exiled', controller: pid, until: 'hostLeaves', hostIid: data.untilHost, cards: [{ iid: value, from, owner: c.owner }] });
        if (data.cont && Object.keys(p).some((k) => k.startsWith('Remember'))) {
          data.cont.remembered = [...data.cont.remembered, value];
          rememberOnCard(state, data.cont.item, data.cont.remembered);
        }
        const hidden = (z: Zone) => z === 'hand' || z === 'library';
        log(state, ctx, pid, `${who.name} puts ${hidden(from) && hidden(data.dest ?? 'hand') ? 'a card' : nm} ${data.dest === 'library' ? (p.LibraryPosition === '-1' ? 'on the bottom of their library' : 'on top of their library') : `into ${data.dest === 'battlefield' ? 'play' : `their ${data.dest}`}`}.`);
      }
    }
    left--;
    candidates = candidates.filter((x) => x !== value);
  } else left = 0;
  if (left > 0 && pickPending(state, ctx, { ...data, left, candidates })) return null;
  if (startPicks(state, ctx, data.queue, data.cont)) return null;
  if (data.cont) runFrom(state, ctx, data.cont);
  else stateBasedActions(state, ctx, []);
  return null;
}

/** Creatures with lethal damage / 0 toughness and planeswalkers with 0 loyalty go to the graveyard. */
export function stateBasedActions(state: GameState, ctx: Ctx, deathtouched: string[] = []) {
  for (let guard = 0; guard < 20; guard++) {
    const dead: [string, string][] = [];
    for (const iid of state.battlefield) {
      const c = state.cards[iid];
      const f = faceOf(c, ctx.lookup);
      if (isCreature(c, ctx.lookup, state)) {
        const [, t] = effectivePT(c, ctx.lookup, state);
        // Only when a printed positive toughness was reduced, or static abilities define the toughness
        // (other 0/0 bodies usually get their size from effects we don't model).
        const base = c.faceDown ? 2 : /^-?\d+$/.test(f.toughness ?? '') ? parseInt(f.toughness!, 10) : 0;
        if ((base > 0 || staticsDefineToughness(state, iid, ctx.lookup)) && t <= 0) { dead.push([iid, 'has 0 toughness']); continue; }
        if (hasKeyword(c, ctx.lookup, 'Indestructible', state)) continue;
        if ((t > 0 && c.damage >= t) || (c.damage > 0 && deathtouched.includes(iid))) dead.push([iid, 'dies (lethal damage)']);
      } else if (f.types.includes('Planeswalker') && !c.faceDown && (c.counters.loyalty ?? 0) <= 0) {
        dead.push([iid, 'is put into the graveyard (0 loyalty)']);
      }
    }
    if (!dead.length) return;
    for (const [iid, why] of dead) {
      const nm = cardName(state.cards[iid], ctx.lookup);
      moveCard(state, ctx, iid, 'graveyard');
      log(state, ctx, null, `${nm} ${why}.`);
    }
  }
}
