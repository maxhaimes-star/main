import { anyColorCost } from './permissions.ts';
import { keptAbility } from './copy.ts';
/**
 * Strict rules enforcement (GameState.strict, on for new games): MTG Arena-style play.
 *
 * - landPlaysLeft / landPlayError: one land per turn (+ AdjustLandPlays statics), own main phase, empty stack,
 *   from hand (or a MayPlay permission: Crucible of Worlds, Courser of Kruphix ...).
 * - Auto-pay: costs are paid from the mana pool first, then by tapping untapped mana sources the player controls
 *   (lands, rocks, mana creatures without summoning sickness) chosen by the solver in game/manapay.ts.
 *   autoPayPreview / castability / abilityUsability expose the same checks to the client.
 * - strictActionError: priority for stack actions; manual table tools and `force` only in fix mode.
 * - checkStateBased: lethal damage / 0 toughness / 0 loyalty, players at 0 life / 10 poison / drawing from an empty
 *   library lose, legend rule (a Pending choice), illegal auras, +1/+1 and -1/-1 counters annihilate.
 * - Combat legality: attackError / blockError / blockersError.
 */
import { FOREIGN_BASE, foreignAbility } from './grants.ts';
import { parseManaSymbols } from '../cards.ts';
import { getCard } from '../cube.ts';
import { cardName, faceOf, hasKeyword, isCreature, type Lookup } from '../game/rules.ts';
import { type PayResult, type PaySource, poolSources, solveMana } from '../game/manapay.ts';
import { type Ctx, log, moveCard, player, randomId } from '../game/state.ts';
import type { CardInstance, GameAction, GameState, GameView, ViewCard } from '../game/types.ts';
import { isHidden } from '../game/types.ts';
import { castableFaces, castOptions } from './costs.ts';
import { activateMana, manaPlansFor } from './mana.ts';
import { stateBasedActions } from './resolve.ts';
import { abilityAt, abilityLine, activatedAbilitiesOf, getScript, scriptRef } from './script.ts';
import { noteTapped } from './manatriggers.ts';
import { activateRestriction, adjustCost, manaConvertApplies, castRestriction, extraLandPlays, mayPlayPermission, type StaticsState } from './statics.ts';
import { activationError, castTimingError } from './timing.ts';

type AnyState = GameState | GameView;
const asGame = (s: AnyState) => s as unknown as GameState;

export function isStrict(state: Pick<GameState, 'strict'>): boolean {
  return !!state.strict;
}
export function fixModeOn(state: Pick<GameState, 'fixMode'>): boolean {
  return !!state.fixMode?.on;
}

function visibleCard(state: AnyState, iid: string): CardInstance | undefined {
  const c = state.cards[iid] as CardInstance | ViewCard | undefined;
  return c && !isHidden(c) ? (c as CardInstance) : undefined;
}

/** Creature that can't use {T} / attack: came under its controller's control this turn and has no haste. */
export function summoningSick(state: AnyState, c: CardInstance, lookup: Lookup = getCard): boolean {
  return c.summoningSick && isCreature(c, lookup, state as StaticsState) && !hasKeyword(c, lookup, 'Haste', state as StaticsState);
}

// ------------------------------------------------------------------ lands

/** Land plays `pid` has left this turn (1 + extra land plays from statics − lands played). */
export function landPlaysLeft(state: AnyState, pid: string, lookup: Lookup = getCard): number {
  const p = state.players.find((x) => x.pid === pid);
  if (!p) return 0;
  const allowed = 1 + extraLandPlays(state as StaticsState, pid, lookup);
  return Math.max(0, allowed - p.landsPlayed);
}

/** Is this card (as `face`) a land? MDFCs with a land back face count when face = 1. */
export function isLandCard(c: CardInstance, lookup: Lookup, face?: number): boolean {
  const data = c.cardId ? lookup(c.cardId) : undefined;
  if (data?.faces && face != null && data.faces[face] && (data.layout === 'modal_dfc' || face === 0)) return /\bLand\b/.test(data.faces[face].typeLine);
  if (data?.faces && data.layout === 'modal_dfc') return /\bLand\b/.test(data.faces[0].typeLine);
  return faceOf(c, lookup).types.includes('Land');
}

/** Why `pid` can't play this land now (null = legal). Assumes strict mode. */
export function landPlayError(state: AnyState, pid: string, iid: string, lookup: Lookup = getCard): string | null {
  const c = visibleCard(state, iid);
  if (!c) return 'No such card';
  if (state.phase !== 'playing') return 'The game has not started';
  if (state.activePlayer !== pid) return 'You can only play lands during your turn';
  if (state.step !== 'main1' && state.step !== 'main2') return 'You can only play lands during your main phase';
  if (state.stack.length) return 'You can only play lands while the stack is empty';
  if (landPlaysLeft(state, pid, lookup) <= 0) return "You've already played a land this turn";
  if (c.zone === 'hand') { if (c.owner !== pid) return 'Not your card'; }
  else if (!mayPlayPermission(state as StaticsState, iid, pid, lookup, (state as GameState).remembered)) return `You can't play lands from your ${c.zone}`;
  return null;
}

// ------------------------------------------------------------------ auto-pay

