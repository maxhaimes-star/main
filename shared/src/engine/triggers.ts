/**
 * Stage 2: triggered abilities.
 *
 * Game code records events while an action runs (state.events: zone changes, steps, attacks, casts, draws,
 * damage ...). After the action (and after every automated resolution) `processTriggers` matches them against
 * the Forge T: lines of the permanents (and graveyard cards with TriggerZones$ Graveyard), queues the triggered
 * abilities in APNAP order, asks the controller for "may" decisions and targets (Pending), and puts them on the
 * stack as StackItems with `auto.source = 'trigger'`. Resolution goes through the Stage 1 chain runner.
 * Delayed triggers ("at the beginning of the next end step ...") live in state.delayedTriggers.
 *
 * Detection never throws: errors are logged and the trigger is skipped.
 */
import { cardName, hasKeyword } from '../game/rules.ts';
import { type Ctx, log, player, randomId } from '../game/state.ts';
import { type CardInstance, type GameEvent, type GameState, type StackItem, STEPS, type Zone } from '../game/types.ts';
import { checkTargets } from './play.ts';
import { answerResolveTargets, lkiOf } from './resolve.ts';
import { chainOf, describe, getScript, isAutomatable, parseParams, PHASES, scriptRef, targetSpecs, triggersOf } from './script.ts';
import { extraTriggerHosts, grantedTriggers } from './effects.ts';
import { foreignTriggers } from './grants.ts';
import { isValidTarget, matchCard, matchPlayer, type MatchEnv, type Tri } from './targets.ts';
import type { AutoInfo, Lki, ParsedAbility, QueuedTrigger, TargetRef, TargetSpec, TriggerContext } from './types.ts';
import { uniqueVar } from './unique.ts';
import { notePermissionUse } from './permissions.ts';
import { moreVar } from './more.ts';
import { designationTriggers } from './designations.ts';
import { turnInfo } from './durations.ts';
import { conditionTrue, evalCount } from './counts.ts';
import { canPayCost, parseCostTokens } from './paycost.ts';
import { keywordTriggers } from './kwtriggers.ts';
import { emitUnblocked } from './combat-rules.ts';
import { wardReminders } from './keyword-play.ts';
import { uniqueTriggerLine, uniqueTriggerSkip, uniqueTriggerSupport, uniqueTriggers } from './turns.ts';

/** Max triggered abilities detected per player action (loop guard). */
export const MAX_TRIGGERS_PER_ACTION = 100;
let budget = MAX_TRIGGERS_PER_ACTION;

/** Trigger modes the engine detects. */
export const SUPPORTED_MODES = new Set([
  'ChangesZone', 'ChangesZoneAll', 'Phase', 'Attacks', 'AttackersDeclared', 'Blocks', 'SpellCast', 'Drawn', 'DamageDone',
  'DamageDoneOnce', 'DamageDealtOnce', 'Sacrificed', 'Discarded', 'DiscardedAll', 'LandPlayed', 'Exiled',
  'BecomesTarget', 'Transformed', 'Taps', 'TapsForMana', 'BecomeMonarch', 'SearchedLibrary', 'DamageAll',
  'TokenCreated', 'TokenCreatedOnce', 'CounterAdded', 'CounterAddedOnce', 'AttackerUnblocked', 'AttackerUnblockedOnce',
]);

/** Trigger parameters the engine understands; a trigger with any other parameter is left to the players. */
const KNOWN_PARAMS = new Set([
  'Mode', 'Execute', 'TriggerDescription', 'Alone', 'ValidToken', 'CounterType', 'ValidAttackingPlayer', 'ValidDefenders', 'ValidCard', 'ValidCards', 'Origin', 'Destination', 'TriggerZones', 'ValidPlayer', 'Phase',
  'OptionalDecider', 'ValidActivatingPlayer', 'ValidSource', 'ValidTarget', 'Static', 'Secondary', 'CombatDamage', 'IsPresent',
  'PresentCompare', 'ActivatorThisTurnCast', 'AttackingPlayer', 'CheckSVar', 'SVarCompare', 'Number', 'FirstCardInDrawStep',
  'NotFirstLand', 'NoResolvingCheck', 'ActivationLimit', 'Activator', 'ValidSA', 'CheckDefinedPlayer', 'FirstAttack', 'Delirium', 'ResolvedLimit',
  'ValidDefenders', 'ValidAttackingPlayer', 'ValidToken', 'CounterType', 'SearchOwnLibrary', 'ThisDoor', 'ValidAttacker', 'ValidBlocker',
  'TargetsValid', 'Attacked',
  // Checked in detect() (extraParams): "during your / an opponent's turn", disappear / revolt, threshold, hellbent, valiant,
  // the Nth counter, damage amounts, attacking with a <type>, "at the beginning of your second main phase".
  'PlayerTurn', 'OpponentTurn', 'Revolt', 'Threshold', 'Hellbent', 'Valiant', 'CounterAmount', 'DamageAmount', 'ValidAttackers', 'PhaseCount', 'FirstCombat',
]);

const PROWESS_LINE = 'DB$ Pump | Defined$ Self | NumAtt$ +1 | NumDef$ +1 | SpellDescription$ Prowess: +1/+1 until end of turn.';

/** Start of a player action: forget stray events and reset the loop guard. */
export function beginAction(state: GameState) {
  state.events = [];
  budget = MAX_TRIGGERS_PER_ACTION;
}

// ------------------------------------------------------------------ static analysis (coverage / UI)

/** Can the engine detect this T: line and run its Execute$ chain? */
export function triggerSupport(cardId: string, face: number, index: number): { detect: boolean; chain: boolean; reason?: string } {
  const t = triggersOf(cardId, face)[index];
  if (!t) return { detect: false, chain: false, reason: 'missing' };
  const p = t.params;
  const unique = uniqueTriggerSupport(cardId, face, index); // rewritten chains / Mode$ Always (turns.ts)
  if (unique && (SUPPORTED_MODES.has(p.Mode) || p.Mode === 'Always')) return unique;
  if (p.Static === 'True') {
    // Mana-ability triggers resolve at once (manatriggers.ts); "forget what it remembered" cleanups are applied (staticCleanup).
    const ch = triggerChain(cardId, face, p.Execute);
    if (p.Mode === 'TapsForMana' && (ch?.api === 'Mana' || ch?.api === 'ManaReflected')) return { detect: true, chain: true };
    if (ch?.api === 'Cleanup' && SUPPORTED_MODES.has(p.Mode)) return { detect: true, chain: true };
    // "Forget it" bookkeeping (Chrome Mox, Spell Queller): what is remembered is looked up live, so nothing to do.
    if (ch?.api === 'Pump' && !ch.sub && Object.keys(ch.params).every((k) => /^(Forget|Defined$|StackDescription$|SpellDescription$)/.test(k))) return { detect: true, chain: true };
    // "If you do, it gains <trigger>" (Serra Paragon): applied to cards played with the host's permission (playGrants).
    if (/MayPlaySource/.test(p.ValidSA ?? '') && (p.Mode === 'SpellCast' || p.Mode === 'LandPlayed') && ch?.api === 'Animate' && ch.params.Triggers && !ch.sub) return { detect: true, chain: true };
    return { detect: false, chain: false, reason: 'static' };
  }
  // Rooms: "When you unlock this door" is queued by the unlock special action (keyword-play.ts unlockDoor).
  if (p.Mode === 'UnlockDoor' && p.ThisDoor === 'True') {
    const ch = triggerChain(cardId, face, p.Execute);
    const un = ch ? isAutomatable(ch).unsupported : ['no chain'];
    return un.length ? { detect: true, chain: false, reason: `effect ${un[0].split(' ')[0]}` } : { detect: true, chain: true };
  }
  if (!SUPPORTED_MODES.has(p.Mode)) return { detect: false, chain: false, reason: `mode ${p.Mode}` };
  const unknown = Object.keys(p).find((k) => !KNOWN_PARAMS.has(k));
  const chain = triggerChain(cardId, face, p.Execute);
  const cost = !!chain && chain.kind === 'AB' && !!chain.params.Cost && parseCostTokens(chain.params.Cost).unknown.length > 0;
  const un = chain ? isAutomatable(chain).unsupported : ['no chain'];
  const auto = !!chain && !cost && un.length === 0;
  if (unknown) return { detect: false, chain: auto, reason: `param ${unknown}` };
  return auto ? { detect: true, chain: true } : { detect: true, chain: false, reason: cost ? 'optional cost (AB$ Cost$)' : `effect ${un[0].split(' ')[0]}` };
}

