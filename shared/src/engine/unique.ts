/**
 * Effects of the cube's unique / hard cards (see unique-support.ts for the list and the support checks):
 * extra turns, Balance, Council's Judgment votes, Liliana's two piles, Mindslaver, Hideaway,
 * "untap up to N lands", Jace's +2 on any library, remove counters, win the game, Oath of Druids,
 * Sylvan Library, Dark Depths' Marit Lage, and a fallback for simple Animate (haste + "sacrifice at end").
 *
 * resolve.ts calls execUniqueStep() for these steps with a UniqueRun (its helpers, bound to the running
 * chain); decisions are Pending questions with data.kind 'unique', answered by answerUniquePending().
 */
import { cardName, faceOf, isCreature } from '../game/rules.ts';
import { type Ctx, detach, drawCards, emit, log, moveCard, player, randomId, turnStats } from '../game/state.ts';
import type { CardInstance, GameState, StackItem, Zone } from '../game/types.ts';
import { createTokenInstance, resumeAuto } from './resolve.ts';
import { getScript, parseAbility, SCRIPTS, spellAbility, targetSpecs } from './script.ts';
import { matchCard } from './targets.ts';
import { isPeekOtherDig, isSimpleAnimate, isTypedTapChoice, uniqueReason } from './unique-support.ts';
import type { AutoCont, Lki, ParsedAbility, Pending, TargetRef, TriggerContext } from './types.ts';

interface Objs { cards: string[]; players: string[] }

/** A pick handled by resolve.ts's generic pick machinery (same shape as its PickData). */
export interface PickSpec {
  kind: 'pick';
  action: 'move' | 'discard' | 'sacrifice' | 'tap';
  chooser: string;
  candidates: string[];
  left: number;
  optional: boolean;
  dest?: Zone;
  params?: Record<string, string>;
  label: string;
}

/** The running chain, as resolve.ts exposes it to this module. */
export interface UniqueRun {
  step: ParsedAbility;
  controller: string;
  sourceIid?: string;
  sourceName: string;
  item: StackItem;
  remembered: string[];
  lki: Record<string, Lki>;
  svars: Record<string, string>;
  trig?: TriggerContext;
  /** The step's condition couldn't be verified. */
  uncertain: boolean;
  amount(raw: string | undefined, dflt: number): number | undefined;
  objects(dflt: 'You' | 'Self'): Objs | undefined;
  defined(value: string | undefined): Objs | undefined;
  ownTargets(): TargetRef[] | undefined;
  /** Continuation after this step. */
  cont(): AutoCont;
  /** Start resolve.ts picks that continue after this step; true when a question was asked. */
  picks(list: PickSpec[]): boolean;
  remember(iids: string[]): void;
  atEndOf(iids: string[], what: string): void;
  manual(): void;
}

type Result = 'ok' | 'wait';

const pname = (state: GameState, pid: string) => state.players.find((p) => p.pid === pid)?.name ?? 'someone';
const nm = (state: GameState, ctx: Ctx, iid: string) => (state.cards[iid] ? cardName(state.cards[iid], ctx.lookup) : 'a card');
const names = (state: GameState, ctx: Ctx, iids: string[]) => iids.map((i) => nm(state, ctx, i)).join(', ') || 'nothing';
const live = (state: GameState) => state.players.filter((p) => !p.conceded).map((p) => p.pid);

/** Players in turn order starting with `first`. */
function turnOrder(state: GameState, first: string, among: string[]): string[] {
  const order = state.players.map((p) => p.pid);
  const i = Math.max(0, order.indexOf(first));
  return [...order.slice(i), ...order.slice(0, i)].filter((p) => among.includes(p));
}

function counterKind(forge: string): string {
  const t = forge.trim().toUpperCase();
  if (t === 'P1P1') return '+1/+1';
  if (t === 'M1M1') return '-1/-1';
  if (t === 'LOYALTY') return 'loyalty';
  return t.toLowerCase();
}

// ------------------------------------------------------------------ pendings

