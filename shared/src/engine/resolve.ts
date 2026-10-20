/**
 * Runs automated stack items: target legality, the effect chain, player decisions (Pending / peek
 * continuations) and state-based actions.
 */
import { cardName, effectivePT, faceOf, hasKeyword, isCreature, payFromPool } from '../game/rules.ts';
import { type Ctx, drawCards, emit, log, moveCard, newInstance, player, randomId, shuffleLibrary } from '../game/state.ts';
import type { CardInstance, GamePlayer, GameState, StackItem, Step, Zone } from '../game/types.ts';
import type { TokenData } from '../cards.ts';
import { chainOf, describe, flatten, parseAbility, PHASES, SCRIPTS, specIndexByStep, supportedVar, baseVarSupported, splitVarMath, applyVarMath, targetSpecs, unsupportedReason } from './script.ts';
import { isValidTarget, matchCard, matchPlayer, type MatchEnv, type Tri } from './targets.ts';
import { lifeGainPrevented, staticsDefineToughness } from './statics.ts';
import type { AutoCont, AutoInfo, Lki, ParsedAbility, Pending, TargetRef, TargetSpec, TriggerContext } from './types.ts';
import { KEYWORD_APIS } from './keywords.ts';
import { answerKeywordPending, execKeywordStep } from './keyword-play.ts';
import { answerReplacementPending, cantBeCountered, counterAmount, damagePrevented, replaceDraws, tokenEntered, tokenMultiplier, modifiedDamage } from './replacements.ts';
import { answerCostPending, type CostData } from './costs.ts';
import { conditionTrue, type CountEnv, evalCount } from './counts.ts';
import { addEffect, turnInfo } from './durations.ts';
import { execUniqueStep, type UniqueRun, uniqueVar, answerUniquePending, type PickSpec } from './unique.ts';
import { isSimpleAnimate, uniqueReason } from './unique-support.ts';
import { answerTapCost } from './turns.ts';
import { answerExtPending, execExtStep, EXT_APIS, type StepApi } from './ext.ts';
import { blightOn } from './setmech.ts';
import { canPayCost, costText, parseCostTokens, payCostNow, timesPayable } from './paycost.ts';
import { answerMorePending, answerMoreTargets, execMoreStep, MORE_APIS, moreDefinedValue, moreVar, type MoreRun } from './more.ts';
import { checkTargets } from './play.ts';
import { enterAttacking } from './combat-rules.ts';
import { answerVenture, becomeMonarch, takeInitiative } from './designations.ts';
import { getCard } from '../cube.ts';
import { autoTapFor } from './strict.ts';

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
  /** The step being executed (ParentTargeted$ / ThisTargeted$ variables). */
  cur?: number;
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
  const r: Run = {
    ...cont, lki, steps, specOf: specIndexByStep(steps), svars: face?.svars ?? {}, controller: cont.item.controller, sourceIid,
    sourceName: src ? cardName(src, ctx.lookup) : face?.name ?? cont.item.text.split(':')[0] ?? 'It', deathtouched: [], trig, splices: [], chosen: { ...(cont.chosen ?? {}) },
    // An effect's triggered ability starts with the effect's remembered objects (Palace Jailer's exiled creature).
    remembered: cont.remembered.length || cont.next > 0 ? cont.remembered : [...(trig?.effectRemembered ?? [])],
  };
  for (const sp of cont.splices ?? []) spliceSteps(r, sp, true);
  return r;
}

/** Steps a splice inserts (a pseudo step setting the remembered objects first, for RepeatEach). */
function spliceList(svars: Record<string, string>, sp: NonNullable<AutoCont['splices']>[number], faceName = 'It'): ParsedAbility[] {
  const line = sp.line ?? (sp.svar ? svars[sp.svar] : undefined);
  const chain = line ? parseAbility(line, svars, faceName) : undefined;
  const list = chain ? flatten(chain, sp.modes) : [];
  if (sp.remember) list.unshift({ kind: 'DB', api: '_Remember', params: { Objects: sp.remember.join(',') }, description: '', svars });
  return list;
}

/** Insert a splice into a run (and record it so a resumed run rebuilds it). Returns the number of steps added. */
function spliceSteps(r: Run, sp: NonNullable<AutoCont['splices']>[number], replay = false): number {
  const list = spliceList(r.svars, sp, r.sourceName);
  r.steps.splice(sp.at + 1, 0, ...list);
  r.specOf.splice(sp.at + 1, 0, ...list.map(() => undefined));
  // Late targets / unless decisions of later steps move with them.
  const shift = <T,>(rec: Record<number, T> | undefined) => {
    if (!rec) return rec;
    const out: Record<number, T> = {};
    for (const [k, v] of Object.entries(rec)) out[Number(k) > sp.at ? Number(k) + list.length : Number(k)] = v;
    return out;
  };
  if (list.length && !replay) { r.lateTargets = shift(r.lateTargets); r.unless = shift(r.unless); }
  (r.splices ??= []).push(sp);
  return list.length;
}

/** Record a splice on a continuation (Pending answers): returns the number of steps it adds. */
export function addSplice(cont: AutoCont, at: number, svar: string, opts: { remember?: string[]; modes?: string[]; line?: string }): number {
  const auto = cont.item.auto;
  const face = auto ? SCRIPTS.cards[auto.cardId]?.[auto.face] : undefined;
  const sp = { at, svar, ...opts };
  const n = spliceList(face?.svars ?? {}, sp, face?.name).length;
  (cont.splices ??= []).push(sp);
  return n;
}

function contAt(r: Run, next: number): AutoCont {
  return JSON.parse(JSON.stringify({ item: r.item, next, targets: r.targets, lki: r.lki, remembered: r.remembered, splices: r.splices, lateTargets: r.lateTargets, unless: r.unless, chosen: r.chosen })) as AutoCont;
}

export function lkiOf(c: CardInstance, ctx: Ctx, state?: GameState): Lki {
  const [power, toughness] = effectivePT(c, ctx.lookup, state);
  const data = c.cardId ? ctx.lookup(c.cardId) : undefined;
  return { power, toughness, mv: c.token && !c.cardId ? 0 : data?.cmc ?? 0, controller: c.controller, owner: c.owner, name: cardName(c, ctx.lookup), ...(Object.keys(c.counters).length ? { counters: { ...c.counters } } : {}) };
}

const ZONE: Record<string, Zone> = { battlefield: 'battlefield', hand: 'hand', graveyard: 'graveyard', exile: 'exile', library: 'library', stack: 'stack', command: 'command' };
const zoneOf = (forge: string | undefined): Zone | undefined => (forge ? ZONE[forge.trim().toLowerCase()] : undefined);

function names(state: GameState, ctx: Ctx, iids: string[]): string {
  return iids.map((i) => (state.cards[i] ? cardName(state.cards[i], ctx.lookup) : 'a card')).join(', ') || 'nothing';
}

function pname(state: GameState, pid: string): string {
  return state.players.find((p) => p.pid === pid)?.name ?? 'someone';
}

/** Reveal `owner`'s hand to `viewer`: the cards in it now (not cards drawn later) until they change zones / end of turn. */
export function revealHandTo(state: GameState, viewer: string, owner: string) {
  if (viewer === owner) return;
  const v = state.players.find((p) => p.pid === viewer);
  if (v) v.viewingHandOf = owner; // the client shows the revealed hand (until end of turn)
  for (const iid of state.players.find((p) => p.pid === owner)?.zones.hand ?? []) {
    const c = state.cards[iid];
    if (c && !c.revealedTo.includes(viewer)) c.revealedTo.push(viewer);
  }
}

/** Diagnostics for tools (scripts/playtest.ts --why): called on every "not automated" fallback of a step. */
export const manualHooks: { onManual?: (step: ParsedAbility, sourceName: string) => void } = {};

function manual(state: GameState, ctx: Ctx, r: Run, step: ParsedAbility) {
  manualHooks.onManual?.(step, r.sourceName);
  const what = step.description === step.api ? `${r.sourceName} (${step.api})` : step.description;
  log(state, ctx, r.controller, `Not automated: ${what} — resolve it by hand.`);
}

// ------------------------------------------------------------------ targets & defined objects

function ownTargets(r: Run, i: number): TargetRef[] | undefined {
  if (r.lateTargets?.[i]) return r.lateTargets[i];
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
    case 'Player.IsRemembered': { const mem = r.remembered; return { cards: [], players: live.filter((p) => mem.includes(p)) }; }
    case 'NonRememberedController': {
      const ctrls = new Set(r.remembered.map((x) => r.lki[x]?.controller ?? state.cards[x]?.controller).filter(Boolean));
      return { cards: [], players: live.filter((p) => !ctrls.has(p)) };
    }
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
    case 'Remembered': case 'RememberedLKI': case 'RememberedCard': {
      // The run's own memory, else what the permanent remembered earlier (e.g. Journey to Nowhere's exiled card).
      const mem = r.remembered.length ? r.remembered : (r.sourceIid && r.item.kind !== 'spell' ? state.remembered?.[r.sourceIid] ?? [] : []);
      const isP = (x: string) => state.players.some((p) => p.pid === x);
      return { cards: mem.filter((x) => !isP(x)), players: mem.filter(isP) };
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
      case 'TriggeredCard': case 'TriggeredCardLKICopy': case 'TriggeredNewCardLKICopy': case 'TriggeredAttacker': case 'TriggeredAttackerLKICopy': return { cards: cardIds(t.card).filter((x) => state.cards[x]), players: [] };
      case 'TriggeredSource': return { cards: cardIds(t.source).filter((x) => state.cards[x]), players: [] };
      case 'TriggeredCardController': return { cards: [], players: players(t.card ? ctrl(t.card) : t.player) };
      case 'TriggeredCardOwner': return { cards: [], players: players(t.card ? (r.lki[t.card]?.owner ?? state.cards[t.card]?.owner) : undefined) };
      case 'TriggeredPlayer': case 'TriggeredActivator': case 'TriggeredAttackingPlayer': return { cards: [], players: players(t.player) };
      case 'TriggeredDefendingPlayer': return { cards: [], players: players(t.defender) };
      case 'TriggeredBlocker': case 'TriggeredBlockerLKICopy': return t.mode === 'AttackerBlocked' ? { cards: cardIds(t.target).filter((x) => state.cards[x]), players: [] } : undefined;
      case 'TriggeredSourceController': return { cards: [], players: players(ctrl(t.source)) };
      case 'TriggeredTarget': return isPlayer(t.target) ? { cards: [], players: players(t.target) } : { cards: cardIds(t.target), players: [] };
    }
  }
  if (value === 'DelayTriggerRemembered' || value === 'DelayTriggerRememberedLKI') return { cards: [...(t?.remembered ?? [])], players: [] };
  if (value === 'ChosenPlayer') { const pc = r.chosen?.players?.[0] ?? src?.chosen?.player; return { cards: [], players: pc ? [pc] : [] }; }
  if (value === 'ChosenCard' || value === 'ChosenCardLKI') return { cards: [...(r.chosen?.cards ?? [])], players: [] };
  if (value === 'ChosenCardController' || value === 'ChosenCardOwner') {
    const ps = (r.chosen?.cards ?? []).map((x) => (value === 'ChosenCardOwner' ? state.cards[x]?.owner : state.cards[x]?.controller) ?? r.lki[x]?.controller);
    return { cards: [], players: [...new Set(ps.filter((x): x is string => !!x))] };
  }
  if (value === 'TargetedOrController') {
    const t = parentTargets(r, i);
    const ps = t.map((ref) => (ref.kind === 'player' ? ref.pid : ref.kind === 'card' ? state.cards[ref.iid]?.controller : undefined)).filter((x): x is string => !!x);
    return { cards: [], players: ps.length ? [...new Set(ps)] : [r.controller] };
  }
  // Self.nonCreature (Iron Man Armor: "if this Equipment isn't a creature, it becomes ..."): the source if it matches.
  if (value?.startsWith('Self.')) {
    const src = r.sourceIid ? state.cards[r.sourceIid] : undefined;
    const E: MatchEnv = { controller: r.controller, sourceIid: r.sourceIid, lookup: getCard };
    return { cards: src && matchCard(src, `Card.${value.slice(5)}`, E) === true ? [src.iid] : [], players: [] };
  }
  if (value?.startsWith('Targeted.')) {
    const E: MatchEnv = { controller: r.controller, sourceIid: r.sourceIid, lookup: getCard };
    return { cards: tgt().cards.filter((x) => state.cards[x] && matchCard(state.cards[x], value.slice(9), E) === true), players: [] };
  }
  if (value === 'OriginalHost') { const h = r.item.auto?.originalHost; return { cards: h && state.cards[h] ? [h] : [], players: [] }; }
  if (value === 'TopOfLibrary') { const top = player(state, r.controller).zones.library[0]; return { cards: top ? [top] : [], players: [] }; }
  if (value === 'ThisTargetedCard' || value === 'ThisTargetedPlayer') { const t = split(state, ownTargets(r, i) ?? []); return value === 'ThisTargetedCard' ? { cards: t.cards, players: [] } : { cards: [], players: t.players }; }
  if (value?.startsWith('Valid ')) {
    const E: MatchEnv = { controller: r.controller, sourceIid: r.sourceIid, lookup: getCard, remembered: r.remembered };
    return { cards: state.battlefield.filter((x) => matchCard(state.cards[x], value.slice(6), E) === true), players: [] };
  }
  const more = moreDefinedValue(state, r, value); // engine/more.ts: Imprinted, ReplacedCard, TriggeredSpellAbility ...
  if (more) return more;
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
    optionalCost: r.item.castInfo?.optionalCost ?? src?.castInfo?.optionalCost,
    remembered: r.remembered,
    timesKicked: r.item.castInfo?.timesKicked ?? src?.castInfo?.timesKicked,
    colorsSpent: auto?.colorsSpent ?? r.item.castInfo?.colorsSpent ?? src?.castInfo?.colorsSpent,
  };
}