function triggerChain(cardId: string, face: number, svar: string | undefined): ParsedAbility | undefined {
  return chainOf({ cardId, face, source: 'trigger', index: 0, svar, targets: [] });
}

// ------------------------------------------------------------------ matching

const ZONE_NAMES: Record<string, Zone> = {
  Battlefield: 'battlefield', Graveyard: 'graveyard', Hand: 'hand', Library: 'library', Exile: 'exile', Stack: 'stack', Command: 'command',
};

function zoneListMatches(spec: string | undefined, z: Zone | 'none'): boolean {
  if (!spec || spec === 'Any') return true;
  return spec.split(',').some((x) => ZONE_NAMES[x.trim()] === z);
}

interface Host {
  c: CardInstance;
  /** Card face whose script applies. */
  face: number;
  /** Card id whose script applies (a copy uses the copied card's, engine/copy.ts). */
  id?: string;
  /** Last-known version (left the battlefield in this batch). */
  lki: boolean;
  /** Effect / emblem (engine/effects.ts): its triggers replace the card's T: lines. */
  effect?: { name: string; remembered: string[]; triggers: { index: number; params: Record<string, string> }[] };
}

/** What a trigger matched: the trigger context, or 'unknown' (couldn't evaluate a condition). */
type Hit = TriggerContext | null | 'unknown';

function and(a: Tri, b: Tri): Tri {
  if (a === false || b === false) return false;
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return true;
}

function cmp(left: number, expr: string, right: (s: string) => number | undefined): Tri {
  const m = /^(LT|LE|EQ|NE|GE|GT)(.+)$/.exec(expr.trim());
  if (!m) return 'unknown';
  const r = /^-?\d+$/.test(m[2]) ? parseInt(m[2], 10) : right(m[2]);
  if (r == null) return 'unknown';
  switch (m[1]) {
    case 'LT': return left < r;
    case 'LE': return left <= r;
    case 'EQ': return left === r;
    case 'NE': return left !== r;
    case 'GE': return left >= r;
    default: return left > r;
  }
}

/**
 * Serra Paragon: a card played with a permanent's MayPlay permission gains a trigger ("If you do, it gains 'When this
 * permanent is put into a graveyard from the battlefield ...'"). The host's Static$ True SpellCast / LandPlayed trigger
 * with ValidSA$ ...MayPlaySource names an Animate with Triggers$: remembered here, granted as the permanent enters.
 */
function playGrants(state: GameState, iid: string, permission: string | undefined, mode: 'SpellCast' | 'LandPlayed') {
  const m = /^static\|([^|]+)\|\d+$/.exec(permission ?? '');
  const host = m ? state.cards[m[1]] : undefined;
  const ref = host ? scriptRef(host) : undefined;
  const f = ref ? getScript(ref.cardId)?.[ref.face] : undefined;
  if (!ref || !f) return;
  for (const t of triggersOf(ref.cardId, ref.face)) {
    const p = t.params;
    if (p.Static !== 'True' || p.Mode !== mode || !/MayPlaySource/.test(p.ValidSA ?? '') || !p.Execute) continue;
    const ch = triggerChain(ref.cardId, ref.face, p.Execute);
    if (ch?.api !== 'Animate' || !ch.params.Triggers) continue;
    (state.remembered ??= {})[`playGrant|${iid}`] = [ref.cardId, String(ref.face), ...ch.params.Triggers.split(',').map((s) => s.trim())];
  }
}

function applyPlayGrant(state: GameState, ctx: Ctx, iid: string, entered: boolean) {
  const g = state.remembered?.[`playGrant|${iid}`];
  if (!g) return;
  delete state.remembered![`playGrant|${iid}`];
  const c = state.cards[iid];
  if (!entered || !c || c.zone !== 'battlefield') return;
  const [cardId, face, ...triggers] = g;
  (c.animations ??= []).push({ id: randomId(ctx.rng), controller: c.controller, until: 'permanent', turn: state.turn, grant: { cardId, face: parseInt(face, 10), triggers } });
  const text = getScript(cardId)?.[parseInt(face, 10)]?.svars[triggers[0]];
  const desc = text ? parseParams(text).params.TriggerDescription : undefined;
  log(state, ctx, c.controller, `${cardName(c, ctx.lookup)} gains "${desc ?? 'a triggered ability'}".`);
}

/** This turn's history from the action's events: attackers, permanents that entered, permissions used, the city's blessing. */
function trackTurnEvents(state: GameState, ctx: Ctx) {
  const evs = state.events ?? [];
  if (!evs.length) return;
  const ti = turnInfo(state);
  for (const ev of evs) {
    if (ev.t === 'cast') {
      notePermissionUse(state, state.cards[ev.iid]?.castInfo?.permission); // once-per-turn permissions (Lurrus)
      playGrants(state, ev.iid, state.cards[ev.iid]?.castInfo?.permission, 'SpellCast');
    } else if (ev.t === 'landPlayed') playGrants(state, ev.iid, state.remembered?.[`playedWith|${ev.iid}`]?.[0], 'LandPlayed');
    if (ev.t === 'zone' && ev.from === 'stack') applyPlayGrant(state, ctx, ev.iid, ev.to === 'battlefield');
    if (ev.t === 'landPlayed') applyPlayGrant(state, ctx, ev.iid, true);
    else if (ev.t === 'attacks') {
      ti.activations[`attacked|${ev.iid}`] = (ti.activations[`attacked|${ev.iid}`] ?? 0) + 1;
      const who = state.cards[ev.iid]?.controller;
      if (who) ti.activations[`attacks|${who}`] = (ti.activations[`attacks|${who}`] ?? 0) + 1;
    } else if (ev.t === 'zone' && ev.to === 'battlefield') ti.activations[`entered|${ev.iid}`] = 1;
    if (ev.t === 'zone' && ev.cause === 'sacrifice') (state.remembered ??= {})[`sacrificed|${ev.snap.controller}`] = [ev.iid];
    if (ev.t === 'zone' && ev.cause === 'discard') ti.activations[`discarded|${ev.iid}`] = 1; // mayhem (engine/castkw.ts)
  }
  // Ascend: ten or more permanents -> the city's blessing (for the rest of the game).
  for (const p of state.players) {
    if (p.designations.includes("City's Blessing")) continue;
    const mine = state.battlefield.filter((iid) => state.cards[iid].controller === p.pid);
    if (mine.length < 10) continue;
    const ascend = mine.some((iid) => scriptRef(state.cards[iid]) && (getScript(scriptRef(state.cards[iid])!.cardId)?.[scriptRef(state.cards[iid])!.face]?.keywords ?? []).includes('Ascend'));
    if (ascend) { p.designations.push("City's Blessing"); log(state, ctx, p.pid, `${p.name} gets the city's blessing (ascend).`); }
  }
}

/** Evaluate a host SVar (the subset triggers use in CheckSVar$). */
function svarValue(state: GameState, ctx: Ctx, env: MatchEnv, svars: Record<string, string>, name: string, trig?: TriggerContext): number | undefined {
  const v = svars[name];
  if (!v) return /^-?\d+$/.test(name) ? parseInt(name, 10) : undefined;
  let m = /^Number\$(-?\d+)$/.exec(v);
  if (m) return parseInt(m[1], 10);
  const mv = moreVar(state, { controller: env.controller, sourceIid: env.sourceIid, remembered: [], trig, item: { id: '', kind: 'trigger', controller: env.controller, text: '' } }, ctx, v);
  if (mv !== undefined) return mv;
  if ((m = /^Count\$ValidHand (.+)$/.exec(v))) {
    let n = 0;
    for (const p of state.players) for (const iid of p.zones.hand) { const r = matchCard(state.cards[iid], m[1], { ...env, defender: trig?.defender }); if (r === 'unknown') return undefined; if (r) n++; }
    return n;
  }
  const counted = evalCount(v, { state, lookup: ctx.lookup, controller: env.controller, sourceIid: env.sourceIid });
  if (counted !== undefined) return counted;
  const u = uniqueVar(state, ctx, env.controller, [], v); // Field of the Dead's different names (unique.ts)
  if (u !== undefined) return u;
  if ((m = /^Count\$Valid (.+)$/.exec(v))) {
    let n = 0;
    for (const iid of state.battlefield) {
      const r = matchCard(state.cards[iid], m[1], env);
      if (r === 'unknown') return undefined;
      if (r) n++;
    }
    return n;
  }
  const me = state.players.find((p) => p.pid === env.controller);
  if (v === 'Count$YourLifeTotal') return me?.life;
  if (v === 'Count$CardsInYourHand') return me?.zones.hand.length;
  return undefined;
}

