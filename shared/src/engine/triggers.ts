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
import { chainOf, describe, getScript, isAutomatable, PHASES, scriptRef, targetSpecs, triggersOf } from './script.ts';
import { extraTriggerHosts, grantedTriggers } from './effects.ts';
import { isValidTarget, matchCard, matchPlayer, type MatchEnv, type Tri } from './targets.ts';
import type { AutoInfo, Lki, ParsedAbility, QueuedTrigger, TargetRef, TargetSpec, TriggerContext } from './types.ts';
import { uniqueVar } from './unique.ts';
import { notePermissionUse } from './permissions.ts';
import { moreVar } from './more.ts';
import { turnInfo } from './durations.ts';
import { conditionTrue, evalCount } from './counts.ts';
import { parseCostTokens } from './paycost.ts';
import { wardReminders } from './keyword-play.ts';
import { uniqueTriggerLine, uniqueTriggerSkip, uniqueTriggerSupport, uniqueTriggers } from './turns.ts';

/** Max triggered abilities detected per player action (loop guard). */
export const MAX_TRIGGERS_PER_ACTION = 100;
let budget = MAX_TRIGGERS_PER_ACTION;

/** Trigger modes the engine detects. */
export const SUPPORTED_MODES = new Set([
  'ChangesZone', 'ChangesZoneAll', 'Phase', 'Attacks', 'AttackersDeclared', 'Blocks', 'SpellCast', 'Drawn', 'DamageDone',
  'DamageDoneOnce', 'DamageDealtOnce', 'Sacrificed', 'Discarded', 'DiscardedAll', 'LandPlayed', 'Exiled',
  'BecomesTarget', 'Transformed', 'Taps', 'TapsForMana',
]);