function evalVar(state: GameState, ctx: Ctx, r: Run, v: string): number | undefined {
  if (!supportedVar(v)) return undefined;
  if (!baseVarSupported(v)) {
    const xm = splitVarMath(v);
    if (xm) {
      const b = evalVar(state, ctx, r, xm.base);
      const k = xm.arg == null ? 0 : /^-?\d+$/.test(xm.arg) ? parseInt(xm.arg, 10) : amount(state, ctx, r, xm.arg, 0);
      return b == null || k == null ? undefined : applyVarMath(b, xm.op, k);
    }
  }
  // ParentTargeted$CardPower: the card targeted by an earlier step ("it deals damage equal to its power", bite spells);
  // ThisTargeted$...: this step's own target.
  const pt = /^(ParentTargeted|ThisTargeted|Enchanted|Equipped)\$Card(Power|Toughness|ManaCost)$/.exec(v);
  if (pt) {
    const cur = r.cur ?? 0;
    const refs = pt[1] === 'ThisTargeted' ? ownTargets(r, cur) ?? [] : pt[1] === 'ParentTargeted' ? parentTargets(r, cur - 1) : [];
    const host = r.sourceIid ? state.cards[r.sourceIid] : undefined;
    const iid = pt[1] === 'Enchanted' || pt[1] === 'Equipped' ? host?.attachedTo || undefined : refs.find((t) => t.kind === 'card')?.iid as string | undefined;
    const c = iid ? state.cards[iid] : undefined;
    const l = c?.zone === 'battlefield' ? lkiOf(c, ctx, state) : iid ? r.lki[iid] ?? (c ? lkiOf(c, ctx, state) : undefined) : undefined;
    if (!l) return 0;
    return pt[2] === 'Power' ? l.power : pt[2] === 'Toughness' ? l.toughness : l.mv;
  }
  if (v === 'Count$xPaid') return r.item.auto?.x ?? r.item.x ?? 0;
  // The triggering spell: its mana value (LKI), or the mana spent to cast it (approximated as mana value + X paid).
  const ts = /^(TriggeredCard|TriggeredSpellAbility)\$(CastTotalManaSpent|CardManaCostLKI|Converge)$/.exec(v);
  if (ts) {
    const iid = r.trig?.card;
    const c = iid ? state.cards[iid] : undefined;
    // Converge: the number of colors of mana spent to cast it.
    if (ts[2] === 'Converge') return new Set((c?.castInfo?.colorsSpent ?? state.stack.find((s) => s.iid === iid)?.castInfo?.colorsSpent ?? []).filter((x) => 'WUBRG'.includes(x))).size;
    const mv = (iid ? r.lki[iid]?.mv : undefined) ?? (c?.cardId ? ctx.lookup(c.cardId)?.cmc ?? 0 : 0);
    if (ts[2] === 'CardManaCostLKI') return mv;
    const spent = c?.castInfo?.manaSpent ?? state.stack.find((s) => s.iid === iid)?.castInfo?.manaSpent;
    if (spent != null) return spent;
    const x = c?.castInfo?.x ?? state.stack.find((s) => s.iid === iid)?.x ?? 0;
    const xs = c?.cardId ? (ctx.lookup(c.cardId)?.manaCost.match(/\{X\}/g) ?? []).length : 0;
    return mv + x * xs;
  }
  // Targeted$Valid <type>: targeted objects that match; ThisTargetedPlayer$Valid Creature.YouCtrl: the targeted player's matching permanents.
  const tv = /^(Targeted|ThisTargetedPlayer|TargetedPlayer)\$Valid ([^\s$]+)$/.exec(v);
  if (tv) {
    const refs = tv[1] === 'ThisTargetedPlayer' ? ownTargets(r, r.cur ?? 0) ?? [] : r.targets.flat();
    if (tv[1] === 'Targeted') return refs.filter((t) => t.kind === 'card' && state.cards[t.iid] && matchCard(state.cards[t.iid], tv[2], env(state, ctx, r)) === true).length;
    const pid = refs.find((t) => t.kind === 'player')?.pid as string | undefined;
    if (!pid) return 0;
    return state.battlefield.filter((x) => matchCard(state.cards[x], tv[2], { controller: pid, lookup: ctx.lookup }) === true).length;
  }
  // SVar$X/HalfDown, SVar$X/Minus.1 ... : math on another SVar.
  let sm = /^SVar\$(\w+)\/(Plus|Minus|Times)\.(-?\d+|\w+)$/.exec(v);
  if (sm) {
    const b = amount(state, ctx, r, sm[1], 0);
    const k = /^-?\d+$/.test(sm[3]) ? parseInt(sm[3], 10) : amount(state, ctx, r, sm[3], 0); // a number or another SVar (Goblin Welder)
    if (b == null || k == null) return undefined;
    return sm[2] === 'Plus' ? b + k : sm[2] === 'Minus' ? b - k : b * k;
  }
  // Count$Compare Y GE2.2.1: 2 if SVar Y >= 2, else 1 (Flow State, Undermountain Adventurer).
  sm = /^Count\$Compare (\w+) (LT|LE|EQ|NE|GE|GT)(-?\w+)\.(-?\d+)\.(-?\d+)$/.exec(v);
  if (sm) {
    const left = amount(state, ctx, r, sm[1], 0);
    if (left == null) return undefined;
    const c = compare(state, ctx, r, left, `${sm[2]}${sm[3]}`);
    return c === 'unknown' ? undefined : parseInt(c ? sm[4] : sm[5], 10);
  }
  sm = /^SVar\$(\w+)\/(HalfDown|HalfUp|Twice|Negative)$/.exec(v);
  if (sm) { const b = amount(state, ctx, r, sm[1], 0); if (b == null) return undefined; return sm[2] === 'HalfDown' ? Math.floor(b / 2) : sm[2] === 'HalfUp' ? Math.ceil(b / 2) : sm[2] === 'Twice' ? b * 2 : -b; }
  // TriggeredCard$CardCounters.P1P1 (last known), Sacrificed$CardManaCost(/Plus.N)
  sm = /^TriggeredCard\$CardCounters\.(\w+)$/.exec(v);
  if (sm) { const iid = r.trig?.card; const k = sm[1].toUpperCase() === 'P1P1' ? '+1/+1' : sm[1].toLowerCase(); return (iid ? r.lki[iid]?.counters?.[k] ?? state.cards[iid]?.counters[k] : 0) ?? 0; }
  sm = /^Sacrificed\$Card(ManaCost|Power)(?:\/Plus\.(\d+))?$/.exec(v);
  if (sm) {
    const iid = state.remembered?.[`sacrificed|${r.controller}`]?.[0];
    const c = iid ? state.cards[iid] : undefined;
    const base = !c ? 0 : sm[1] === 'ManaCost' ? (c.cardId ? ctx.lookup(c.cardId)?.cmc ?? 0 : 0) : parseInt(faceOf(c, ctx.lookup).power ?? '0', 10) || 0;
    return base + (parseInt(sm[2] ?? '0', 10) || 0);
  }
  // Count$Valid <type>.ControlledBy <Defined> (Generous Plunderer: artifacts the defending player controls)
  sm = /^Count\$Valid (.+?)\.?\+?ControlledBy (\w+)$/.exec(v);
  if (sm) {
    const ps = defined(state, r, 0, sm[2])?.players ?? [];
    return state.battlefield.filter((x) => ps.includes(state.cards[x].controller) && matchCard(state.cards[x], sm![1], env(state, ctx, r)) === true).length;
  }
  const mv = moreVar(state, r, ctx, v); // engine/more.ts
  if (mv !== undefined) return mv;
  if (v === 'Count$TriggerRememberAmount' || v === 'TriggerCount$Amount') return r.trig?.amount ?? 0;
  // RememberAmount$ True (PutCounter): how many were put (0 when an optional step was declined).
  if (v === 'Count$RememberedNumber') return r.chosen?.rememberedNumber ?? 0;
  // RememberedLKI$CardCounters.VOYAGE: counters the remembered card had (last known information).
  sm = /^(Remembered|RememberedLKI)\$CardCounters\.(\w+)$/.exec(v);
  if (sm) {
    const iid = r.remembered[0];
    const k = counterKind(sm[2]);
    return iid ? (r.lki[iid]?.counters?.[k] ?? (sm[1] === 'Remembered' ? state.cards[iid]?.counters[k] : 0) ?? 0) : 0;
  }
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
  const announced = r.item.auto?.extra?.[s]; // Announce$ values (Intrepid Adversary's NumTimes)
  if (announced != null && /^-?\d+$/.test(announced)) return sign * parseInt(announced, 10);
  // An SVar name, or an inline variable ("NumCards$ PlayerCountRegisteredOpponents$HasPropertyLostLifeThisTurn").
  const sv = r.svars[s] ?? (/\$/.test(s) ? s : undefined);
  const n = sv ? evalVar(state, ctx, r, sv) : undefined;
  return n == null ? undefined : sign * n;
}

function env(state: GameState, ctx: Ctx, r: Run): MatchEnv {
  const src = r.sourceIid ? state.cards[r.sourceIid] : undefined;
  return {
    controller: r.controller, sourceIid: r.sourceIid, lookup: ctx.lookup, num: (name) => amount(state, ctx, r, name, 0),
    turnInfo: turnInfo(state), remembered: r.remembered, defender: r.trig?.defender, attachedTo: src?.attachedTo ?? '',
    ...(src?.chosen ? { chosen: src.chosen } : {}), ...(r.chosen?.cards ? { chosenCards: r.chosen.cards } : {}), exiledWith: exiledWithSource(state, r.sourceIid),
    targetedPlayers: [...new Set(r.targets.flat().map((t) => (t.kind === 'player' ? t.pid : '')).filter(Boolean))], targetedCards: r.targets.flat().map((t) => (t.kind === 'card' ? t.iid : '')).filter(Boolean), imprinted: r.chosen?.imprinted ?? [],
    libraries: Object.fromEntries(state.players.map((pl) => [pl.pid, pl.zones.library])),
  };
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
    // "Card.Self+AttachedTo Creature.YouCtrl" (Springheart Nantuko): what it's attached to must match.
    let present = p.ConditionPresent ?? 'Card';
    let attachedTo: string | undefined;
    const am = /\+AttachedTo (\S+)$/.exec(present);
    if (am) { attachedTo = am[1]; present = present.slice(0, am.index); }
    for (const iid of cards) {
      let m = matchCard(state.cards[iid], present, env(state, ctx, r));
      if (m === true && attachedTo) { const host = state.cards[state.cards[iid].attachedTo ?? '']; m = host ? matchCard(host, attachedTo, env(state, ctx, r)) : false; }
      if (m === true) count++;
      else if (m === 'unknown') unknown = true;
    }
    const c = compare(state, ctx, r, count, p.ConditionCompare ?? 'GE1');
    const c2: Tri = unknown && c !== 'unknown' ? 'unknown' : c;
    if (c2 === false) return false;
    if (c2 === 'unknown') result = 'unknown';
  }
  // A second presence condition (Super-Adaptoid: "if that creature has haste and CARDNAME doesn't").
  if (p.ConditionPresent2) {
    const cards = p.ConditionDefined2 ? defined(state, r, i, p.ConditionDefined2)?.cards.filter((c) => state.cards[c]) : [...state.battlefield];
    if (!cards) return 'unknown';
    let count = 0, unknown = false;
    for (const iid of cards) { const m = matchCard(state.cards[iid], p.ConditionPresent2, env(state, ctx, r)); if (m === true) count++; else if (m === 'unknown') unknown = true; }
    const c = compare(state, ctx, r, count, p.ConditionCompare2 ?? 'GE1');
    if (c === false && !unknown) return false;
    if ((c === 'unknown' || unknown) && result === true) result = 'unknown';
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
    // WithCountersAmount$ X with RememberLKI$ True (Cosima: X = the voyage counters it had in exile): evaluated before it moves.
    if (p.RememberLKI === 'True') { r.lki[iid] ??= lkiOf(c, ctx, state); r.remembered = [iid]; }
    const withCounters = p.WithCountersType ? (p.WithCountersAmount ? amount(state, ctx, r, p.WithCountersAmount, 1) : 1) : undefined;
    // Transformed$ True: "return it to the battlefield transformed" (Fable of the Mirror-Breaker, Ajani, Kytheon):
    // it enters transformed, so a planeswalker back face enters with its own loyalty.
    const transformed = p.Transformed === 'True';
    moveCard(state, ctx, iid, 'battlefield', { tapped: p.Tapped === 'True', controller: p.GainControl === 'True' ? r.controller : c.zone === 'battlefield' ? c.controller : c.owner, ...(transformed ? { transformed } : {}) });
    // WithCountersType$ (persist / undying): it returns with a counter.
    const back = state.cards[iid];
    if (p.WithCountersType && back?.zone === 'battlefield') {
      const k = counterKind(p.WithCountersType);
      const n = withCounters ?? 1;
      if (n > 0) {
        back.counters[k] = (back.counters[k] ?? 0) + n;
        emit(state, { t: 'counterAdded', iid, kind: k, n });
        log(state, ctx, r.controller, `${cardName(back, ctx.lookup)} enters with ${n} ${k} counter${n === 1 ? '' : 's'}.`);
      }
    }
  } else {
    moveCard(state, ctx, iid, dest, dest === 'exile' && p.ExileFaceDown === 'True' ? { faceDown: true, unseen: unseenFaceDown(r) } : {});
    if (dest === 'exile') noteExiledWith(state, r.sourceIid, [iid]);
  }
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
  action: 'move' | 'discard' | 'sacrifice' | 'tap' | 'blight';
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
  /** Player whose hand is revealed to the chooser for this pick (Pending.revealed). */
  reveal?: string;
  /** Each pick adds 1 to the resolving ability's X ("tap X untapped Myr"). */
  countX?: boolean;
  /** Shuffle this player's library once the picks are done (library searches). */
  shuffle?: string;
  /** Chosen cards that go back into the library after that shuffle (top, or bottom with LibraryPosition$ -1). */
  toLibrary?: string[];
  /** Dig: where the cards that weren't chosen go once the picks are done (digChoose). */
  dig?: DigRest;
  /** Reveal each chosen card to every player (Narset: "reveal a noncreature, nonland card ... put it into your hand"). */
  revealChosen?: boolean;
}

