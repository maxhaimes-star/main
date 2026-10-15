import { basicLandCard, type CardData, type Color, type TokenData } from '../cards.ts';
import type { Rng } from '../draft.ts';
import { computeCombat } from './combat.ts';
import { cardName, effectivePT, faceOf, hasKeyword, isCreature, type Lookup, payFromPool } from './rules.ts';
import { activateAuto } from '../engine/play.ts';
import { afterSpellResolved, finishCast, payCastMana, planCast } from '../engine/costs.ts';
import { durationsAtCleanup, durationsAtTurnStart } from '../engine/durations.ts';
import { activateMana } from '../engine/mana.ts';
import { loyaltyError, recordActivation } from '../engine/timing.ts';
import { answerPending, createTokenInstance, resolveAuto, resumeAuto } from '../engine/resolve.ts';
import { answerTriggerChoice, answerTriggerTargets, beginAction, processTriggers, triggerStillApplies } from '../engine/triggers.ts';
import { activateRestriction, attackRestriction, blockRestriction, combatReminders } from '../engine/statics.ts';
import { tokenCopy } from '../engine/copy.ts';
import { skipsStep, untapPrevented } from '../engine/replacements.ts';
import { wardReminders } from '../engine/keyword-play.ts';
import { nextTurnPlayer, routeAction, turnStarted } from '../engine/turns.ts';
import { enforceAttackRequirements, enforceBlockRestrictions, takeExtraCombat } from '../engine/combat-rules.ts';
import { noteTapped } from '../engine/manatriggers.ts';
import {
  answerStrictPending, attackError, blockError, blockersError, castHelp, castManaCost, reduceGeneric, castZoneError, checkStateBased, executeAutoPay, fixModeOn,
  isLandCard, landPlayError, planAutoPay, strictActionError, summoningSick,
} from '../engine/strict.ts';
import { maxHandSize, mayPlayPermission } from '../engine/statics.ts';
import { spellAbility, targetSpecs } from '../engine/script.ts';
import { parseRequirements } from './manapay.ts';
import {
  type Ctx, detach, drawCards, emit, log, moveCard, newInstance, player, randomId, shuffleLibrary, turnStats,
} from './state.ts';
import {
  type CardInstance, type GameAction, type GamePlayer, type GameState, type PlayerZone, type StackItem, type Step,
  type Zone, PLAYER_ZONES, STEPS,
} from './types.ts';

export type { Ctx } from './state.ts';
export { moveCard, player } from './state.ts';

export interface GameSeat { pid: string; name: string; deck: string[]; side: string[] }

const HISTORY_LIMIT = 25;
const DEFAULT_STOPS: GamePlayer['stops'] = {
  own: ['main1', 'main2'],
  opp: ['end'],
};

/** Card lookup that also understands basic lands ("basic_forest"). */
export function withBasics(lookup: (id: string) => CardData | undefined): Lookup {
  const basics: Record<string, CardData> = {};
  for (const c of ['W', 'U', 'B', 'R', 'G'] as Color[]) { const b = basicLandCard(c); basics[b.id] = b; }
  return (id) => basics[id] ?? lookup(id);
}

/** opts.strict: rules enforcement (engine/strict.ts), default true. */
export function createGame(id: string, seats: GameSeat[], startingPlayer: string, ctx: Ctx, opts: { strict?: boolean } = {}): GameState {
  const state: GameState = {
    id,
    players: [],
    cards: {},
    battlefield: [],
    stack: [],
    turn: 0,
    activePlayer: startingPlayer,
    startingPlayer,
    step: 'untap',
    priority: startingPlayer,
    passed: [],
    phase: 'mulligan',
    winner: null,
    combat: { proposal: null, attackersDeclared: false, blockersDeclared: false },
    log: [],
    history: [],
    undoRequest: null,
    pending: [],
    seq: 0,
    strict: opts.strict ?? true,
    fixMode: { on: false, requestedBy: null },
  };
  for (const seat of seats) {
    const p: GamePlayer = {
      pid: seat.pid, name: seat.name, life: 20, counters: {},
      zones: { library: [], hand: [], graveyard: [], exile: [], command: [], sideboard: [] },
      manaPool: {}, mulligans: 0, kept: false, needsBottom: 0, landsPlayed: 0,
      stops: { own: [...DEFAULT_STOPS.own], opp: [...DEFAULT_STOPS.opp] },
      passUntilEOT: false, peek: null, viewingHandOf: null, conceded: false, designations: [], autoTriggers: true,
    };
    state.players.push(p);
    for (const cardId of seat.deck) p.zones.library.push(newInstance(state, ctx.rng, seat.pid, 'library', cardId).iid);
    for (const cardId of seat.side) p.zones.sideboard.push(newInstance(state, ctx.rng, seat.pid, 'sideboard', cardId).iid);
    shuffleLibrary(state, p, ctx.rng);
    drawCards(state, p, 7);
  }
  log(state, ctx, null, `Game begins. ${player(state, startingPlayer).name} will play first.`);
  return state;
}

// ------------------------------------------------------------------ helpers

function others(state: GameState, pid: string): GamePlayer[] {
  return state.players.filter((p) => p.pid !== pid && !p.conceded);
}

function nextPlayer(state: GameState, pid: string): string {
  const live = state.players.filter((p) => !p.conceded);
  const i = live.findIndex((p) => p.pid === pid);
  return live[(i + 1) % live.length].pid;
}


function isPublicZone(z: Zone) {
  return z === 'battlefield' || z === 'graveyard' || z === 'exile' || z === 'stack' || z === 'command';
}

/** Whether `pid` may manipulate this card. Public cards: anyone (it's a shared table, everything is logged). */
function canTouch(state: GameState, pid: string, inst: CardInstance): boolean {
  if (inst.owner === pid || inst.controller === pid) return true;
  if (isPublicZone(inst.zone) && !inst.faceDown) return true;
  if (inst.zone === 'hand' && (inst.revealedTo.includes(pid) || player(state, pid).viewingHandOf === inst.owner)) return true;
  return false;
}

function publicName(state: GameState, ctx: Ctx, inst: CardInstance, from: Zone, to: Zone): string {
  const hidden = (z: Zone) => z === 'library' || z === 'hand' || z === 'sideboard';
  if (inst.faceDown && to !== 'battlefield') return 'a face-down card';
  if (hidden(from) && hidden(to)) return 'a card';
  if (to === 'exile' && inst.faceDown) return 'a card';
  return cardName(inst, ctx.lookup);
}

const ZONE_LABEL: Record<Zone, string> = {
  library: 'library', hand: 'hand', battlefield: 'the battlefield', graveyard: 'graveyard', exile: 'exile',
  stack: 'the stack', command: 'the command zone', sideboard: 'sideboard',
};

function snapshot(state: GameState): string {
  const { history: _h, log: _l, ...rest } = state;
  return JSON.stringify(rest);
}

const NOT_UNDOABLE = new Set<GameAction['t']>(['chat', 'requestUndo', 'answerUndo', 'setStops', 'lookAtHand', 'peek', 'setAutoTriggers', 'requestFixMode', 'answerFixMode', 'endFixMode']);

// ------------------------------------------------------------------ turn structure

function emptyPools(state: GameState) {
  for (const p of state.players) p.manaPool = {};
}

function hasStop(state: GameState, pid: string): boolean {
  const p = player(state, pid);
  if (p.passUntilEOT) return false;
  const own = state.activePlayer === pid;
  const step = state.step;
  // Combat steps that need a decision always stop for the deciding player.
  const attackers = state.battlefield.some((id) => state.cards[id].attacking);
  if (step === 'attackers' && own && !state.combat.attackersDeclared) return true;
  if (step === 'blockers' && !own && attackers && !state.combat.blockersDeclared) return true;
  if (step === 'damage' && attackers && state.combat.proposal && !state.combat.proposal.confirmed.includes(pid)) return true;
  if (step === 'main1' && own && state.turn > 0) return true;
  return (own ? p.stops.own : p.stops.opp).includes(step);
}