/** Intervening "if": IsPresent$ / CheckSVar$. */
export function conditionHolds(state: GameState, ctx: Ctx, cond: Record<string, string>, controller: string, sourceIid: string | undefined, cardId: string | undefined, face: number, trig?: TriggerContext): Tri {
  const host = sourceIid ? state.cards[sourceIid] : undefined;
  const env: MatchEnv = { controller, sourceIid, lookup: ctx.lookup, attachedTo: host?.attachedTo ?? '', turnInfo: turnInfo(state), defender: trig?.defender };
  let res: Tri = true;
  if (cond.IsPresent) {
    let [valid, inlineCmp] = cond.IsPresent.trim().split(/\s+/);
    // Kytheon: "if CARDNAME and at least two other creatures attacked this combat" (Card.Self+attackedThisCombat GE3).
    let selfAttacked: boolean | undefined;
    if (/Self\+attackedThisCombat/.test(valid)) { selfAttacked = (env.turnInfo!.activations[`attacked|${sourceIid}`] ?? 0) > 0; valid = 'Creature.attackedThisCombat'; }
    let n = 0;
    let unknown = false;
    for (const iid of state.battlefield) {
      const r = matchCard(state.cards[iid], valid, env);
      if (r === 'unknown') unknown = true;
      else if (r) n++;
    }
    if (selfAttacked === false) n = 0;
    const c = cmp(n, cond.PresentCompare ?? inlineCmp ?? 'GE1', () => undefined);
    res = and(res, unknown ? 'unknown' : c);
  }
  if (cond.CheckSVar) {
    const svars = (cardId ? getScript(cardId)?.[face]?.svars : undefined) ?? {};
    const left = svarValue(state, ctx, env, svars, cond.CheckSVar, trig);
    res = and(res, left == null ? 'unknown' : cmp(left, cond.SVarCompare ?? 'GE1', (s) => svarValue(state, ctx, env, svars, s, trig)));
  }
  // CheckDefinedPlayer$ You.hasInitiative / You.isMonarch / You.hasBlessing
  if (cond.CheckDefinedPlayer) {
    const [who, prop] = cond.CheckDefinedPlayer.split('.');
    const pid = who === 'You' ? controller : who === 'TriggeredPlayer' ? trig?.player : undefined;
    const pl = state.players.find((p) => p.pid === pid);
    const d = pl?.designations ?? [];
    const v: Tri = prop === 'hasInitiative' ? d.includes('Initiative') : prop === 'isMonarch' ? d.includes('Monarch') : prop === 'hasBlessing' ? d.includes("City's Blessing") : 'unknown';
    res = and(res, pl ? v : 'unknown');
  }
  if (cond.Delirium === 'True') res = and(res, conditionTrue('Delirium', { state, lookup: ctx.lookup, controller, sourceIid }) ?? 'unknown');
  return res;
}

function matchP(pid: string | undefined, valid: string | undefined, env: MatchEnv): Tri {
  if (!valid) return true;
  if (!pid) return false;
  return matchPlayer(pid, valid, env);
}

function matchC(c: CardInstance | undefined, valid: string | undefined, env: MatchEnv): Tri {
  if (!valid) return true;
  if (!c) return false;
  return matchCard(c, valid, env);
}

/**
 * TargetsValid$ (heroic, "Repartee", "whenever you cast a spell that targets ..."): does the spell just cast target
 * something matching? Player alternatives (You / Opponent / Player) are checked against player targets, the others
 * against card targets. The spell's chosen targets are on its stack item.
 */
function spellTargets(state: GameState, iid: string, valid: string, env: MatchEnv): Tri {
  const item = state.stack.find((s) => s.iid === iid);
  if (!item) return 'unknown';
  const targets = item.auto?.targets.flat() ?? [];
  const alts = valid.split(',').map((x) => x.trim());
  const playerAlts = alts.filter((a) => /^(You|Player|Opponent)\b/.test(a)).join(',');
  const cardAlts = alts.filter((a) => !/^(You|Player|Opponent)\b/.test(a)).join(',');
  let r: Tri = false;
  for (const t of targets) {
    let m: Tri = false;
    if (t.kind === 'player') m = playerAlts ? matchPlayer(t.pid, playerAlts, env) : false;
    else if (t.kind === 'card') m = cardAlts ? matchC(state.cards[t.iid], cardAlts, env) : false;
    if (m === true) return true;
    if (m === 'unknown') r = 'unknown';
  }
  return r;
}

function isPlayerId(state: GameState, id: string): boolean {
  return state.players.some((p) => p.pid === id);
}