/** Untapped mana sources `pid` controls, as solver sources (key = iid, option = manaOptionsFor id). */
export function manaSources(state: AnyState, pid: string, lookup: Lookup = getCard, exclude: Set<string> = new Set()): PaySource[] {
  const out: PaySource[] = [];
  for (const iid of state.battlefield) {
    if (exclude.has(iid)) continue;
    const c = visibleCard(state, iid);
    if (!c || c.controller !== pid) continue;
    if (activateRestriction(state as StaticsState, iid, pid, lookup, true)) continue;
    const plans = manaPlansFor(state as GameState, c, lookup);
    if (!plans.length) continue;
    const sick = summoningSick(state, c, lookup);
    const f = faceOf(c, lookup);
    const base = f.types.includes('Land') ? 0 : isCreature(c, lookup, state as StaticsState) ? 3 : 1;
    const options = plans.filter((o) => {
      if (!o.produces || o.byHand.length || o.discardHand || o.mana || o.tapOther) return false;
      if (o.sideEffects.some((s) => /^Spend only/.test(s))) return false;
      if (o.tap) return !c.tapped && !sick;
      return o.sacSelf; // untapped-free abilities must at least use the source up
    }).map((o) => ({ id: o.id, produces: o.produces, penalty: base + (o.life + o.selfDamage) * 5 + (o.sacSelf ? 40 : 0) }));
    const mine = out.find((s) => s.key === iid);
    if (mine) mine.options.unshift(...options); else if (options.length) out.push({ key: iid, options });
    // "Tap an untapped artifact you control: add {U}" (Urza): each such permanent is a source of its own.
    for (const o of plans) {
      if (!o.tapOther || !o.produces || o.byHand.length || o.mana || o.life || (o.tap && (c.tapped || sick)) || exclude.has(o.tapOther)) continue;
      const opt = { id: `via:${iid}:${o.id}`, produces: o.produces, penalty: 2 };
      const have = out.find((s) => s.key === o.tapOther);
      if (have) have.options.push(opt); else out.push({ key: o.tapOther, options: [opt] });
    }
  }
  return out;
}

/**
 * Permanents that may be tapped to help pay: Improvise (artifacts), Convoke (creatures), Waterbend (artifacts and
 * creatures, up to the waterbend amount). Each tapped one pays for {1}; with `colored` (Convoke, rule 702.51a) a
 * creature may instead pay one colored symbol of one of its colors (hybrid / Phyrexian symbols of that color too).
 */
export interface PayHelp { artifacts?: boolean; creatures?: boolean; colored?: boolean; max?: number; label: string }

/** Improvise / Convoke on the card being cast (script K: lines). */
export function castHelp(c: CardInstance, face?: number): PayHelp | undefined {
  const ref = c.cardId ? { cardId: c.cardId, face: face ?? 0 } : undefined;
  const kws = ref ? getScript(ref.cardId)?.[ref.face]?.keywords ?? [] : [];
  const improvise = kws.includes('Improvise'), convoke = kws.includes('Convoke');
  if (!improvise && !convoke) return undefined;
  return { artifacts: improvise, creatures: convoke, colored: convoke, label: improvise && convoke ? 'improvise / convoke' : improvise ? 'improvise' : 'convoke' };
}

/** Waterbend<N> in an ability cost: N generic mana that untapped artifacts / creatures may help pay. */
export function waterbendOf(cost: string): number {
  let n = 0;
  for (const m of cost.matchAll(/\bWaterbend<(\d+)>/g)) n += parseInt(m[1], 10);
  return n;
}

const HELP_OPTION = 'help';

/** A permanent's current colors (W/U/B/R/G letters; face-down: none). */
function permanentColors(c: CardInstance, lookup: Lookup): string[] {
  if (c.faceDown) return [];
  const f = faceOf(c, lookup);
  const data = c.cardId ? lookup(c.cardId) : undefined;
  const colors = f.colors ?? (c.token && !c.cardId ? c.token.colors : data?.colors ?? []);
  return [...new Set(colors)].filter((m) => /^[WUBRG]$/.test(m));
}

function helpSources(state: AnyState, pid: string, help: PayHelp, lookup: Lookup, exclude: Set<string>, sources: PaySource[]): PaySource[] {
  const byKey = new Map(sources.map((s) => [s.key, s]));
  const out = sources.map((s) => ({ ...s, options: [...s.options] }));
  const outByKey = new Map(out.map((s) => [s.key, s]));
  for (const iid of state.battlefield) {
    if (exclude.has(iid)) continue;
    const c = visibleCard(state, iid);
    if (!c || c.controller !== pid || c.tapped) continue;
    const creature = isCreature(c, lookup, state as StaticsState);
    const artifact = faceOf(c, lookup).types.includes('Artifact');
    if (!((help.artifacts && artifact) || (help.creatures && creature))) continue;
    const opts: PaySource['options'] = [{ id: HELP_OPTION, produces: '*', penalty: creature ? 4 : 2 }];
    if (help.colored && creature) {
      // Convoke: one colored symbol of one of the creature's colors (slightly dearer than generic, so generic uses '*')
      for (const m of permanentColors(c, lookup)) opts.push({ id: `${HELP_OPTION}:${m}`, produces: m, penalty: 4.5, helper: true });
    }
    if (byKey.has(iid)) outByKey.get(iid)!.options.push(...opts);
    else out.push({ key: iid, options: opts });
  }
  return out;
}

