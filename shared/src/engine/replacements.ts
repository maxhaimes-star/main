/**
 * Replacement effects (Forge R: lines and the ETB keywords etbCounter).
 *
 * Zone changes go through state.ts moveCard, which calls the hook installed here (moveHooks.before):
 *  - Event$ Moved, self, Destination$ Battlefield: ETBTapped / LandTapped (conditional, e.g. fastlands) /
 *    DBTap with UnlessCost$ PayLife<N> (shocklands: enters tapped, a Pending lets the controller pay N life
 *    to untap it) / PayBeforeETB (Mox Diamond) / tap + counters (Baloth Prime).
 *  - Event$ Moved by other permanents: "enters tapped" (Spider-Woman), "exile it instead" (Containment Priest,
 *    Dauthi Voidwalker with a void counter), self "shuffle into library instead" (Blightsteel Colossus).
 *  - K:etbCounter:<type>:<number> counters; "doesn't untap" (Event$ Untap, self) sets the noUntap flag.
 * Other hooks, called from the reducer / engine:
 *  - cantBeCountered (Event$ Counter, Layer$ CantHappen, with IsPresent conditions)
 *  - untapPrevented  (Event$ Untap: Monoliths, Meekstone; stun counters)
 *  - damagePrevented (Event$ DamageDone Prevent$ True, ValidTarget$ You)
 *  - skipsStep       (Event$ BeginPhase Skip$ True)
 *  - replaceDraws    (Event$ Draw -> Token, e.g. Hullbreacher)
 *  - tokenMultiplier (Event$ CreateToken -> ReplaceToken Type$ Amount)
 *  - counterAmount   (Event$ AddCounter -> ReplaceCounter, "that many plus one")
 */
import { cardName, type Lookup } from '../game/rules.ts';
import { type Ctx, emit, log, moveCard, moveHooks, type MoveOpts, newInstance, player, randomId, shuffleLibrary } from '../game/state.ts';
import type { CardInstance, GameState, StackItem, Step, Zone } from '../game/types.ts';
import { getScript, parseParams, SCRIPTS, scriptRef } from './script.ts';
import { matchCard, matchPlayer, type MatchEnv } from './targets.ts';
import { playerProtectedFrom, protectedFrom } from './protection.ts';
import { untapLimits } from './statics.ts';
import { turnInfo } from './durations.ts';
import type { EffectRecord, Pending } from './types.ts';

interface RLine { params: Record<string, string>; svars: Record<string, string>; name: string }

const rcache = new Map<string, RLine[]>();

function faceIndex(c: CardInstance): number {
  return c.transformed ? 1 : 0;
}

/** Parsed R: lines of a card's current face. */
export function replacementsOf(c: CardInstance): RLine[] {
  const ref = c.faceDown ? undefined : scriptRef(c); // a copy: the copied card's R: lines
  if (!ref) return [];
  const key = `${ref.cardId}|${ref.face}`;
  let v = rcache.get(key);
  if (!v) {
    const f = getScript(ref.cardId)?.[ref.face];
    v = f ? f.replacements.map((line) => ({ params: parseParams(line).params, svars: f.svars, name: f.name })) : [];
    rcache.set(key, v);
  }
  return v;
}

const isActive = (r: RLine) => /Battlefield/.test(r.params.ActiveZones ?? '');

/** R: lines of permanents on the battlefield for an event (static "while on the battlefield" replacements). */
function hosted(state: GameState, event: string, except?: string): { host: CardInstance; r: RLine }[] {
  const out: { host: CardInstance; r: RLine }[] = [];
  for (const id of state.battlefield) {
    if (id === except) continue;
    const host = state.cards[id];
    for (const r of replacementsOf(host)) if (r.params.Event === event && isActive(r)) out.push({ host, r });
  }
  return out;
}

/** Replacement effects of Effect records (ReplacementEffects$, engine/effects.ts) for an event. */
function effectReplacements(state: GameState, event: string): { e: EffectRecord; r: RLine }[] {
  const out: { e: EffectRecord; r: RLine }[] = [];
  for (const e of state.effects ?? []) {
    if (e.kind !== 'effect' || !e.replacements?.length) continue;
    const f = getScript(e.cardId)?.[e.face];
    if (!f) continue;
    for (const name of e.replacements) {
      const line = f.svars[name];
      if (!line) continue;
      const r: RLine = { params: parseParams(line).params, svars: f.svars, name: e.name };
      if (r.params.Event === event) out.push({ e, r });
    }
  }
  return out;
}