/** Match one trigger line against one event. */
function matchEvent(state: GameState, ctx: Ctx, host: Host, p: Record<string, string>, ev: GameEvent, env: MatchEnv): Hit {
  const mode = p.Mode;
  const cardNow = (iid: string, snap?: CardInstance) => state.cards[iid] ?? snap;
  let r: Tri;
  switch (mode) {
    case 'ChangesZone': case 'ChangesZoneAll': case 'Exiled': case 'Sacrificed': case 'Discarded': case 'DiscardedAll': {
      if (ev.t !== 'zone') return null;
      if (mode === 'Exiled' && ev.to !== 'exile') return null;
      if (mode === 'Sacrificed' && ev.cause !== 'sacrifice') return null;
      if ((mode === 'Discarded' || mode === 'DiscardedAll') && ev.cause !== 'discard') return null;
      if (!zoneListMatches(p.Origin, ev.from) || !zoneListMatches(p.Destination, ev.to)) return null;
      const leaving = ev.from === 'battlefield' || mode === 'Sacrificed';
      const c = leaving ? ev.snap : cardNow(ev.iid, ev.snap);
      r = matchC(c, mode === 'ChangesZoneAll' || mode === 'DiscardedAll' ? p.ValidCards ?? p.ValidCard : p.ValidCard, env);
      const who = leaving ? ev.snap.controller : (state.cards[ev.iid]?.controller ?? ev.snap.controller);
      if (p.ValidPlayer) r = and(r, matchP(who, p.ValidPlayer, env));
      if (r === false) return null;
      if (r === 'unknown') return 'unknown';
      const lki: Record<string, Lki> = {};
      if (leaving) lki[ev.iid] = lkiOf(ev.snap, ctx);
      return { mode, card: ev.iid, player: who, lki };
    }
    case 'Phase': {
      // Phase$ Main: each main phase; with PhaseCount$ 2 the second one ("your second main phase").
      const step = p.Phase === 'Main' ? (p.PhaseCount === '2' ? 'main2' : p.PhaseCount === '1' ? 'main1' : ev.t === 'phase' && (ev.step === 'main1' || ev.step === 'main2') ? ev.step : 'main1') : PHASES[p.Phase ?? ''];
      if (ev.t !== 'phase' || step !== ev.step) return null;
      r = matchP(ev.active, p.ValidPlayer, env);
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, player: ev.active };
    }
    case 'TokenCreated': case 'TokenCreatedOnce': {
      if (ev.t !== 'zone' || ev.from !== 'none' || ev.to !== 'battlefield') return null;
      const c = state.cards[ev.iid] ?? ev.snap;
      r = and(matchC(c, p.ValidToken ?? 'Card', env), p.ValidPlayer ? matchP(c.controller, p.ValidPlayer, env) : true);
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, card: ev.iid, player: c.controller };
    }
    case 'CounterAdded': case 'CounterAddedOnce': {
      if (ev.t !== 'counterAdded') return null;
      if (p.CounterType && counterName(p.CounterType) !== ev.kind) return null;
      const c = state.cards[ev.iid];
      r = matchC(c, p.ValidCard ?? 'Card', env);
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, card: ev.iid, player: c?.controller, amount: ev.n };
    }
    case 'AttackerUnblocked': case 'AttackerUnblockedOnce': {
      if (ev.t !== 'unblocked') return null;
      r = and(p.ValidAttackingPlayer ? matchP(ev.attackingPlayer, p.ValidAttackingPlayer, env) : true, p.ValidDefenders ? matchP(ev.defender, p.ValidDefenders, env) : true);
      if (p.ValidAttackers) r = and(r, ev.attackers.some((x) => matchC(state.cards[x], p.ValidAttackers, env) === true));
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, card: ev.attackers[0], player: ev.attackingPlayer, defender: ev.defender };
    }
    case 'Attacks': {
      if (ev.t !== 'attacks') return null;
      const c = state.cards[ev.iid];
      r = matchC(c, p.ValidCard, env);
      // FirstAttack$ True: "attacks for the first time each turn" (the attack being processed is counted already).
      if (p.FirstAttack === 'True' && (turnInfo(state).activations[`attacked|${ev.iid}`] ?? 0) > 1) r = false;
      // Alone$ True (exalted): the only attacking creature.
      if (p.Alone === 'True' && state.battlefield.filter((x) => state.cards[x].attacking).length !== 1) r = false;
      // Attacked$ You,Planeswalker.YouCtrl (Tamiyo, Seasoned Scholar): what it attacks — a player or a permanent.
      if (p.Attacked && r !== false) r = and(r, attackedMatches(state, c?.attacking ?? ev.defender, p.Attacked, env));
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, card: ev.iid, player: c?.controller, defender: ev.defender };
    }
    case 'AttackersDeclared': {
      if (ev.t !== 'attackersDeclared') return null;
      r = matchP(ev.pid, p.AttackingPlayer, env);
      // ValidAttackers$ Dragon.YouCtrl: "whenever you attack with one or more Dragons".
      if (p.ValidAttackers && r !== false) {
        const atk = state.battlefield.filter((x) => state.cards[x].attacking && state.cards[x].controller === ev.pid).map((x) => matchC(state.cards[x], p.ValidAttackers, env));
        r = and(r, atk.includes(true) ? true : atk.includes('unknown') ? 'unknown' : false);
      }
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, player: ev.pid };
    }
    case 'Blocks': {
      if (ev.t !== 'blocks') return null;
      r = matchC(state.cards[ev.iid], p.ValidCard, env);
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, card: ev.iid, player: state.cards[ev.iid]?.controller };
    }
    case 'SpellCast': {
      if (ev.t !== 'cast') return null;
      r = and(matchC(state.cards[ev.iid], p.ValidCard ?? 'Card', env), matchP(ev.pid, p.ValidActivatingPlayer, env));
      if (p.ActivatorThisTurnCast) r = and(r, cmp(ev.nth, p.ActivatorThisTurnCast, () => undefined));
      if (p.TargetsValid && r !== false) r = and(r, spellTargets(state, ev.iid, p.TargetsValid, env));
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, card: ev.iid, player: ev.pid };
    }
    case 'Drawn': {
      if (ev.t !== 'drawn') return null;
      r = and(matchC(state.cards[ev.iid], p.ValidCard, env), matchP(ev.pid, p.ValidPlayer, env));
      if (p.Number) r = and(r, ev.nth === parseInt(p.Number, 10));
      if (p.FirstCardInDrawStep === 'False' && ev.firstInDrawStep) r = false;
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, card: ev.iid, player: ev.pid };
    }
    case 'DamageDone': case 'DamageDoneOnce': case 'DamageDealtOnce': case 'DamageAll': {
      if (ev.t !== 'damage') return null;
      if (p.CombatDamage === 'True' && !ev.combat) return null;
      if (p.CombatDamage === 'False' && ev.combat) return null;
      const src = ev.sourceSnap ?? state.cards[ev.source];
      r = matchC(src, p.ValidSource, env);
      if (p.ValidTarget) {
        if (isPlayerId(state, ev.target)) r = and(r, matchPlayer(ev.target, p.ValidTarget, env));
        else r = and(r, matchC(ev.targetSnap ?? state.cards[ev.target], p.ValidTarget, env));
      }
      if (r === false) return null;
      if (r === 'unknown') return 'unknown';
      const lki: Record<string, Lki> = {};
      if (src) lki[ev.source] = lkiOf(src, ctx);
      return { mode, source: ev.source, card: ev.source, player: src?.controller, target: ev.target, amount: ev.amount, lki };
    }
    case 'BecomesTarget': {
      if (ev.t !== 'targeted') return null;
      const isP = isPlayerId(state, ev.target);
      r = p.ValidTarget ? (isP ? matchPlayer(ev.target, p.ValidTarget.replace(/,?Permanent[^,]*|,?Card[^,]*|,?Creature[^,]*/g, '').replace(/^,/, '') || 'none', env) : matchC(state.cards[ev.target], p.ValidTarget.replace(/(^|,)(You|Player|Opponent)(\.[^,]*)?/g, '').replace(/^,/, '') || 'none', env)) : true;
      const vs = p.ValidSource ?? '';
      if (/^Spell\b/.test(vs) && !ev.spell) r = false;
      if (/OppCtrl/.test(vs)) r = and(r, ev.pid !== env.controller);
      if (/YouCtrl/.test(vs)) r = and(r, ev.pid === env.controller);
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, card: isP ? undefined : ev.target, target: ev.target, source: ev.sourceIid, player: ev.pid };
    }
    case 'SearchedLibrary': {
      if (ev.t !== 'searched') return null;
      if (p.SearchOwnLibrary === 'True' && ev.owner !== ev.pid) return null;
      r = matchP(ev.pid, p.ValidPlayer, env);
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, player: ev.pid };
    }
    case 'BecomeMonarch': {
      if (ev.t !== 'monarch') return null;
      const v = p.ValidPlayer ?? 'Player';
      // "Player.OpponentOf Remembered" (Palace Jailer): an opponent of the remembered player.
      if (/OpponentOf Remembered/.test(v)) r = !!env.remembered && env.remembered.some((x) => isPlayerId(state, x) && x !== ev.pid);
      else r = matchP(ev.pid, v, env);
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, player: ev.pid };
    }
    case 'Transformed': {
      if (ev.t !== 'transformed') return null;
      r = matchC(state.cards[ev.iid], p.ValidCard, env);
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, card: ev.iid, player: state.cards[ev.iid]?.controller };
    }
    case 'Taps': case 'TapsForMana': {
      if (ev.t !== 'tapped' || (mode === 'TapsForMana' && !ev.forMana)) return null;
      r = matchC(state.cards[ev.iid], p.ValidCard, env);
      if (p.Activator) r = and(r, matchP(ev.pid, p.Activator, env));
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, card: ev.iid, player: ev.pid, ...(ev.forMana ? { produced: ev.forMana } : {}) };
    }
    case 'LandPlayed': {
      if (ev.t !== 'landPlayed') return null;
      r = matchC(state.cards[ev.iid], p.ValidCard, env);
      if (p.NotFirstLand === 'True') r = and(r, (state.players.find((x) => x.pid === ev.pid)?.landsPlayed ?? 0) > 1);
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, card: ev.iid, player: ev.pid };
    }
  }
  return null;
}

/** Trigger conditions in KNOWN_PARAMS that matchEvent doesn't check (see there). */
function extraParams(state: GameState, ctx: Ctx, c: CardInstance, p: Record<string, string>, hit: TriggerContext | undefined, ev: GameEvent): Tri {
  const cenv = { state, lookup: ctx.lookup, controller: c.controller, sourceIid: c.iid };
  if (p.PlayerTurn === 'True' && state.activePlayer !== c.controller) return false;
  if (p.OpponentTurn === 'True' && state.activePlayer === c.controller) return false;
  for (const k of ['Revolt', 'Threshold', 'Hellbent'] as const) if (p[k] === 'True' && conditionTrue(k, cenv) === false) return false;
  if (p.DamageAmount && ev.t === 'damage' && cmp(ev.amount, p.DamageAmount, () => undefined) === false) return false;
  if (p.CounterAmount && ev.t === 'counterAdded') {
    // "When the fourth plan counter is put on this": the count went past N with these counters.
    const now = state.cards[ev.iid]?.counters[ev.kind] ?? 0;
    const m = /^(LT|LE|EQ|NE|GE|GT)(\d+)$/.exec(p.CounterAmount);
    if (!m) return 'unknown';
    if (m[1] === 'EQ' ? !(now >= +m[2] && now - ev.n < +m[2]) : cmp(now, p.CounterAmount, () => undefined) === false) return false;
  }
  // Valiant: "becomes the target of a spell or ability you control for the first time each turn".
  if (p.Valiant === 'True' && hit) {
    const ti = turnInfo(state);
    const key = `valiant|${c.iid}|${p.Execute ?? ''}`;
    if ((ti.activations[key] ?? 0) > 0) return false;
    ti.activations[key] = 1;
  }
  return true;
}