function enterStep(state: GameState, ctx: Ctx, step: Step) {
  state.step = step;
  state.passed = [];
  state.priority = state.activePlayer;
  emptyPools(state);
  const active = player(state, state.activePlayer);
  if (step !== 'untap') emit(state, { t: 'phase', step, active: state.activePlayer, turn: state.turn });
  switch (step) {
    case 'untap': {
      for (const id of state.battlefield) {
        const c = state.cards[id];
        if (c.controller !== state.activePlayer) continue;
        if (!c.noUntap && !untapPrevented(state, ctx, c)) c.tapped = false;
        c.summoningSick = false;
      }
      // No priority in untap: go straight to upkeep.
      enterStep(state, ctx, 'upkeep');
      return;
    }
    case 'draw': {
      const skip = skipsStep(state, ctx, active.pid, 'draw');
      if (state.turn === 1 && state.activePlayer === state.startingPlayer && state.players.length === 2) {
        log(state, ctx, active.pid, `${active.name} skips the first draw.`);
      } else if (skip) {
        log(state, ctx, active.pid, `${active.name} skips their draw step (${skip}).`);
      } else if (drawCards(state, active, 1) === 0) {
        log(state, ctx, active.pid, `${active.name} can't draw — library is empty!`);
      } else {
        const ev = state.events?.[state.events.length - 1];
        if (ev?.t === 'drawn' && ev.pid === active.pid) ev.firstInDrawStep = true;
        log(state, ctx, active.pid, `${active.name} draws for the turn.`);
      }
      break;
    }
    case 'beginCombat':
      state.combat = { proposal: null, attackersDeclared: false, blockersDeclared: false };
      break;
    case 'attackers': {
      const canAttack = state.battlefield.some((id) => {
        const c = state.cards[id];
        if (state.strict && c.controller === state.activePlayer && attackRestriction(state, id, ctx.lookup)) return false;
        return c.controller === state.activePlayer && !c.tapped && isCreature(c, ctx.lookup, state) && !(state.strict && summoningSick(state, c, ctx.lookup));
      });
      if (!canAttack) { state.combat.attackersDeclared = true; log(state, ctx, null, 'No attackers.'); }
      break;
    }
    case 'blockers': {
      const any = state.battlefield.some((id) => state.cards[id].attacking);
      if (!any) { enterStep(state, ctx, 'endCombat'); return; }
      if (state.strict) {
        // Arena-style: no decision to make when the defender has no untapped creature.
        const canBlock = state.battlefield.some((id) => {
          const c = state.cards[id];
          return c.controller !== state.activePlayer && !c.tapped && isCreature(c, ctx.lookup, state);
        });
        if (!canBlock) { state.combat.blockersDeclared = true; log(state, ctx, null, 'No blockers.'); }
      }
      break;
    }
    case 'damage': {
      const any = state.battlefield.some((id) => state.cards[id].attacking);
      if (!any) { enterStep(state, ctx, 'endCombat'); return; }
      state.combat.proposal = computeCombat(state, ctx.lookup);
      if (state.strict) {
        // Rules-enforced: combat damage is dealt at once (first / double strike are part of the computation).
        log(state, ctx, null, `Combat damage: ${state.combat.proposal.lines.join('; ')}.`);
        applyCombat(state, ctx);
        break;
      }
      log(state, ctx, null, `Combat damage proposed: ${state.combat.proposal.lines.join('; ')}. Both players confirm (OK) to apply.`);
      break;
    }
    case 'endCombat': {
      for (const id of state.battlefield) { state.cards[id].attacking = undefined; state.cards[id].blocking = undefined; }
      state.combat = { proposal: null, attackersDeclared: false, blockersDeclared: false };
      break;
    }
    case 'cleanup': {
      for (const id of state.battlefield) { const c = state.cards[id]; c.damage = 0; c.tempPT = [0, 0]; c.tempKeywords = undefined; }
      for (const p of state.players) for (const id of p.zones.hand) state.cards[id].revealedTo = [];
      for (const p of state.players) p.viewingHandOf = null;
      durationsAtCleanup(state, ctx);
      if (state.strict && state.phase === 'playing') {
        if (askCleanupDiscard(state, ctx)) return; // continues in answerCleanupDiscard
      } else if (active.zones.hand.length > 7) log(state, ctx, active.pid, `${active.name} has ${active.zones.hand.length} cards — discard down to 7.`);
      endCleanup(state, ctx);
      return;
    }
  }
}

function endCleanup(state: GameState, ctx: Ctx) {
  startTurn(state, ctx, nextTurnPlayer(state, ctx, nextPlayer(state, state.activePlayer))); // extra turns (engine/turns.ts)
}

/** Strict cleanup: the active player discards down to their maximum hand size (a Pending choice per card). */
function askCleanupDiscard(state: GameState, ctx: Ctx): boolean {
  const active = player(state, state.activePlayer);
  const excess = active.zones.hand.length - maxHandSize(state, active.pid, ctx.lookup);
  if (excess <= 0) return false;
  state.pending.push({
    id: randomId(ctx.rng), pid: active.pid, prompt: `Cleanup: discard ${excess} card${excess === 1 ? '' : 's'} (maximum hand size)`,
    options: active.zones.hand.map((iid) => ({ value: iid, label: cardName(state.cards[iid], ctx.lookup) })),
    data: { kind: 'cleanupDiscard' },
  });
  return true;
}

function answerCleanupDiscard(state: GameState, ctx: Ctx, pid: string, id: string, value: string): string | null | undefined {
  const q = state.pending.find((p) => p.id === id);
  if (!q || q.data.kind !== 'cleanupDiscard') return undefined;
  if (q.pid !== pid) return 'That question is for another player';
  const me = player(state, pid);
  if (!me.zones.hand.includes(value)) return 'Choose a card in your hand';
  state.pending = state.pending.filter((p) => p !== q);
  const nm = cardName(state.cards[value], ctx.lookup);
  moveCard(state, ctx, value, 'graveyard', { cause: 'discard' });
  log(state, ctx, pid, `${me.name} discards ${nm} (hand size).`);
  if (!askCleanupDiscard(state, ctx)) endCleanup(state, ctx);
  return null;
}

function startTurn(state: GameState, ctx: Ctx, pid: string) {
  state.turn++;
  state.activePlayer = pid;
  for (const p of state.players) { p.landsPlayed = 0; p.passUntilEOT = false; }
  state.turnStats = { cast: {}, drawn: {} };
  log(state, ctx, null, `— Turn ${state.turn}: ${player(state, pid).name} —`);
  turnStarted(state, ctx, pid); // Mindslaver control starts / ends (engine/turns.ts)
  durationsAtTurnStart(state, ctx, pid);
  enterStep(state, ctx, 'untap');
}

function advanceStep(state: GameState, ctx: Ctx) {
  if (state.step === 'endCombat' && takeExtraCombat(state, ctx)) { enterStep(state, ctx, 'beginCombat'); return; } // engine/combat-rules.ts
  const i = STEPS.indexOf(state.step);
  enterStep(state, ctx, STEPS[i + 1] ?? 'cleanup');
}

/** Auto-pass for players without a stop, so the game flows like MTGO. Puts triggered abilities on the stack first. */
function settle(state: GameState, ctx: Ctx) {
  for (let guard = 0; guard < 60 && state.phase === 'playing'; guard++) {
    checkStateBased(state, ctx); // strict mode only
    if (state.phase !== 'playing') return;
    processTriggers(state, ctx);
    if (state.pending.length) return;
    const pid = state.priority;
    const p = player(state, pid);
    if (p.conceded) { passPriority(state, ctx, pid); continue; }
    if (state.stack.length > 0) {
      // Something to respond to: only auto-pass with F6, or if it's your own item and the other player hasn't passed yet.
      if (p.passUntilEOT) { passPriority(state, ctx, pid); continue; }
      return;
    }
    if (hasStop(state, pid)) return;
    passPriority(state, ctx, pid);
  }
}