/**
 * Plan paying `cost` (pool first, then untapped sources; `help`: Improvise / Convoke / Waterbend). null = can't be paid.
 * Phyrexian symbols: by default with mana when possible, else 2 life — but auto-pay never pays life down to 0 or below.
 * `phyrexian: 'life'` (the player's choice) pays them with life whenever the player has that much life.
 */
export function planAutoPay(state: AnyState, pid: string, cost: string, x: number, lookup: Lookup = getCard, exclude: Set<string> = new Set(), help?: PayHelp, phyrexian?: 'mana' | 'life'): PayResult | null {
  const p = state.players.find((q) => q.pid === pid);
  if (!p) return null;
  if (!parseManaSymbols(cost).length) return { picks: [], lifePaid: 0, spent: [] };
  let sources = [...poolSources(p.manaPool), ...manaSources(state, pid, lookup, exclude)];
  if (help && (help.max ?? 1) > 0) sources = helpSources(state, pid, help, lookup, exclude, sources);
  const life = phyrexian === 'life' ? p.life : p.life - 1;
  return solveMana(cost, x, sources, life, help?.max ?? Infinity, phyrexian === 'life');
}

/** Does this cost have Phyrexian symbols ({B/P}, {G/U/P} ...)? */
export function hasPhyrexian(cost: string): boolean {
  return parseManaSymbols(cost).some((s) => /P/.test(s) && s.length > 1);
}

/**
 * Activate the mana abilities a plan picked (mana goes to the pool; the caller then pays from the pool).
 * Permanents tapped to help (Improvise / Convoke / Waterbend) are tapped here: returns how many generic mana they paid
 * (`generic`, which the caller removes from the cost with reduceGeneric) and the colored symbols convoked creatures
 * paid (`symbols`, removed with removeSymbols) before paying the rest from the pool.
 */
export function executeAutoPay(state: GameState, ctx: Ctx, pid: string, plan: PayResult, help?: PayHelp): { generic: number; symbols: string[] } {
  let helped = 0;
  const symbols: string[] = [];
  const names: string[] = [];
  for (const pk of plan.picks) {
    if (pk.pool) continue;
    if (pk.option === HELP_OPTION || pk.option.startsWith(`${HELP_OPTION}:`)) {
      const c = state.cards[pk.key];
      if (!c || c.tapped || c.zone !== 'battlefield') continue;
      c.tapped = true;
      noteTapped(state, c.iid, pid);
      if (pk.option === HELP_OPTION) { helped++; names.push(cardName(c, ctx.lookup)); }
      else { symbols.push(...(pk.paid ?? [])); names.push(`${cardName(c, ctx.lookup)} for {${pk.paid?.join('}{') ?? pk.produces}}`); }
      continue;
    }
    const via = /^via:([^:]+):(.+)$/.exec(pk.option); // a mana ability of another permanent that taps this one (Urza)
    const err = via ? activateMana(state, ctx, pid, { t: 'activateMana', iid: via[1], option: via[2] }) : activateMana(state, ctx, pid, { t: 'activateMana', iid: pk.key, option: pk.option });
    if (err) log(state, ctx, pid, `Auto-pay: ${err}`);
  }
  if (names.length) log(state, ctx, pid, `${player(state, pid).name} taps ${names.join(', ')} (${help?.label ?? 'help'}: pays ${[...(helped ? [`{${helped}}`] : []), ...symbols.map((s) => `{${s}}`)].join('')}).`);
  return { generic: helped, symbols };
}

/** Remove these mana symbols (as parseManaSymbols spells them) from a cost, one occurrence each. */
export function removeSymbols(mana: string, symbols: string[]): string {
  if (!symbols.length) return mana;
  const out = parseManaSymbols(mana);
  for (const sym of symbols) {
    let i = out.indexOf(sym);
    if (i < 0) i = out.findIndex((s) => !/^\d+$|^[XYZ]$/.test(s) && s.replace('/', '').includes(sym.replace(/[^WUBRG]/g, '').charAt(0)));
    if (i >= 0) out.splice(i, 1);
  }
  return out.map((s) => `{${s}}`).join('');
}

/** Remove up to `n` generic mana from a cost (X counts as generic = x). */
export function reduceGeneric(mana: string, n: number, x: number): string {
  return n > 0 ? reduceGenericBy(mana, n, x) : mana;
}

/** Tap sources for `cost` if the pool doesn't cover it. Returns false if it can't be paid. */
export function autoTapFor(state: GameState, ctx: Ctx, pid: string, cost: string, x = 0, exclude: Set<string> = new Set()): boolean {
  const plan = planAutoPay(state, pid, cost, x, ctx.lookup, exclude);
  if (!plan) return false;
  executeAutoPay(state, ctx, pid, plan);
  return true;
}

/** Remove up to n generic mana (delve). */
function reduceGenericBy(mana: string, n: number, x: number): string {
  let left = n;
  const out: string[] = [];
  for (const s of parseManaSymbols(mana)) {
    if (/^\d+$/.test(s) || s === 'X') {
      const v = s === 'X' ? x : parseInt(s, 10);
      const take = Math.min(v, left);
      left -= take;
      if (v - take > 0) out.push(String(v - take));
    } else out.push(s);
  }
  return out.map((s) => `{${s}}`).join('');
}