/** Static$ True state-maintenance triggers: only "forget what this card remembered" is applied (immediately). */
function staticCleanup(state: GameState, ctx: Ctx, host: Host, p: Record<string, string>, ev: GameEvent, env: MatchEnv) {
  if (!SUPPORTED_MODES.has(p.Mode) || !host.id || host.effect || !hostZoneOk(host, p, ev)) return;
  const chain = triggerChain(host.id, host.face, p.Execute);
  if (chain?.api !== 'Cleanup' || !chain.params.ClearRemembered) return;
  const hit = matchEvent(state, ctx, host, p, ev, env);
  if (hit && hit !== 'unknown' && state.remembered) delete state.remembered[host.c.iid];
}

/** "Once"/"All" modes trigger once per batch (per target / per source for the damage ones). */
function onceKey(mode: string, hit: TriggerContext): string | null {
  switch (mode) {
    case 'ChangesZoneAll': case 'DiscardedAll': case 'AttackersDeclared': case 'DamageAll': case 'TokenCreatedOnce': case 'AttackerUnblockedOnce': return '';
    case 'CounterAddedOnce': return `c:${hit.card}`;
    case 'DamageDoneOnce': return `t:${hit.target}`;
    case 'DamageDealtOnce': return `s:${hit.source}`;
  }
  return null;
}

// ------------------------------------------------------------------ detection

function hostsFor(state: GameState, ev: GameEvent, leftSnaps: Map<string, CardInstance>): Host[] {
  const out = new Map<string, Host>();
  const add = (c: CardInstance | undefined, lki: boolean) => {
    if (!c || c.faceDown || out.has(c.iid)) return;
    const ref = scriptRef(c);
    out.set(c.iid, { c, face: ref?.face ?? 0, id: ref?.cardId, lki });
  };
  const leaveEvent = ev.t === 'zone' && ev.from === 'battlefield';
  if (leaveEvent) for (const snap of leftSnaps.values()) add(snap, true);
  if (ev.t === 'zone') add(ev.from === 'battlefield' ? ev.snap : state.cards[ev.iid] ?? ev.snap, ev.from === 'battlefield' || !state.cards[ev.iid]);
  if (ev.t === 'cast') add(state.cards[ev.iid], false);
  for (const iid of state.battlefield) add(state.cards[iid], false);
  for (const p of state.players) for (const iid of p.zones.graveyard) {
    const c = state.cards[iid];
    if (c?.cardId && triggersOf(c.cardId, 0).some((t) => /Graveyard/.test(t.params.TriggerZones ?? ''))) add(c, false);
  }
  return [...out.values(), ...extraTriggerHosts(state)];
}

/** Zone the host must be in for this trigger to work. */
function hostZoneOk(host: Host, p: Record<string, string>, ev: GameEvent): boolean {
  if (host.effect) return true;
  const zone: Zone = host.lki ? 'battlefield' : host.c.zone;
  if (zone === 'hand' || zone === 'library' || zone === 'sideboard') return false; // hidden zones: never (logs are public)
  const isEventCard = (ev.t === 'zone' || ev.t === 'cast') && ev.iid === host.c.iid;
  if (p.TriggerZones) {
    const zs = p.TriggerZones.split(',').map((z) => ZONE_NAMES[z.trim()]);
    if (zs.includes(zone)) return true;
    // Leaves-the-battlefield triggers of the card itself look back in time.
    return isEventCard && host.lki && zs.includes('battlefield');
  }
  return zone === 'battlefield' || isEventCard;
}

interface Detected { controller: string; q: QueuedTrigger }

function hostLabel(host: Host, ctx: Ctx): string {
  if (host.effect) return host.effect.name;
  return cardName(host.c, ctx.lookup);
}

function queueFor(state: GameState, ctx: Ctx, host: Host, index: number, p: Record<string, string>, hit: TriggerContext, line?: string, ref?: { cardId: string; face: number }): QueuedTrigger {
  const c = host.c;
  const cardId = ref?.cardId ?? host.id ?? '';
  const face = ref?.face ?? host.face;
  const auto: AutoInfo = { cardId, face, source: 'trigger', index, targets: [], trigger: hit };
  if (line) auto.line = line; else if (p.Execute) auto.svar = p.Execute;
  const cond: Record<string, string> = {};
  for (const k of ['IsPresent', 'PresentCompare', 'CheckSVar', 'SVarCompare', 'CheckDefinedPlayer', 'Delirium']) if (p[k]) cond[k] = p[k];
  if (Object.keys(cond).length && p.NoResolvingCheck !== 'True') hit.condition = cond;
  const name = hostLabel(host, ctx);
  const chain = chainOf(auto);
  const faceName = (cardId && getScript(cardId)?.[face]?.name) || name;
  const desc = describe(p.TriggerDescription ?? chain?.description ?? 'Triggered ability', faceName);
  const optCost = !!chain && chain.kind === 'AB' && !!chain.params.Cost ? parseCostTokens(chain.params.Cost) : undefined;
  const manual = !chain || (!!optCost && optCost.unknown.length > 0);
  const q: QueuedTrigger = { id: randomId(ctx.rng), controller: c.controller, sourceIid: state.cards[c.iid] ? c.iid : undefined, sourceName: name, text: `${name}: ${desc}`, auto };
  if (p.OptionalDecider && !(optCost && !optCost.mandatory)) q.optional = true; // an optional cost already asks
  if (manual) q.manual = true;
  return q;
}

function counterName(forge: string): string {
  const t = forge.trim().toUpperCase();
  return t === 'P1P1' ? '+1/+1' : t === 'M1M1' ? '-1/-1' : t === 'LOYALTY' ? 'loyalty' : t.toLowerCase();
}

/** Attacked$: comma-separated player specs (You, Opponent ...) or card specs (Planeswalker.YouCtrl, Battle ...). */
function attackedMatches(state: GameState, target: string, spec: string, env: MatchEnv): Tri {
  const card = state.cards[target];
  let res: Tri = false;
  for (const one of spec.split(',').map((x) => x.trim()).filter(Boolean)) {
    const isCardSpec = /^(Card|Permanent|Creature|Planeswalker|Battle|Artifact|Enchantment)\b/.test(one);
    const m: Tri = isCardSpec ? (card ? matchCard(card, one, env) : false) : (card ? false : matchPlayer(target, one, env));
    if (m === true) return true;
    if (m === 'unknown') res = 'unknown';
  }
  return res;
}