/** Trigger parameters the engine understands; a trigger with any other parameter is left to the players. */
const KNOWN_PARAMS = new Set([
  'Mode', 'Execute', 'TriggerDescription', 'ValidCard', 'ValidCards', 'Origin', 'Destination', 'TriggerZones', 'ValidPlayer', 'Phase',
  'OptionalDecider', 'ValidActivatingPlayer', 'ValidSource', 'ValidTarget', 'Static', 'Secondary', 'CombatDamage', 'IsPresent',
  'PresentCompare', 'ActivatorThisTurnCast', 'AttackingPlayer', 'CheckSVar', 'SVarCompare', 'Number', 'FirstCardInDrawStep',
  'NotFirstLand', 'NoResolvingCheck', 'ActivationLimit', 'Activator', 'ValidSA', 'CheckDefinedPlayer', 'FirstAttack', 'Delirium', 'ResolvedLimit',
  'ValidDefenders', 'ValidAttackingPlayer', 'ValidToken', 'CounterType', 'SearchOwnLibrary', 'ThisDoor', 'ValidAttacker', 'ValidBlocker',
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
    return { detect: false, chain: false, reason: 'static' };
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
  effect?: { name: string; triggers: { index: number; params: Record<string, string> }[] };
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

/** This turn's history from the action's events: attackers, permanents that entered, permissions used, the city's blessing. */
function trackTurnEvents(state: GameState, ctx: Ctx) {
  const evs = state.events ?? [];
  if (!evs.length) return;
  const ti = turnInfo(state);
  for (const ev of evs) {
    if (ev.t === 'cast') notePermissionUse(state, state.cards[ev.iid]?.castInfo?.permission); // once-per-turn permissions (Lurrus)
    else if (ev.t === 'attacks') {
      ti.activations[`attacked|${ev.iid}`] = (ti.activations[`attacked|${ev.iid}`] ?? 0) + 1;
      const who = state.cards[ev.iid]?.controller;
      if (who) ti.activations[`attacks|${who}`] = (ti.activations[`attacks|${who}`] ?? 0) + 1;
    } else if (ev.t === 'zone' && ev.to === 'battlefield') ti.activations[`entered|${ev.iid}`] = 1;
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
      if (ev.t !== 'phase' || PHASES[p.Phase ?? ''] !== ev.step) return null;
      r = matchP(ev.active, p.ValidPlayer, env);
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, player: ev.active };
    }
    case 'Attacks': {
      if (ev.t !== 'attacks') return null;
      const c = state.cards[ev.iid];
      r = matchC(c, p.ValidCard, env);
      // FirstAttack$ True: "attacks for the first time each turn" (the attack being processed is counted already).
      if (p.FirstAttack === 'True' && (turnInfo(state).activations[`attacked|${ev.iid}`] ?? 0) > 1) r = false;
      if (r === false) return null;
      return r === 'unknown' ? 'unknown' : { mode, card: ev.iid, player: c?.controller, defender: ev.defender };
    }
    case 'AttackersDeclared': {
      if (ev.t !== 'attackersDeclared') return null;
      r = matchP(ev.pid, p.AttackingPlayer, env);
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
    case 'DamageDone': case 'DamageDoneOnce': case 'DamageDealtOnce': {
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
    case 'ChangesZoneAll': case 'DiscardedAll': case 'AttackersDeclared': return '';
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

/** Find the triggered abilities that the events in state.events trigger, and queue them (APNAP). */
function detect(state: GameState, ctx: Ctx) {
  const events = state.events ?? [];
  state.events = [];
  if (!events.length) return;
  const found: Detected[] = [];
  const once = new Set<string>();
  const leftSnaps = new Map<string, CardInstance>();
  for (const ev of events) if (ev.t === 'zone' && ev.from === 'battlefield') leftSnaps.set(ev.iid, ev.snap);
  const auto = (pid: string) => state.players.find((p) => p.pid === pid)?.autoTriggers !== false;
  for (const ev of events) {
    let hosts: Host[];
    try { hosts = hostsFor(state, ev, leftSnaps); } catch (e) { log(state, ctx, null, `Trigger detection error: ${(e as Error).message}`); continue; }
    for (const host of hosts) {
      const c = host.c;
      if (!auto(c.controller)) continue;
      try {
        const env: MatchEnv = { controller: c.controller, sourceIid: c.iid, lookup: ctx.lookup, attachedTo: c.attachedTo ?? '' };
        // Prowess (keyword) as a synthesized trigger.
        if (ev.t === 'cast' && !host.lki && c.zone === 'battlefield' && hasKeyword(c, ctx.lookup, 'Prowess')) {
          const p = { Mode: 'SpellCast', ValidCard: 'Card.nonCreature', ValidActivatingPlayer: 'You', TriggerZones: 'Battlefield', TriggerDescription: 'Prowess (+1/+1 until end of turn)' };
          const hit = matchEvent(state, ctx, host, p, ev, env);
          if (hit && hit !== 'unknown') found.push({ controller: c.controller, q: queueFor(state, ctx, host, -1, p, hit, PROWESS_LINE) });
        }
        if (!host.id && !host.effect && !c.animations) continue;
        // The card's T: lines (a copy: the copied card's), triggers granted by animate effects, or an effect's triggers.
        const own = host.effect ? host.effect.triggers : host.id ? triggersOf(host.id, host.face) : [];
        for (const t of [...own, ...(host.effect ? [] : grantedTriggers(c))] as { index: number; params: Record<string, string>; ref?: { cardId: string; face: number } }[]) {
          const p = t.params;
          if (p.Static === 'True') { staticCleanup(state, ctx, host, p, ev, env); continue; }
          if (!SUPPORTED_MODES.has(p.Mode)) continue;
          if (!hostZoneOk(host, p, ev)) continue;
          const hit = matchEvent(state, ctx, host, p, ev, env);
          if (!hit) continue;
          const unknownParam = Object.keys(p).find((k) => !KNOWN_PARAMS.has(k));
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
          found.push({ controller: c.controller, q: queueFor(state, ctx, host, t.index, p, hit, uniqueTriggerLine(t.ref?.cardId ?? c.cardId ?? "", t.ref?.face ?? host.face, p), t.ref) });
        }
      } catch (e) {
        log(state, ctx, null, `Trigger detection error (${hostLabel(host, ctx)}): ${(e as Error).message} — handle it by hand.`);
      }
    }
    if (ev.t === 'phase') delayedFor(state, ctx, ev, found);
  }
  // APNAP: the active player's triggers go on the stack first, then the others' in turn order.
  const order = state.players.map((p) => p.pid);
  const ai = order.indexOf(state.activePlayer);
  const rank = (pid: string) => (order.indexOf(pid) - ai + order.length) % order.length;
  found.sort((a, b) => rank(a.controller) - rank(b.controller));
  (state.triggerQueue ??= []).push(...found.map((f) => f.q));
}

function delayedFor(state: GameState, ctx: Ctx, ev: Extract<GameEvent, { t: 'phase' }>, found: Detected[]) {
  const list = state.delayedTriggers ?? [];
  if (!list.length) return;
  const keep = [];
  for (const d of list) {
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
  uniqueTriggers(state, ctx); // Sagas, Hideaway, Mode$ Always, Saga sacrifice (turns.ts)
  try { detect(state, ctx); } catch (e) { log(state, ctx, null, `Trigger detection error: ${(e as Error).message}`); }
  const pushed = flush(state, ctx);
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