type UData =
  | { kind: 'unique'; u: 'vote'; voters: string[]; idx: number; votes: Record<string, number>; candidates: string[]; sub?: string; caster: string; source: string; cont: AutoCont }
  | { kind: 'unique'; u: 'pile'; separator: string; target: string; cards: string[]; pile1: string[]; chosen?: string; source: string; cont: AutoCont }
  | { kind: 'unique'; u: 'tap'; pid: string; tap: boolean; candidates: string[]; left: number; optional: boolean; source: string; cont: AutoCont }
  | { kind: 'unique'; u: 'jace'; pid: string; target: string; iid: string; cont: AutoCont }
  | { kind: 'unique'; u: 'hideaway'; pid: string; host: string; top: string[]; cont: AutoCont }
  | { kind: 'unique'; u: 'oath'; pid: string; valid: string; source: string; cont: AutoCont }
  | { kind: 'unique'; u: 'sylvan'; pid: string; phase: 'draw' | 'pick' | 'pay'; left: number; card?: string; life: number; n: number; source: string; cont: AutoCont };

function ask(state: GameState, ctx: Ctx, pid: string, prompt: string, options: Pending['options'], data: UData) {
  state.pending.push({ id: randomId(ctx.rng), pid, prompt, options, data: data as unknown as Record<string, unknown> });
}

// ------------------------------------------------------------------ steps