/** A triggered ability's optional cost ("you may pay {E}{E}{E}. When you do ..."), asked as it resolves. */
interface OptCostData {
  kind: 'optcost';
  cont: AutoCont;
  cost: string;
  x: number;
  /** Mana<cost NumTimes>: the answer is how many times to pay. */
  times?: boolean;
  label: string;
}

interface ColorData {
  kind: 'color';
  n: number;
  cont?: AutoCont;
  /** "Combo" mana: more single mana to choose after this one, from these colors. */
  more?: number;
  colors?: string[];
}

function askColor(state: GameState, ctx: Ctx, pid: string, source: string, data: ColorData) {
  const colors = data.colors ?? ['W', 'U', 'B', 'R', 'G'];
  state.pending.push({
    id: randomId(ctx.rng), pid, prompt: `${source}: add ${data.n} mana of any one color${data.more ? ` (${data.more} more to choose)` : ''}`,
    options: colors.map((c) => ({ value: c, label: `{${c}}` })), data: data as unknown as Record<string, unknown>,
  });
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
  if (d.reveal) {
    const hand = state.players.find((p) => p.pid === d.reveal)?.zones.hand ?? [];
    revealHandTo(state, d.chooser, d.reveal);
    pending.revealed = hand.map((iid) => ({ iid, label: cardName(state.cards[iid], ctx.lookup), legal: cands.includes(iid) }));
  }
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


/** Dig with a choice (Narset, Parter of Veils; Once Upon a Time; Stock Up; Thassa's Oracle ...): the rest of the looked-at cards. */
interface DigRest { top: string[]; dest2: Zone; toTop: boolean; random: boolean; owner: string; source: string; counter?: string }

/**
 * "Look at the top N, put up to / exactly M (matching ChangeValid$) into <zone>, the rest on the bottom / into the
 * graveyard": a pick among the top N (only the chooser sees the options), then the rest moves automatically. A card put
 * into a hand that had to match a restriction (or with Reveal$) is revealed to everyone. undefined = not a shape this
 * handles (the peek window does it by hand).
 */
function digChoose(state: GameState, ctx: Ctx, r: Run, i: number, _me: GamePlayer, E: ReturnType<typeof env>): StepResult | undefined {
  const p = r.steps[i].params;
  if (p.DestinationZone3) return undefined;
  // Whose library: the controller's, a targeted / defined player's (Jace's +2 fateseal).
  const o = objects(state, r, i, 'You');
  if (!o || o.players.length !== 1) return undefined;
  const me = player(state, o.players[0]);
  // Who chooses: the controller, or an opponent (Karn, Scion of Urza: "An opponent chooses one of them").
  let chooser = r.controller;
  if (p.Choser) {
    if (p.Choser !== 'Player.Opponent' && p.Choser !== 'Opponent') return undefined;
    const opp = state.players.find((q) => q.pid !== r.controller && !q.conceded);
    if (!opp) return undefined;
    chooser = opp.pid;
  }
  const n = amount(state, ctx, r, p.DigNum, 1);
  const dest = zoneOf(p.DestinationZone ?? 'Hand');
  const dest2 = zoneOf(p.DestinationZone2 ?? 'Library');
  if (n == null || !dest || !dest2 || dest === 'stack' || dest2 === 'stack' || dest2 === 'battlefield') return undefined;
  const top = me.zones.library.slice(0, Math.max(0, n));
  const any = p.ChangeNum === 'Any';
  const m = any ? top.length : amount(state, ctx, r, p.ChangeNum, 1);
  if (m == null) return undefined;
  const valid = p.ChangeValid ?? 'Card';
  const matches = top.map((x) => matchCard(state.cards[x], valid, E));
  if (matches.some((x) => x === 'unknown')) return undefined;
  const cands = top.filter((_, k) => matches[k] === true);
  const reveal = p.Reveal === 'True';
  const whose = me.pid === r.controller ? 'their' : `${me.name}'s`;
  if (reveal && top.length) {
    for (const x of top) state.cards[x].revealedTo = state.players.map((q) => q.pid);
    log(state, ctx, r.controller, `${me.name} reveals ${names(state, ctx, top)} (${r.sourceName}).`);
  } else if (p.NoLooking !== 'True') log(state, ctx, r.controller, `${pname(state, r.controller)} looks at the top ${top.length === 1 ? 'card' : `${top.length} cards`} of ${whose} library (${r.sourceName}).`);
  const rest: DigRest = {
    top, dest2, toTop: dest2 === 'library' && p.LibraryPosition2 != null && parseInt(p.LibraryPosition2, 10) >= 0, random: p.RestRandomOrder === 'True', owner: me.pid, source: r.sourceName,
    ...(p.ExileWithCounters && dest2 === 'exile' ? { counter: counterKind(p.ExileWithCounters) } : {}),
  };
  const showChosen = dest === 'hand' && p.NoReveal !== 'True' && (reveal || valid !== 'Card' || !!p.ForceRevealToController);
  // Forge's Dig puts a chosen card on the bottom of the library unless LibraryPosition$ says otherwise.
  const params = dest === 'library' ? { ...p, LibraryPosition: p.LibraryPosition ?? '-1' } : p;
  const yours = me.pid === chooser ? 'your' : `${me.name}'s`;
  const where = dest === 'library' ? (params.LibraryPosition === '-1' ? `on the bottom of ${yours} library` : `on top of ${yours} library`) : dest === 'battlefield' ? 'onto the battlefield' : `into ${yours} ${dest}`;
  const created = startPicks(state, ctx, [{
    kind: 'pick', action: 'move', chooser, candidates: cands, left: Math.min(m, cands.length), optional: any || p.Optional === 'True',
    dest, params, dig: rest, ...(showChosen ? { revealChosen: true } : {}),
    label: `${r.sourceName}: choose ${p.ChangeValidDesc ? `a ${p.ChangeValidDesc} card` : 'a card'} to put ${where}`,
  }], contAt(r, i + 1));
  if (created) return 'wait';
  if (top.length) log(state, ctx, r.controller, `${r.sourceName}: no ${p.ChangeValidDesc ? `${p.ChangeValidDesc} ` : ''}card to take.`);
  finishDig(state, ctx, rest);
  return 'ok';
}

/** RearrangeTopOfLibrary (Ponder, Sensei's Divining Top, Mirri's Guile): the order is asked card by card, then "shuffle?". */
interface RearrangeData { kind: 'rearrange'; chooser: string; owner: string; left: string[]; placed: string[]; mayShuffle: boolean; source: string; cont: AutoCont }
interface RShuffleData { kind: 'rshuffle'; chooser: string; owner: string; source: string; cont: AutoCont }

function rearrangeStep(state: GameState, ctx: Ctx, r: Run, i: number, me: GamePlayer): StepResult {
  const p = r.steps[i].params;
  const n = amount(state, ctx, r, p.NumCards, 1);
  const o = objects(state, r, i, 'You');
  if (n == null || !o || o.players.length !== 1) return peekStep(state, ctx, r, i, me);
  const owner = player(state, o.players[0]);
  const top = owner.zones.library.slice(0, Math.max(0, n));
  log(state, ctx, r.controller, `${pname(state, r.controller)} looks at the top ${top.length === 1 ? 'card' : `${top.length} cards`} of ${owner.pid === r.controller ? 'their' : `${owner.name}'s`} library (${r.sourceName}).`);
  const d: RearrangeData = { kind: 'rearrange', chooser: r.controller, owner: owner.pid, left: top, placed: [], mayShuffle: p.MayShuffle === 'True', source: r.sourceName, cont: contAt(r, i + 1) };
  return askRearrange(state, ctx, d) ? 'wait' : 'ok';
}

const ORDINAL = ['top', 'second from the top', 'third from the top', 'fourth from the top', 'fifth from the top'];

/** Ask for the next card of the new order, or put them back (and ask "shuffle?"). true = a question is open. */
function askRearrange(state: GameState, ctx: Ctx, d: RearrangeData): boolean {
  const owner = player(state, d.owner);
  const inLib = (x: string) => state.cards[x]?.zone === 'library' && owner.zones.library.includes(x);
  const left = d.left.filter(inLib);
  if (left.length > 1) {
    state.pending.push({
      id: randomId(ctx.rng), pid: d.chooser, prompt: `${d.source}: choose the card to put ${ORDINAL[d.placed.length] ?? `#${d.placed.length + 1} from the top`}`,
      options: left.map((x) => ({ value: x, label: cardName(state.cards[x], ctx.lookup) })), data: { ...d, left } as unknown as Record<string, unknown>,
    });
    return true;
  }
  const order = [...d.placed.filter(inLib), ...left];
  owner.zones.library = [...order, ...owner.zones.library.filter((x) => !order.includes(x))];
  if (order.length) log(state, ctx, d.chooser, `${pname(state, d.chooser)} puts ${order.length === 1 ? 'the card' : `the ${order.length} cards`} back on top of ${d.owner === d.chooser ? 'their' : `${owner.name}'s`} library in the chosen order (${d.source}).`);
  if (!d.mayShuffle) return false;
  const q: RShuffleData = { kind: 'rshuffle', chooser: d.chooser, owner: d.owner, source: d.source, cont: d.cont };
  state.pending.push({
    id: randomId(ctx.rng), pid: d.chooser, prompt: `${d.source}: shuffle ${d.owner === d.chooser ? 'your' : `${owner.name}'s`} library?`,
    options: [{ value: 'yes', label: 'Shuffle' }, { value: 'no', label: "Don't shuffle" }], data: q as unknown as Record<string, unknown>,
  });
  return true;
}

/** The looked-at cards that weren't taken: bottom (or top) of the library, or the graveyard. */
function finishDig(state: GameState, ctx: Ctx, d: DigRest) {
  const owner = state.players.find((q) => q.pid === d.owner);
  if (!owner) return;
  let rest = d.top.filter((x) => state.cards[x]?.zone === 'library' && owner.zones.library.includes(x));
  if (d.random) {
    rest = [...rest];
    for (let k = rest.length - 1; k > 0; k--) { const j = Math.floor(ctx.rng() * (k + 1)); [rest[k], rest[j]] = [rest[j], rest[k]]; }
  }
  if (!rest.length) return;
  if (d.dest2 === 'library') {
    owner.zones.library = owner.zones.library.filter((x) => !rest.includes(x));
    if (d.toTop) owner.zones.library.unshift(...rest); else owner.zones.library.push(...rest);
    for (const x of rest) state.cards[x].revealedTo = [];
    log(state, ctx, d.owner, `${owner.name} puts ${rest.length} card${rest.length === 1 ? '' : 's'} on the ${d.toTop ? 'top' : 'bottom'} of their library (${d.source}).`);
  } else {
    for (const x of rest) {
      moveCard(state, ctx, x, d.dest2);
      const moved = state.cards[x];
      if (d.counter && moved?.zone === d.dest2) moved.counters[d.counter] = (moved.counters[d.counter] ?? 0) + 1; // Karn: "with a silver counter on it"
    }
    log(state, ctx, d.owner, `${d.source}: ${names(state, ctx, rest)} → ${d.dest2}${d.counter ? ` (with a ${d.counter} counter)` : ''}.`);
  }
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
  if (mode !== 'look' && n > 0) emit(state, { t: 'scry', pid: r.controller, mode, n });
  const verb = mode === 'scry' ? `scries ${n}` : mode === 'surveil' ? `surveils ${n}` : `looks at the top ${n}`;
  log(state, ctx, r.controller, `${me.name} ${verb} (${r.sourceName}${mode === 'look' ? `: ${step.description}` : ''}).`);
  return 'wait';
}

/**
 * Rule 406.3: a card exiled face down can't be looked at unless the effect says so (Headliner Scarlett's MayLookAt
 * static); Bomat Courier, Memory Jar: nobody sees it, not even its owner.
 */
function unseenFaceDown(r: Run): boolean {
  return !Object.values(r.svars).some((v) => /MayLookAt/.test(v));
}

/** Stage 2: a permanent's abilities remember objects across resolutions (Journey to Nowhere, Tidehollow Sculler ...). */
/** "Exiled with <source>" bookkeeping (Bomat Courier, ExiledWithSource). */
export function noteExiledWith(state: GameState, src: string | undefined, iids: string[]) {
  if (!src || !iids.length) return;
  const key = `exiled|${src}`;
  const mem = (state.remembered ??= {});
  mem[key] = [...new Set([...(mem[key] ?? []).filter((x) => state.cards[x]?.zone === 'exile'), ...iids.filter((x) => state.cards[x]?.zone === 'exile')])];
}

export function exiledWithSource(state: GameState, src: string | undefined): string[] {
  if (!src) return [];
  return [
    ...(state.remembered?.[`exiled|${src}`] ?? []),
    ...(state.remembered?.[src] ?? []),
    ...(state.effects ?? []).flatMap((e) => (e.kind === 'exiled' && e.hostIid === src ? e.cards.map((x) => x.iid) : [])),
  ].filter((x) => state.cards[x]?.zone === 'exile');
}

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
function addDelayed(state: GameState, ctx: Ctx, r: Run, at: Step, chain: { svar?: string; line?: string }, remembered: string[], text: string, extra?: { event?: Record<string, string>; thisTurn?: boolean; pid?: string }) {
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
    step: at, turn: state.turn, createdStep: state.step, auto: info, ...(extra ?? {}),
  });
  log(state, ctx, r.controller, `${r.sourceName}: delayed trigger set up (${text}).`);
}

/** AtEOT$ values: [Your](Sacrifice|Exile|Destroy|Hand|Library)[Combat|Upkeep|Ctrl] (script.ts checks them). */
export const AT_EOT_RE = /^(Your)?(Sacrifice|Exile|Destroy|Hand|Library)(Combat|Upkeep|Ctrl)?$/;

/** AtEOT$ Sacrifice / Exile / YourSacrifice / ExileCombat ...: "sacrifice it at the beginning of the (your) next end step". */
function atEndOf(state: GameState, ctx: Ctx, r: Run, iids: string[], what: string) {
  const m = AT_EOT_RE.exec(what) ?? [what, undefined, 'Exile', undefined];
  const verb = { Sacrifice: 'sacrifice', Exile: 'exile', Destroy: 'destroy', Hand: 'return to hand', Library: 'put on top of its library' }[m[2] as 'Exile'];
  const them = `the token${iids.length === 1 ? '' : 's'}`;
  const line = m[2] === 'Destroy' ? `DB$ Destroy | Defined$ DelayTriggerRemembered | SpellDescription$ Destroy ${them}.`
    : `DB$ ChangeZone | Defined$ DelayTriggerRemembered | Origin$ Battlefield | Destination$ ${{ Sacrifice: 'Graveyard', Exile: 'Exile', Hand: 'Hand', Library: 'Library' }[m[2] as 'Exile']} | SpellDescription$ ${verb[0].toUpperCase()}${verb.slice(1)} ${them}.`;
  const step: Step = m[3] === 'Combat' ? 'endCombat' : m[3] === 'Upkeep' ? 'upkeep' : 'end';
  const when = m[3] === 'Combat' ? 'end of combat' : `the beginning of ${m[1] ? 'your' : 'the'} next ${m[3] === 'Upkeep' ? 'upkeep' : 'end step'}`;
  addDelayed(state, ctx, r, step, { line }, iids, `${verb} ${names(state, ctx, iids)} at ${when}`, m[1] ? { pid: r.controller } : undefined);
}

// ------------------------------------------------------------------ steps

/** The resolution's helpers for extension steps (engine/ext.ts: Animate, Effect, Clone ...). */
function extApi(state: GameState, ctx: Ctx, r: Run, i: number, remember: (iids: string[]) => void, E: MatchEnv): StepApi {
  // "Defined$ Valid Card.token+YouCtrl": the battlefield permanents that match.
  const def = (v: string | undefined) => {
    if (!v?.startsWith('Valid ')) return defined(state, r, i, v);
    const ms = state.battlefield.map((x) => [x, matchCard(state.cards[x], v.slice(6), E)] as const);
    return ms.some(([, m]) => m === 'unknown') ? undefined : { cards: ms.filter(([, m]) => m).map(([x]) => x), players: [] };
  };
  return {
    controller: r.controller, sourceIid: r.sourceIid, sourceName: r.sourceName, item: r.item, auto: r.item.auto!, env: E,
    objects: (dflt) => (ownTargets(r, i) ? objects(state, r, i, dflt) : def(r.steps[i].params.Defined ?? dflt)),
    defined: def,
    amount: (raw, dflt) => amount(state, ctx, r, raw, dflt),
    remember, remembered: () => r.remembered,
    cont: () => contAt(r, i + 1),
    delayed: (at, line, iids, text) => addDelayed(state, ctx, r, at, { line }, iids, text),
    manual: () => manual(state, ctx, r, r.steps[i]),
  };
}

type StepResult = 'ok' | 'wait';

function execStep(state: GameState, ctx: Ctx, r: Run, i: number): StepResult {
  const step = r.steps[i];
  const p = step.params;
  const me = player(state, r.controller);
  r.cur = i;
  const reason = unsupportedReason(step);
  if (step.api === 'Effect' && p.AILogic === 'CantRegenerate') return 'ok'; // "can't be regenerated": nothing to do
  if (reason) {
    if (step.api !== 'Cleanup') manual(state, ctx, r, step);
    return 'ok';
  }
  // A triggered ability with an optional cost ("you may pay ... If you do"): asked first (Guide of Souls, Smuggler's Copter ...).
  if (i === 0 && step.kind === 'AB' && p.Cost && r.item.kind === 'trigger' && !r.costPaid) return optionalCost(state, ctx, r, step);
  // Targets for a step added while resolving (a mode / branch chosen now): asked now.
  if (step.params.ValidTgts && r.specOf[i] == null && !r.lateTargets?.[i]) return askLateTargets(state, ctx, r, i);
  // "... unless <player> pays <cost>" / UnlessSwitched "if <player> pays <cost>, ..." (also "counter it unless its controller pays").
  if (step.params.UnlessCost && r.unless?.[i] === undefined) return askUnless(state, ctx, r, i);
  // "You may put a counter ..." (Optional$ True on a step without its own choice): asked as it resolves.
  if (p.Optional === 'True' && MAY_STEPS.has(step.api) && r.unless?.[i] === undefined) return askMay(state, ctx, r, i);
  if (r.unless?.[i] === false) {
    if (p.RememberAmount === 'True') r.chosen = { ...(r.chosen ?? {}), rememberedNumber: 0 };
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
  if (EXT_APIS.has(step.api)) return execExtStep(state, ctx, step, extApi(state, ctx, r, i, remember, E)); // engine/ext.ts
  if (MORE_APIS.has(step.api) || (step.api === 'Charm' && !step.params.Modes)) { // engine/more.ts
    const res = execMoreStep(state, ctx, moreRun(state, ctx, r, i, cond === 'unknown'));
    if (res) return res;
  }

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
      if (p.DividedAsYouChoose && many && !division) return askDivision(state, ctx, r, i, n, o);
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
        let k = dmgOf(iid);
        if (!c || k <= 0) continue;
        const stopped = damagePrevented(state, ctx.lookup, iid, srcObj);
        if (stopped) { log(state, ctx, null, `Damage to ${cardName(c, ctx.lookup)} is prevented (${stopped}).`); continue; }
        k = modifiedDamage(state, ctx.lookup, iid, srcObj, k);
        damageCard(state, ctx, r, c, k, deathtouch);
        hit.push(division && many ? `${cardName(c, ctx.lookup)} (${k})` : cardName(c, ctx.lookup));
        dealt += k;
        if (srcObj) emit(state, { t: 'damage', source: srcObj, target: iid, amount: k, combat: false });
      }
      for (const pid of o.players) {
        let k = dmgOf(pid);
        if (k <= 0) continue;
        const prev = damagePrevented(state, ctx.lookup, pid, srcObj);
        if (prev) { log(state, ctx, pid, `Damage to ${pname(state, pid)} is prevented (${prev}).`); continue; }
        k = modifiedDamage(state, ctx.lookup, pid, srcObj, k);
        player(state, pid).life -= k;
        noteLife(state, pid, -k);
        hit.push(division && many ? `${pname(state, pid)} (${k})` : pname(state, pid));
        dealt += k;
        if (srcObj) emit(state, { t: 'damage', source: srcObj, target: pid, amount: k, combat: false });
      }
      log(state, ctx, r.controller, `${srcName} deals ${division && many ? '' : `${n} `}damage to ${hit.join(', ') || 'nothing'}.`);
      if (src && hasKeyword(src, ctx.lookup, 'Lifelink', state) && hit.length) {
        const gain = dealt;
        if (!lifeGainPrevented(state, src.controller, ctx.lookup)) { player(state, src.controller).life += gain; noteLife(state, src.controller, gain); }
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
        cs.forEach((c, k) => { if (ms[k] && !damagePrevented(state, ctx.lookup, c.iid, r.sourceIid)) { const m = modifiedDamage(state, ctx.lookup, c.iid, r.sourceIid, n); damageCard(state, ctx, r, c, m, false); hit.push(cardName(c, ctx.lookup)); if (r.sourceIid) emit(state, { t: 'damage', source: r.sourceIid, target: c.iid, amount: m, combat: false }); } });
      }
      if (p.ValidPlayers) for (const pl of state.players) if (!pl.conceded && matchPlayer(pl.pid, p.ValidPlayers, E) !== false && !damagePrevented(state, ctx.lookup, pl.pid, r.sourceIid)) { const m = modifiedDamage(state, ctx.lookup, pl.pid, r.sourceIid, n); pl.life -= m; noteLife(state, pl.pid, -m); hit.push(pl.name); if (r.sourceIid) emit(state, { t: 'damage', source: r.sourceIid, target: pl.pid, amount: m, combat: false }); }
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
      if (p.Origin === 'Command' && p.Defined === 'Self' && r.sourceIid?.startsWith('effect:')) {
        const id = r.sourceIid.slice(7);
        state.effects = (state.effects ?? []).filter((e) => e.id !== id);
        return 'ok';
      }
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
        // Hidden choice: search a library, or pick from hand / graveyard / exile / battlefield (one or more zones).
        let ownerPid = p.DefinedPlayer ? defined(state, r, i, p.DefinedPlayer)?.players[0] : pickFromPlayer ? targetPlayers!.players[0] : r.controller;
        // "DefinedPlayer$ Targeted" after a creature-target step (Cloak and Dagger): the player targeted earlier in the chain.
        if (!ownerPid && p.DefinedPlayer === 'Targeted') ownerPid = r.targets.flat().find((t) => t.kind === 'player')?.pid;
        if (!ownerPid) { log(state, ctx, r.controller, `${r.sourceName}: no player to choose from.`); return 'ok'; }
        const chooser = player(state, ownerPid);
        const chooserPid = p.Chooser === 'You' ? r.controller : ownerPid;
        const search = origins.includes('library');
        const origin = origins.find((z) => z !== 'library') ?? origins[0];
        if (!origin) return bad();
        // ChangeType with run-level properties: "targetedBy" (Cloak and Dagger), "inZoneHand".
        const targeted = new Set(r.targets.flat().map((t) => (t.kind === 'card' ? t.iid : '')).filter(Boolean));
        const alts = (p.ChangeType ?? 'Card').split(',').map((a) => ({ targetedBy: /targetedBy/.test(a), valid: a.replace(/\+?targetedBy/, '').replace(/\.$/, '') || 'Card' }));
        const fits = (x: string) => alts.some((a) => (!a.targetedBy || targeted.has(x)) && matchCard(state.cards[x], a.valid, E) !== false);
        const pool: string[] = [];
        for (const z of origins) {
          if (z === 'battlefield') pool.push(...state.battlefield.filter((x) => /YouCtrl|OppCtrl|YouOwn|targetedBy/.test(p.ChangeType ?? '') || state.cards[x].controller === ownerPid));
          else if (z !== 'stack') pool.push(...chooser.zones[z as 'hand']);
        }
        const cands = pool.filter((x) => state.cards[x] && fits(x));
        const n = p.ChangeNum === 'All' ? cands.length : amount(state, ctx, r, p.ChangeNum, 1);
        if (n == null) return bad();
        if (search) {
          emit(state, { t: 'searched', pid: chooserPid, owner: ownerPid } as never);
          log(state, ctx, chooserPid, `${pname(state, chooserPid)} searches ${chooserPid === ownerPid ? 'their' : `${chooser.name}'s`} library (${r.sourceName}).`);
        }
        if (!cands.length || n <= 0) {
          log(state, ctx, chooserPid, `${r.sourceName}: no card to choose.`);
          if (search && p.Shuffle !== 'False') shuffleLibrary(state, chooser, ctx.rng);
          return 'ok';
        }
        const host = untilHostLeaves(state, r, p, dest);
        if (host === 'gone') { log(state, ctx, r.controller, `${r.sourceName} already left the battlefield — nothing is exiled.`); return 'ok'; }
        const yours = ownerPid === chooserPid ? 'your' : `${chooser.name}'s`;
        if (origin === 'hand' && ownerPid !== chooserPid) {
          revealHandTo(state, chooserPid, ownerPid);
          log(state, ctx, r.controller, `${chooser.name} reveals their hand to ${pname(state, chooserPid)}${p.Hidden ? '' : `: ${names(state, ctx, chooser.zones.hand)}`}.`);
        }
        const where = dest === 'library' ? (p.LibraryPosition === '-1' ? `on the bottom of ${yours} library` : `on top of ${yours} library`) : `to ${dest === 'battlefield' ? 'the battlefield' : dest === 'exile' ? 'exile' : `${yours} ${dest}`}`;
        const optional = search ? p.Mandatory !== 'True' && (p.ChangeType ?? 'Card') !== 'Card' || p.Optional === 'True'
          : p.Mandatory !== 'True' && (origin !== 'hand' || p.Optional === 'True' || !/^\d+$/.test(p.ChangeNum ?? '1')
            // "You may exile a nonland card from their hand or the chosen creature" (Cloak and Dagger).
            || alts.some((a) => a.targetedBy));
        const created = startPicks(state, ctx, [{
          kind: 'pick', action: 'move', chooser: chooserPid, candidates: cands, left: Math.min(n, cands.length), optional,
          dest, params: p, ...(host ? { untilHost: host } : {}), ...(origin === 'hand' && ownerPid !== chooserPid ? { reveal: ownerPid } : {}),
          ...(search && p.Shuffle !== 'False' ? { shuffle: ownerPid } : {}),
          label: `${r.sourceName}: ${search ? `search for ${p.ChangeTypeDesc ? `a ${p.ChangeTypeDesc}` : 'a card'} to put` : 'choose a card to put'} ${where}${dest === 'library' && n > 1 ? ' (the last one you choose ends up on top)' : ''}`,
        }], contAt(r, i + 1));
        if (!created && search && p.Shuffle !== 'False') shuffleLibrary(state, chooser, ctx.rng);
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
        // A card revealed to everyone (Atraxa's PeekAndReveal) stays revealed as it goes from the library to the hand.
        const shown = from === 'library' && dest === 'hand' && state.players.every((q) => c.revealedTo.includes(q.pid));
        moveTo(state, ctx, r, iid, dest, p);
        if (shown && state.cards[iid]?.zone === 'hand') state.cards[iid].revealedTo = state.players.map((q) => q.pid);
        moved.push(nm);
        if (untilHost && state.cards[iid]?.zone === 'exile') exiled.push({ iid, from, owner: c.owner });
      }
      if (untilHost && exiled.length) addEffect(state, ctx, { kind: 'exiled', controller: r.controller, until: 'hostLeaves', hostIid: untilHost, cards: exiled });
      remember(cards.filter((x) => state.cards[x]));
      if (p.Imprint === 'True') r.chosen = { ...(r.chosen ?? {}), imprinted: cards.filter((x) => state.cards[x]) };
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
        const dp = p.Defined ?? p.DefinedPlayer; // DefinedPlayer$ Targeted (Strategic Betrayal)
        const ps = own ? split(state, own).players : dp ? defined(state, r, i, dp)?.players : state.players.filter((x) => !x.conceded).map((x) => x.pid);
        if (!ps) return bad();
        pool.push(...ps.flatMap((pid) => [...player(state, pid).zones[origin as 'hand']]));
      }
      // "Card.IsRemembered": the cards this chain remembered (Scroll Rack puts the exiled cards back).
      const ms = valid === 'Card.IsRemembered' ? pool.map((x) => [x, r.remembered.includes(x)] as const) : pool.map((x) => [x, matchCard(state.cards[x], valid, E)] as const);
      if (ms.some(([, m]) => m === 'unknown')) return bad();
      const list = ms.filter(([, m]) => m).map(([x]) => x);
      // RandomOrder$ True (Atraxa: "put the rest on the bottom of your library in a random order").
      if (p.RandomOrder === 'True') for (let k = list.length - 1; k > 0; k--) { const j = Math.floor(ctx.rng() * (k + 1)); [list[k], list[j]] = [list[j], list[k]]; }
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
      if (p.TokenAttacking) for (const iid of made) if (state.cards[iid]) enterAttacking(state, ctx, state.cards[iid], r.sourceIid);
      if (p.AtEOT && made.length) atEndOf(state, ctx, r, made, p.AtEOT);
      // PumpKeywords$ Haste | PumpDuration$ EOT: "it gains haste until end of turn" (permanent without PumpDuration$).
      if (p.PumpKeywords) for (const iid of made) {
        const c = state.cards[iid];
        if (!c) continue;
        const kws = p.PumpKeywords.split('&').map((k) => k.trim()).filter(Boolean);
        if (/^(EOT|EndOfTurn)$/.test(p.PumpDuration ?? '')) c.tempKeywords = [...new Set([...(c.tempKeywords ?? []), ...kws])];
        else (c.animations ??= []).push({ id: randomId(ctx.rng), controller: r.controller, until: p.PumpDuration === 'UntilYourNextTurn' ? 'yourNextTurn' : 'permanent', turn: state.turn, keywords: kws });
      }
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
    case 'DelayedTrigger': {
      const evented = p.Mode !== 'Phase' && ['SpellCast', 'ChangesZone'].includes(p.Mode ?? '');
      const at = evented ? state.step : PHASES[(p.Phase ?? '').replace(/->$/, '')];
      if (!at || !p.Execute) return bad();
      const objs = p.RememberObjects ? defined(state, r, i, p.RememberObjects) : undefined;
      const rememberedNow = objs ? objs.cards : [];
      let extra: { event?: Record<string, string>; thisTurn?: boolean; pid?: string } | undefined;
      // "During its controller's next turn" (Gideon, Battle-Forged +2): fires in the remembered creature's controller's turn.
      if (p.ValidPlayer === 'Player.controlsCard.IsTriggerRemembered') {
        const c = rememberedNow.map((x) => state.cards[x]).find((x) => x?.zone === 'battlefield');
        if (!c) { log(state, ctx, r.controller, `${r.sourceName}: no target — nothing happens.`); return 'ok'; }
        extra = { pid: c.controller };
      }
      if (evented) {
        const event: Record<string, string> = {};
        for (const [k, v] of Object.entries(p)) if (!['Execute', 'ThisTurn', 'RememberObjects', 'TriggerDescription', 'SpellDescription', 'StackDescription', 'Cost', 'AILogic', 'SubAbility', 'Defined', 'Optional'].includes(k)) event[k] = v;
        extra = { event, ...(p.ThisTurn === 'True' ? { thisTurn: true } : {}) };
      }
      addDelayed(state, ctx, r, at, { svar: p.Execute }, rememberedNow, describe(p.TriggerDescription ?? p.SpellDescription ?? 'Delayed trigger', r.sourceName), extra);
      return 'ok';
    }
    case 'ImmediateTrigger': {
      if (!p.Execute) return bad();
      const auto = r.item.auto!;
      const text = describe(p.TriggerDescription ?? p.SpellDescription ?? 'Reflexive trigger', r.sourceName);
      const times = p.TriggerAmount === 'Remembered$Amount' ? r.remembered.length : 1;
      const rememberedAmount = p.RememberSVarAmount ? amount(state, ctx, r, p.RememberSVarAmount, 0) : undefined;
      for (let k = 0; k < times; k++) (state.triggerQueue ??= []).push({
        id: randomId(ctx.rng), controller: r.controller, sourceIid: r.sourceIid, sourceName: r.sourceName, text: `${r.sourceName}: ${text}`,
        auto: { cardId: auto.cardId, face: auto.face, source: 'trigger', index: -1, svar: p.Execute, targets: [], trigger: { ...(r.trig ?? {}), mode: 'Immediate', remembered: [...r.remembered], lki: { ...r.lki }, ...(rememberedAmount != null ? { amount: rememberedAmount } : {}) } },
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
        // "Creature.targetedBy": the chain's targets (Guide of Souls).
        const targetedBy = /\+?targetedBy\b/.test(p.ValidCards ?? '');
        const valid = (p.ValidCards ?? 'Card').replace(/\+?targetedBy\b/, '').replace(/\.$/, '') || 'Card';
        const pool = targetedBy ? r.targets.flat().filter((t) => t.kind === 'card').map((t) => (t as { iid: string }).iid).filter((x) => state.battlefield.includes(x)) : state.battlefield;
        const ms = pool.map((x) => [x, matchCard(state.cards[x], valid, E)] as const);
        if (ms.some(([, m]) => m === 'unknown')) return bad();
        o = { cards: ms.filter(([, m]) => m).map(([x]) => x), players: [] };
      } else o = objects(state, r, i, 'Self');
      if (!o) return bad();
      // CounterType2$ / CounterNum2$: a second kind of counter (Guide of Souls' flying counter).
      const kinds: [string, number][] = [[kind, n]];
      if (p.CounterType2) kinds.push([counterKind(p.CounterType2), amount(state, ctx, r, p.CounterNum2, 1) ?? 1]);
      for (const [k, num] of kinds) {
        for (const iid of o.cards) {
          const c = state.cards[iid];
          if (!c) continue;
          const m = counterAmount(state, ctx, c, k, num);
          c.counters[k] = (c.counters[k] ?? 0) + m;
          if (p.RememberAmount === 'True') r.chosen = { ...(r.chosen ?? {}), rememberedNumber: (r.chosen?.rememberedNumber ?? 0) + m };
          if (m > 0) emit(state, { t: 'counterAdded', iid, kind: k, n: m });
          log(state, ctx, r.controller, `${cardName(c, ctx.lookup)} gets ${m} ${k} counter${m === 1 ? '' : 's'} (now ${c.counters[k]}).`);
        }
        for (const pid of o.players) {
          const pl = player(state, pid);
          pl.counters[k] = (pl.counters[k] ?? 0) + num;
          log(state, ctx, pid, `${pl.name} gets ${num} ${k} counter${num === 1 ? '' : 's'} (now ${pl.counters[k]}).`);
        }
      }
      return 'ok';
    }
    case 'GainLife': case 'LoseLife': case 'SetLife': {
      const n = amount(state, ctx, r, p.LifeAmount, 0);
      const o = objects(state, r, i, 'You');
      if (n == null || !o) return bad();
      for (const pid of o.players) {
        const pl = player(state, pid);
        if (step.api === 'GainLife') {
          const no = lifeGainPrevented(state, pid, ctx.lookup);
          if (no) { log(state, ctx, pid, `${pl.name} can't gain life (${no}).`); continue; }
          pl.life += n; noteLife(state, pid, n);
        }
        else if (step.api === 'LoseLife') { pl.life -= n; noteLife(state, pid, -n); }
        else { noteLife(state, pid, n - pl.life); pl.life = n; }
        const verb = step.api === 'GainLife' ? `gains ${n} life` : step.api === 'LoseLife' ? `loses ${n} life` : `has their life total set to ${n}`;
        log(state, ctx, pid, `${pl.name} ${verb} (${pl.life}).`);
      }
      return 'ok';
    }
    case 'Counter': {
      const refs = p.Defined === 'TriggeredStackItem' ? (r.trig?.source ? [{ kind: 'stack', id: r.trig.source } as TargetRef] : [])
        : ownTargets(r, i) ?? (p.Defined ? (defined(state, r, i, p.Defined)?.cards ?? []).map((iid) => ({ kind: 'card', iid }) as TargetRef) : []);
      for (const ref of refs) {
        const item = ref.kind === 'stack' ? state.stack.find((s) => s.id === ref.id) : ref.kind === 'card' ? state.stack.find((s) => s.iid === ref.iid) : undefined;
        if (!item) continue;
        const uncounterable = cantBeCountered(state, ctx, item);
        if (uncounterable) { log(state, ctx, r.controller, `${item.text} can't be countered — ${uncounterable}`); continue; }
        if (p.UnlessCost && r.unless?.[i] === undefined) { // decided by askUnless (paycost.ts) normally
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
        if (p.RememberCountered) remember([item.sourceIid ?? item.iid ?? ''].filter((x) => state.cards[x]));
      }
      return 'ok';
    }
    case 'Pump': case 'PumpAll': {
      if (p.PumpZone && !p.KW) {
        // A pump that only names targets / remembers them (Goblin Welder's "target artifact card in that graveyard").
        if (p.ImprintCards) r.chosen = { ...(r.chosen ?? {}), imprinted: defined(state, r, i, p.ImprintCards)?.cards ?? [] };
        if (p.RememberObjects) remember(defined(state, r, i, p.RememberObjects)?.cards ?? []);
        return 'ok';
      }
      if (p.PumpZone) {
        // "Target card in your graveyard gains flashback until end of turn" (Snapcaster Mage): a cast permission.
        const o = objects(state, r, i, 'Self');
        for (const iid of o?.cards ?? []) {
          const c = state.cards[iid];
          if (!c || c.zone === 'battlefield') continue;
          addEffect(state, ctx, { kind: 'grant', controller: r.controller, until: 'eot', iid, zone: c.zone, keyword: p.KW, source: r.sourceName });
          log(state, ctx, r.controller, `${cardName(c, ctx.lookup)} gains ${p.KW.toLowerCase()} until end of turn (${r.sourceName}).`);
        }
        return 'ok';
      }
      // "Double target creature's power": +X/+0 where X is its power (per creature, below).
      const dbl = (v: string | undefined) => /^\+?Double$/.test(v ?? '');
      const a = dbl(p.NumAtt) ? 0 : amount(state, ctx, r, p.NumAtt, 0);
      const d = dbl(p.NumDef) ? 0 : amount(state, ctx, r, p.NumDef, 0);
      if (a == null || d == null) return bad();
      const kws = p.KW ? p.KW.split('&').map((k) => k.trim().replace(/^HIDDEN /, '')).filter(Boolean) : [];
      let cards: string[];
      if (step.api === 'PumpAll') {
        const ms = state.battlefield.map((x) => [x, matchCard(state.cards[x], p.ValidCards ?? 'Creature', E)] as const);
        if (ms.some(([, m]) => m === 'unknown')) return bad();
        cards = ms.filter(([, m]) => m).map(([x]) => x);
      } else {
        const o = objects(state, r, i, 'Self');
        if (!o) return bad();
        cards = o.cards;
        // "You gain protection from everything / hexproof until your next turn" (The One Ring, Teferi's Protection-style pumps on players).
        if (o.players.length && kws.length) {
          const until = /UntilYourNextTurn|UntilUntaps/.test(p.Duration ?? '') ? 'yourNextTurn' as const : 'eot' as const;
          for (const pid of o.players) {
            addEffect(state, ctx, { kind: 'playerKw', controller: r.controller, until, pid, keywords: kws, turn: state.turn });
            log(state, ctx, pid, `${pname(state, pid)} gains ${kws.join(', ').toLowerCase()} ${until === 'eot' ? 'until end of turn' : 'until their next turn'} (${r.sourceName}).`);
          }
        }
      }
      const hit: string[] = [];
      for (const iid of cards) {
        const c = onBattlefield(state, iid);
        if (!c) continue;
        const [pw, tg] = dbl(p.NumAtt) || dbl(p.NumDef) ? effectivePT(c, ctx.lookup, state) : [0, 0];
        c.tempPT = [c.tempPT[0] + a + (dbl(p.NumAtt) ? pw : 0), c.tempPT[1] + d + (dbl(p.NumDef) ? tg : 0)];
        if (kws.length) c.tempKeywords = [...new Set([...(c.tempKeywords ?? []), ...kws])];
        hit.push(cardName(c, ctx.lookup));
      }
      const bits = [dbl(p.NumAtt) || dbl(p.NumDef) ? `ha${hit.length === 1 ? 's its' : 've their'} ${dbl(p.NumAtt) && dbl(p.NumDef) ? 'power and toughness' : dbl(p.NumAtt) ? 'power' : 'toughness'} doubled` : '', (a || d) ? `get${hit.length === 1 ? 's' : ''} ${a >= 0 ? '+' : ''}${a}/${d >= 0 ? '+' : ''}${d}` : '', kws.length ? `gain${hit.length === 1 ? 's' : ''} ${kws.join(', ')}` : ''].filter(Boolean).join(' and ');
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
        if (p.Mode === 'Defined') { // DefinedCards$ (Concealing Curtains: the chosen card)
          const ids = (defined(state, r, i, p.DefinedCards)?.cards ?? []).filter((x) => pl.zones.hand.includes(x));
          const nm = names(state, ctx, ids);
          for (const iid of ids) moveCard(state, ctx, iid, 'graveyard', { cause: 'discard' });
          remember(ids);
          if (ids.length) log(state, ctx, pid, `${pl.name} discards ${nm}.`);
          continue;
        }
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
          revealHandTo(state, r.controller, pid);
          log(state, ctx, r.controller, `${pl.name} reveals their hand: ${names(state, ctx, pl.zones.hand)}.${cands.length ? ` ${me.name} chooses a card to discard.` : ''}`);
          if (!cands.length) { log(state, ctx, r.controller, `${r.sourceName}: no ${p.DiscardValidDesc ?? 'valid card'} to choose.`); continue; }
          picks.push({ kind: 'pick', action: 'discard', chooser: r.controller, candidates: cands, left: Math.min(n, cands.length), optional: false, reveal: pid, label: `${r.sourceName}: choose ${p.DiscardValidDesc ? `a ${p.DiscardValidDesc.replace(/ from it/, '')}` : 'a card'} for ${pl.name} to discard` });
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
        const ids: string[] = [];
        // One at a time: a replacement may shuffle the library (Emrakul), which re-keys its cards.
        for (let k = 0; k < n && pl.zones.library.length; k++) { const iid = pl.zones.library[0]; ids.push(iid); moveCard(state, ctx, iid, 'graveyard'); }
        all.push(...ids.filter((x) => state.cards[x]));
        log(state, ctx, pid, `${pl.name} mills ${names(state, ctx, ids)}.`);
      }
      remember(all);
      return 'ok';
    }
    case 'Dig': if (p.ChangeNum !== 'All') return digChoose(state, ctx, r, i, me, E) ?? peekStep(state, ctx, r, i, me);
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
          else moveCard(state, ctx, iid, dest, { faceDown: dest === 'exile' && p.ExileFaceDown === 'True', unseen: unseenFaceDown(r) });
          if (dest === 'exile') noteExiledWith(state, r.sourceIid, [iid]);
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
    case 'Scry': case 'Surveil': return peekStep(state, ctx, r, i, me);
    case 'RearrangeTopOfLibrary': return rearrangeStep(state, ctx, r, i, me);
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
      // "Combo Any" / "Combo W U": each mana its own color choice (Coalition Relic).
      const combo = /^Combo (.+)$/.exec(p.Produced ?? '');
      if (combo) {
        const colors = combo[1].trim() === 'Any' ? ['W', 'U', 'B', 'R', 'G'] : combo[1].trim().split(/\s+/).filter((c) => /^[WUBRGC]$/.test(c));
        if (!colors.length) return bad();
        if (colors.length === 1) { me.manaPool[colors[0]] = (me.manaPool[colors[0]] ?? 0) + n; log(state, ctx, r.controller, `${me.name} adds ${Array(n).fill(`{${colors[0]}}`).join('')}.`); return 'ok'; }
        askColor(state, ctx, r.controller, r.sourceName, { kind: 'color', n: 1, more: n - 1, colors, cont: contAt(r, i + 1) });
        return 'wait';
      }
      if (p.Produced === 'Any') {
        const data: ColorData = { kind: 'color', n, cont: contAt(r, i + 1) };
        state.pending.push({
          id: randomId(ctx.rng), pid: r.controller, prompt: `${r.sourceName}: add ${n} mana of any one color`,
          options: ['W', 'U', 'B', 'R', 'G'].map((c) => ({ value: c, label: `{${c}}` })), data: data as unknown as Record<string, unknown>,
        });
        return 'wait';
      }
      // Produced$ Chosen: the color chosen for the source (ChooseColor earlier in the chain: Foraging Wickermaw).
      const chosenWord = p.Produced === 'Chosen' && r.sourceIid ? state.cards[r.sourceIid]?.chosen?.color : undefined;
      if (p.Produced === 'Chosen' && !chosenWord) return bad();
      const syms = chosenWord ? [({ White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G' } as Record<string, string>)[chosenWord] ?? 'C'] : (p.Produced ?? '').split(' ');
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
      const o = p.Defined ? defined(state, r, i, p.Defined) : undefined;
      const who = o?.players[0] ?? r.controller;
      if (step.api === 'BecomeMonarch') becomeMonarch(state, ctx, who); else takeInitiative(state, ctx, who); // engine/designations.ts
      return 'ok';
    }
    case 'RevealHand': {
      const o = objects(state, r, i, 'You');
      if (!o) return bad();
      for (const pid of o.players) {
        revealHandTo(state, r.controller, pid);
        log(state, ctx, r.controller, `${pname(state, pid)} reveals their hand: ${names(state, ctx, player(state, pid).zones.hand)}.`);
      }
      return 'ok';
    }
  }
  if (KEYWORD_APIS.has(step.api)) { execKeywordStep(state, ctx, step, r); return 'ok'; }
  if (isSimpleAnimate(step)) return execUniqueStep(state, ctx, uniqueRun(state, ctx, r, i, cond === 'unknown')) ?? bad();
  return bad();
}

// ------------------------------------------------------------------ optional costs of triggered abilities

function optionalCost(state: GameState, ctx: Ctx, r: Run, step: ParsedAbility): StepResult {
  const { toks, mandatory, unknown } = parseCostTokens(step.params.Cost);
  if (unknown.length) { manual(state, ctx, r, step); return 'ok'; }
  const x = r.svars.X && !/xPaid/.test(r.svars.X) ? amount(state, ctx, r, 'X', 0) ?? 0 : 0;
  const label = costText(toks);
  const cont = contAt(r, 0);
  cont.costPaid = true;
  const times = toks.find((t) => t.kind === 'manaTimes');
  if (times) {
    const max = timesPayable(state, r.controller, times.mana ?? '', 10, ctx.lookup);
    const data: OptCostData = { kind: 'optcost', cont, cost: step.params.Cost, x, times: true, label };
    state.pending.push({
      id: randomId(ctx.rng), pid: r.controller, prompt: `${r.sourceName}: ${label.charAt(0).toLowerCase()}${label.slice(1)} — how many times? (you can afford ${max})`,
      options: Array.from({ length: max + 1 }, (_v, k) => ({ value: String(k), label: k === 0 ? "Don't pay" : `${k} time${k === 1 ? '' : 's'}` })),
      number: { min: 0, max }, data: data as unknown as Record<string, unknown>,
    });
    return 'wait';
  }
  const payable = canPayCost(state, ctx, r.controller, r.sourceIid, toks, x);
  if (mandatory) {
    if (!payable) { log(state, ctx, r.controller, `${r.sourceName}: can't ${label.toLowerCase()} — nothing happens.`); return 'wait'; }
    payOptional(state, ctx, { kind: 'optcost', cont, cost: step.params.Cost, x, label }, 1);
    return 'wait';
  }
  const data: OptCostData = { kind: 'optcost', cont, cost: step.params.Cost, x, label };
  const options = payable ? [{ value: 'pay', label }, { value: 'decline', label: "Don't" }] : [{ value: 'decline', label: `Can't pay (${label.toLowerCase()})` }];
  state.pending.push({ id: randomId(ctx.rng), pid: r.controller, prompt: `${r.sourceName}: ${label.toLowerCase()}? (${step.description})`, options, data: data as unknown as Record<string, unknown> });
  return 'wait';
}

/** Pay an optional cost and continue the chain (after the cost's choices). Returns true when a question was asked. */
function payOptional(state: GameState, ctx: Ctx, d: OptCostData, times: number): boolean {
  const { toks } = parseCostTokens(d.cost);
  const pid = d.cont.item.controller;
  const src = d.cont.item.sourceIid ?? d.cont.item.iid;
  const choices = payCostNow(state, ctx, pid, src, toks, d.x, times);
  if (d.times && d.cont.item.auto) d.cont.item.auto.extra = { ...(d.cont.item.auto.extra ?? {}), NumTimes: String(times) };
  if (choices.some((c) => c.kind === 'tapType' && c.upTo) && d.cont.item.auto) { d.cont.item.auto.x = 0; d.cont.item.x = 0; }
  const name = d.cont.item.text.split(':')[0];
  const picks = costPicks(choices, pid, name);
  if (startPicks(state, ctx, picks, d.cont)) return true;
  runFrom(state, ctx, d.cont);
  return false;
}

function answerOptionalCost(state: GameState, ctx: Ctx, pid: string, d: OptCostData, value: string) {
  const who = player(state, pid).name;
  const name = d.cont.item.text.split(':')[0];
  if (d.times) {
    const n = parseInt(value, 10) || 0;
    if (n <= 0) { log(state, ctx, pid, `${who} doesn't pay (${name}).`); return; }
    payOptional(state, ctx, d, n);
    return;
  }
  if (value !== 'pay') { log(state, ctx, pid, `${who} doesn't ${d.label.toLowerCase()} (${name}).`); return; }
  const { toks } = parseCostTokens(d.cost);
  if (!canPayCost(state, ctx, pid, d.cont.item.sourceIid ?? d.cont.item.iid, toks, d.x)) { log(state, ctx, pid, `${who} can no longer ${d.label.toLowerCase()} (${name}).`); return; }
  payOptional(state, ctx, d, 1);
}

// ------------------------------------------------------------------ targets chosen while resolving

interface LateData { kind: 'late'; cont: AutoCont; step: number }
interface DivideData { kind: 'divide'; cont: AutoCont; total: number; keys: string[] }

/** Divided damage whose division wasn't given at cast time (e.g. triggered Fury): the controller divides it now. */
function askDivision(state: GameState, ctx: Ctx, r: Run, i: number, total: number, o: { cards: string[]; players: string[] }): StepResult {
  const targets = [
    ...o.cards.filter((iid) => state.cards[iid]).map((iid) => ({ key: iid, label: cardName(state.cards[iid], ctx.lookup) })),
    ...o.players.map((pid) => ({ key: pid, label: pname(state, pid) })),
  ];
  const keys = targets.map((t) => t.key);
  if (total < keys.length) { // can't give each at least 1: put it all on the first
    r.item.auto = { ...(r.item.auto ?? { cardId: '', index: 0 }), division: { [keys[0]]: total } } as typeof r.item.auto;
    return execStep(state, ctx, r, i);
  }
  const even: Record<string, number> = {};
  keys.forEach((k, j) => { even[k] = Math.floor(total / keys.length) + (j < total % keys.length ? 1 : 0); });
  const data: DivideData = { kind: 'divide', cont: contAt(r, i), total, keys };
  state.pending.push({
    id: randomId(ctx.rng), pid: r.controller, prompt: `${r.sourceName}: divide ${total} damage among ${targets.map((t) => t.label).join(', ')}`,
    options: [{ value: JSON.stringify(even), label: targets.map((t) => `${t.label}: ${even[t.key]}`).join(', ') }],
    data: data as unknown as Record<string, unknown>, divide: { total, min: 1, targets },
  });
  return 'wait';
}

function answerDivision(state: GameState, ctx: Ctx, data: DivideData, value: string): string | null {
  let d: Record<string, number>;
  try { d = JSON.parse(value) as Record<string, number>; } catch { return 'Expected a JSON division'; }
  if (!d || typeof d !== 'object') return 'Expected a JSON division';
  const keys = Object.keys(d);
  if (keys.some((k) => !data.keys.includes(k))) return 'Unknown target in division';
  if (data.keys.some((k) => !(k in d))) return 'Every target must get some damage';
  if (Object.values(d).some((v) => !Number.isInteger(v) || v < 1)) return 'Each target must get at least 1 damage';
  if (Object.values(d).reduce((a, b) => a + b, 0) !== data.total) return `The division must total ${data.total}`;
  const auto = data.cont.item.auto;
  data.cont.item.auto = { ...(auto ?? { cardId: '', index: 0 }), division: d } as typeof auto;
  runFrom(state, ctx, data.cont);
  return null;
}

function candidatesFor(state: GameState, ctx: Ctx, spec: TargetSpec, controller: string, sourceIid: string | undefined): TargetRef[] {
  const refs: TargetRef[] = [];
  if (spec.players) for (const p of state.players) refs.push({ kind: 'player', pid: p.pid });
  if (spec.zone === 'stack') for (const s of state.stack) refs.push({ kind: 'stack', id: s.id });
  else if (spec.cards) for (const iid of Object.keys(state.cards)) refs.push({ kind: 'card', iid });
  return refs.filter((ref) => isValidTarget(state, spec, ref, controller, sourceIid, ctx.lookup));
}

/** A step added while resolving targets something: ask for its targets now (forced choices are made automatically). */
function askLateTargets(state: GameState, ctx: Ctx, r: Run, i: number): StepResult {
  const step = r.steps[i];
  const spec = targetSpecs({ ...step, sub: undefined })[0];
  const cands = spec ? candidatesFor(state, ctx, spec, r.controller, r.sourceIid) : [];
  if (!spec || cands.length <= spec.min) {
    if (spec && cands.length < spec.min) log(state, ctx, r.controller, `${r.sourceName}: no legal target${spec.min === 1 ? '' : 's'} for "${step.description}".`);
    r.lateTargets = { ...(r.lateTargets ?? {}), [i]: cands };
    return execStep(state, ctx, r, i);
  }
  const data: LateData = { kind: 'late', cont: contAt(r, i), step: i };
  state.pending.push({
    id: randomId(ctx.rng), pid: r.controller, prompt: `${r.sourceName}: ${step.description} — choose target${spec.max > 1 ? 's' : ''}`,
    options: spec.min === 0 ? [{ value: 'none', label: 'No target' }] : [], data: data as unknown as Record<string, unknown>,
    targets: { specs: [spec], sourceIid: r.sourceIid, controller: r.controller, label: r.sourceName },
  });
  return 'wait';
}

/** Answer (chooseTargets) to a question asked while resolving: late targets, or a more.ts question (cast / copy targets). */
export function answerResolveTargets(state: GameState, ctx: Ctx, pend: Pending, targets: TargetRef[][]): string | null {
  const more = answerMoreTargets(state, ctx, pend, targets);
  if (more !== undefined) return more;
  const d = pend.data as unknown as LateData;
  if (d.kind !== 'late') return 'That question does not take targets';
  const r = makeRun(state, ctx, d.cont);
  const step = r?.steps[d.step];
  if (!r || !step) { state.pending = state.pending.filter((p) => p !== pend); return null; }
  const res = checkTargets(state, { ...step, sub: undefined }, undefined, targets, r.controller, r.sourceIid ?? '', ctx, r.sourceName);
  if ('error' in res) return res.error;
  state.pending = state.pending.filter((p) => p !== pend);
  d.cont.lateTargets = { ...(d.cont.lateTargets ?? {}), [d.step]: res.targets[0] ?? [] };
  for (const ref of res.targets.flat()) if (ref.kind === 'card' && state.cards[ref.iid]) d.cont.lki[ref.iid] = lkiOf(state.cards[ref.iid], ctx, state);
  runFrom(state, ctx, d.cont);
  return null;
}

// ------------------------------------------------------------------ "unless <player> pays <cost>"

interface Unless2Data { kind: 'unless2'; cont: AutoCont; step: number; cost: string; switched: boolean; payer: string; x: number; label: string; may?: boolean }

/** "DefinedCost_Remembered_Minus2" (Flash): the remembered card's mana cost, reduced. */
function definedCost(state: GameState, ctx: Ctx, r: Run, raw: string): string | undefined {
  const m = /^DefinedCost_Remembered(?:_Minus(\d+))?$/.exec(raw.trim());
  if (!m) return undefined;
  const c = state.cards[r.remembered[0]];
  if (!c) return '';
  let less = parseInt(m[1] ?? '0', 10) || 0;
  const syms = (faceOf(c, ctx.lookup).manaCost.match(/\{[^}]+\}/g) ?? []).map((s) => s.slice(1, -1));
  const out: string[] = [];
  for (const s of syms) {
    if (/^\d+$/.test(s)) { const v = Math.max(0, parseInt(s, 10) - less); less = Math.max(0, less - parseInt(s, 10)); if (v) out.push(String(v)); } else out.push(s);
  }
  return out.join(' ');
}

function askUnless(state: GameState, ctx: Ctx, r: Run, i: number): StepResult {
  const step = r.steps[i];
  const p = step.params;
  const stackRef = p.Defined === 'TriggeredStackItem' ? state.stack.find((s) => s.id === r.trig?.source) : undefined;
  const payer = (stackRef?.controller ?? (p.UnlessPayer ? defined(state, r, i, p.UnlessPayer)?.players[0] : defined(state, r, i, 'TargetedController')?.players[0])) ?? r.controller;
  if (step.api === 'Counter' && p.Defined === 'TriggeredStackItem' && !stackRef) { r.unless = { ...(r.unless ?? {}), [i]: false }; return 'ok'; }
  const cost = definedCost(state, ctx, r, p.UnlessCost) ?? p.UnlessCost;
  const x = /X/.test(cost) ? amount(state, ctx, r, 'X', 0) ?? 0 : 0;
  const { toks } = parseCostTokens(cost);
  const switched = p.UnlessSwitched === 'True';
  const decide = (run: boolean): StepResult => { r.unless = { ...(r.unless ?? {}), [i]: run }; return run ? execStep(state, ctx, r, i) : 'ok'; };
  const free = toks.every((t) => (t.kind === 'mana' && !(t.mana ?? '').replace(/\{0\}/g, '').replace(/\{X\}/g, x ? '{X}' : '')) || (typeof t.n === 'number' ? t.n === 0 : x === 0));
  if (!toks.length || free) return decide(switched);
  const label = costText(toks).replace(/\{X\}/g, `{${x}}`).replace(/<X>/g, String(x));
  const payable = canPayCost(state, ctx, payer, r.sourceIid, toks, x);
  if (!payable) {
    log(state, ctx, payer, `${pname(state, payer)} can't ${label.toLowerCase()} (${r.sourceName}).`);
    return decide(!switched);
  }
  const data: Unless2Data = { kind: 'unless2', cont: contAt(r, i), step: i, cost, switched, payer, x, label };
  const what = step.description && step.description !== step.api ? step.description : r.sourceName;
  state.pending.push({
    id: randomId(ctx.rng), pid: payer,
    prompt: switched ? `${r.sourceName}: ${label.toLowerCase()}? If you do: ${what}` : `${r.sourceName}: ${label.toLowerCase()}, or else: ${what}`,
    options: [{ value: 'pay', label }, { value: 'decline', label: "Don't pay" }], data: data as unknown as Record<string, unknown>,
  });
  return 'wait';
}

/** Steps whose Optional$ True is a plain "you may" asked before the step runs. */
const MAY_STEPS = new Set(['PutCounter']);

function askMay(state: GameState, ctx: Ctx, r: Run, i: number): StepResult {
  const step = r.steps[i];
  const what = step.description && step.description !== step.api ? step.description : `${step.api} (${r.sourceName})`;
  const data: Unless2Data = { kind: 'unless2', cont: contAt(r, i), step: i, cost: '', switched: true, payer: r.controller, x: 0, label: what, may: true };
  state.pending.push({
    id: randomId(ctx.rng), pid: r.controller, prompt: `${r.sourceName}: ${what}?`,
    options: [{ value: 'pay', label: 'Yes' }, { value: 'decline', label: 'No' }], data: data as unknown as Record<string, unknown>,
  });
  return 'wait';
}

function answerUnless(state: GameState, ctx: Ctx, pid: string, d: Unless2Data, value: string) {
  if (d.may) {
    d.cont.unless = { ...(d.cont.unless ?? {}), [d.step]: value === 'pay' };
    if (value !== 'pay') log(state, ctx, pid, `${player(state, pid).name} chooses not to (${d.label}).`);
    runFrom(state, ctx, d.cont);
    return;
  }
  const who = player(state, pid).name;
  const name = d.cont.item.text.split(':')[0];
  let paid = false;
  let picks: Omit<PickData, 'queue' | 'cont'>[] = [];
  if (value === 'pay') {
    const { toks } = parseCostTokens(d.cost);
    const src = d.cont.item.sourceIid ?? d.cont.item.iid;
    if (canPayCost(state, ctx, pid, src, toks, d.x)) {
      paid = true;
      picks = costPicks(payCostNow(state, ctx, pid, src, toks, d.x), pid, name);
      log(state, ctx, pid, `${who} pays (${d.label.toLowerCase()}).`);
    }
  }
  if (!paid) log(state, ctx, pid, `${who} doesn't pay (${d.label.toLowerCase()}).`);
  d.cont.unless = { ...(d.cont.unless ?? {}), [d.step]: d.switched ? paid : !paid };
  if (startPicks(state, ctx, picks, d.cont)) return;
  runFrom(state, ctx, d.cont);
}

/** Cost choices (paycost.ts) as resolve.ts picks. */
function costPicks(choices: ReturnType<typeof payCostNow>, pid: string, name: string): Omit<PickData, 'queue' | 'cont'>[] {
  return choices.map((c) => ({
    kind: 'pick', chooser: pid, candidates: c.candidates, left: c.n, optional: c.upTo, label: `${name}: ${c.text} (cost)`,
    ...(c.kind === 'discard' ? { action: 'discard' as const } : c.kind === 'sac' ? { action: 'sacrifice' as const }
      : c.kind === 'blight' ? { action: 'blight' as const, params: { Num: String(c.amount ?? 1) } }
      : c.kind === 'tapType' ? { action: 'tap' as const, countX: c.upTo } : { action: 'move' as const, dest: (c.kind === 'return' ? 'hand' : 'exile') as Zone }),
  }));
}

/** Life gained / lost this turn (Ocelot Pride, Kaito, spectacle ...). */
export function noteLife(state: GameState, pid: string, delta: number) {
  if (!delta) return;
  const ti = turnInfo(state);
  const k = `${delta > 0 ? 'life+' : 'life-'}|${pid}`;
  ti.activations[k] = (ti.activations[k] ?? 0) + Math.abs(delta);
}

/** Damage from a source to a card iid or player id, for more.ts effects. */
function dealDamageTo(state: GameState, ctx: Ctx, r: Run, source: string | undefined, key: string, n0: number): number {
  if (n0 <= 0) return 0;
  const n = modifiedDamage(state, ctx.lookup, key, source, n0);
  const src = source ? state.cards[source] : undefined;
  if (state.players.some((p) => p.pid === key)) {
    const prev = damagePrevented(state, ctx.lookup, key, source);
    if (prev) { log(state, ctx, key, `Damage to ${pname(state, key)} is prevented (${prev}).`); return 0; }
    player(state, key).life -= n;
    noteLife(state, key, -n);
  } else {
    const c = onBattlefield(state, key);
    if (!c) return 0;
    if (damagePrevented(state, ctx.lookup, key, source)) return 0;
    damageCard(state, ctx, r, c, n, !!src && hasKeyword(src, ctx.lookup, 'Deathtouch', state));
  }
  if (source) emit(state, { t: 'damage', source, target: key, amount: n, combat: false });
  if (src && hasKeyword(src, ctx.lookup, 'Lifelink', state)) { player(state, src.controller).life += n; noteLife(state, src.controller, n); }
  return n;
}

/** The running chain as engine/more.ts sees it. */
function moreRun(state: GameState, ctx: Ctx, r: Run, i: number, uncertain: boolean): MoreRun {
  let offset = 0;
  return {
    ...uniqueRun(state, ctx, r, i, uncertain),
    remembered: r.remembered,
    index: i,
    env: env(state, ctx, r),
    chosen: (r.chosen ??= {}),
    splice: (svar, opts = {}) => { const n = spliceSteps(r, { at: i + offset, svar, ...opts }); offset += n; return n; },
    contAt: (next) => contAt(r, next),
    damage: (source, key, n) => dealDamageTo(state, ctx, r, source, key, n),
    lateTargets: () => r.lateTargets?.[i],
  };
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
  if (total > 0 && left === 0 && item.iid && state.cards[item.iid]?.castInfo?.bestowed && state.cards[item.iid].zone === 'stack') {
    // Bestow: with its target gone it isn't an Aura spell any more — it resolves as a creature spell (702.103e).
    const c = state.cards[item.iid];
    delete c.castInfo!.bestowed;
    if (item.castInfo) delete item.castInfo.bestowed;
    log(state, ctx, item.controller, `${name}: its target is gone — it resolves as a creature.`);
    finish();
    return true;
  }
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
  if (item.kind !== 'spell') { const ti = turnInfo(state); const key = `resolved|${auto.cardId}|${auto.index}|${item.sourceIid}`; ti.activations[key] = (ti.activations[key] ?? 0) + 1; }
  const isSpellCard = item.kind === 'spell' && !!item.iid;
  if (isSpellCard && isPermanentSpell) finish();
  const cont: AutoCont = { item, next: 0, targets: legal, lki, remembered: [] };
  const r = makeRun(state, ctx, cont)!;
  for (let i = 0; i < r.steps.length; i++) {
    if (execStep(state, ctx, r, i) === 'wait') break;
  }
  if (isSpellCard && !isPermanentSpell && state.cards[item.iid!]?.zone === 'stack' && !rebound(state, ctx, item)) finish();
  stateBasedActions(state, ctx, r.deathtouched);
  return true;
}

/** Rebound: a spell cast from the hand is exiled as it resolves; at its owner's next upkeep they may cast it free. */
function rebound(state: GameState, ctx: Ctx, item: StackItem): boolean {
  const c = item.iid ? state.cards[item.iid] : undefined;
  if (!c?.cardId || !SCRIPTS.cards[c.cardId]?.[0]?.keywords.includes('Rebound')) return false;
  const info = item.castInfo ?? c.castInfo;
  if (info?.from || info?.exileOnLeave) return false; // not cast from the hand
  const name = cardName(c, ctx.lookup);
  moveCard(state, ctx, c.iid, 'exile');
  if (state.cards[c.iid]?.zone !== 'exile') return true;
  const line = 'DB$ Play | Defined$ DelayTriggerRemembered | WithoutManaCost$ True | Optional$ True | SpellDescription$ Rebound — you may cast it from exile without paying its mana cost.';
  (state.delayedTriggers ??= []).push({
    id: randomId(ctx.rng), controller: item.controller, sourceIid: c.iid, sourceName: name, text: `${name}: rebound — you may cast it from exile without paying its mana cost`,
    step: 'upkeep', turn: state.turn, createdStep: state.step, pid: item.controller,
    auto: { cardId: c.cardId, face: 0, source: 'trigger', index: -1, line, targets: [], trigger: { mode: 'Delayed', remembered: [c.iid], lki: {} } },
  });
  log(state, ctx, item.controller, `${name} resolves and is exiled (rebound).`);
  return true;
}

/** Answer a Pending question. Returns an error string or null. */
export function answerPending(state: GameState, ctx: Ctx, pid: string, id: string, value: string): string | null {
  const pend = state.pending.find((p) => p.id === id);
  if (!pend) return 'That question is no longer open';
  if (pend.pid !== pid) return 'That question is for another player';
  if (!pend.number && !pend.divide && !pend.options.some((o) => o.value === value)) return 'Not one of the options';
  state.pending = state.pending.filter((p) => p !== pend);
  if ((pend.data as { kind?: string }).kind === 'cost') return answerCostPending(state, ctx, pid, pend.data as unknown as CostData, value);
  let ext = answerReplacementPending(state, ctx, pend, value);
  if (ext === undefined) ext = answerKeywordPending(state, ctx, pend, value);
  if (ext === undefined) ext = answerUniquePending(state, ctx, pend, value);
  if (ext === undefined) ext = answerTapCost(state, ctx, pend, value);
  if (ext === undefined) ext = answerExtPending(state, ctx, pend, value);
  if (ext === undefined) ext = answerVenture(state, ctx, pend, value);
  if (ext !== undefined) return ext;
  const more = answerMorePending(state, ctx, pend, value); // engine/more.ts
  if (more !== undefined) return more;
  const data = pend.data as unknown as PickData | UnlessData | ColorData | OptCostData | LateData | Unless2Data | DivideData | RearrangeData | RShuffleData;
  const who = player(state, pid);
  if (data.kind === 'rearrange') {
    const d: RearrangeData = { ...data, placed: [...data.placed, value], left: data.left.filter((x) => x !== value) };
    if (!askRearrange(state, ctx, d)) runFrom(state, ctx, d.cont);
    return null;
  }
  if (data.kind === 'rshuffle') {
    if (value === 'yes') {
      const owner = player(state, data.owner);
      shuffleLibrary(state, owner, ctx.rng);
      log(state, ctx, pid, `${who.name} shuffles ${data.owner === pid ? 'their' : `${owner.name}'s`} library (${data.source}).`);
    }
    runFrom(state, ctx, data.cont);
    return null;
  }
  if (data.kind === 'divide') {
    const err = answerDivision(state, ctx, data, value);
    if (err) state.pending.push(pend); // invalid division: ask again
    return err;
  }
  if (data.kind === 'late') { if (value === 'none') { data.cont.lateTargets = { ...(data.cont.lateTargets ?? {}), [data.step]: [] }; runFrom(state, ctx, data.cont); } return null; }
  if (data.kind === 'unless2') { answerUnless(state, ctx, pid, data, value); return null; }
  if (data.kind === 'optcost') { answerOptionalCost(state, ctx, pid, data, value); return null; }
  if (data.kind === 'color') {
    who.manaPool[value] = (who.manaPool[value] ?? 0) + data.n;
    log(state, ctx, pid, `${who.name} adds ${Array(data.n).fill(`{${value}}`).join('')}.`);
    if (data.more) { askColor(state, ctx, pid, 'Mana', { ...data, more: data.more - 1 }); return null; }
    if (data.cont) runFrom(state, ctx, data.cont);
    return null;
  }
  if (data.kind === 'unless') {
    const item = state.stack.find((s) => s.id === data.stackId);
    if (item) {
      if (value === 'pay') {
        if (state.strict) autoTapFor(state, ctx, pid, data.cost); // rules-enforced auto-pay (engine/strict.ts)
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
      } else if (data.action === 'blight') {
        blightOn(state, ctx, value, parseInt(data.params?.Num ?? '1', 10) || 1, data.label.replace(/:.*/, ''));
      } else if (data.action === 'tap') {
        c.tapped = true;
        log(state, ctx, pid, `${who.name} taps ${nm}.`);
        if (data.countX && data.cont?.item.auto) { data.cont.item.auto.x = (data.cont.item.auto.x ?? 0) + 1; data.cont.item.x = data.cont.item.auto.x; }
      } else {
        const p = data.params ?? {};
        const from = c.zone;
        if (data.dest === 'library' && data.shuffle && from === 'library') {
          // "Search your library for a card, then shuffle and put that card on top" (Vampiric Tutor): placed after the shuffle.
          data.toLibrary = [...(data.toLibrary ?? []), value];
        } else if (data.dest === 'library') moveCard(state, ctx, value, 'library', { position: p.LibraryPosition === '-1' ? 'bottom' : 'top' });
        else if (data.dest === 'battlefield') moveCard(state, ctx, value, 'battlefield', { tapped: p.Tapped === 'True', controller: pid });
        else moveCard(state, ctx, value, data.dest ?? 'hand');
        if (data.untilHost && state.cards[value]?.zone === 'exile') addEffect(state, ctx, { kind: 'exiled', controller: pid, until: 'hostLeaves', hostIid: data.untilHost, cards: [{ iid: value, from, owner: c.owner }] });
        if (data.cont && Object.keys(p).some((k) => k.startsWith('Remember'))) {
          data.cont.remembered = [...data.cont.remembered, value];
          rememberOnCard(state, data.cont.item, data.cont.remembered);
        }
        // Imprint$ True (Currency Converter: "if it's a land card ..."): later steps refer to the chosen card as Imprinted.
        if (data.cont && p.Imprint === 'True' && state.cards[value]) data.cont.chosen = { ...(data.cont.chosen ?? {}), imprinted: [...(data.cont.chosen?.imprinted ?? []), value] };
        const hidden = (z: Zone) => (z === 'hand' || z === 'library') && !data.revealChosen;
        const moved = state.cards[value];
        if (data.revealChosen && moved) { moved.revealedTo = state.players.map((q) => q.pid); log(state, ctx, pid, `${who.name} reveals ${nm}.`); }
        const their = c.owner === pid ? 'their' : `${pname(state, c.owner)}'s`;
        log(state, ctx, pid, `${who.name} puts ${hidden(from) && hidden(data.dest ?? 'hand') ? 'a card' : nm} ${data.dest === 'library' ? (p.LibraryPosition === '-1' ? `on the bottom of ${their} library` : `on top of ${their} library`) : `into ${data.dest === 'battlefield' ? 'play' : `${their} ${data.dest}`}`}.`);
      }
    }
    left--;
    candidates = candidates.filter((x) => x !== value);
  } else left = 0;
  // Dig: a chosen card put back into the library (Thassa's Oracle, Expressive Iteration) is not one of "the rest".
  const dig = data.dig && value !== 'none' ? { ...data.dig, top: data.dig.top.filter((x) => x !== value) } : data.dig;
  if (left > 0 && pickPending(state, ctx, { ...data, left, candidates, ...(dig ? { dig } : {}) })) return null;
  if (dig) finishDig(state, ctx, dig);
  if (data.shuffle) {
    const owner = state.players.find((x) => x.pid === data.shuffle);
    const held = (data.toLibrary ?? []).filter((x) => state.cards[x]?.zone === 'library');
    if (owner) {
      owner.zones.library = owner.zones.library.filter((x) => !held.includes(x));
      shuffleLibrary(state, owner, ctx.rng);
      const bottom = data.params?.LibraryPosition === '-1';
      for (const x of held) { if (bottom) owner.zones.library.push(x); else owner.zones.library.unshift(x); }
    }
  }
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