/** The card as it would be on the stack for `face` (for cost statics). */
function asCast(c: CardInstance, face: number | undefined, lookup: Lookup): CardInstance {
  const data = c.cardId ? lookup(c.cardId) : undefined;
  if (data?.faces && face != null && face > 0 && data.faces[face]) {
    return data.layout === 'modal_dfc' || data.layout === 'transform' ? { ...c, transformed: true } : { ...c, castAs: data.faces[face].name };
  }
  return c;
}

/**
 * The mana a cast will actually cost (cost statics, delve with the whole graveyard, free MayPlay permissions).
 * `mana` is the chosen option's cost (castOptions().cost / CastPlan.mana).
 */
export function castManaCost(state: AnyState, pid: string, c: CardInstance, face: number | undefined, mana: string, opts: { delve?: boolean; x?: number; faceDown?: boolean }, lookup: Lookup = getCard): string {
  if (opts.faceDown) return '{3}';
  let cost = adjustCost(state as StaticsState, asCast(c, face, lookup), pid, mana, 'Spell', lookup).cost;
  if (opts.delve) {
    const gy = state.players.find((p) => p.pid === c.owner)?.zones.graveyard.filter((i) => i !== c.iid).length ?? 0;
    cost = reduceGenericBy(cost, gy, opts.x ?? 0);
  }
  return cost;
}

/** Is this an X cost with X required? */
function hasX(cost: string): boolean {
  return parseManaSymbols(cost).includes('X');
}

/**
 * Which sources auto-pay will tap for a cast (Arena-style preview). `phyrexian`: as the cast action's (pay Phyrexian
 * symbols with mana first, or with life). `phyrexian` in the result: the cost has Phyrexian symbols (a choice to offer).
 */
export function autoPayPreview(state: AnyState, pid: string, iid: string, face?: number, costOption?: string, x?: number, lookup: Lookup = getCard, phyrexian?: 'mana' | 'life'):
  { ok: boolean; taps: { iid: string; mana: string }[]; reason?: string; cost?: string; life?: number; phyrexian?: boolean } {
  const c = visibleCard(state, iid);
  if (!c) return { ok: false, taps: [], reason: 'No such card' };
  const opts = castOptions(asGame(state), iid, face, lookup);
  const opt = opts.find((o) => o.id === (costOption ?? 'normal'));
  if (!opt) return { ok: false, taps: [], reason: `No "${costOption}" cost` };
  const free = c.zone !== 'hand' ? mayPlayPermission(state as StaticsState, iid, pid, lookup, asGame(state).remembered)?.free : false;
  const delve = opt.extra.some((e) => /^Delve/.test(e));
  const cost = free ? '' : castManaCost(state, pid, c, face, opt.cost, { delve, x: x ?? 0 }, lookup);
  const plan = planAutoPay(state, pid, cost, x ?? 0, lookup, undefined, castHelp(c, face), phyrexian);
  const phy = hasPhyrexian(cost) ? { phyrexian: true } : {};
  if (!plan) return { ok: false, taps: [], reason: 'Not enough mana', cost, ...phy };
  return { ok: true, taps: plan.picks.filter((p) => !p.pool).map((p) => ({ iid: p.key, mana: p.produces })), cost, ...(plan.lifePaid ? { life: plan.lifePaid } : {}), ...phy };
}

// ------------------------------------------------------------------ casting / activating checks

/** Error if `pid` may not act at "priority" right now (strict). */
export function priorityError(state: AnyState, pid: string): string | null {
  if (state.phase !== 'playing') return 'The game has not started';
  if (state.pending.length) {
    const q = state.pending[0];
    return `Waiting for ${state.players.find((p) => p.pid === q.pid)?.name ?? 'a player'}: ${q.prompt}`;
  }
  if (state.priority !== pid) return "You don't have priority";
  return null;
}

/** Strict zone check for casting: hand, the cost option's zone (flashback ...), an adventure in exile, or a MayPlay permission. */
export function castZoneError(state: AnyState, pid: string, c: CardInstance, costOption: string | undefined, lookup: Lookup = getCard): string | null {
  const name = cardName(c, lookup);
  if (c.zone === 'hand') return c.owner === pid ? null : `You can't cast ${name} from another player's hand`;
  const opt = costOption ?? 'normal';
  if (c.zone === 'graveyard' && ['flashback', 'escape', 'mayhem'].includes(opt) && c.owner === pid) return null;
  if (c.zone === 'exile' && (opt === 'madness' || opt === 'foretell') && c.owner === pid) return null;
  if (c.zone === 'exile' && c.castAs && c.owner === pid) return null; // on an adventure
  if (mayPlayPermission(state as StaticsState, c.iid, pid, lookup, asGame(state).remembered)) return null;
  return `You can't cast ${name} from ${c.owner === pid ? 'your' : "another player's"} ${c.zone}`;
}

/**
 * What a click on a card in your hand does: play the land / cast the spell at once, or open the card's menu (a
 * land with abilities usable from hand — cycling Triomes —, a card with several castable faces, an {X} cost).
 */
export function handClick(state: AnyState, pid: string, iid: string, lookup: Lookup = getCard): 'playLand' | 'cast' | 'menu' {
  const c = visibleCard(state, iid);
  if (!c?.cardId) return 'menu';
  const data = lookup(c.cardId);
  const face = faceOf(c, lookup);
  const fromHand = c.owner === pid && activatedAbilitiesOf(c.cardId, 0).some((e) => e.zone === 'hand');
  if (face.types.includes('Land') && data?.layout !== 'modal_dfc') return fromHand ? 'menu' : 'playLand';
  if ((data?.faces && castableFaces(data).length > 1) || /\{X\}/.test(face.manaCost)) return 'menu';
  return 'cast';
}