/** The card's own R: lines for an event (no ActiveZones: they apply to the card itself as it moves / is countered). */
function own(c: CardInstance, event: string): RLine[] {
  return replacementsOf(c).filter((r) => r.params.Event === event && !isActive(r));
}

function svarParams(r: RLine, name: string | undefined): { api: string; params: Record<string, string> } | undefined {
  const sv = name ? r.svars[name] : undefined;
  if (!sv) return undefined;
  const p = parseParams(sv);
  return { api: p.api, params: p.params };
}

function cmp(n: number, expr: string | undefined): boolean {
  const m = /^(LT|LE|EQ|NE|GE|GT)(-?\d+)$/.exec((expr ?? 'GE1').trim());
  if (!m) return true;
  const k = parseInt(m[2], 10);
  switch (m[1]) {
    case 'LT': return n < k;
    case 'LE': return n <= k;
    case 'EQ': return n === k;
    case 'NE': return n !== k;
    case 'GE': return n >= k;
    default: return n > k;
  }
}

/** "Card wasn't cast" etc.: strip properties targets.ts doesn't know, checking them here. */
function validCard(c: CardInstance, valid: string, env: MatchEnv, extra: { wasCast?: boolean } = {}): boolean {
  let ok = true;
  const cleaned = valid.split(',').map((alt) => alt.replace(/\+?(!?)wasCast/g, (_m, neg: string) => {
    if (extra.wasCast != null && (neg ? extra.wasCast : !extra.wasCast)) ok = false;
    return '';
  }).replace(/\.$/, '')).join(',');
  return ok && matchCard(c, cleaned, env) !== false;
}

/** Count cards matching `valid` in zones (default battlefield), for Condition/IsPresent checks. */
function countPresent(state: GameState, lookup: Lookup, valid: string, zone: string | undefined, controller: string, sourceIid?: string): number {
  const z = (zone ?? 'Battlefield').toLowerCase();
  const pool = z === 'battlefield' ? state.battlefield : state.players.flatMap((p) => (p.zones as Record<string, string[]>)[z] ?? []);
  const env: MatchEnv = { controller, sourceIid, lookup };
  return pool.filter((id) => state.cards[id] && matchCard(state.cards[id], valid, env) === true).length;
}

function pname(state: GameState, pid: string): string {
  return state.players.find((p) => p.pid === pid)?.name ?? 'someone';
}

function counterKind(forge: string): string {
  const t = forge.trim().toUpperCase();
  if (t === 'P1P1') return '+1/+1';
  if (t === 'M1M1') return '-1/-1';
  if (t === 'LOYALTY') return 'loyalty';
  return t.toLowerCase();
}

const ZONES: Record<string, Zone> = { battlefield: 'battlefield', hand: 'hand', graveyard: 'graveyard', exile: 'exile', library: 'library' };

// ------------------------------------------------------------------ zone changes

type MoveResult = { to: Zone; opts: MoveOpts; after?: () => void };

function beforeMove(state: GameState, ctx: Ctx, iid: string, to: Zone, opts: MoveOpts): MoveResult | undefined {
  const c = state.cards[iid];
  if (!c || c.zone === to) return undefined;
  if (to === 'graveyard') return toGraveyard(state, ctx, c);
  if (to === 'battlefield') return toBattlefield(state, ctx, c, opts);
  return undefined;
}