function passPriority(state: GameState, ctx: Ctx, pid: string) {
  if (state.pending.length) return; // waiting on an engine question
  if (!state.passed.includes(pid)) state.passed.push(pid);
  const live = state.players.filter((p) => !p.conceded);
  if (live.every((p) => state.passed.includes(p.pid))) {
    if (state.stack.length) {
      resolveTop(state, ctx);
    } else {
      if (state.step === 'damage' && state.combat.proposal) applyCombat(state, ctx);
      advanceStep(state, ctx);
    }
  } else {
    state.priority = nextPlayer(state, pid);
  }
}

function giveResponse(state: GameState, actor: string) {
  // After someone puts something on the stack, the next player gets a chance to respond.
  state.passed = [actor];
  state.priority = state.players.length > 1 ? nextPlayer(state, actor) : actor;
  if (state.priority === actor) state.passed = [];
}

function isPermanentSpell(inst: CardInstance, ctx: Ctx): boolean {
  const face = faceOf(inst, ctx.lookup);
  return face.types.some((t) => ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'].includes(t)) || inst.faceDown;
}

/** Put a resolving spell card where it goes: battlefield (permanents), exile (adventures) or graveyard. */
function finishSpell(state: GameState, ctx: Ctx, item: StackItem, quiet: boolean) {
  const inst = state.cards[item.iid!];
  const face = faceOf(inst, ctx.lookup);
  const permanent = isPermanentSpell(inst, ctx);
  const card = inst.cardId ? ctx.lookup(inst.cardId) : undefined;
  const onAdventure = !!inst.castAs && card?.layout === 'adventure' && inst.castAs !== card.faces?.[0].name;
  if (onAdventure) {
    moveCard(state, ctx, item.iid!, 'exile');
    if (!quiet) log(state, ctx, item.controller, `${face.name} resolves (card goes on an adventure in exile).`);
    else log(state, ctx, item.controller, `${face.name} goes on an adventure in exile.`);
  } else if (permanent) {
    const transformed = inst.transformed;
    moveCard(state, ctx, item.iid!, 'battlefield', { controller: item.controller, faceDown: inst.faceDown });
    inst.transformed = transformed;
    if (transformed) { const f = faceOf(inst, ctx.lookup); if (f.loyalty) inst.counters.loyalty = parseInt(f.loyalty, 10) || 0; }
    if (item.x && /\{X\}/.test(face.manaCost) && face.types.includes('Creature') && /ravenous|enters with X/i.test(face.oracle)) {
      inst.counters['+1/+1'] = item.x;
    }
    if (!quiet) log(state, ctx, item.controller, `${face.name} resolves.`);
  } else {
    moveCard(state, ctx, item.iid!, 'graveyard');
    if (!quiet) log(state, ctx, item.controller, `${face.name} resolves.`);
  }
}

function resolveTop(state: GameState, ctx: Ctx) {
  const item = state.stack[state.stack.length - 1];
  if (!item) return;
  let resolved = true;
  if (!triggerStillApplies(state, ctx, item)) {
    // intervening "if" no longer true: removed
    resolved = false;
  } else if (item.auto) {
    const inst = item.iid ? state.cards[item.iid] : undefined;
    resolved = resolveAuto(state, ctx, item, !!inst && isPermanentSpell(inst, ctx), () => finishSpell(state, ctx, item, true));
  } else {
    if (!item.iid || !state.cards[item.iid]) state.stack.pop();
    if (item.iid && state.cards[item.iid]) finishSpell(state, ctx, item, false);
    else log(state, ctx, item.controller, `Resolved: ${item.text}`);
  }
  afterSpellResolved(state, ctx, item, resolved);
  state.passed = [];
  state.priority = state.activePlayer;
}

function applyCombat(state: GameState, ctx: Ctx) {
  const prop = state.combat.proposal!;
  for (const h of prop.hits ?? []) {
    const src = state.cards[h.source];
    if (!src) continue;
    const tgt = state.cards[h.target];
    emit(state, { t: 'damage', source: h.source, target: h.target, amount: h.amount, combat: true, sourceSnap: JSON.parse(JSON.stringify(src)), ...(tgt ? { targetSnap: JSON.parse(JSON.stringify(tgt)) } : {}) });
  }
  for (const [key, delta] of Object.entries(prop.lifeChange)) {
    if (key.startsWith('poison:')) {
      const p = player(state, key.slice(7));
      p.counters.poison = (p.counters.poison ?? 0) + delta;
    } else {
      player(state, key).life += delta;
    }
  }
  for (const [iid, dmg] of Object.entries(prop.damage)) {
    const c = state.cards[iid];
    if (!c) continue;
    if (faceOf(c, ctx.lookup).types.includes('Planeswalker')) c.counters.loyalty = Math.max(0, (c.counters.loyalty ?? 0) - dmg);
    else c.damage += dmg;
  }
  for (const iid of prop.dies) {
    if (state.cards[iid]?.zone === 'battlefield') moveCard(state, ctx, iid, 'graveyard');
  }
  log(state, ctx, null, `Combat damage applied. ${prop.dies.length ? `Died: ${prop.dies.length}.` : ''} Life: ${state.players.map((p) => `${p.name} ${p.life}`).join(', ')}`);
  state.combat.proposal = null;
  for (const id of state.battlefield) { state.cards[id].attacking = undefined; state.cards[id].blocking = undefined; }
}

function checkMulliganDone(state: GameState, ctx: Ctx) {
  if (state.players.every((p) => p.kept && p.needsBottom === 0)) {
    state.phase = 'playing';
    state.turn = 0;
    startTurn(state, ctx, state.startingPlayer);
    settle(state, ctx);
  }
}

// ------------------------------------------------------------------ reducer

/** Apply an action. Returns an error string, or null on success. Mutates `state`. */
export function applyAction(state: GameState, pid: string, action: GameAction, ctx: Ctx): string | null {
  if (!state.players.some((p) => p.pid === pid)) return 'You are not playing in this game';
  // Mindslaver: the controlling player acts as the controlled one (engine/turns.ts).
  const route = routeAction(state, pid, action);
  if ('error' in route) return route.error;
  pid = route.pid;
  const me = state.players.find((p) => p.pid === pid);
  if (!me) return 'You are not playing in this game';
  if (state.phase === 'over' && action.t !== 'chat') return 'The game is over';
  const strictErr = strictActionError(state, pid, action); // rules enforcement (engine/strict.ts)
  if (strictErr) return strictErr;
  beginAction(state);
  const before = NOT_UNDOABLE.has(action.t) ? null : snapshot(state);
  const err = reduce(state, me, action, ctx);
  if (err) return err;
  if (before) {
    state.history.push(before);
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
  }
  if (state.phase === 'playing' && !['chat', 'requestUndo', 'answerUndo'].includes(action.t)) settle(state, ctx);
  state.seq++;
  return null;
}

function card(state: GameState, iid: string): CardInstance | undefined {
  return state.cards[iid];
}

function reduce(state: GameState, me: GamePlayer, a: GameAction, ctx: Ctx): string | null {
  const pid = me.pid;
  const name = me.name;
  switch (a.t) {
    // ---------------- mulligans
    case 'mulligan': {
      if (state.phase !== 'mulligan' || me.kept) return 'Not deciding on a hand';
      for (const iid of [...me.zones.hand]) moveCard(state, ctx, iid, 'library');
      shuffleLibrary(state, me, ctx.rng);
      drawCards(state, me, 7);
      me.mulligans++;
      log(state, ctx, pid, `${name} mulligans (${me.mulligans}).`);
      return null;
    }
    case 'keep': {
      if (state.phase !== 'mulligan' || me.kept) return 'Not deciding on a hand';
      me.kept = true;
      me.needsBottom = Math.min(me.mulligans, me.zones.hand.length);
      log(state, ctx, pid, `${name} keeps ${7 - me.needsBottom}.`);
      checkMulliganDone(state, ctx);
      return null;
    }
    case 'bottom': {
      if (me.needsBottom !== a.iids.length) return `Choose exactly ${me.needsBottom} card(s)`;
      if (!a.iids.every((i) => me.zones.hand.includes(i))) return 'Cards must be in your hand';
      for (const iid of a.iids) moveCard(state, ctx, iid, 'library', { position: 'bottom' });
      me.needsBottom = 0;
      log(state, ctx, pid, `${name} puts ${a.iids.length} card(s) on the bottom.`);
      checkMulliganDone(state, ctx);
      return null;
    }

    // ---------------- priority & turn
    case 'pass': {
      if (state.phase !== 'playing') return 'Game has not started';
      if (state.priority !== pid) return "You don't have priority";
      if (state.pending.length) return `Waiting for ${player(state, state.pending[0].pid).name}: ${state.pending[0].prompt}`;
      return doPass(state, ctx, pid);
    }
    case 'passUntilEOT': {
      me.passUntilEOT = true;
      log(state, ctx, pid, `${name} passes until end of turn.`);
      if (state.priority === pid) passPriority(state, ctx, pid);
      return null;
    }
    case 'setStops': {
      me.stops = { own: a.own.filter((s) => STEPS.includes(s)), opp: a.opp.filter((s) => STEPS.includes(s)) };
      return null;
    }
    case 'gotoStep': {
      if (state.phase !== 'playing') return 'Game has not started';
      if (state.activePlayer !== pid) return 'Only the active player can skip ahead';
      if (state.stack.length) return 'Resolve the stack first';
      const target = STEPS.indexOf(a.step);
      if (target <= STEPS.indexOf(state.step)) return 'Can only move forward';
      if (state.strict && !fixModeOn(state)) {
        // Rules-enforced: pass priority step by step (the opponent can still act on their stops), like Arena's "to combat / end turn".
        if (state.priority !== pid) return "You don't have priority";
        if (state.pending.length) return `Waiting for ${player(state, state.pending[0].pid).name}: ${state.pending[0].prompt}`;
        const turn = state.turn;
        for (let guard = 0; guard < 40; guard++) {
          if (state.phase !== 'playing' || state.turn !== turn || state.activePlayer !== pid || state.stack.length || state.pending.length || state.priority !== pid) break;
          if (STEPS.indexOf(state.step) >= target) break;
          const err = doPass(state, ctx, pid);
          if (err) { if (guard === 0) return err; break; }
          settle(state, ctx);
        }
        return null;
      }
      // Walk forward through each step so turn-based actions happen.
      for (let guard = 0; guard < 15 && STEPS.indexOf(state.step) < target && state.activePlayer === pid; guard++) {
        if (state.step === 'damage' && state.combat.proposal) applyCombat(state, ctx);
        advanceStep(state, ctx);
      }
      log(state, ctx, pid, `${name} moves to ${a.step}.`);
      return null;
    }
    case 'nextTurn': {
      if (state.phase !== 'playing') return 'Game has not started';
      if (state.activePlayer !== pid) return "It's not your turn";
      if (state.strict && !fixModeOn(state)) {
        // Rules-enforced "end turn": pass until end of turn (end-step triggers and the opponent's stops still happen).
        me.passUntilEOT = true;
        log(state, ctx, pid, `${name} passes until end of turn.`);
        if (state.priority === pid && !state.pending.length) return doPass(state, ctx, pid);
        return null;
      }
      if (state.stack.length) return 'Resolve the stack first';
      if (state.combat.proposal) applyCombat(state, ctx);
      log(state, ctx, pid, `${name} ends the turn.`);
      enterStep(state, ctx, 'cleanup');
      return null;
    }

    // ---------------- library
    case 'draw': {
      const n = drawCards(state, me, Math.max(1, Math.min(20, a.n)));
      log(state, ctx, pid, `${name} draws ${n} card${n === 1 ? '' : 's'}.`);
      return null;
    }
    case 'shuffle': {
      shuffleLibrary(state, me, ctx.rng);
      log(state, ctx, pid, `${name} shuffles their library.`);
      return null;
    }
    case 'mill': {
      const ids = me.zones.library.slice(0, Math.max(1, a.n));
      for (const iid of ids) moveCard(state, ctx, iid, 'graveyard');
      log(state, ctx, pid, `${name} mills ${ids.map((i) => cardName(state.cards[i], ctx.lookup)).join(', ') || 'nothing'}.`);
      return null;
    }
    case 'peek': {
      const lib = me.zones.library;
      const iids = a.mode === 'search' ? lib.slice() : lib.slice(0, Math.max(1, a.n ?? 1));
      me.peek = { mode: a.mode, iids };
      const verb = { scry: `scries ${iids.length}`, surveil: `surveils ${iids.length}`, look: `looks at the top ${iids.length}`, search: 'searches their library' }[a.mode];
      log(state, ctx, pid, `${name} ${verb}.`);
      return null;
    }
    case 'resolvePeek': {
      if (!me.peek) return 'Nothing to resolve';
      // Cards cast/moved out of the library while peeking are simply skipped.
      const allowed = new Set(me.peek.iids.filter((i) => state.cards[i]?.zone === 'library'));
      const keep = (l: string[]) => l.filter((i) => allowed.has(i) || !me.peek!.iids.includes(i));
      const r = { top: keep(a.top), bottom: keep(a.bottom), graveyard: keep(a.graveyard), hand: keep(a.hand), battlefield: keep(a.battlefield), exile: keep(a.exile), shuffle: a.shuffle };
      const lists = [r.top, r.bottom, r.graveyard, r.hand, r.battlefield, r.exile];
      const all = lists.flat();
      if (!all.every((i) => allowed.has(i))) return 'Those cards are not available';
      if (new Set(all).size !== all.length) return 'A card was chosen twice';
      const mode = me.peek.mode;
      const then = me.peek.then;
      me.peek = null;
      for (const iid of all) detach(state, state.cards[iid]);
      const place = (iid: string, to: Zone, position?: 'top' | 'bottom') => {
        // Already removed from the library above; moveCard's detach is then a no-op.
        state.cards[iid].zone = 'library';
        moveCard(state, ctx, iid, to, { position });
      };
      [...r.top].reverse().forEach((iid) => place(iid, 'library', 'top'));
      r.bottom.forEach((iid) => place(iid, 'library', 'bottom'));
      r.graveyard.forEach((iid) => place(iid, 'graveyard'));
      r.hand.forEach((iid) => place(iid, 'hand'));
      r.battlefield.forEach((iid) => place(iid, 'battlefield'));
      r.exile.forEach((iid) => place(iid, 'exile'));
      const parts: string[] = [];
      if (r.top.length) parts.push(`${r.top.length} on top`);
      if (r.bottom.length) parts.push(`${r.bottom.length} on the bottom`);
      if (r.graveyard.length) parts.push(`${r.graveyard.map((i) => cardName(state.cards[i], ctx.lookup)).join(', ')} to graveyard`);
      if (r.hand.length) parts.push(`${r.hand.length} to hand`);
      if (r.battlefield.length) parts.push(`${r.battlefield.map((i) => cardName(state.cards[i], ctx.lookup)).join(', ')} onto the battlefield`);
      if (r.exile.length) parts.push(`${r.exile.map((i) => cardName(state.cards[i], ctx.lookup)).join(', ')} to exile`);
      if (r.shuffle || mode === 'search') shuffleLibrary(state, me, ctx.rng);
      log(state, ctx, pid, `${name} puts ${parts.join(', ') || 'everything back'}${r.shuffle || mode === 'search' ? ' and shuffles' : ''}.`);
      if (then) resumeAuto(state, ctx, then);
      return null;
    }
    case 'revealTop': {
      const ids = me.zones.library.slice(0, Math.max(1, a.n));
      for (const iid of ids) state.cards[iid].revealedTo = state.players.map((p) => p.pid);
      log(state, ctx, pid, `${name} reveals the top ${ids.length}: ${ids.map((i) => cardName(state.cards[i], ctx.lookup)).join(', ')}.`);
      return null;
    }

    // ---------------- moving cards
    case 'move': {
      const c = card(state, a.iid);
      if (!c) return 'No such card';
      if (!canTouch(state, pid, c)) return "You can't move that card";
      const from = c.zone;
      const label = publicName(state, ctx, c, from, a.to);
      const owner = player(state, c.owner);
      moveCard(state, ctx, a.iid, a.to, { position: a.position, faceDown: a.faceDown, tapped: a.tapped, controller: a.to === 'battlefield' && !a.toOwner ? (from === 'battlefield' ? c.controller : pid) : undefined });
      const whose = c.owner === pid ? 'their' : `${owner.name}'s`;
      const where = a.to === 'library' ? (typeof a.position === 'number' ? `position ${a.position + 1} from the top of ${whose} library` : `the ${a.position === 'bottom' ? 'bottom' : 'top'} of ${whose} library`) : ['graveyard', 'hand', 'exile', 'sideboard'].includes(a.to) ? `${whose} ${ZONE_LABEL[a.to]}` : ZONE_LABEL[a.to];
      log(state, ctx, pid, `${name} moves ${label} from ${from === 'battlefield' || from === 'stack' ? ZONE_LABEL[from] : `${c.owner === pid ? 'their' : `${owner.name}'s`} ${ZONE_LABEL[from]}`} to ${where}${a.faceDown ? ' face down' : ''}.`);
      return null;
    }
    case 'playLand': {
      const c = card(state, a.iid);
      if (!c || c.owner !== pid) return 'Not your card';
      if (c.zone !== 'hand' && c.zone !== 'graveyard' && c.zone !== 'exile' && c.zone !== 'library') return 'Card must be in your hand';
      let landBack = false;
      if (state.strict) {
        const front = isLandCard(c, ctx.lookup, 0);
        landBack = !front && isLandCard(c, ctx.lookup, 1);
        if (!front && !landBack) return `${cardName(c, ctx.lookup)} isn't a land`;
        const err = landPlayError(state, pid, a.iid, ctx.lookup);
        if (err && !(fixModeOn(state) && /already played/.test(err))) return err;
      }
      moveCard(state, ctx, a.iid, 'battlefield', { controller: pid });
      if (landBack && state.cards[a.iid]?.zone === 'battlefield') c.transformed = true; // modal DFC played as its land face
      me.landsPlayed++;
      emit(state, { t: 'landPlayed', iid: a.iid, pid });
      log(state, ctx, pid, `${name} plays ${cardName(c, ctx.lookup)}${me.landsPlayed > 1 ? ` (land #${me.landsPlayed} this turn)` : ''}.`);
      return null;
    }
    case 'cast': {
      const c = card(state, a.iid);
      if (!c) return 'No such card';
      if (!canTouch(state, pid, c)) return "You can't cast that card";
      if (c.zone === 'battlefield' || c.zone === 'stack') return 'That card is already in play';
      let strictPay: ReturnType<typeof planAutoPay> = null;
      if (state.strict) {
        const fix = fixModeOn(state);
        if (!a.faceDown && isLandCard(c, ctx.lookup, a.face ?? 0)) return `${cardName(c, ctx.lookup)} is a land — play it instead of casting it`;
        const zoneErr = castZoneError(state, pid, c, a.costOption, ctx.lookup);
        if (zoneErr && !fix) return zoneErr;
        if (!a.manual && !a.faceDown && c.cardId && a.targets === undefined) {
          const sp = spellAbility(c.cardId, a.face ?? 0);
          if (sp && targetSpecs(sp.ability, a.modes).length) return `${cardName(c, ctx.lookup)}: choose targets`;
        }
      }
      const prep = planCast(state, c, pid, a, ctx); // timing, static restrictions (force overrides both), cost option, targets
      if ('error' in prep) return prep.error;
      if (state.strict) {
        // Rules-enforced: the mana must be paid — pool first, then untapped sources (Arena-style auto-pay).
        if (c.zone !== 'hand' && !['flashback', 'escape', 'madness'].includes(prep.plan.def.id) && mayPlayPermission(state, c.iid, pid, ctx.lookup, state.remembered)?.free) prep.plan.mana = '';
        const cost = castManaCost(state, pid, c, a.face, prep.plan.mana, { delve: prep.plan.def.delve, x: prep.plan.x, faceDown: !!a.faceDown }, ctx.lookup);
        strictPay = planAutoPay(state, pid, cost, prep.plan.x, ctx.lookup, undefined, a.faceDown ? undefined : castHelp(c, a.face));
        if (!strictPay && !fixModeOn(state)) return `Not enough mana to cast ${a.faceDown ? 'that' : cardName(c, ctx.lookup)} (${cost || '{0}'})`;
        if (prep.plan.def.delve) {
          // Delve: mana is paid after the exile choices (engine/costs.ts finishCosts auto-taps then).
          const full = castManaCost(state, pid, c, a.face, prep.plan.mana, { x: prep.plan.x }, ctx.lookup);
          const gy = me.zones.graveyard.filter((i) => i !== c.iid).length;
          if (gy > 0 && (parseRequirements(full, prep.plan.x)?.generic ?? 0) > 0) strictPay = null;
        }
      }
      const data = c.cardId ? ctx.lookup(c.cardId) : undefined;
      const from = c.zone;
      detach(state, c);
      c.zone = 'stack';
      c.controller = pid;
      c.revealedTo = [];
      c.faceDown = !!a.faceDown;
      c.castAs = undefined;
      c.transformed = false;
      if (data?.faces && a.face != null && a.face > 0) {
        if (data.layout === 'modal_dfc' || data.layout === 'transform') c.transformed = true;
        else c.castAs = data.faces[a.face].name;
      } else if (data?.faces && data.layout === 'adventure') {
        c.castAs = undefined;
      }
      const face = faceOf(c, ctx.lookup);
      if (strictPay) {
        const helped = executeAutoPay(state, ctx, pid, strictPay, castHelp(c, a.face)); // Improvise / Convoke taps pay generic mana
        if (helped) prep.plan.mana = reduceGeneric(prep.plan.mana, helped, prep.plan.x);
      }
      const payment = payCastMana(state, me, c, prep.plan, ctx.lookup); // cost option + static cost changes (Thalia ...)
      const paid = payment.note;
      const item: StackItem = { id: randomId(ctx.rng), kind: 'spell', iid: c.iid, controller: pid, text: a.faceDown ? 'Face-down spell' : face.name, x: a.x };
      if (prep.auto) item.auto = prep.auto;
      state.stack.push(item);
      if (!a.faceDown) {
        const st = turnStats(state);
        st.cast[pid] = (st.cast[pid] ?? 0) + 1;
        emit(state, { t: 'cast', iid: c.iid, pid, nth: st.cast[pid] });
      }
      const fromText = from === 'hand' ? '' : ` from ${from === 'library' ? 'the top of their library' : ZONE_LABEL[from]}`;
      const tnames = prep.auto?.targets.flat().map((t) => t.kind === 'player' ? player(state, t.pid).name : t.kind === 'card' ? cardName(state.cards[t.iid], ctx.lookup) : state.stack.find((s) => s.id === t.id)?.text ?? 'a spell') ?? [];
      log(state, ctx, pid, `${name} casts ${a.faceDown ? 'a face-down spell' : face.name}${a.x != null ? ` (X=${a.x})` : ''}${fromText}${tnames.length ? ` targeting ${tnames.join(', ')}` : ''}${paid}.`);
      if (prep.auto) wardReminders(state, ctx, pid, prep.auto.targets);
      finishCast(state, ctx, pid, c, item, prep.plan, payment, a); // cast info, life / sacrifice / exile costs (may ask)
      giveResponse(state, pid);
      return null;
    }
    case 'activate': {
      const c = card(state, a.iid);
      if (!c) return 'No such card';
      if (a.ability != null) {
        if (!canTouch(state, pid, c) || (c.zone === 'battlefield' && c.controller !== pid)) return "You don't control that card";
        const err = activateAuto(state, ctx, pid, c, a);
        if (err) return err;
        giveResponse(state, pid);
        return null;
      }
      const banned = a.force || c.zone !== 'battlefield' ? null : activateRestriction(state, c.iid, pid, ctx.lookup); // Phyrexian Revoker ...
      if (banned) return banned;
      if (a.loyalty != null) {
        const lerr = a.force ? null : loyaltyError(state, c, pid, cardName(c, ctx.lookup));
        if (lerr) return lerr;
        c.counters.loyalty = (c.counters.loyalty ?? 0) + a.loyalty;
        recordActivation(state, c, undefined, undefined, true);
      }
      const src = cardName(c, ctx.lookup);
      state.stack.push({ id: randomId(ctx.rng), kind: 'ability', sourceIid: c.iid, controller: pid, text: `${src}: ${a.text}` });
      log(state, ctx, pid, `${name} activates ${src}${a.loyalty != null ? ` [${a.loyalty > 0 ? '+' : ''}${a.loyalty}]` : ''}: ${a.text}`);
      if (a.loyalty != null && (c.counters.loyalty ?? 0) <= 0) log(state, ctx, null, `${src} has 0 loyalty.`);
      giveResponse(state, pid);
      return null;
    }
    case 'choose': {
      let sp = answerStrictPending(state, ctx, pid, a.id, a.value);
      if (sp === undefined) sp = answerCleanupDiscard(state, ctx, pid, a.id, a.value);
      if (sp !== undefined) return sp;
      const q = state.pending.find((p) => p.id === a.id);
      if (state.strict && q?.pid === pid && q.data.kind === 'unless' && a.value === 'pay' && !planAutoPay(state, pid, String(q.data.cost ?? ''), 0, ctx.lookup)) return 'Not enough mana';
      const t = answerTriggerChoice(state, ctx, pid, a.id, a.value);
      if (t !== undefined) return t;
      return answerPending(state, ctx, pid, a.id, a.value);
    }
    case 'chooseTargets': {
      return answerTriggerTargets(state, ctx, pid, a.id, a.targets);
    }
    case 'setAutoTriggers': {
      me.autoTriggers = a.on;
      log(state, ctx, pid, `${name} turns automatic triggers ${a.on ? 'on' : 'off'}.`);
      if (!a.on) {
        const mine = (state.triggerQueue ?? []).filter((t) => t.controller === pid);
        state.triggerQueue = (state.triggerQueue ?? []).filter((t) => t.controller !== pid);
        state.pending = state.pending.filter((p) => !(p.data.kind === 'trigger' && mine.some((t) => t.id === p.data.qid)));
      }
      return null;
    }
    case 'trigger': {
      const src = a.sourceIid && state.cards[a.sourceIid] ? cardName(state.cards[a.sourceIid], ctx.lookup) : '';
      const text = src ? `${src}: ${a.text}` : a.text;
      state.stack.push({ id: randomId(ctx.rng), kind: 'trigger', sourceIid: a.sourceIid, controller: pid, text });
      log(state, ctx, pid, `${name} puts a trigger on the stack — ${text}`);
      giveResponse(state, pid);
      return null;
    }
    case 'resolve': {
      if (!state.stack.length) return 'The stack is empty';
      if (state.pending.length) return `Waiting for ${player(state, state.pending[0].pid).name}: ${state.pending[0].prompt}`;
      resolveTop(state, ctx);
      return null;
    }
    case 'counterTop':
    case 'removeStackItem': {
      const item = a.t === 'counterTop' ? state.stack[state.stack.length - 1] : state.stack.find((s) => s.id === a.id);
      if (!item) return 'Nothing there';
      if (item.iid && state.cards[item.iid]) {
        const nm = cardName(state.cards[item.iid], ctx.lookup);
        moveCard(state, ctx, item.iid, 'graveyard');
        log(state, ctx, pid, `${name} counters ${nm}.`);
      } else {
        state.stack = state.stack.filter((s) => s !== item);
        log(state, ctx, pid, `${name} removes from the stack: ${item.text}`);
      }
      state.passed = [];
      state.priority = state.activePlayer;
      return null;
    }

    // ---------------- permanents
    case 'tap': {
      const c = card(state, a.iid);
      if (!c || c.zone !== 'battlefield') return 'Not on the battlefield';
      if (!canTouch(state, pid, c)) return 'Not your permanent';
      c.tapped = a.tapped ?? !c.tapped;
      log(state, ctx, pid, `${name} ${c.tapped ? 'taps' : 'untaps'} ${cardName(c, ctx.lookup)}.`);
      return null;
    }
    case 'tapForMana': {
      const c = card(state, a.iid);
      if (!c || c.zone !== 'battlefield') return 'Not on the battlefield';
      if (c.controller !== pid) return 'Not your permanent';
      if (c.tapped) return 'Already tapped';
      const symbols = a.mana.match(/[WUBRGC]/g) ?? [];
      c.tapped = true;
      for (const s of symbols) me.manaPool[s] = (me.manaPool[s] ?? 0) + 1;
      log(state, ctx, pid, `${name} taps ${cardName(c, ctx.lookup)} for ${symbols.map((s) => `{${s}}`).join('')}.`);
      return null;
    }
    case 'activateMana': {
      return activateMana(state, ctx, pid, a);
    }
    case 'addMana': {
      if (!/^[WUBRGC]$/.test(a.mana)) return 'Bad mana';
      me.manaPool[a.mana] = Math.max(0, (me.manaPool[a.mana] ?? 0) + a.n);
      return null;
    }
    case 'clearMana': {
      me.manaPool = {};
      return null;
    }
    case 'untapAll': {
      for (const id of state.battlefield) if (state.cards[id].controller === pid) state.cards[id].tapped = false;
      log(state, ctx, pid, `${name} untaps all their permanents.`);
      return null;
    }
    case 'counter': {
      const c = card(state, a.iid);
      if (!c) return 'No such card';
      const kind = a.kind.trim().slice(0, 24) || '+1/+1';
      c.counters[kind] = Math.max(0, (c.counters[kind] ?? 0) + a.delta);
      if (!c.counters[kind]) delete c.counters[kind];
      log(state, ctx, pid, `${name} ${a.delta > 0 ? 'adds' : 'removes'} ${Math.abs(a.delta)} ${kind} counter${Math.abs(a.delta) === 1 ? '' : 's'} ${a.delta > 0 ? 'to' : 'from'} ${cardName(c, ctx.lookup)} (now ${c.counters[kind] ?? 0}).`);
      return null;
    }
    case 'playerCounter': {
      const p = player(state, a.pid);
      const kind = a.kind.trim().slice(0, 24);
      p.counters[kind] = Math.max(0, (p.counters[kind] ?? 0) + a.delta);
      log(state, ctx, pid, `${p.name}'s ${kind}: ${p.counters[kind]}.`);
      return null;
    }
    case 'life': {
      const p = player(state, a.pid);
      p.life += a.delta;
      log(state, ctx, pid, `${p.name} ${a.delta >= 0 ? 'gains' : 'loses'} ${Math.abs(a.delta)} life (${p.life}).`);
      return null;
    }
    case 'pt': {
      const c = card(state, a.iid);
      if (!c) return 'No such card';
      const key = a.permanent ? 'permPT' : 'tempPT';
      c[key] = [c[key][0] + a.dp, c[key][1] + a.dt];
      const [p, t] = effectivePT(c, ctx.lookup, state);
      log(state, ctx, pid, `${cardName(c, ctx.lookup)} gets ${a.dp >= 0 ? '+' : ''}${a.dp}/${a.dt >= 0 ? '+' : ''}${a.dt}${a.permanent ? '' : ' until end of turn'} (${p}/${t}).`);
      return null;
    }
    case 'damage': {
      const c = card(state, a.iid);
      if (!c) return 'No such card';
      c.damage = Math.max(0, c.damage + a.delta);
      const [, t] = effectivePT(c, ctx.lookup, state);
      log(state, ctx, pid, `${cardName(c, ctx.lookup)} has ${c.damage} damage${c.damage >= t && t > 0 && !hasKeyword(c, ctx.lookup, 'Indestructible', state) ? ' (lethal)' : ''}.`);
      return null;
    }
    case 'transform': {
      const c = card(state, a.iid);
      if (!c) return 'No such card';
      if (!canTouch(state, pid, c)) return 'Not your card';
      c.transformed = !c.transformed;
      const f = faceOf(c, ctx.lookup);
      if (c.zone === 'battlefield' && f.loyalty && c.counters.loyalty == null) c.counters.loyalty = parseInt(f.loyalty, 10) || 0;
      log(state, ctx, pid, `${name} transforms it into ${f.name}.`);
      return null;
    }
    case 'faceDown': {
      const c = card(state, a.iid);
      if (!c || !canTouch(state, pid, c)) return 'Not your card';
      const was = cardName(c, ctx.lookup);
      c.faceDown = a.faceDown;
      log(state, ctx, pid, a.faceDown ? `${name} turns a card face down.` : `${name} turns ${was === 'a face-down card' ? cardName(c, ctx.lookup) : was} face up.`);
      return null;
    }
    case 'attach': {
      const c = card(state, a.iid);
      if (!c || c.zone !== 'battlefield') return 'Not on the battlefield';
      if (a.to && (!state.cards[a.to] || state.cards[a.to].zone !== 'battlefield' || a.to === a.iid)) return 'Invalid target';
      c.attachedTo = a.to ?? undefined;
      log(state, ctx, pid, a.to ? `${name} attaches ${cardName(c, ctx.lookup)} to ${cardName(state.cards[a.to], ctx.lookup)}.` : `${name} unattaches ${cardName(c, ctx.lookup)}.`);
      return null;
    }
    case 'control': {
      const c = card(state, a.iid);
      if (!c || c.zone !== 'battlefield') return 'Not on the battlefield';
      const to = player(state, a.pid);
      c.controller = a.pid;
      c.summoningSick = true;
      c.attacking = undefined;
      c.blocking = undefined;
      log(state, ctx, pid, `${to.name} gains control of ${cardName(c, ctx.lookup)}.`);
      return null;
    }
    case 'createToken': {
      const n = Math.max(1, Math.min(50, a.n));
      const owner = a.pid ?? pid;
      for (let i = 0; i < n; i++) createTokenInstance(state, ctx, owner, a.token, !!a.tapped);
      log(state, ctx, pid, `${name} creates ${n} ${a.token.name}${a.token.power != null ? ` ${a.token.power}/${a.token.toughness}` : ''} token${n === 1 ? '' : 's'}.`);
      return null;
    }
    case 'copyCard': {
      const src = card(state, a.iid);
      if (!src || (!src.cardId && !src.token)) return 'Can only copy a card or token';
      const face = faceOf(src, ctx.lookup);
      tokenCopy(state, ctx, pid, src, {}); // copiable values (engine/copy.ts): copies of tokens / copies copy what they copy
      log(state, ctx, pid, `${name} creates a token copy of ${face.name}.`);
      return null;
    }
    case 'note': {
      const c = card(state, a.iid);
      if (!c) return 'No such card';
      c.note = a.note.slice(0, 140) || undefined;
      if (c.note) log(state, ctx, pid, `Note on ${cardName(c, ctx.lookup)}: ${c.note}`);
      return null;
    }
    case 'noUntap': {
      const c = card(state, a.iid);
      if (!c) return 'No such card';
      c.noUntap = a.value;
      return null;
    }
    case 'reveal': {
      const c = card(state, a.iid);
      if (!c || c.owner !== pid) return 'Not your card';
      c.revealedTo = state.players.map((p) => p.pid);
      log(state, ctx, pid, `${name} reveals ${cardName(c, ctx.lookup)}.`);
      return null;
    }
    case 'revealHand': {
      for (const iid of me.zones.hand) state.cards[iid].revealedTo = state.players.map((p) => p.pid);
      log(state, ctx, pid, `${name} reveals their hand: ${me.zones.hand.map((i) => cardName(state.cards[i], ctx.lookup)).join(', ') || '(empty)'}.`);
      return null;
    }
    case 'lookAtHand': {
      if (a.pid === pid) return 'That is your own hand';
      me.viewingHandOf = a.pid;
      if (a.pid) log(state, ctx, pid, `${name} looks at ${player(state, a.pid).name}'s hand.`);
      return null;
    }
    case 'designation': {
      const has = me.designations.includes(a.name);
      if (a.on && !has) {
        // Monarch / initiative are unique.
        if (['Monarch', 'Initiative'].includes(a.name)) for (const p of state.players) p.designations = p.designations.filter((d) => d !== a.name);
        me.designations.push(a.name);
      }
      if (!a.on) me.designations = me.designations.filter((d) => d !== a.name);
      log(state, ctx, pid, `${name} ${a.on ? 'gets' : 'loses'} ${a.name}.`);
      return null;
    }

    // ---------------- combat
    case 'declareAttacker': {
      const c = card(state, a.iid);
      if (!c || c.zone !== 'battlefield' || c.controller !== pid) return 'Not your creature';
      if (state.activePlayer !== pid) return "It's not your turn";
      if (state.combat.attackersDeclared) return 'Attackers are already declared';
      if (a.target) {
        if (c.tapped) return 'Tapped creatures can’t attack';
        if (state.strict && !a.force) { const e = attackError(state, pid, c.iid, a.target, ctx.lookup); if (e) return e; }
        const no = a.force ? null : attackRestriction(state, c.iid, ctx.lookup);
        if (no) return `${no} (use force to override)`;
        c.attacking = a.target;
      } else c.attacking = undefined;
      return null;
    }
    case 'confirmAttackers': {
      if (state.activePlayer !== pid) return "It's not your turn";
      if (state.strict && (state.step !== 'attackers' || state.combat.attackersDeclared)) return 'Not declaring attackers now';
      confirmAttackers(state, ctx);
      if (state.priority === pid && state.step === 'attackers') passPriority(state, ctx, pid);
      return null;
    }
    case 'declareBlocker': {
      const c = card(state, a.iid);
      if (!c || c.zone !== 'battlefield' || c.controller !== pid) return 'Not your creature';
      if (state.activePlayer === pid) return 'Only the defending player blocks';
      if (state.combat.blockersDeclared) return 'Blockers are already declared';
      if (a.attacker) {
        const att = state.cards[a.attacker];
        if (!att?.attacking) return 'That creature is not attacking';
        if (c.tapped) return 'Tapped creatures can’t block';
        const no = a.force ? null : blockRestriction(state, c.iid, a.attacker, ctx.lookup);
        if (no) return state.strict ? no : `${no} (use force to override)`;
        if (state.strict && !a.force) { const e = blockError(state, c.iid, a.attacker, ctx.lookup); if (e) return e; }
        if (hasKeyword(att, ctx.lookup, 'Flying', state) && !hasKeyword(c, ctx.lookup, 'Flying', state) && !hasKeyword(c, ctx.lookup, 'Reach', state)) {
          // Not enforced: just warn in the log so odd cases (e.g. effects granting reach) still work.
          log(state, ctx, pid, `Warning: ${cardName(c, ctx.lookup)} blocks a flier without flying or reach.`);
        }
        c.blocking = a.attacker;
      } else c.blocking = undefined;
      return null;
    }
    case 'confirmBlockers': {
      if (state.activePlayer === pid) return 'Only the defending player blocks';
      if (state.strict) {
        if (state.step !== 'blockers' || state.combat.blockersDeclared) return 'Not declaring blockers now';
        const e = blockersError(state, ctx.lookup);
        if (e) return e;
      }
      confirmBlockers(state, ctx, pid);
      if (state.priority === pid && state.step === 'blockers') passPriority(state, ctx, pid);
      return null;
    }
    case 'proposeDamage': {
      state.combat.proposal = computeCombat(state, ctx.lookup);
      return null;
    }
    case 'confirmDamage': {
      if (!state.combat.proposal) return 'No combat damage pending';
      if (state.priority === pid) {
        if (!state.combat.proposal.confirmed.includes(pid)) state.combat.proposal.confirmed.push(pid);
        passPriority(state, ctx, pid);
      } else if (!state.combat.proposal.confirmed.includes(pid)) state.combat.proposal.confirmed.push(pid);
      return null;
    }
    case 'clearCombat': {
      for (const id of state.battlefield) { state.cards[id].attacking = undefined; state.cards[id].blocking = undefined; }
      state.combat.proposal = null;
      log(state, ctx, pid, `${name} clears combat (damage will be handled by hand).`);
      return null;
    }

    // ---------------- meta
    case 'requestUndo': {
      if (!state.history.length) return 'Nothing to undo';
      if (others(state, pid).length === 0) { undo(state, ctx, pid); return null; }
      state.undoRequest = pid;
      log(state, ctx, pid, `${name} asks to undo the last action.`);
      return null;
    }
    case 'answerUndo': {
      if (!state.undoRequest || state.undoRequest === pid) return 'No undo request to answer';
      const requester = state.undoRequest;
      state.undoRequest = null;
      if (a.accept) undo(state, ctx, requester);
      else log(state, ctx, pid, `${name} declines the undo.`);
      return null;
    }
    case 'concede': {
      me.conceded = true;
      const left = state.players.filter((p) => !p.conceded);
      log(state, ctx, pid, `${name} concedes.`);
      if (left.length <= 1) {
        state.phase = 'over';
        state.winner = left[0]?.pid ?? null;
        if (left[0]) log(state, ctx, null, `${left[0].name} wins the game!`);
      }
      return null;
    }
    case 'requestFixMode': {
      if (!state.strict) return 'Manual tools are always available in this game';
      if (state.fixMode?.on) return 'Fix mode is already on';
      if (others(state, pid).length === 0) {
        state.fixMode = { on: true, requestedBy: pid };
        log(state, ctx, pid, `${name} turns on fix mode (manual tools enabled).`);
        return null;
      }
      state.fixMode = { on: false, requestedBy: pid };
      log(state, ctx, pid, `${name} asks to fix the board by hand (fix mode).`);
      return null;
    }
    case 'answerFixMode': {
      const req = state.fixMode?.requestedBy;
      if (!req || state.fixMode?.on || req === pid) return 'No fix-mode request to answer';
      if (a.accept) {
        state.fixMode = { on: true, requestedBy: req };
        log(state, ctx, pid, `${name} accepts: fix mode is on — manual tools are enabled until it is ended.`);
      } else {
        state.fixMode = { on: false, requestedBy: null };
        log(state, ctx, pid, `${name} declines fix mode.`);
      }
      return null;
    }
    case 'endFixMode': {
      if (!state.fixMode?.on && !state.fixMode?.requestedBy) return 'Fix mode is not on';
      state.fixMode = { on: false, requestedBy: null };
      log(state, ctx, pid, `${name} ends fix mode (rules enforced again).`);
      return null;
    }
    case 'chat': {
      const text = a.text.trim().slice(0, 300);
      if (text) log(state, ctx, pid, `${name}: ${text}`);
      return null;
    }
  }
  return 'Unknown action';
}

/** The 'pass' action: finishes a pending combat declaration, then passes priority. */
function doPass(state: GameState, ctx: Ctx, pid: string): string | null {
  if (state.step === 'attackers' && state.activePlayer === pid && !state.combat.attackersDeclared) confirmAttackers(state, ctx);
  if (state.step === 'blockers' && state.activePlayer !== pid && !state.combat.blockersDeclared) {
    const e = state.strict ? blockersError(state, ctx.lookup) : null;
    if (e) return e;
    confirmBlockers(state, ctx, pid);
  }
  if (state.step === 'damage' && state.combat.proposal && !state.combat.proposal.confirmed.includes(pid)) state.combat.proposal.confirmed.push(pid);
  passPriority(state, ctx, pid);
  return null;
}

function confirmAttackers(state: GameState, ctx: Ctx) {
  enforceAttackRequirements(state, ctx); // "attacks each combat if able" (engine/combat-rules.ts)
  const atk = state.battlefield.filter((id) => state.cards[id].attacking);
  for (const id of atk) {
    const c = state.cards[id];
    if (!hasKeyword(c, ctx.lookup, 'Vigilance', state) && !c.tapped) { c.tapped = true; noteTapped(state, id, c.controller); }
  }
  state.combat.attackersDeclared = true;
  for (const id of atk) {
    const target = state.cards[id].attacking!;
    emit(state, { t: 'attacks', iid: id, defender: state.cards[target]?.controller ?? target });
  }
  if (atk.length) emit(state, { t: 'attackersDeclared', pid: state.activePlayer });
  const names = atk.map((id) => cardName(state.cards[id], ctx.lookup));
  log(state, ctx, state.activePlayer, atk.length ? `${player(state, state.activePlayer).name} attacks with ${names.join(', ')}.` : 'No attackers.');
  for (const r of combatReminders(state, ctx.lookup, 'attackers')) log(state, ctx, null, r);
}

function confirmBlockers(state: GameState, ctx: Ctx, pid: string) {
  enforceBlockRestrictions(state, ctx, pid); // menace, "three or more blockers", evasion (engine/combat-rules.ts)
  state.combat.blockersDeclared = true;
  const blocks = state.battlefield.filter((id) => state.cards[id].blocking && state.cards[id].controller === pid);
  for (const b of blocks) emit(state, { t: 'blocks', iid: b, attacker: state.cards[b].blocking! });
  log(state, ctx, pid, blocks.length
    ? `${player(state, pid).name} blocks: ${blocks.map((b) => `${cardName(state.cards[b], ctx.lookup)} → ${cardName(state.cards[state.cards[b].blocking!], ctx.lookup)}`).join(', ')}.`
    : `${player(state, pid).name} doesn't block.`);
  for (const r of combatReminders(state, ctx.lookup, 'blockers')) log(state, ctx, null, r);
}

function undo(state: GameState, ctx: Ctx, pid: string) {
  const prev = state.history.pop();
  if (!prev) return;
  const restored = JSON.parse(prev) as Omit<GameState, 'history' | 'log'>;
  const { log: logs, history } = state;
  Object.assign(state, restored, { log: logs, history, undoRequest: null, seq: state.seq, fixMode: state.fixMode });
  log(state, ctx, pid, `${player(state, pid).name} undid the last action.`);
}

export { PLAYER_ZONES };