/**
 * Can `pid` cast (or play, for lands) this card right now: priority, timing, land drop, zone,
 * restrictions and mana (pool + untapped sources via auto-pay, for any available cost option).
 */
export function castability(state: AnyState, pid: string, iid: string, lookup: Lookup = getCard, face?: number): { ok: boolean; reason?: string } {
  const c = visibleCard(state, iid);
  if (!c) return { ok: false, reason: 'No such card' };
  const pe = priorityError(state, pid);
  if (pe) return { ok: false, reason: pe };
  const data = c.cardId ? lookup(c.cardId) : undefined;
  const frontLand = isLandCard(c, lookup, data?.faces && data.layout === 'modal_dfc' ? 0 : undefined);
  if (frontLand && !face) {
    const e = landPlayError(state, pid, iid, lookup);
    return e ? { ok: false, reason: e } : { ok: true };
  }
  if (face != null) return faceCastability(state, pid, c, face, lookup);
  // A card with several castable faces (split cards and Rooms, adventurers, modal DFCs) is castable when any of its
  // spell faces is: each face is cast for its own cost (a Room's door, never the combined "{2}{G} // {3}{G}{G}").
  const faces = data?.faces && castableFaces(data).length > 1 ? castableFaces(data).filter((f) => !isLandCard(c, lookup, f)) : [undefined];
  let first: { ok: boolean; reason?: string } | undefined;
  for (const f of faces) {
    const r = faceCastability(state, pid, c, f, lookup);
    if (r.ok) return r;
    first ??= r;
  }
  return first ?? { ok: false, reason: 'Not enough mana' };
}

/** castability for one face (undefined = the card as a whole / its front). */
function faceCastability(state: AnyState, pid: string, c: CardInstance, face: number | undefined, lookup: Lookup): { ok: boolean; reason?: string } {
  const g = asGame(state);
  const iid = c.iid;
  const timing = castTimingError(g, c, pid, face, lookup);
  if (timing) return { ok: false, reason: timing };
  const restricted = castRestriction(state as StaticsState, iid, pid, lookup);
  if (restricted) return { ok: false, reason: restricted };
  let reason = 'Not enough mana';
  const opts = castOptions(g, iid, face, lookup);
  if (!opts.length) return { ok: false, reason: "That face can't be cast" };
  for (const o of opts) {
    if (o.unavailable) { if (o.id === 'normal') reason = o.unavailable; continue; }
    const z = castZoneError(state, pid, c, o.id, lookup);
    if (z) { if (o.id === 'normal') reason = z; continue; }
    const pv = autoPayPreview(state, pid, iid, face, o.id, hasX(o.cost) ? 0 : undefined, lookup);
    if (pv.ok) return { ok: true };
    // castable by choosing to pay Phyrexian symbols with life (down to 0)
    if (pv.phyrexian && autoPayPreview(state, pid, iid, face, o.id, hasX(o.cost) ? 0 : undefined, lookup, 'life').ok) return { ok: true };
  }
  return { ok: false, reason };
}

interface AbilityCost { mana: string; tap: boolean; untap: boolean; counters: Record<string, number> }

function abilityCost(cost: string, x: number): AbilityCost {
  const out: AbilityCost = { mana: '', tap: false, untap: false, counters: {} };
  for (const tok of cost.match(/\S+<[^>]*>|\S+/g) ?? []) {
    let m: RegExpExecArray | null;
    if (/^(\d+|[WUBRGCSX]|[WUBRG2]\/[WUBRGP])$/.test(tok)) out.mana += `{${tok === 'X' ? x : tok}}`;
    else if (/^[WUBRG]{2}$/.test(tok)) out.mana += `{${tok[0]}/${tok[1]}}`; // hybrid ("GW": Figure of Fable)
    else if ((m = /^Waterbend<(\d+)>$/.exec(tok))) out.mana += `{${m[1]}}`;
    else if (tok === 'T') out.tap = true;
    else if (tok === 'Q') out.untap = true;
    else if ((m = /^SubCounter<(\d+|X)\/([A-Za-z0-9]+)>$/.exec(tok))) {
      const k = m[2].toUpperCase() === 'P1P1' ? '+1/+1' : m[2].toUpperCase() === 'M1M1' ? '-1/-1' : m[2].toUpperCase() === 'LOYALTY' ? 'loyalty' : m[2].toLowerCase();
      out.counters[k] = (out.counters[k] ?? 0) + (m[1] === 'X' ? x : parseInt(m[1], 10));
    }
  }
  return out;
}

/**
 * Strict checks for activating ability `index` of `c` (beyond what activateAuto validates): {T}/{Q} with summoning
 * sickness, and the mana via auto-pay. Returns an error, or the payment plan (null when there is no mana to pay).
 */