/** Find the triggered abilities that the events in state.events trigger, and queue them (APNAP). */
function detect(state: GameState, ctx: Ctx) {
  // No-blockers shortcut (strict: the defender couldn't block): the attackers are unblocked all the same.
  if ((state.events ?? []).some((e) => e.t === 'phase' && e.step === 'blockers') && state.combat.blockersDeclared) emitUnblocked(state);
  const events = state.events ?? [];
  state.events = [];
  if (!events.length) return;
  const found: Detected[] = [];
  const once = new Set<string>();
  const leftSnaps = new Map<string, CardInstance>();
  // Last-known attachments: an Equipment / Aura whose creature left in these events still "equips" it for them
  // (Skullclamp: "whenever equipped creature dies"; Jitte / Swords: combat damage from a creature that then died).
  const lkiAttached = new Map<string, string>();
  for (const ev of events) if (ev.t === 'zone' && ev.from === 'battlefield') {
    leftSnaps.set(ev.iid, ev.snap);
    for (const a of ev.attached ?? []) if (!lkiAttached.has(a)) lkiAttached.set(a, ev.iid);
  }
  const auto = (pid: string) => state.players.find((p) => p.pid === pid)?.autoTriggers !== false;
  for (const ev of events) {
    let hosts: Host[];
    try { hosts = hostsFor(state, ev, leftSnaps); } catch (e) { log(state, ctx, null, `Trigger detection error: ${(e as Error).message}`); continue; }
    for (const host of hosts) {
      const c = host.c;
      if (!auto(c.controller)) continue;
      try {
        const env: MatchEnv = { controller: c.controller, sourceIid: c.iid, lookup: ctx.lookup, attachedTo: c.attachedTo || lkiAttached.get(c.iid) || '', turnInfo: turnInfo(state), chosen: c.chosen ?? {}, ...(host.effect ? { remembered: host.effect.remembered } : {}) };
        // Prowess (keyword) as a synthesized trigger.
        if (ev.t === 'cast' && !host.lki && c.zone === 'battlefield' && hasKeyword(c, ctx.lookup, 'Prowess')) {
          const p = { Mode: 'SpellCast', ValidCard: 'Card.nonCreature', ValidActivatingPlayer: 'You', TriggerZones: 'Battlefield', TriggerDescription: 'Prowess (+1/+1 until end of turn)' };
          const hit = matchEvent(state, ctx, host, p, ev, env);
          if (hit && hit !== 'unknown') found.push({ controller: c.controller, q: queueFor(state, ctx, host, -1, p, hit, PROWESS_LINE) });
        }
        // Triggered keywords (Annihilator, Exalted, Persist, Living Weapon, Fading, Cascade, Storm ...): engine/kwtriggers.ts.
        if (host.id && !host.effect && !c.faceDown) {
          for (const kt of keywordTriggers(getScript(host.id)?.[host.face]?.keywords ?? [])) {
            if (!hostZoneOk(host, kt.params, ev)) continue;
            const hit = matchEvent(state, ctx, host, kt.params, ev, env);
            if (!hit || hit === 'unknown') continue;
            const ok = onceKey(kt.params.Mode, hit);
            if (ok != null) { const key = `${c.iid}|kw${kt.kw}|${ok}`; if (once.has(key)) continue; once.add(key); }
            found.push({ controller: c.controller, q: queueFor(state, ctx, host, -1, kt.params, hit, kt.line) });
          }
        }
        // Triggers other permanents grant it (Kaldra Compleat, Nadu): engine/grants.ts.
        const foreign = host.effect || host.lki ? [] : foreignTriggers(state, c.iid, ctx.lookup);
        if (!host.id && !host.effect && !c.animations && !foreign.length) continue;
        // The card's T: lines (a copy: the copied card's), triggers granted by animate effects, or an effect's triggers.
        const own = host.effect ? host.effect.triggers : host.id ? triggersOf(host.id, host.face) : [];
        for (const t of [...own, ...(host.effect ? [] : grantedTriggers(c)), ...foreign] as { index: number; params: Record<string, string>; ref?: { cardId: string; face: number } }[]) {
          const p = t.params;
          if (p.Static === 'True') {
            const ch = host.id ? triggerChain(host.id, host.face, p.Execute) : undefined;
            const forgetOnly = ch?.api === 'Pump' && !ch.sub && Object.keys(ch.params).every((k) => /^(Forget|Defined$|StackDescription$|SpellDescription$)/.test(k));
            if (ch?.api === 'Cleanup' || forgetOnly || p.Mode === 'TapsForMana' || p.Mode === 'ChangesZone' && /^(Cleanup|Forget)/.test(ch?.api ?? '')) { staticCleanup(state, ctx, host, p, ev, env); continue; }
            // Other "static" triggers (an effect's "exiled until an opponent becomes the monarch") use the stack like any trigger.
          }
          if (!SUPPORTED_MODES.has(p.Mode)) continue;
          if (!hostZoneOk(host, p, ev)) continue;
          const hit = matchEvent(state, ctx, host, p, ev, env);
          if (!hit) continue;
          const extra = extraParams(state, ctx, c, p, hit === 'unknown' ? undefined : hit, ev);
          if (extra === false) continue;
          const unknownParam = extra === 'unknown' ? 'condition' : Object.keys(p).find((k) => !KNOWN_PARAMS.has(k));
          const faceName = getScript(t.ref?.cardId ?? host.id ?? '')?.[t.ref?.face ?? host.face]?.name ?? hostLabel(host, ctx);
          const desc = describe(p.TriggerDescription ?? 'a triggered ability', faceName);
          if (hit === 'unknown' || unknownParam) {
            if (once.has(`hint|${c.iid}|${t.index}`)) continue;
            once.add(`hint|${c.iid}|${t.index}`);
            log(state, ctx, c.controller, `Check by hand: ${hostLabel(host, ctx)} may trigger — ${desc}`);
            continue;
          }
          const ok = onceKey(p.Mode, hit);
          if (ok != null) {
            const key = `${c.iid}|${t.index}|${ok}`;
            if (once.has(key)) continue;
            once.add(key);
          }
          if (p.IsPresent || p.CheckSVar || p.CheckDefinedPlayer || p.Delirium) {
            const cond: Record<string, string> = {};
            for (const k of ['IsPresent', 'PresentCompare', 'CheckSVar', 'SVarCompare', 'CheckDefinedPlayer', 'Delirium']) if (p[k]) cond[k] = p[k];
            const holds = conditionHolds(state, ctx, cond, c.controller, c.iid, t.ref?.cardId ?? host.id, t.ref?.face ?? host.face, hit);
            if (holds === false) continue;
            if (holds === 'unknown') { log(state, ctx, c.controller, `Check by hand: ${hostLabel(host, ctx)} may trigger (condition not verified) — ${desc}`); continue; }
          }
          if (p.ActivationLimit) {
            const st = (state.turnStats ??= { cast: {}, drawn: {} });
            const fired = (st.fired ??= {});
            const key = `${c.iid}|${t.index}`;
            if ((fired[key] ?? 0) >= parseInt(p.ActivationLimit, 10)) continue;
            fired[key] = (fired[key] ?? 0) + 1;
          }
          if (budget <= 0) { if (budget === 0) log(state, ctx, null, 'Too many triggers in one action — stopping automatic triggers (put the rest on the stack by hand).'); budget--; continue; }
          budget--;
          if (uniqueTriggerSkip(state, ctx, t.ref?.cardId ?? c.cardId ?? "", t.ref?.face ?? host.face, p, hit.player)) continue;
          if (host.effect) hit.effectRemembered = [...host.effect.remembered];
          const q = queueFor(state, ctx, host, t.index, p, hit, uniqueTriggerLine(t.ref?.cardId ?? c.cardId ?? "", t.ref?.face ?? host.face, p), t.ref);
          found.push({ controller: c.controller, q });
          // Panharmonicon-style statics (Sanctum of All): the ability triggers additional times.
          if (!host.effect) for (let k = extraTriggerCount(state, ctx, c, p); k > 0; k--) {
            found.push({ controller: c.controller, q: { ...JSON.parse(JSON.stringify(q)) as QueuedTrigger, id: randomId(ctx.rng) } });
          }
        }
      } catch (e) {
        log(state, ctx, null, `Trigger detection error (${hostLabel(host, ctx)}): ${(e as Error).message} — handle it by hand.`);
      }
    }
    if (ev.t === 'phase') delayedFor(state, ctx, ev, found);
    else eventDelayedFor(state, ctx, ev, found);
    if (ev.t === 'drawn' && ev.nth === 1) miracle(state, ctx, ev, found);
    if (ev.t === 'attacks') exertOffer(state, ctx, ev, found);
  }
  // APNAP: the active player's triggers go on the stack first, then the others' in turn order.
  const order = state.players.map((p) => p.pid);
  const ai = order.indexOf(state.activePlayer);
  const rank = (pid: string) => (order.indexOf(pid) - ai + order.length) % order.length;
  found.sort((a, b) => rank(a.controller) - rank(b.controller));
  (state.triggerQueue ??= []).push(...found.map((f) => f.q));
}

/** Miracle: the first card a player draws in a turn may be revealed and cast for its miracle cost. */
function miracle(state: GameState, ctx: Ctx, ev: Extract<GameEvent, { t: 'drawn' }>, found: Detected[]) {
  const c = state.cards[ev.iid];
  if (!c || c.zone !== 'hand' || !c.cardId) return;
  const kw = getScript(c.cardId)?.[0]?.keywords.find((k) => /^Miracle:/.test(k));
  if (!kw) return;
  const cost = kw.split(':')[1].trim();
  if (state.players.find((p) => p.pid === ev.pid)?.autoTriggers === false) return;
  const { toks, unknown } = parseCostTokens(cost);
  if (unknown.length || !canPayCost(state, ctx, ev.pid, undefined, toks, 0)) return; // can't cast it: no need to reveal
  const name = cardName(c, ctx.lookup);
  const line = `DB$ Play | Defined$ TriggeredCard | PlayCost$ ${cost} | Optional$ True | SpellDescription$ Miracle — you may cast it by paying ${cost}.`;
  found.push({ controller: ev.pid, q: { id: randomId(ctx.rng), controller: ev.pid, sourceIid: c.iid, sourceName: name, text: `${name}: Miracle — you may cast it for its miracle cost`,
    auto: { cardId: c.cardId, face: 0, source: 'trigger', index: -1, line, targets: [], trigger: { mode: 'Drawn', card: c.iid, player: ev.pid } } } });
  log(state, ctx, ev.pid, `${player(state, ev.pid).name} reveals ${name} (miracle).`);
}