/** A "put it into <zone> instead" redirect from a ReplaceWith$ ChangeZone SVar. */
function redirect(state: GameState, ctx: Ctx, c: CardInstance, sv: { params: Record<string, string> }, by: string, why: string): MoveResult | undefined {
  const dest = ZONES[(sv.params.Destination ?? '').toLowerCase()];
  if (!dest) return undefined;
  const nm = cardName(c, ctx.lookup);
  const owner = c.owner;
  const counter = sv.params.WithCountersType;
  return {
    to: dest, opts: dest === 'library' ? { position: 'top' } : {},
    after: () => {
      if (counter && state.cards[c.iid]) state.cards[c.iid].counters[counterKind(counter)] = 1;
      if (sv.params.Shuffle === 'True') shuffleLibrary(state, player(state, owner), ctx.rng);
      log(state, ctx, null, `${by}: ${nm} ${why} — ${dest === 'library' ? `shuffled into its owner's library` : `put into ${dest} instead`}${counter ? ` with a ${counterKind(counter)} counter` : ''}.`);
    },
  };
}

function toGraveyard(state: GameState, ctx: Ctx, c: CardInstance): MoveResult | undefined {
  for (const r of own(c, 'Moved')) {
    if (r.params.Destination !== 'Graveyard') continue;
    const sv = svarParams(r, r.params.ReplaceWith);
    if (sv?.api === 'ChangeZone') return redirect(state, ctx, c, sv, r.name, 'would go to the graveyard');
  }
  if (c.token) return undefined;
  // Effects' replacements (Yawgmoth's Will: "if a card would be put into your graveyard this turn, exile it instead").
  for (const { e, r } of effectReplacements(state, 'Moved')) {
    if (r.params.Destination !== 'Graveyard' || !r.params.ValidCard) continue;
    if (!validCard(c, r.params.ValidCard, { controller: e.controller, lookup: ctx.lookup })) continue;
    const sv = svarParams(r, r.params.ReplaceWith);
    if (sv?.api === 'ChangeZone') return redirect(state, ctx, c, sv, e.name, 'would go to the graveyard');
  }
  for (const { host, r } of hosted(state, 'Moved', c.iid)) {
    if (r.params.Destination !== 'Graveyard' || !r.params.ValidCard) continue;
    if (!validCard(c, r.params.ValidCard, { controller: host.controller, sourceIid: host.iid, lookup: ctx.lookup })) continue;
    const sv = svarParams(r, r.params.ReplaceWith);
    if (sv?.api === 'ChangeZone') return redirect(state, ctx, c, sv, cardName(host, ctx.lookup), 'would go to the graveyard');
  }
  return undefined;
}

interface ShockData { kind: 'shock'; iid: string; pid: string; life: number; name: string }
interface MoxData { kind: 'payBeforeEtb'; iid: string; pid: string; valid: string; name: string }

function toBattlefield(state: GameState, ctx: Ctx, c: CardInstance, opts: MoveOpts): MoveResult | undefined {
  const from = c.zone;
  const controller = opts.controller ?? c.controller;
  const projected: CardInstance = { ...c, controller, zone: 'battlefield' };
  const afters: (() => void)[] = [];
  let tapped = !!opts.tapped;

  // Replacements from other permanents (Containment Priest, Spider-Woman).
  for (const { host, r } of hosted(state, 'Moved', c.iid)) {
    if (r.params.Destination !== 'Battlefield' || !r.params.ValidCard) continue;
    if (!validCard(projected, r.params.ValidCard, { controller: host.controller, sourceIid: host.iid, lookup: ctx.lookup }, { wasCast: from === 'stack' })) continue;
    const sv = svarParams(r, r.params.ReplaceWith);
    const by = cardName(host, ctx.lookup);
    if (sv?.api === 'ChangeZone') {
      const res = redirect(state, ctx, c, sv, by, 'would enter the battlefield');
      if (res) return res;
    } else if (sv?.api === 'Tap') {
      if (!tapped) afters.push(() => log(state, ctx, null, `${cardName(c, ctx.lookup)} enters tapped (${by}).`));
      tapped = true;
    }
  }

  // The card's own "as it enters" replacements.
  const nm = cardName(c, ctx.lookup);
  const counters: [string, number][] = [];
  for (const r of own(c, 'Moved')) {
    if (r.params.Destination !== 'Battlefield') continue;
    const sv = svarParams(r, r.params.ReplaceWith);
    if (sv?.api === 'Tap') {
      const p = sv.params;
      let cond = true;
      if (p.ConditionPresent) cond = cmp(countPresent(state, ctx.lookup, p.ConditionPresent, undefined, controller, c.iid), p.ConditionCompare);
      const unless = /^PayLife<(\d+)>$/.exec(p.UnlessCost ?? '');
      if (unless) {
        tapped = true;
        const data: ShockData = { kind: 'shock', iid: c.iid, pid: controller, life: parseInt(unless[1], 10), name: nm };
        afters.push(() => {
          if (state.cards[c.iid]?.zone !== 'battlefield') return;
          state.pending.push({
            id: randomId(ctx.rng), pid: controller, prompt: `${nm}: pay ${data.life} life? If you don't, it stays tapped.`,
            options: [{ value: 'pay', label: `Pay ${data.life} life (untapped)` }, { value: 'decline', label: "Don't pay (tapped)" }],
            data: data as unknown as Record<string, unknown>,
          });
        });
      } else if (p.UnlessCost) {
        tapped = true;
        afters.push(() => log(state, ctx, controller, `${nm} enters tapped — if you pay ${p.UnlessCost}, untap it by hand.`));
      } else if (cond) {
        tapped = true;
        if (p.ConditionPresent) afters.push(() => log(state, ctx, controller, `${nm} enters tapped (${r.params.Description ? r.params.Description.replace(/CARDNAME/g, nm) : 'condition'}).`));
      } else {
        afters.push(() => log(state, ctx, controller, `${nm} enters untapped.`));
      }
      // Sub-abilities that put counters on it as it enters (Baloth Prime).
      for (let s = svarParams(r, p.SubAbility), guard = 0; s && guard < 5; s = svarParams(r, s.params.SubAbility), guard++) {
        const n = parseInt(s.params.CounterNum ?? '', 10);
        if (s.api === 'PutCounter' && s.params.CounterType && !Number.isNaN(n)) counters.push([counterKind(s.params.CounterType), n]);
      }
    } else if (sv?.api === 'Discard' && r.params.ReplaceWith === 'PayBeforeETB') {
      const data: MoxData = { kind: 'payBeforeEtb', iid: c.iid, pid: controller, valid: sv.params.DiscardValid ?? 'Card', name: nm };
      afters.push(() => payBeforeEtbPending(state, ctx, data));
    } else {
      afters.push(() => log(state, ctx, controller, `Not automated: ${nm} — ${(r.params.Description ?? 'replacement effect').replace(/CARDNAME/g, nm)} (handle by hand).`));
    }
  }

  // K:etbCounter:<type>:<number>
  const f = c.cardId && !c.faceDown ? getScript(c.cardId)?.[faceIndex(c)] : undefined;
  for (const k of f?.keywords ?? []) {
    const m = /^etbCounter:([A-Za-z0-9]+):(\d+)(:|$)/.exec(k);
    if (m) counters.push([counterKind(m[1]), parseInt(m[2], 10)]);
  }
  // "Doesn't untap during your untap step" (Monoliths): show the flag.
  const noUntap = own(c, 'Untap').some((r) => r.params.Layer === 'CantHappen' && /Self/.test(r.params.ValidCard ?? ''));

  if (!afters.length && !counters.length && !noUntap && tapped === !!opts.tapped) return undefined;
  return {
    to: 'battlefield', opts: { ...opts, tapped },
    after: () => {
      const inst = state.cards[c.iid];
      if (inst?.zone === 'battlefield') {
        for (const [k, n] of counters) inst.counters[k] = (inst.counters[k] ?? 0) + n;
        if (counters.length) log(state, ctx, controller, `${nm} enters with ${counters.map(([k, n]) => `${n} ${k} counter${n === 1 ? '' : 's'}`).join(' and ')}.`);
        if (noUntap) inst.noUntap = true;
      }
      for (const a of afters) a();
    },
  };
}

/** A token was just created on the battlefield: apply other permanents' "enters tapped" replacements (Spider-Woman). */
export function tokenEntered(state: GameState, ctx: Ctx, inst: CardInstance) {
  for (const { host, r } of hosted(state, 'Moved', inst.iid)) {
    if (r.params.Destination !== 'Battlefield' || !r.params.ValidCard || inst.tapped) continue;
    if (!validCard(inst, r.params.ValidCard, { controller: host.controller, sourceIid: host.iid, lookup: ctx.lookup }, { wasCast: false })) continue;
    if (svarParams(r, r.params.ReplaceWith)?.api === 'Tap') {
      inst.tapped = true;
      log(state, ctx, null, `${cardName(inst, ctx.lookup)} enters tapped (${cardName(host, ctx.lookup)}).`);
    }
  }
}

function payBeforeEtbPending(state: GameState, ctx: Ctx, d: MoxData) {
  if (state.cards[d.iid]?.zone !== 'battlefield') return;
  const env: MatchEnv = { controller: d.pid, sourceIid: d.iid, lookup: ctx.lookup };
  const lands = player(state, d.pid).zones.hand.filter((id) => matchCard(state.cards[id], d.valid, env) !== false);
  if (!lands.length) {
    moveCard(state, ctx, d.iid, 'graveyard');
    log(state, ctx, d.pid, `${pname(state, d.pid)} has no card to discard — ${d.name} goes to the graveyard.`);
    return;
  }
  state.pending.push({
    id: randomId(ctx.rng), pid: d.pid, prompt: `${d.name}: discard a land card to keep it on the battlefield?`,
    options: [...lands.map((id) => ({ value: id, label: `Discard ${cardName(state.cards[id], ctx.lookup)}` })), { value: 'decline', label: `Don't (${d.name} goes to the graveyard)` }],
    data: d as unknown as Record<string, unknown>,
  });
}

/** Answer a replacement Pending (shocklands, Mox Diamond). undefined = not ours. */
export function answerReplacementPending(state: GameState, ctx: Ctx, pend: Pending, value: string): string | null | undefined {
  const d = pend.data as unknown as ShockData | MoxData;
  if (d.kind === 'shock') {
    const c = state.cards[d.iid];
    const me = player(state, d.pid);
    if (value === 'pay') {
      me.life -= d.life;
      if (c?.zone === 'battlefield') c.tapped = false;
      log(state, ctx, d.pid, `${me.name} pays ${d.life} life (${me.life}) — ${d.name} enters untapped.`);
    } else {
      log(state, ctx, d.pid, `${me.name} doesn't pay — ${d.name} enters tapped.`);
    }
    return null;
  }
  if (d.kind === 'payBeforeEtb') {
    const me = player(state, d.pid);
    if (value !== 'decline' && state.cards[value]?.zone === 'hand') {
      const nm = cardName(state.cards[value], ctx.lookup);
      moveCard(state, ctx, value, 'graveyard', { cause: 'discard' });
      log(state, ctx, d.pid, `${me.name} discards ${nm} — ${d.name} stays on the battlefield.`);
    } else {
      if (state.cards[d.iid]?.zone === 'battlefield') moveCard(state, ctx, d.iid, 'graveyard');
      log(state, ctx, d.pid, `${me.name} doesn't discard a land — ${d.name} goes to the graveyard.`);
    }
    return null;
  }
  return undefined;
}

// ------------------------------------------------------------------ other events

/** "This spell can't be countered": the reason (description), or undefined. */
export function cantBeCountered(state: GameState, ctx: Ctx, item: StackItem): string | undefined {
  if (item.kind !== 'spell' || !item.iid) return undefined;
  const c = state.cards[item.iid];
  if (!c) return undefined;
  for (const r of own(c, 'Counter')) {
    const p = r.params;
    if (p.Layer !== 'CantHappen' || !/Self/.test(p.ValidCard ?? 'Card.Self')) continue;
    if (p.IsPresent && !cmp(countPresent(state, ctx.lookup, p.IsPresent, p.PresentZone, item.controller, c.iid), p.PresentCompare)) continue;
    return (p.Description ?? "This spell can't be countered.").replace(/CARDNAME/g, cardName(c, ctx.lookup));
  }
  return undefined;
}

/**
 * Untap step: true when this tapped permanent doesn't untap — a "doesn't untap" replacement (Monoliths,
 * Meekstone) or a stun counter (one is removed instead).
 */
export function untapPrevented(state: GameState, ctx: Ctx, c: CardInstance): boolean {
  if (!c.tapped) return false;
  if ((c.counters.stun ?? 0) > 0) {
    c.counters.stun--;
    if (!c.counters.stun) delete c.counters.stun;
    log(state, ctx, c.controller, `${cardName(c, ctx.lookup)} stays tapped — a stun counter is removed instead.`);
    return true;
  }
  if (own(c, 'Untap').some((r) => r.params.Layer === 'CantHappen' && /Self/.test(r.params.ValidCard ?? ''))) return true;
  // Winter Orb / Static Orb: "players can't untap more than N <type> during their untap steps" (the first N untap).
  for (const lim of untapLimits(state, c.controller, ctx.lookup)) {
    if (matchCard(c, lim.valid, { controller: c.controller, lookup: ctx.lookup }) !== true) continue;
    const ti = turnInfo(state);
    const key = `untapped|${lim.valid}`;
    if ((ti.activations[key] ?? 0) >= lim.max) return true;
    ti.activations[key] = (ti.activations[key] ?? 0) + 1;
  }
  for (const { host, r } of hosted(state, 'Untap')) {
    if (r.params.Layer !== 'CantHappen' || !r.params.ValidCard) continue;
    if (matchCard(c, r.params.ValidCard, { controller: host.controller, sourceIid: host.iid, lookup: ctx.lookup }) === true) {
      log(state, ctx, c.controller, `${cardName(c, ctx.lookup)} doesn't untap (${cardName(host, ctx.lookup)}).`);
      return true;
    }
  }
  return false;
}

/**
 * Is damage to `target` (a player id or a permanent's iid) from `source` prevented? Glacial Chasm / Solitary Confinement
 * ("prevent all damage that would be dealt to you"), protection (engine/protection.ts), effects' prevention
 * replacements (Maze of Ith: combat damage to and by that creature; Kytheon). Returns the reason, or undefined.
 */
export function damagePrevented(state: GameState, lookup: Lookup, target: string, source?: string, combat = false): string | undefined {
  const isPlayer = state.players.some((p) => p.pid === target);
  if (isPlayer) {
    for (const id of state.battlefield) {
      const host = state.cards[id];
      for (const r of replacementsOf(host)) {
        if (r.params.Event !== 'DamageDone' || r.params.Prevent !== 'True' || !isActive(r)) continue;
        if (r.params.ValidTarget === 'You' && host.controller === target) return cardName(host, lookup);
      }
    }
    if (playerProtectedFrom(state, target, source, lookup)) return 'protection';
  } else if (source && protectedFrom(state, target, source, lookup)) return 'protection';
  const src = source ? state.cards[source] : undefined;
  const tgt = isPlayer ? undefined : state.cards[target];
  for (const { e, r } of effectReplacements(state, 'DamageDone')) {
    const p = r.params;
    if (p.Prevent !== 'True' || (p.IsCombat === 'True' && !combat)) continue;
    const env: MatchEnv = { controller: e.controller, sourceIid: e.hostIid, lookup, remembered: e.remembered };
    const cardOk = (c: CardInstance | undefined, valid: string) => !!c && (valid === 'Card.EffectSource' ? c.iid === e.hostIid : matchCard(c, valid, env) === true);
    if (p.ValidTarget && !(isPlayer ? matchPlayer(target, p.ValidTarget, env) === true : cardOk(tgt, p.ValidTarget))) continue;
    if (p.ValidSource && !cardOk(src, p.ValidSource)) continue;
    return e.name;
  }
  return undefined;
}

const PHASES: Partial<Record<Step, string>> = { upkeep: 'Upkeep', draw: 'Draw', end: 'End of Turn' };

/** "Skip your draw step" (Solitary Confinement): the source's name, or undefined. */
export function skipsStep(state: GameState, ctx: Ctx, pid: string, step: Step): string | undefined {
  for (const { host, r } of hosted(state, 'BeginPhase')) {
    if (r.params.Skip !== 'True' || r.params.Phase !== PHASES[step]) continue;
    if (matchPlayer(pid, r.params.ValidPlayer ?? 'You', { controller: host.controller, lookup: ctx.lookup }) === true) return cardName(host, ctx.lookup);
  }
  return undefined;
}

/**
 * Engine draws (not the draw-step draw): replacements like Hullbreacher. Returns how many cards `pid`
 * still draws; replaced draws create the replacement's tokens for the replacement's controller.
 */
export function replaceDraws(state: GameState, ctx: Ctx, pid: string, n: number): number {
  if (n <= 0) return n;
  for (const { host, r } of hosted(state, 'Draw')) {
    if (matchPlayer(pid, r.params.ValidPlayer ?? 'You', { controller: host.controller, lookup: ctx.lookup }) !== true) continue;
    const sv = svarParams(r, r.params.ReplaceWith);
    const token = sv?.api === 'Token' ? SCRIPTS.tokens[sv.params.TokenScript ?? ''] : undefined;
    if (!token) continue;
    for (let k = 0; k < n; k++) {
      const inst = newInstance(state, ctx.rng, host.controller, 'battlefield', undefined, token);
      inst.summoningSick = true;
      state.battlefield.push(inst.iid);
      tokenEntered(state, ctx, inst);
      emit(state, { t: 'zone', iid: inst.iid, from: 'none', to: 'battlefield', snap: JSON.parse(JSON.stringify(inst)) as CardInstance });
    }
    log(state, ctx, host.controller, `${cardName(host, ctx.lookup)}: instead of ${pname(state, pid)} drawing ${n} card${n === 1 ? '' : 's'}, ${pname(state, host.controller)} creates ${n} ${token.name} token${n === 1 ? '' : 's'}.`);
    return 0;
  }
  return n;
}

/** Token-doubling replacements (Elspeth, Storm Slayer) for tokens created under `owner`'s control. */
export function tokenMultiplier(state: GameState, ctx: Ctx, owner: string): number {
  let m = 1;
  for (const { host, r } of hosted(state, 'CreateToken')) {
    if (!/YouCtrl/.test(r.params.ValidToken ?? '') || host.controller !== owner) continue;
    const sv = svarParams(r, r.params.ReplaceWith);
    if (sv?.api === 'ReplaceToken' && sv.params.Type === 'Amount') {
      m *= 2;
      log(state, ctx, owner, `${cardName(host, ctx.lookup)} doubles the tokens.`);
    }
  }
  return m;
}

/** Counter-adding replacements (Michelangelo: "that many plus one"). Returns the number actually put on `c`. */
export function counterAmount(state: GameState, ctx: Ctx, c: CardInstance, kind: string, n: number): number {
  if (n <= 0 || c.zone !== 'battlefield') return n;
  let out = n;
  for (const { host, r } of hosted(state, 'AddCounter')) {
    if (r.params.ValidCounterType && counterKind(r.params.ValidCounterType) !== kind) continue;
    if (r.params.ValidCard && matchCard(c, r.params.ValidCard, { controller: host.controller, sourceIid: host.iid, lookup: ctx.lookup }) !== true) continue;
    const sv = svarParams(r, r.params.ReplaceWith);
    if (sv?.api === 'ReplaceCounter') {
      out += 1;
      log(state, ctx, host.controller, `${cardName(host, ctx.lookup)}: one more ${kind} counter.`);
    }
  }
  return out;
}

moveHooks.before = beforeMove;

// ------------------------------------------------------------------ coverage

/** Why an R: line isn't handled automatically (null = handled), for coverage tools. */
export function replacementGap(line: string, svars: Record<string, string>): string | null {
  const p = parseParams(line).params;
  const sv = p.ReplaceWith && svars[p.ReplaceWith] ? parseParams(svars[p.ReplaceWith]) : undefined;
  const active = /Battlefield/.test(p.ActiveZones ?? '');
  switch (p.Event) {
    case 'Moved':
      if (p.Destination === 'Battlefield' && !active) {
        if (p.ReplaceWith === 'PayBeforeETB' || sv?.api === 'Tap' || sv?.api === 'Discard') return sv?.api === 'Tap' && sv.params.UnlessCost && !/^PayLife<\d+>$/.test(sv.params.UnlessCost) ? 'Moved (enters tapped unless cost)' : null;
        return 'Moved (as it enters)';
      }
      if (p.Destination === 'Battlefield' && active) return sv?.api === 'ChangeZone' || sv?.api === 'Tap' ? null : 'Moved (other enters)';
      if (p.Destination === 'Graveyard') return sv?.api === 'ChangeZone' ? null : 'Moved (to graveyard)';
      return `Moved (to ${p.Destination ?? '?'})`;
    case 'Counter': return p.Layer === 'CantHappen' ? null : 'Counter';
    case 'Untap': return p.Layer === 'CantHappen' ? null : 'Untap';
    case 'DamageDone': return p.Prevent === 'True' && p.ValidTarget === 'You' ? null : 'DamageDone';
    case 'BeginPhase': return p.Skip === 'True' ? null : 'BeginPhase';
    case 'Draw': return sv?.api === 'Token' ? null : 'Draw';
    case 'CreateToken': return sv?.api === 'ReplaceToken' ? null : 'CreateToken';
    case 'AddCounter': return sv?.api === 'ReplaceCounter' ? null : 'AddCounter';
  }
  return p.Event ?? '?';
}