export function abilityPayment(state: AnyState, pid: string, c: CardInstance, cost: string, x: number, lookup: Lookup = getCard): { error: string } | { plan: PayResult | null; mana: string } {
  const parsed = abilityCost(cost, x);
  const name = cardName(c, lookup);
  if ((parsed.tap || parsed.untap) && c.zone === 'battlefield' && summoningSick(state, c, lookup)) return { error: `${name} has summoning sickness` };
  if (!parsed.mana) return { plan: null, mana: '' };
  let mana = adjustCost(state as StaticsState, c, pid, parsed.mana, 'Ability', lookup).cost;
  if (manaConvertApplies(state as StaticsState, c.iid, pid, lookup)) mana = anyColorCost(mana); // Agatha's Soul Cauldron
  const exclude = new Set(parsed.tap || /\bSac<1\/(CARDNAME|Self|NICKNAME)>/.test(cost) ? [c.iid] : []);
  const wb = waterbendOf(cost);
  const plan = planAutoPay(state, pid, mana, x, lookup, exclude, wb ? { artifacts: true, creatures: true, max: wb, label: 'waterbend' } : undefined);
  if (!plan) return { error: 'Not enough mana' };
  return { plan, mana };
}

/** Can `pid` activate ability `abilityIndex` (an A: index, as in activatedAbilitiesOf) of `iid` right now? */
export function abilityUsability(state: AnyState, pid: string, iid: string, abilityIndex: number, lookup: Lookup = getCard): { ok: boolean; reason?: string } {
  const c = visibleCard(state, iid);
  if (!c) return { ok: false, reason: 'No such card' };
  const pe = priorityError(state, pid);
  if (pe) return { ok: false, reason: pe };
  if (c.zone === 'battlefield' ? c.controller !== pid : c.owner !== pid) return { ok: false, reason: "You don't control that card" };
  const foreign = abilityIndex >= FOREIGN_BASE ? foreignAbility(state as StaticsState, iid, abilityIndex, lookup) : undefined; // engine/grants.ts
  const kept = keptAbility(c, abilityIndex); // Thespian's Stage
  const ref = foreign ? { cardId: foreign.cardId, face: foreign.face } : kept ? { cardId: kept.cardId, face: kept.face } : c.zone === 'battlefield' ? scriptRef(c) : c.cardId ? { cardId: c.cardId, face: c.transformed ? 1 : 0 } : undefined;
  if (!ref) return { ok: false, reason: 'That card has no abilities' };
  const sIndex = foreign ? foreign.scriptIndex : kept ? kept.index : abilityIndex;
  const line = abilityLine(ref.cardId, ref.face, sIndex);
  const ab = abilityAt(ref.cardId, ref.face, sIndex);
  if (!line || !ab) return { ok: false, reason: 'No such ability' };
  const name = cardName(c, lookup);
  const banned = activateRestriction(state as StaticsState, iid, pid, lookup);
  if (banned) return { ok: false, reason: banned };
  const timing = activationError(asGame(state), c, pid, ab, abilityIndex, name);
  if (timing) return { ok: false, reason: timing.replace(/ \(use force to override\)/, '') };
  const cost = ab.params.Cost ?? '';
  const parsed = abilityCost(cost, 0);
  if (parsed.tap && c.tapped) return { ok: false, reason: `${name} is tapped` };
  if (parsed.untap && !c.tapped) return { ok: false, reason: `${name} is untapped` };
  for (const [k, n] of Object.entries(parsed.counters)) if ((c.counters[k] ?? 0) < n) return { ok: false, reason: `${name} doesn't have enough ${k} counters` };
  const pay = abilityPayment(state, pid, c, cost, 0, lookup);
  if ('error' in pay) return { ok: false, reason: pay.error };
  return { ok: true };
}

// ------------------------------------------------------------------ action gate

/** Manual table tools: rejected in strict mode unless fix mode is on. */
export const MANUAL_ACTIONS = new Set<GameAction['t']>([
  'move', 'tap', 'tapForMana', 'counter', 'playerCounter', 'life', 'pt', 'damage', 'createToken', 'copyCard', 'note', 'noUntap',
  'transform', 'faceDown', 'attach', 'control', 'addMana', 'untapAll', 'draw', 'mill', 'shuffle', 'peek', 'revealTop',
  'resolve', 'counterTop', 'removeStackItem', 'trigger', 'designation', 'proposeDamage', 'clearCombat',
]);

/** Actions that use the stack / need priority in strict mode. */
const PRIORITY_ACTIONS = new Set<GameAction['t']>(['cast', 'activate', 'playLand']);

/** Strict-mode gate, before the reducer runs the action. null = go ahead. */
type PeekResult = Record<'top' | 'bottom' | 'graveyard' | 'hand' | 'battlefield' | 'exile', string[]> & { shuffle?: boolean };

/**
 * Rules-enforced games: a scry window may only put cards on top or on the bottom, a surveil window on top or into the
 * graveyard (no shuffling). Other windows are free (fix mode / by-hand looks). null = fine.
 */
export function peekDestinationError(state: Pick<GameState, 'strict' | 'fixMode'>, mode: string, r: PeekResult): string | null {
  if (!state.strict || state.fixMode?.on) return null;
  const allowed = mode === 'scry' ? ['top', 'bottom'] : mode === 'surveil' ? ['top', 'graveyard'] : null;
  if (!allowed) return null;
  const bad = (['top', 'bottom', 'graveyard', 'hand', 'battlefield', 'exile'] as const).find((k) => r[k].length && !allowed.includes(k));
  if (bad || r.shuffle) return `${mode === 'scry' ? 'Scry' : 'Surveil'} puts cards only on top of your library or ${mode === 'scry' ? 'on the bottom' : 'into your graveyard'}`;
  return null;
}