/**
 * Exert (Glorybringer: S:Mode$ OptionalAttackCost | Cost$ Exert<1/CARDNAME> | Trigger$ X): "you may exert it as it
 * attacks. When you do, <X>". Offered as an optional trigger; using it exerts the creature (it doesn't untap during
 * its controller's next untap step, replacements.ts untapPrevented).
 */
function exertOffer(state: GameState, ctx: Ctx, ev: Extract<GameEvent, { t: 'attacks' }>, found: Detected[]) {
  const c = state.cards[ev.iid];
  const ref = c ? scriptRef(c) : undefined;
  const f = ref ? getScript(ref.cardId)?.[ref.face] : undefined;
  if (!c || !ref || !f || c.zone !== 'battlefield') return;
  for (const line of f.statics) {
    const p = parseParams(line).params;
    if (p.Mode !== 'OptionalAttackCost' || p.ValidCard !== 'Card.Self' || !/^Exert<1\/(CARDNAME|Self|NICKNAME)>$/.test(p.Cost ?? '') || !p.Trigger || !f.svars[p.Trigger]) continue;
    const name = cardName(c, ctx.lookup);
    const desc = (p.Description ?? 'You may exert it as it attacks.').replace(/CARDNAME/g, name);
    found.push({ controller: c.controller, q: {
      id: randomId(ctx.rng), controller: c.controller, sourceIid: c.iid, sourceName: name, text: `${name}: ${desc}`, optional: true, exert: c.iid,
      auto: { cardId: ref.cardId, face: ref.face, source: 'trigger', index: -1, svar: p.Trigger, targets: [], trigger: { mode: 'Attacks', card: c.iid, player: c.controller, defender: ev.defender } },
    } });
  }
}

/** Panharmonicon statics (S:Mode$ Panharmonicon | ValidCard$ | IsPresent$ | PresentCompare$): how many extra times a trigger of `c` triggers. */
export function extraTriggerCount(state: GameState, ctx: Ctx, c: CardInstance, p: Record<string, string>): number {
  if (c.zone !== 'battlefield') return 0;
  let n = 0;
  for (const iid of state.battlefield) {
    const src = state.cards[iid];
    if (!src || src.faceDown || src.controller !== c.controller) continue;
    const f = scriptRef(src) ? getScript(scriptRef(src)!.cardId)?.[scriptRef(src)!.face] : undefined;
    for (const line of f?.statics ?? []) {
      const sp = parseParams(line).params;
      if (sp.Mode !== 'Panharmonicon' || Object.keys(sp).some((k) => !['Mode', 'ValidCard', 'IsPresent', 'PresentCompare', 'Description', 'ValidMode'].includes(k))) continue;
      if (sp.ValidMode && !sp.ValidMode.split(',').includes(p.Mode)) continue;
      const env: MatchEnv = { controller: src.controller, sourceIid: src.iid, lookup: ctx.lookup };
      if (sp.ValidCard && matchCard(c, sp.ValidCard, env) !== true) continue;
      if (sp.IsPresent) {
        const have = state.battlefield.filter((x) => matchCard(state.cards[x], sp.IsPresent, env) === true).length;
        if (cmp(have, sp.PresentCompare ?? 'GE1', () => undefined) !== true) continue;
      }
      n++;
    }
  }
  return n;
}

/** Mark a creature exerted: it doesn't untap during its controller's next untap step. */
export function exert(state: GameState, ctx: Ctx, iid: string) {
  const c = state.cards[iid];
  if (!c || c.zone !== 'battlefield') return;
  (state.remembered ??= {})[`exerted|${iid}`] = [String(state.turn)];
  log(state, ctx, c.controller, `${player(state, c.controller).name} exerts ${cardName(c, ctx.lookup)} (it won't untap during their next untap step).`);
}

/** Event-based delayed triggers ("when you cast your next instant or sorcery spell this turn", "when CARDNAME leaves the battlefield"). */
function eventDelayedFor(state: GameState, ctx: Ctx, ev: GameEvent, found: Detected[]) {
  const list = state.delayedTriggers ?? [];
  if (!list.some((d) => d.event)) return;
  const keep = [];
  for (const d of list) {
    if (!d.event || d.thisTurn && state.turn > d.turn) { if (!d.event || !d.thisTurn || state.turn <= d.turn) keep.push(d); continue; }
    const c = (d.sourceIid && state.cards[d.sourceIid]) || ({ iid: d.sourceIid ?? '', cardId: d.auto.cardId, controller: d.controller, owner: d.controller, zone: 'command', counters: {} } as unknown as CardInstance);
    const host: Host = { c, face: d.auto.face ?? 0, id: d.auto.cardId, lki: false };
    const env: MatchEnv = { controller: d.controller, sourceIid: c.iid, lookup: ctx.lookup, attachedTo: c.attachedTo ?? '', turnInfo: turnInfo(state) };
    let hit: Hit = null;
    try { hit = matchEvent(state, ctx, host, d.event, ev, env); } catch { hit = null; }
    if (!hit || hit === 'unknown') { keep.push(d); continue; }
    if (state.players.find((p) => p.pid === d.controller)?.autoTriggers === false) { log(state, ctx, d.controller, `Reminder (automatic triggers are off): ${d.text}`); continue; }
    const prev = d.auto.trigger;
    const auto: AutoInfo = { ...d.auto, trigger: { ...hit, remembered: prev?.remembered ?? [], lki: { ...(hit.lki ?? {}), ...(prev?.lki ?? {}) } } };
    found.push({ controller: d.controller, q: { id: d.id, controller: d.controller, sourceIid: d.sourceIid && state.cards[d.sourceIid] ? d.sourceIid : undefined, sourceName: d.sourceName, text: d.text, auto } });
  }
  state.delayedTriggers = keep;
}

function delayedFor(state: GameState, ctx: Ctx, ev: Extract<GameEvent, { t: 'phase' }>, found: Detected[]) {
  const list = state.delayedTriggers ?? [];
  if (!list.length) return;
  const keep = [];
  for (const d of list) {
    if (d.thisTurn && ev.turn > d.turn) continue; // expired
    if (d.event) { keep.push(d); continue; }
    if (d.pid && ev.active !== d.pid) { keep.push(d); continue; }
    const stepMatch = ev.step === d.step || (d.step === 'end' && ev.step === 'cleanup');
    const next = ev.turn > d.turn || STEPS.indexOf(d.createdStep) < STEPS.indexOf(d.step);
    if (!stepMatch || !next) { keep.push(d); continue; }
    if (state.players.find((p) => p.pid === d.controller)?.autoTriggers === false) {
      log(state, ctx, d.controller, `Reminder (automatic triggers are off): ${d.text}`);
      continue;
    }
    found.push({ controller: d.controller, q: { id: d.id, controller: d.controller, sourceIid: d.sourceIid && state.cards[d.sourceIid] ? d.sourceIid : undefined, sourceName: d.sourceName, text: d.text, auto: d.auto } });
  }
  state.delayedTriggers = keep;
}

// ------------------------------------------------------------------ putting triggers on the stack

function candidates(state: GameState, ctx: Ctx, spec: TargetSpec, controller: string, sourceIid: string | undefined): TargetRef[] {
  const refs: TargetRef[] = [];
  if (spec.players) for (const p of state.players) refs.push({ kind: 'player', pid: p.pid });
  if (spec.zone === 'stack') for (const s of state.stack) refs.push({ kind: 'stack', id: s.id });
  else if (spec.cards) for (const iid of Object.keys(state.cards)) refs.push({ kind: 'card', iid });
  return refs.filter((r) => isValidTarget(state, spec, r, controller, sourceIid, ctx.lookup));
}