/** Run a unique step. Returns undefined when the step isn't one of ours. */
export function execUniqueStep(state: GameState, ctx: Ctx, r: UniqueRun): Result | undefined {
  const step = r.step;
  const p = step.params;
  if (isTypedTapChoice(step)) return typedTap(state, ctx, r);
  if (isPeekOtherDig(step)) return jaceDig(state, ctx, r);
  if (isSimpleAnimate(step)) return animate(state, ctx, r);
  if (uniqueReason(step) === undefined) return undefined;
  switch (step.api) {
    case 'AddTurn': {
      const o = r.objects('You');
      const n = r.amount(p.NumTurns, 1);
      if (!o || n == null) { r.manual(); return 'ok'; }
      for (const pid of o.players) {
        for (let k = 0; k < n; k++) (state.extraTurns ??= []).push(pid);
        log(state, ctx, pid, `${pname(state, pid)} will take ${n === 1 ? 'an extra turn' : `${n} extra turns`} after this one (${r.sourceName}).`);
      }
      return 'ok';
    }
    case 'Balance': return balance(state, ctx, r);
    case 'Vote': return vote(state, ctx, r);
    case 'TwoPiles': return twoPiles(state, ctx, r);
    case 'RemoveCounter': {
      const o = r.objects('Self');
      if (!o) { r.manual(); return 'ok'; }
      const kind = counterKind(p.CounterType);
      for (const iid of o.cards) {
        const c = state.cards[iid];
        if (!c || c.zone !== 'battlefield') continue;
        const have = c.counters[kind] ?? 0;
        const n = p.CounterNum === 'All' ? have : Math.min(have, r.amount(p.CounterNum, 1) ?? 1);
        c.counters[kind] = have - n;
        if (!c.counters[kind] && kind !== 'loyalty') delete c.counters[kind];
        log(state, ctx, r.controller, `${r.sourceName}: removes ${n} ${kind} counter${n === 1 ? '' : 's'} from ${cardName(c, ctx.lookup)} (now ${c.counters[kind] ?? 0}).`);
      }
      return 'ok';
    }
    case 'ControlPlayer': {
      const own = r.ownTargets();
      const target = own ? own.find((t) => t.kind === 'player') : undefined;
      const pid = target?.kind === 'player' ? target.pid : r.defined(p.Defined)?.players[0];
      if (!pid) { log(state, ctx, r.controller, `${r.sourceName}: no target player.`); return 'ok'; }
      if (pid === r.controller) { log(state, ctx, r.controller, `${r.sourceName}: you already control yourself.`); return 'ok'; }
      state.controlledBy = { pid, by: r.controller, active: false, since: state.turn };
      log(state, ctx, r.controller, `${pname(state, r.controller)} will control ${pname(state, pid)} during ${pname(state, pid)}'s next turn (${r.sourceName}).`);
      return 'ok';
    }
    case 'WinsGame': {
      if (r.uncertain) { r.manual(); return 'ok'; }
      state.phase = 'over';
      state.winner = r.controller;
      log(state, ctx, r.controller, `${pname(state, r.controller)} wins the game (${r.sourceName})!`);
      return 'ok';
    }
    case 'Hideaway': return hideaway(state, ctx, r);
    case 'OathOfDruids': return oath(state, ctx, r);
    case 'SylvanLibrary': {
      const pid = r.controller;
      const n = parseInt(p.Num ?? '2', 10) || 2;
      const life = parseInt(p.Life ?? '4', 10) || 4;
      ask(state, ctx, pid, `${r.sourceName}: draw ${n} additional cards?`, [{ value: 'yes', label: `Draw ${n} more` }, { value: 'no', label: 'No' }],
        { kind: 'unique', u: 'sylvan', pid, phase: 'draw', left: n, life, n, source: r.sourceName, cont: r.cont() });
      return 'wait';
    }
    case 'SacSelfToken': {
      const src = r.sourceIid ? state.cards[r.sourceIid] : undefined;
      if (!src || src.zone !== 'battlefield') { log(state, ctx, r.controller, `${r.sourceName} is no longer on the battlefield — nothing happens.`); return 'ok'; }
      const owner = src.controller;
      moveCard(state, ctx, src.iid, 'graveyard', { cause: 'sacrifice' });
      log(state, ctx, owner, `${pname(state, owner)} sacrifices ${r.sourceName}.`);
      for (const script of (p.TokenScript ?? '').split(',').map((s) => s.trim())) {
        const token = SCRIPTS.tokens[script];
        if (!token) continue;
        createTokenInstance(state, ctx, owner, token, false);
        log(state, ctx, owner, `${pname(state, owner)} creates ${token.name}${token.power != null ? `, a ${token.power}/${token.toughness}` : ''} token.`);
      }
      return 'ok';
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ Balance

function balance(state: GameState, ctx: Ctx, r: UniqueRun): Result {
  const p = r.step.params;
  const ps = live(state);
  const hand = p.Zone === 'Hand';
  const valid = p.Valid ?? 'Card';
  const env = (pid: string) => ({ controller: pid, sourceIid: r.sourceIid, lookup: ctx.lookup });
  const pool = (pid: string) => (hand ? player(state, pid).zones.hand : state.battlefield.filter((iid) => state.cards[iid].controller === pid && matchCard(state.cards[iid], valid, env(pid)) === true));
  const counts = ps.map((pid) => pool(pid).length);
  const min = Math.min(...counts);
  const what = hand ? 'cards in hand' : `${valid.toLowerCase()}s`;
  log(state, ctx, r.controller, `${r.sourceName}: ${what} — ${ps.map((pid, k) => `${pname(state, pid)} ${counts[k]}`).join(', ')}; everyone goes down to ${min}.`);
  const picks: PickSpec[] = [];
  for (const pid of turnOrder(state, r.controller, ps)) {
    const cands = pool(pid);
    const excess = cands.length - min;
    if (excess <= 0) continue;
    picks.push({
      kind: 'pick', action: hand ? 'discard' : 'sacrifice', chooser: pid, candidates: cands, left: excess, optional: false,
      label: `${r.sourceName}: choose ${hand ? 'a card to discard' : `a ${valid.toLowerCase()} to sacrifice`} (keep ${min})`,
    });
  }
  return r.picks(picks) ? 'wait' : 'ok';
}

// ------------------------------------------------------------------ Council's Judgment

function vote(state: GameState, ctx: Ctx, r: UniqueRun): Result {
  const p = r.step.params;
  const voters = turnOrder(state, r.controller, r.defined(p.Defined ?? 'Player')?.players ?? live(state));
  const env = { controller: r.controller, sourceIid: r.sourceIid, lookup: ctx.lookup };
  const candidates = state.battlefield.filter((iid) => matchCard(state.cards[iid], p.VoteCard, env) === true);
  if (!candidates.length || !voters.length) { log(state, ctx, r.controller, `${r.sourceName}: nothing to vote for.`); return 'ok'; }
  const d: UData = { kind: 'unique', u: 'vote', voters, idx: 0, votes: {}, candidates, sub: p.VoteSubAbility, caster: r.controller, source: r.sourceName, cont: r.cont() };
  askVote(state, ctx, d);
  return 'wait';
}

function askVote(state: GameState, ctx: Ctx, d: Extract<UData, { u: 'vote' }>) {
  const cands = d.candidates.filter((iid) => state.cards[iid]?.zone === 'battlefield');
  const voter = d.voters[d.idx];
  ask(state, ctx, voter, `${d.source}: vote for a nonland permanent ${pname(state, d.caster)} doesn't control`, cands.map((iid) => ({ value: iid, label: nm(state, ctx, iid) })), { ...d, candidates: cands });
}

function finishVote(state: GameState, ctx: Ctx, d: Extract<UData, { u: 'vote' }>) {
  const max = Math.max(0, ...Object.values(d.votes));
  const winners = Object.keys(d.votes).filter((iid) => d.votes[iid] === max && state.cards[iid]?.zone === 'battlefield');
  log(state, ctx, d.caster, `${d.source}: most votes — ${names(state, ctx, winners)}.`);
  const cont = d.cont;
  cont.remembered = [...winners];
  const sv = d.sub ? getScript(cont.item.auto?.cardId ?? '')?.[cont.item.auto?.face ?? 0]?.svars[d.sub] : undefined;
  const sub = sv ? parseAbility(sv, {}, d.source) : undefined;
  const dest = sub?.api === 'ChangeZone' || sub?.api === 'ChangeZoneAll' ? ({ Exile: 'exile', Graveyard: 'graveyard', Hand: 'hand', Library: 'library' } as Record<string, Zone>)[sub.params.Destination ?? ''] : undefined;
  if (sub?.api === 'Destroy' || sub?.api === 'Sacrifice' || dest) {
    for (const iid of winners) moveCard(state, ctx, iid, dest ?? 'graveyard', sub?.api === 'Sacrifice' ? { cause: 'sacrifice' } : {});
    log(state, ctx, d.caster, `${d.source}: ${names(state, ctx, winners)} → ${dest ?? 'graveyard'}.`);
  } else log(state, ctx, d.caster, `Not automated: ${d.source} — apply the vote result to ${names(state, ctx, winners)} by hand.`);
  resumeAuto(state, ctx, cont);
}

// ------------------------------------------------------------------ Liliana of the Veil: two piles

function twoPiles(state: GameState, ctx: Ctx, r: UniqueRun): Result {
  const p = r.step.params;
  const own = r.ownTargets();
  const target = own?.find((t) => t.kind === 'player');
  const pid = target?.kind === 'player' ? target.pid : r.defined(p.Defined ?? 'You')?.players[0];
  if (!pid) { r.manual(); return 'ok'; }
  const separator = p.Separator === 'Targeted' ? pid : r.controller;
  const env = { controller: r.controller, sourceIid: r.sourceIid, lookup: ctx.lookup };
  const cards = state.battlefield.filter((iid) => state.cards[iid].controller === pid && matchCard(state.cards[iid], p.ValidCards ?? 'Permanent', env) !== false);
  if (!cards.length) { log(state, ctx, r.controller, `${pname(state, pid)} controls nothing to separate.`); return 'ok'; }
  const d: Extract<UData, { u: 'pile' }> = { kind: 'unique', u: 'pile', separator, target: pid, cards, pile1: [], chosen: p.ChosenPile, source: r.sourceName, cont: r.cont() };
  askPile(state, ctx, d);
  return 'wait';
}

function askPile(state: GameState, ctx: Ctx, d: Extract<UData, { u: 'pile' }>) {
  const rest = d.cards.filter((iid) => !d.pile1.includes(iid) && state.cards[iid]?.zone === 'battlefield');
  ask(state, ctx, d.separator, `${d.source}: put permanents into pile 1 (the rest form pile 2)${d.pile1.length ? ` — pile 1: ${names(state, ctx, d.pile1)}` : ''}`,
    [...rest.map((iid) => ({ value: iid, label: nm(state, ctx, iid) })), { value: 'done', label: 'Done separating' }], d);
}

function finishPiles(state: GameState, ctx: Ctx, d: Extract<UData, { u: 'pile' }>, choice: '1' | '2') {
  const pile1 = d.pile1.filter((iid) => state.cards[iid]?.zone === 'battlefield');
  const pile2 = d.cards.filter((iid) => !d.pile1.includes(iid) && state.cards[iid]?.zone === 'battlefield');
  const chosen = choice === '1' ? pile1 : pile2;
  log(state, ctx, d.target, `${pname(state, d.target)} chooses pile ${choice} (${names(state, ctx, chosen)}).`);
  const sv = d.chosen ? getScript(d.cont.item.auto?.cardId ?? '')?.[d.cont.item.auto?.face ?? 0]?.svars[d.chosen] : undefined;
  const sub = sv ? parseAbility(sv, {}, d.source) : undefined;
  if (sub?.api === 'SacrificeAll' || sub?.api === 'DestroyAll') {
    for (const iid of chosen) moveCard(state, ctx, iid, 'graveyard', sub.api === 'SacrificeAll' ? { cause: 'sacrifice' } : {});
    log(state, ctx, d.target, `${pname(state, d.target)} ${sub.api === 'SacrificeAll' ? 'sacrifices' : 'loses'} ${names(state, ctx, chosen)}.`);
  } else log(state, ctx, d.target, `Not automated: ${d.source} — apply the chosen pile by hand.`);
  d.cont.remembered = [...chosen];
  resumeAuto(state, ctx, d.cont);
}

// ------------------------------------------------------------------ untap up to N lands

function typedTap(state: GameState, ctx: Ctx, r: UniqueRun): Result {
  const p = r.step.params;
  const tap = r.step.api === 'Tap';
  const type = (tap ? p.TapType : p.UntapType) ?? 'Permanent';
  const n = r.amount(p.Amount, 1);
  if (n == null) { r.manual(); return 'ok'; }
  const env = { controller: r.controller, sourceIid: r.sourceIid, lookup: ctx.lookup };
  const candidates = state.battlefield.filter((iid) => state.cards[iid].tapped !== tap && matchCard(state.cards[iid], type, env) !== false);
  if (!candidates.length || n <= 0) { log(state, ctx, r.controller, `${r.sourceName}: nothing to ${tap ? 'tap' : 'untap'}.`); return 'ok'; }
  const optional = p.UntapUpTo === 'True' || p.TapUpTo === 'True';
  const d: Extract<UData, { u: 'tap' }> = { kind: 'unique', u: 'tap', pid: r.controller, tap, candidates, left: n, optional, source: r.sourceName, cont: r.cont() };
  if (!optional && candidates.length <= n) {
    for (const iid of candidates) state.cards[iid].tapped = tap;
    log(state, ctx, r.controller, `${r.sourceName}: ${tap ? 'taps' : 'untaps'} ${names(state, ctx, candidates)}.`);
    return 'ok';
  }
  askTap(state, ctx, d);
  return 'wait';
}

function askTap(state: GameState, ctx: Ctx, d: Extract<UData, { u: 'tap' }>) {
  const cands = d.candidates.filter((iid) => state.cards[iid]?.zone === 'battlefield' && state.cards[iid].tapped !== d.tap);
  const options = cands.map((iid) => ({ value: iid, label: `${nm(state, ctx, iid)}${state.cards[iid].controller !== d.pid ? ` (${pname(state, state.cards[iid].controller)})` : ''}` }));
  if (d.optional) options.push({ value: 'done', label: 'Done' });
  if (!cands.length || d.left <= 0) { resumeAuto(state, ctx, d.cont); return; }
  ask(state, ctx, d.pid, `${d.source}: choose a permanent to ${d.tap ? 'tap' : 'untap'} (${d.left} left)`, options, { ...d, candidates: cands });
}

// ------------------------------------------------------------------ Jace +2: top card of any library

function jaceDig(state: GameState, ctx: Ctx, r: UniqueRun): Result {
  const target = r.ownTargets()?.find((t) => t.kind === 'player');
  if (!target || target.kind !== 'player') { log(state, ctx, r.controller, `${r.sourceName}: no target player.`); return 'ok'; }
  const lib = player(state, target.pid).zones.library;
  if (!lib.length) { log(state, ctx, r.controller, `${pname(state, target.pid)}'s library is empty.`); return 'ok'; }
  const iid = lib[0];
  const name = nm(state, ctx, iid);
  log(state, ctx, r.controller, `${pname(state, r.controller)} looks at the top card of ${target.pid === r.controller ? 'their' : `${pname(state, target.pid)}'s`} library (${r.sourceName}).`);
  ask(state, ctx, r.controller, `${r.sourceName}: the top card of ${pname(state, target.pid)}'s library — leave it or put it on the bottom?`,
    [{ value: 'top', label: `Leave ${name} on top` }, { value: 'bottom', label: `Put ${name} on the bottom` }],
    { kind: 'unique', u: 'jace', pid: r.controller, target: target.pid, iid, cont: r.cont() });
  return 'wait';
}

// ------------------------------------------------------------------ Animate (fallback): haste + "sacrifice it at end of turn"

function animate(state: GameState, ctx: Ctx, r: UniqueRun): Result {
  const p = r.step.params;
  const o = r.objects('Self');
  if (!o) { r.manual(); return 'ok'; }
  const cards = o.cards.filter((iid) => state.cards[iid]?.zone === 'battlefield');
  const kws = p.Keywords ? p.Keywords.split('&').map((k) => k.trim()).filter(Boolean) : [];
  for (const iid of cards) {
    const c = state.cards[iid];
    if (kws.length) c.tempKeywords = [...new Set([...(c.tempKeywords ?? []), ...kws])];
    const bits = [kws.length ? `gains ${kws.join(', ').toLowerCase()}` : '', p.Abilities ? 'gains an ability' : ''].filter(Boolean).join(' and ');
    log(state, ctx, r.controller, `${cardName(c, ctx.lookup)} ${bits}${p.Duration === 'Permanent' && kws.length ? '' : kws.length ? ' until end of turn' : ''}.`);
  }
  if (p.AtEOT && cards.length) r.atEndOf(cards, p.AtEOT);
  return 'ok';
}

// ------------------------------------------------------------------ Hideaway (Shelldock Isle: its Play ability is in more.ts)

function hideaway(state: GameState, ctx: Ctx, r: UniqueRun): Result {
  const n = parseInt(r.step.params.Num ?? '4', 10) || 4;
  const host = r.sourceIid;
  const me = player(state, r.controller);
  const top = me.zones.library.slice(0, n);
  if (!top.length || !host) { log(state, ctx, r.controller, `${r.sourceName}: library is empty — nothing to hide away.`); return 'ok'; }
  log(state, ctx, r.controller, `${me.name} looks at the top ${top.length} cards (${r.sourceName} — hideaway).`);
  ask(state, ctx, r.controller, `${r.sourceName}: choose a card to exile face down (the rest go on the bottom)`, top.map((iid) => ({ value: iid, label: nm(state, ctx, iid) })),
    { kind: 'unique', u: 'hideaway', pid: r.controller, host, top, cont: r.cont() });
  return 'wait';
}

// ------------------------------------------------------------------ Oath of Druids / Sylvan Library

/** Does an opponent of `pid` control more creatures than `pid`? (Oath of Druids' targeting requirement) */
export function oathApplies(state: GameState, ctx: Ctx, pid: string): boolean {
  const n = (who: string) => state.battlefield.filter((iid) => state.cards[iid].controller === who && isCreature(state.cards[iid], ctx.lookup, state)).length;
  const mine = n(pid);
  return state.players.some((p) => p.pid !== pid && !p.conceded && n(p.pid) > mine);
}

function oath(state: GameState, ctx: Ctx, r: UniqueRun): Result {
  const pid = r.trig?.player ?? state.activePlayer;
  if (!oathApplies(state, ctx, pid)) { log(state, ctx, pid, `${r.sourceName}: no opponent of ${pname(state, pid)} controls more creatures — nothing happens.`); return 'ok'; }
  ask(state, ctx, pid, `${r.sourceName}: reveal cards from the top of your library until you reveal a creature card?`, [{ value: 'yes', label: 'Reveal' }, { value: 'no', label: "Don't" }],
    { kind: 'unique', u: 'oath', pid, valid: r.step.params.Valid ?? 'Creature', source: r.sourceName, cont: r.cont() });
  return 'wait';
}

function digUntil(state: GameState, ctx: Ctx, pid: string, valid: string, source: string) {
  const me = player(state, pid);
  const revealed: string[] = [];
  let found: string | undefined;
  for (const iid of [...me.zones.library]) {
    if (matchCard(state.cards[iid], valid, { controller: pid, lookup: ctx.lookup }) === true) { found = iid; break; }
    revealed.push(iid);
  }
  const foundName = found ? nm(state, ctx, found) : undefined;
  log(state, ctx, pid, `${me.name} reveals ${names(state, ctx, [...revealed, ...(found ? [found] : [])])} (${source}).`);
  if (found) moveCard(state, ctx, found, 'battlefield', { controller: pid });
  for (const iid of revealed) moveCard(state, ctx, iid, 'graveyard');
  log(state, ctx, pid, found ? `${foundName} enters the battlefield; ${revealed.length} other card${revealed.length === 1 ? '' : 's'} go${revealed.length === 1 ? 'es' : ''} to the graveyard.` : `No creature found — ${revealed.length} cards go to the graveyard.`);
}

function askSylvan(state: GameState, ctx: Ctx, d: Extract<UData, { u: 'sylvan' }>) {
  const me = player(state, d.pid);
  if (d.left <= 0 || !me.zones.hand.length) { resumeAuto(state, ctx, d.cont); return; }
  if (d.phase === 'pick') {
    ask(state, ctx, d.pid, `${d.source}: choose a card you drew this turn (${d.left} left) — then pay ${d.life} life or put it back on top`,
      me.zones.hand.map((iid) => ({ value: iid, label: nm(state, ctx, iid) })), d);
  } else {
    ask(state, ctx, d.pid, `${d.source}: pay ${d.life} life or put the chosen card on top of your library?`,
      [{ value: 'pay', label: `Pay ${d.life} life (keep ${nm(state, ctx, d.card!)})` }, { value: 'top', label: `Put ${nm(state, ctx, d.card!)} on top` }], d);
  }
}

// ------------------------------------------------------------------ answers

/** Answer a unique Pending. Returns undefined when the Pending isn't ours. */
export function answerUniquePending(state: GameState, ctx: Ctx, pend: Pending, value: string): string | null | undefined {
  const d = pend.data as unknown as UData;
  if (d.kind !== 'unique') return undefined;
  const who = pname(state, pend.pid);
  switch (d.u) {
    case 'vote': {
      d.votes[value] = (d.votes[value] ?? 0) + 1;
      log(state, ctx, pend.pid, `${who} votes for ${nm(state, ctx, value)}.`);
      if (d.idx + 1 < d.voters.length) askVote(state, ctx, { ...d, idx: d.idx + 1 });
      else finishVote(state, ctx, d);
      return null;
    }
    case 'pile': {
      if (value === 'done') {
        const rest = d.cards.filter((iid) => !d.pile1.includes(iid) && state.cards[iid]?.zone === 'battlefield');
        log(state, ctx, d.separator, `${pname(state, d.separator)} separates: pile 1 — ${names(state, ctx, d.pile1)}; pile 2 — ${names(state, ctx, rest)}.`);
        ask(state, ctx, d.target, `${d.source}: choose the pile you sacrifice`, [
          { value: 'pile:1', label: `Pile 1: ${names(state, ctx, d.pile1)}` }, { value: 'pile:2', label: `Pile 2: ${names(state, ctx, rest)}` },
        ], d);
        return null;
      }
      if (value === 'pile:1' || value === 'pile:2') { finishPiles(state, ctx, d, value === 'pile:1' ? '1' : '2'); return null; }
      const next = { ...d, pile1: [...d.pile1, value] };
      if (next.pile1.length >= d.cards.length) return answerUniquePending(state, ctx, { ...pend, data: next as unknown as Record<string, unknown> }, 'done');
      askPile(state, ctx, next);
      return null;
    }
    case 'tap': {
      if (value === 'done') { resumeAuto(state, ctx, d.cont); return null; }
      const c = state.cards[value];
      if (c) { c.tapped = d.tap; log(state, ctx, pend.pid, `${who} ${d.tap ? 'taps' : 'untaps'} ${cardName(c, ctx.lookup)} (${d.source}).`); }
      askTap(state, ctx, { ...d, left: d.left - 1, candidates: d.candidates.filter((x) => x !== value) });
      return null;
    }
    case 'jace': {
      if (value === 'bottom' && state.cards[d.iid]?.zone === 'library') {
        moveCard(state, ctx, d.iid, 'library', { position: 'bottom' });
        log(state, ctx, pend.pid, `${who} puts the top card of ${pname(state, d.target)}'s library on the bottom.`);
      } else log(state, ctx, pend.pid, `${who} leaves the card on top of ${pname(state, d.target)}'s library.`);
      resumeAuto(state, ctx, d.cont);
      return null;
    }
    case 'hideaway': {
      const host = state.cards[d.host];
      moveCard(state, ctx, value, 'exile', { faceDown: true });
      if (state.cards[value]) state.cards[value].revealedTo = [d.pid];
      (state.remembered ??= {})[d.host] = [value];
      for (const iid of d.top) if (iid !== value && state.cards[iid]?.zone === 'library') moveCard(state, ctx, iid, 'library', { position: 'bottom' });
      log(state, ctx, d.pid, `${who} exiles a card face down with ${host ? cardName(host, ctx.lookup) : 'it'} and puts the rest on the bottom of their library.`);
      resumeAuto(state, ctx, d.cont);
      return null;
    }
    case 'oath': {
      if (value === 'yes') digUntil(state, ctx, d.pid, d.valid, d.source);
      else log(state, ctx, d.pid, `${who} doesn't reveal (${d.source}).`);
      resumeAuto(state, ctx, d.cont);
      return null;
    }
    case 'sylvan': {
      const me = player(state, d.pid);
      if (d.phase === 'draw') {
        if (value !== 'yes') { log(state, ctx, d.pid, `${who} doesn't draw extra cards (${d.source}).`); resumeAuto(state, ctx, d.cont); return null; }
        const got = drawCards(state, me, d.n);
        log(state, ctx, d.pid, `${who} draws ${got} additional card${got === 1 ? '' : 's'} (${d.source}).`);
        askSylvan(state, ctx, { ...d, phase: 'pick', left: Math.min(got, d.n) });
        return null;
      }
      if (d.phase === 'pick') { askSylvan(state, ctx, { ...d, phase: 'pay', card: value }); return null; }
      if (value === 'pay') { me.life -= d.life; log(state, ctx, d.pid, `${who} pays ${d.life} life to keep a card (${me.life}).`); }
      else if (d.card && state.cards[d.card]?.zone === 'hand') { moveCard(state, ctx, d.card, 'library'); log(state, ctx, d.pid, `${who} puts a card back on top of their library.`); }
      askSylvan(state, ctx, { ...d, phase: 'pick', left: d.left - 1, card: undefined });
      return null;
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ variables

/** Variables only the unique effects use (see uniqueVarSupported). undefined = not ours. */
export function uniqueVar(state: GameState, ctx: Ctx, controller: string, remembered: string[], v: string): number | undefined {
  if (v === 'Remembered$Amount') return remembered.length;
  let m = /^PlayerCountPlayers\$LowestValidLibrary (\S+)$/.exec(v);
  if (m) return Math.min(...state.players.filter((p) => !p.conceded).map((p) => p.zones.library.length));
  m = /^Count\$Valid (\S+)\$DifferentCardNames$/.exec(v);
  if (m) {
    const env = { controller, lookup: ctx.lookup };
    const seen = new Set<string>();
    for (const iid of state.battlefield) {
      const c: CardInstance = state.cards[iid];
      if (matchCard(c, m[1], env) === true) seen.add(cardName(c, ctx.lookup));
    }
    return seen.size;
  }
  return undefined;
}