export function strictActionError(state: GameState, pid: string, a: GameAction): string | null {
  if (!state.strict) return null;
  const fix = fixModeOn(state);
  if (MANUAL_ACTIONS.has(a.t) && !fix) return `That's a manual action — in a rules-enforced game ask for fix mode first ("Fix board")`;
  if ('force' in a && a.force && !fix) return 'Overriding the rules (force) is only possible in fix mode';
  if (a.t === 'cast' && a.manual && !fix) return 'Casting by hand is only possible in fix mode';
  if (a.t === 'activate' && a.ability == null && !fix) return 'Activating by hand is only possible in fix mode';
  if (a.t === 'lookAtHand' && a.pid && !fix) return "You can't look at another player's hand";
  if (a.t === 'setAutoTriggers' && !a.on && !fix) return 'Triggered abilities are automatic in a rules-enforced game';
  if (PRIORITY_ACTIONS.has(a.t)) {
    const e = priorityError(state, pid);
    if (e) return e;
  }
  if (a.t === 'activateMana') {
    if (state.phase !== 'playing') return 'The game has not started';
    if (state.priority !== pid && !state.pending.some((q) => q.pid === pid)) return "You don't have priority";
  }
  return null;
}

// ------------------------------------------------------------------ combat

/** Why `iid` can't attack `target` (strict). */
export function attackError(state: GameState, pid: string, iid: string, target: string, lookup: Lookup): string | null {
  const c = state.cards[iid];
  const name = cardName(c, lookup);
  if (state.step !== 'attackers') return 'Attackers are declared in the declare attackers step';
  if (!isCreature(c, lookup, state)) return `${name} isn't a creature`;
  if (c.tapped) return `${name} is tapped`;
  if (summoningSick(state, c, lookup)) return `${name} has summoning sickness`;
  const tp = state.players.find((p) => p.pid === target);
  if (tp) { if (tp.pid === pid || tp.conceded) return 'Attack an opponent'; return null; }
  const t = state.cards[target];
  if (!t || t.zone !== 'battlefield') return 'Invalid attack target';
  const f = faceOf(t, lookup);
  if (f.types.includes('Planeswalker')) return t.controller === pid ? "You can't attack your own planeswalker" : null;
  if (f.types.includes('Battle')) return null;
  return 'Creatures attack players, planeswalkers or battles';
}

function colorsOf(c: CardInstance, lookup: Lookup): string[] {
  return faceOf(c, lookup).colors ?? [];
}

/** Why `blocker` can't block `attacker` (strict, evasion keywords; statics are checked by blockRestriction). */
export function blockError(state: GameState, blocker: string, attacker: string, lookup: Lookup): string | null {
  const b = state.cards[blocker];
  const a = state.cards[attacker];
  const bn = cardName(b, lookup);
  const an = cardName(a, lookup);
  if (state.step !== 'blockers') return 'Blockers are declared in the declare blockers step';
  if (!isCreature(b, lookup, state)) return `${bn} isn't a creature`;
  if (b.tapped) return `${bn} is tapped`;
  const kw = (c: CardInstance, k: string) => hasKeyword(c, lookup, k, state);
  if (kw(a, 'Unblockable')) return `${an} can't be blocked`;
  if (kw(a, 'Flying') && !kw(b, 'Flying') && !kw(b, 'Reach')) return `${an} has flying — only creatures with flying or reach can block it`;
  if (kw(a, 'Shadow') && !kw(b, 'Shadow')) return `${an} has shadow`;
  if (kw(a, 'Horsemanship') && !kw(b, 'Horsemanship')) return `${an} has horsemanship`;
  const bArtifact = faceOf(b, lookup).types.includes('Artifact');
  if (kw(a, 'Fear') && !bArtifact && !colorsOf(b, lookup).includes('B')) return `${an} has fear — only artifact and/or black creatures can block it`;
  if (kw(a, 'Intimidate') && !bArtifact && !colorsOf(b, lookup).some((x) => colorsOf(a, lookup).includes(x))) return `${an} has intimidate`;
  return null;
}

/** Whole-block legality when blockers are confirmed: menace. */
export function blockersError(state: GameState, lookup: Lookup): string | null {
  for (const iid of state.battlefield) {
    const a = state.cards[iid];
    if (!a.attacking) continue;
    const n = state.battlefield.filter((b) => state.cards[b].blocking === iid).length;
    if (n === 1 && hasKeyword(a, lookup, 'Menace', state)) return `${cardName(a, lookup)} has menace — it can't be blocked except by two or more creatures`;
  }
  return null;
}

// ------------------------------------------------------------------ state-based actions

function loseGame(state: GameState, ctx: Ctx, losers: { pid: string; why: string }[]) {
  for (const { pid, why } of losers) {
    const p = player(state, pid);
    p.lost = why;
    p.conceded = true;
    log(state, ctx, pid, `${p.name} loses the game (${why}).`);
  }
  const left = state.players.filter((p) => !p.conceded);
  if (left.length <= 1) {
    state.phase = 'over';
    state.winner = left[0]?.pid ?? null;
    state.pending = [];
    log(state, ctx, null, left[0] ? `${left[0].name} wins the game!` : 'The game is a draw.');
  }
}