function targetName(state: GameState, ctx: Ctx, ref: TargetRef): string {
  if (ref.kind === 'player') return state.players.find((p) => p.pid === ref.pid)?.name ?? 'a player';
  if (ref.kind === 'card') return cardName(state.cards[ref.iid], ctx.lookup);
  return state.stack.find((s) => s.id === ref.id)?.text ?? 'an ability';
}

function push(state: GameState, ctx: Ctx, t: QueuedTrigger) {
  if (t.exert) exert(state, ctx, t.exert);
  const item: StackItem = { id: randomId(ctx.rng), kind: 'trigger', controller: t.controller, text: t.text };
  if (t.sourceIid) item.sourceIid = t.sourceIid;
  if (!t.manual) item.auto = t.auto;
  state.stack.push(item);
  const tn = t.auto.targets.flat().map((r) => targetName(state, ctx, r));
  const desc = t.text.startsWith(`${t.sourceName}: `) ? t.text.slice(t.sourceName.length + 2) : t.text;
  log(state, ctx, t.controller, `${t.sourceName}'s trigger${tn.length ? ` (targeting ${tn.join(', ')})` : ''}: ${desc}${t.manual ? ' — resolve it by hand' : ''}`);
  if (item.auto?.targets.flat().length) wardReminders(state, ctx, t.controller, item.auto.targets); // "becomes the target" events + ward
}

/**
 * Put queued triggers on the stack, asking for decisions / targets first.
 * Returns the controllers of the triggers that went on the stack.
 */
function flush(state: GameState, ctx: Ctx): string[] {
  const q = state.triggerQueue ?? [];
  const pushed: string[] = [];
  while (q.length && !state.pending.length && !state.players.some((p) => p.peek?.then) && state.phase === 'playing') {
    const t = q[0];
    if (!t.manual && !t.targetsChosen) {
      const chain = chainOf(t.auto);
      const specs = chain ? targetSpecs(chain) : [];
      if (specs.length) {
        const cands = specs.map((s) => candidates(state, ctx, s, t.controller, t.sourceIid));
        if (specs.some((s, k) => s.min > 0 && cands[k].length < s.min)) {
          log(state, ctx, t.controller, `${t.sourceName}'s trigger has no legal targets — removed (${t.text}).`);
          q.shift();
          continue;
        }
        if (cands.every((c) => c.length === 0)) {
          t.auto.targets = specs.map(() => []);
          t.targetsChosen = true;
        } else {
          const options: { value: string; label: string }[] = [];
          if (specs.every((s) => s.min === 0)) options.push({ value: 'none', label: 'No targets' });
          if (t.optional) options.push({ value: 'decline', label: "Don't use it" });
          state.pending.push({
            id: randomId(ctx.rng), pid: t.controller, prompt: `${t.text} — choose target${specs.length > 1 || specs[0].max > 1 ? 's' : ''}`,
            options, data: { kind: 'trigger', qid: t.id }, targets: { specs, sourceIid: t.sourceIid, controller: t.controller, label: t.sourceName },
          });
          break;
        }
      } else t.targetsChosen = true;
    }
    if (t.optional && !t.accepted && !(t.targetsChosen && t.auto.targets.some((l) => l.length))) {
      state.pending.push({
        id: randomId(ctx.rng), pid: t.controller, prompt: `Use ${t.sourceName}'s ability? (${t.text})`,
        options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], data: { kind: 'trigger', qid: t.id },
      });
      break;
    }
    q.shift();
    push(state, ctx, t);
    pushed.push(t.controller);
  }
  return pushed;
}

/**
 * Detect triggers from the recorded events and put them on the stack (asking questions first when needed).
 * Gives priority to the active player (or, when all new triggers are one player's, to the next player).
 * Returns true when something was put on the stack.
 */
export function processTriggers(state: GameState, ctx: Ctx): boolean {
  if (state.phase !== 'playing') { state.events = []; return false; }
  trackTurnEvents(state, ctx);
  designationTriggers(state, ctx, state.events ?? []); // monarch draw / steal, initiative (engine/designations.ts)
  uniqueTriggers(state, ctx); // Sagas, Hideaway, Mode$ Always, Saga sacrifice (turns.ts)
  try { detect(state, ctx); } catch (e) { log(state, ctx, null, `Trigger detection error: ${(e as Error).message}`); }
  const pushed = flush(state, ctx);
  // Triggers put on the stack can cause events of their own ("becomes the target": Nadu, ward): detect those now,
  // so their triggers go on the stack above them.
  for (let guard = 0; guard < 5 && pushed.length && state.events?.some((e) => e.t === 'targeted') && !state.pending.length; guard++) {
    try { detect(state, ctx); } catch (e) { log(state, ctx, null, `Trigger detection error: ${(e as Error).message}`); }
    pushed.push(...flush(state, ctx));
  }
  if (!pushed.length) return false;
  const live = state.players.filter((p) => !p.conceded).map((p) => p.pid);
  const ctrls = new Set(pushed);
  if (ctrls.size === 1 && live.length > 1) {
    const c = pushed[0];
    const i = live.indexOf(c);
    state.passed = [c];
    state.priority = live[(i + 1) % live.length];
  } else {
    state.passed = [];
    state.priority = state.activePlayer;
  }
  return true;
}

// ------------------------------------------------------------------ answers

/** Answer a trigger question with 'choose'. Returns undefined when the Pending isn't a trigger question. */
export function answerTriggerChoice(state: GameState, ctx: Ctx, pid: string, id: string, value: string): string | null | undefined {
  const pend = state.pending.find((p) => p.id === id);
  if (!pend || pend.data.kind !== 'trigger') return undefined;
  if (pend.pid !== pid) return 'That question is for another player';
  if (!pend.options.some((o) => o.value === value)) return 'Not one of the options';
  state.pending = state.pending.filter((p) => p !== pend);
  const q = state.triggerQueue ?? [];
  const t = q.find((x) => x.id === pend.data.qid);
  if (!t) return null;
  if (value === 'no' || value === 'decline') {
    state.triggerQueue = q.filter((x) => x !== t);
    log(state, ctx, pid, `${player(state, pid).name} doesn't use ${t.sourceName}'s trigger.`);
  } else if (value === 'none') {
    const chain = chainOf(t.auto);
    t.auto.targets = chain ? targetSpecs(chain).map(() => []) : [];
    t.targetsChosen = true;
    t.accepted = true;
  } else t.accepted = true;
  return null;
}

/** Answer a trigger's target question ('chooseTargets'). */
export function answerTriggerTargets(state: GameState, ctx: Ctx, pid: string, id: string, targets: TargetRef[][]): string | null {
  const pend = state.pending.find((p) => p.id === id);
  if (!pend) return 'That question is no longer open';
  if (pend.pid !== pid) return 'That question is for another player';
  if (pend.targets && pend.data.kind !== 'trigger') return answerResolveTargets(state, ctx, pend, targets); // resolve.ts / more.ts questions
  if (!pend.targets || pend.data.kind !== 'trigger') return 'That question does not take targets';
  const t = (state.triggerQueue ?? []).find((x) => x.id === pend.data.qid);
  if (!t) { state.pending = state.pending.filter((p) => p !== pend); return null; }
  const chain = chainOf(t.auto);
  if (!chain) return 'Unknown ability';
  const res = checkTargets(state, chain, undefined, targets, t.controller, t.sourceIid ?? '', ctx, t.sourceName);
  if ('error' in res) return res.error;
  state.pending = state.pending.filter((p) => p !== pend);
  t.auto.targets = res.targets;
  t.auto.targetZones = res.targetZones;
  t.targetsChosen = true;
  t.accepted = true;
  return null;
}

/**
 * Before a triggered ability resolves: re-check its intervening "if". Returns false (and removes it) when the
 * condition no longer holds.
 */
export function triggerStillApplies(state: GameState, ctx: Ctx, item: StackItem): boolean {
  const cond = item.auto?.trigger?.condition;
  if (item.kind !== 'trigger' || !item.auto || !cond) return true;
  const holds = conditionHolds(state, ctx, cond, item.controller, item.sourceIid, item.auto.cardId, item.auto.face, item.auto.trigger);
  if (holds !== false) return true;
  state.stack = state.stack.filter((s) => s !== item);
  log(state, ctx, item.controller, `${item.text} — its condition is no longer true; it does nothing.`);
  return false;
}

/** Triggers waiting (for the UI / tests). */
export function queuedTriggers(state: GameState): QueuedTrigger[] {
  return state.triggerQueue ?? [];
}