function legendKey(c: CardInstance, lookup: Lookup): string | null {
  if (c.faceDown) return null;
  const f = faceOf(c, lookup);
  if (!/\bLegendary\b/.test(f.typeLine)) return null;
  return `${c.controller}|${f.name}`;
}

/**
 * State-based actions (strict mode): run whenever a player would receive priority. Players losing ends the game
 * (the server then moves the match on). The legend rule asks the controller which one to keep.
 */
export function checkStateBased(state: GameState, ctx: Ctx) {
  if (!state.strict || state.phase !== 'playing') return;
  for (let guard = 0; guard < 10; guard++) {
    let changed = false;
    // +1/+1 and -1/-1 counters annihilate
    for (const iid of state.battlefield) {
      const c = state.cards[iid];
      const p = c.counters['+1/+1'] ?? 0, m = c.counters['-1/-1'] ?? 0;
      if (p > 0 && m > 0) {
        const k = Math.min(p, m);
        if (p - k) c.counters['+1/+1'] = p - k; else delete c.counters['+1/+1'];
        if (m - k) c.counters['-1/-1'] = m - k; else delete c.counters['-1/-1'];
      }
    }
    // creatures with lethal damage / 0 toughness, planeswalkers with 0 loyalty
    const n = state.battlefield.length;
    stateBasedActions(state, ctx);
    if (state.battlefield.length !== n) changed = true;
    // auras attached to nothing / an object that left; equipment attached illegally becomes unattached
    for (const iid of [...state.battlefield]) {
      const c = state.cards[iid];
      if (!c || c.faceDown) continue;
      const f = faceOf(c, ctx.lookup);
      const to = c.attachedTo;
      const targetOk = !!to && (state.cards[to]?.zone === 'battlefield' || state.players.some((p) => p.pid === to && !p.conceded));
      if (c.castInfo?.bestowed && (!targetOk || (to && state.cards[to] && !isCreature(state.cards[to], ctx.lookup, state)))) {
        // Bestow: an unattached bestowed Aura becomes a creature again (702.103f).
        delete c.castInfo.bestowed;
        c.attachedTo = undefined;
        log(state, ctx, null, `${cardName(c, ctx.lookup)} is no longer attached — it's a creature again (bestow).`);
        changed = true;
      } else if (/\bAura\b/.test(f.typeLine) && !targetOk && !isCreature(c, ctx.lookup, state)) {
        moveCard(state, ctx, iid, 'graveyard');
        log(state, ctx, null, `${f.name} is put into its owner's graveyard (not attached to a legal object).`);
        changed = true;
      } else if (to && !targetOk) c.attachedTo = undefined;
      else if (to && /\bEquipment\b/.test(f.typeLine) && !isCreature(c, ctx.lookup, state) && state.cards[to] && !isCreature(state.cards[to], ctx.lookup, state)) c.attachedTo = undefined;
    }
    if (!changed) break;
  }
  // players
  const losers: { pid: string; why: string }[] = [];
  for (const p of state.players) {
    if (p.conceded) { p.drewFromEmpty = false; continue; }
    if (p.life <= 0) losers.push({ pid: p.pid, why: `${p.life} life` });
    else if ((p.counters.poison ?? 0) >= 10) losers.push({ pid: p.pid, why: `${p.counters.poison} poison counters` });
    else if (p.drewFromEmpty) losers.push({ pid: p.pid, why: 'drew from an empty library' });
    p.drewFromEmpty = false;
  }
  if (losers.length) { loseGame(state, ctx, losers); if (state.phase !== 'playing') return; }
  // legend rule
  const groups = new Map<string, string[]>();
  for (const iid of state.battlefield) {
    const k = legendKey(state.cards[iid], ctx.lookup);
    if (k) groups.set(k, [...(groups.get(k) ?? []), iid]);
  }
  for (const [key, iids] of groups) {
    if (iids.length < 2) continue;
    if (state.pending.some((q) => q.data.kind === 'legend' && q.data.key === key)) continue;
    const [controller] = key.split('|');
    const name = faceOf(state.cards[iids[0]], ctx.lookup).name;
    state.pending.push({
      id: randomId(ctx.rng), pid: controller, prompt: `Legend rule: choose the ${name} to keep (the others go to the graveyard)`,
      options: iids.map((iid, i) => ({ value: iid, label: `${name} #${i + 1}${state.cards[iid].tapped ? ' (tapped)' : ''}` })),
      data: { kind: 'legend', key, iids },
    });
  }
}

/** Answer a strict-mode question (legend rule). undefined = not one of ours. */
export function answerStrictPending(state: GameState, ctx: Ctx, pid: string, id: string, value: string): string | null | undefined {
  const q = state.pending.find((p) => p.id === id);
  if (!q || q.data.kind !== 'legend') return undefined;
  if (q.pid !== pid) return 'That question is for another player';
  if (!q.options.some((o) => o.value === value)) return 'Not one of the options';
  state.pending = state.pending.filter((p) => p !== q);
  for (const iid of q.data.iids as string[]) {
    if (iid === value || state.cards[iid]?.zone !== 'battlefield') continue;
    const nm = cardName(state.cards[iid], ctx.lookup);
    moveCard(state, ctx, iid, 'graveyard');
    log(state, ctx, pid, `${nm} is put into the graveyard (legend rule).`);
  }
  return null;
}
