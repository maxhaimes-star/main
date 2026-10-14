import { basicLandCard, type CardData, type Color, type TokenData } from '../cards.ts';
import type { Rng } from '../draft.ts';
import { computeCombat } from './combat.ts';
import { cardName, effectivePT, faceOf, hasKeyword, isCreature, type Lookup, payFromPool } from './rules.ts';
import { activateAuto, prepareCast } from '../engine/play.ts';
import { answerPending, resolveAuto, resumeAuto } from '../engine/resolve.ts';
import {
  type Ctx, detach, drawCards, log, moveCard, newInstance, player, randomId, shuffleLibrary,
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

export function createGame(id: string, seats: GameSeat[], startingPlayer: string, ctx: Ctx): GameState {
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
  };
  for (const seat of seats) {
    const p: GamePlayer = {
      pid: seat.pid, name: seat.name, life: 20, counters: {},
      zones: { library: [], hand: [], graveyard: [], exile: [], command: [], sideboard: [] },
      manaPool: {}, mulligans: 0, kept: false, needsBottom: 0, landsPlayed: 0,
      stops: { own: [...DEFAULT_STOPS.own], opp: [...DEFAULT_STOPS.opp] },
      passUntilEOT: false, peek: null, viewingHandOf: null, conceded: false, designations: [],
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

const NOT_UNDOABLE = new Set<GameAction['t']>(['chat', 'requestUndo', 'answerUndo', 'setStops', 'lookAtHand', 'peek']);

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
  switch (step) {
    case 'untap': {
      for (const id of state.battlefield) {
        const c = state.cards[id];
        if (c.controller !== state.activePlayer) continue;
        if (!c.noUntap) c.tapped = false;
        c.summoningSick = false;
      }
      // No priority in untap: go straight to upkeep.
      enterStep(state, ctx, 'upkeep');
      return;
    }
    case 'draw': {
      if (state.turn === 1 && state.activePlayer === state.startingPlayer && state.players.length === 2) {
        log(state, ctx, active.pid, `${active.name} skips the first draw.`);
      } else if (drawCards(state, active, 1) === 0) {
        log(state, ctx, active.pid, `${active.name} can't draw — library is empty!`);
      } else {
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
        return c.controller === state.activePlayer && !c.tapped && isCreature(c, ctx.lookup);
      });
      if (!canAttack) { state.combat.attackersDeclared = true; log(state, ctx, null, 'No attackers.'); }
      break;
    }
    case 'blockers': {
      const any = state.battlefield.some((id) => state.cards[id].attacking);
      if (!any) { enterStep(state, ctx, 'endCombat'); return; }
      break;
    }
    case 'damage': {
      const any = state.battlefield.some((id) => state.cards[id].attacking);
      if (!any) { enterStep(state, ctx, 'endCombat'); return; }
      state.combat.proposal = computeCombat(state, ctx.lookup);
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
      if (active.zones.hand.length > 7) log(state, ctx, active.pid, `${active.name} has ${active.zones.hand.length} cards — discard down to 7.`);
      startTurn(state, ctx, nextPlayer(state, state.activePlayer));
      return;
    }
  }
}

function startTurn(state: GameState, ctx: Ctx, pid: string) {
  state.turn++;
  state.activePlayer = pid;
  for (const p of state.players) { p.landsPlayed = 0; p.passUntilEOT = false; }
  log(state, ctx, null, `— Turn ${state.turn}: ${player(state, pid).name} —`);
  enterStep(state, ctx, 'untap');
}

function advanceStep(state: GameState, ctx: Ctx) {
  const i = STEPS.indexOf(state.step);
  enterStep(state, ctx, STEPS[i + 1] ?? 'cleanup');
}

/** Auto-pass for players without a stop, so the game flows like MTGO. */
function settle(state: GameState, ctx: Ctx) {
  for (let guard = 0; guard < 60 && state.phase === 'playing' && !state.pending.length; guard++) {
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
  if (item.auto) {
    const inst = item.iid ? state.cards[item.iid] : undefined;
    resolveAuto(state, ctx, item, !!inst && isPermanentSpell(inst, ctx), () => finishSpell(state, ctx, item, true));
  } else {
    if (!item.iid || !state.cards[item.iid]) state.stack.pop();
    if (item.iid && state.cards[item.iid]) finishSpell(state, ctx, item, false);
    else log(state, ctx, item.controller, `Resolved: ${item.text}`);
  }
  state.passed = [];
  state.priority = state.activePlayer;
}

function applyCombat(state: GameState, ctx: Ctx) {
  const prop = state.combat.proposal!;
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
  const me = state.players.find((p) => p.pid === pid);
  if (!me) return 'You are not playing in this game';
  if (state.phase === 'over' && action.t !== 'chat') return 'The game is over';
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
      if (state.step === 'attackers' && state.activePlayer === pid && !state.combat.attackersDeclared) confirmAttackers(state, ctx);
      if (state.step === 'blockers' && state.activePlayer !== pid && !state.combat.blockersDeclared) confirmBlockers(state, ctx, pid);
      if (state.step === 'damage' && state.combat.proposal && !state.combat.proposal.confirmed.includes(pid)) state.combat.proposal.confirmed.push(pid);
      passPriority(state, ctx, pid);
      return null;
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
      moveCard(state, ctx, a.iid, 'battlefield', { controller: pid });
      me.landsPlayed++;
      log(state, ctx, pid, `${name} plays ${cardName(c, ctx.lookup)}${me.landsPlayed > 1 ? ` (land #${me.landsPlayed} this turn)` : ''}.`);
      return null;
    }
    case 'cast': {
      const c = card(state, a.iid);
      if (!c) return 'No such card';
      if (!canTouch(state, pid, c)) return "You can't cast that card";
      if (c.zone === 'battlefield' || c.zone === 'stack') return 'That card is already in play';
      const prep = prepareCast(state, c, pid, a, ctx);
      if (prep.error) return prep.error;
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
      const cost = data?.layout === 'split' && data.faces && a.face != null ? data.faces[a.face].manaCost : face.manaCost;
      let paid = '';
      if (!a.faceDown && cost) {
        const res = payFromPool(cost, me.manaPool, a.x ?? 0);
        if (res) {
          me.manaPool = res.pool;
          if (res.lifePaid) { me.life -= res.lifePaid; paid = ` (paid ${res.lifePaid} life)`; }
        } else if (Object.values(me.manaPool).some((v) => v > 0)) {
          paid = ' (mana pool did not cover the cost — not deducted)';
        }
      } else if (a.faceDown) {
        const res = payFromPool('{3}', me.manaPool);
        if (res) me.manaPool = res.pool;
      }
      const item: StackItem = { id: randomId(ctx.rng), kind: 'spell', iid: c.iid, controller: pid, text: a.faceDown ? 'Face-down spell' : face.name, x: a.x };
      if (prep.auto) item.auto = prep.auto;
      state.stack.push(item);
      const fromText = from === 'hand' ? '' : ` from ${from === 'library' ? 'the top of their library' : ZONE_LABEL[from]}`;
      const tnames = prep.auto?.targets.flat().map((t) => t.kind === 'player' ? player(state, t.pid).name : t.kind === 'card' ? cardName(state.cards[t.iid], ctx.lookup) : state.stack.find((s) => s.id === t.id)?.text ?? 'a spell') ?? [];
      log(state, ctx, pid, `${name} casts ${a.faceDown ? 'a face-down spell' : face.name}${a.x != null ? ` (X=${a.x})` : ''}${fromText}${tnames.length ? ` targeting ${tnames.join(', ')}` : ''}${paid}.`);
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
      if (a.loyalty != null) {
        c.counters.loyalty = (c.counters.loyalty ?? 0) + a.loyalty;
      }
      const src = cardName(c, ctx.lookup);
      state.stack.push({ id: randomId(ctx.rng), kind: 'ability', sourceIid: c.iid, controller: pid, text: `${src}: ${a.text}` });
      log(state, ctx, pid, `${name} activates ${src}${a.loyalty != null ? ` [${a.loyalty > 0 ? '+' : ''}${a.loyalty}]` : ''}: ${a.text}`);
      if (a.loyalty != null && (c.counters.loyalty ?? 0) <= 0) log(state, ctx, null, `${src} has 0 loyalty.`);
      giveResponse(state, pid);
      return null;
    }
    case 'choose': {
      return answerPending(state, ctx, pid, a.id, a.value);
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
      const [p, t] = effectivePT(c, ctx.lookup);
      log(state, ctx, pid, `${cardName(c, ctx.lookup)} gets ${a.dp >= 0 ? '+' : ''}${a.dp}/${a.dt >= 0 ? '+' : ''}${a.dt}${a.permanent ? '' : ' until end of turn'} (${p}/${t}).`);
      return null;
    }
    case 'damage': {
      const c = card(state, a.iid);
      if (!c) return 'No such card';
      c.damage = Math.max(0, c.damage + a.delta);
      const [, t] = effectivePT(c, ctx.lookup);
      log(state, ctx, pid, `${cardName(c, ctx.lookup)} has ${c.damage} damage${c.damage >= t && t > 0 && !hasKeyword(c, ctx.lookup, 'Indestructible') ? ' (lethal)' : ''}.`);
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
      for (let i = 0; i < n; i++) {
        const inst = newInstance(state, ctx.rng, owner, 'battlefield', undefined, a.token);
        inst.tapped = !!a.tapped;
        inst.summoningSick = true;
        state.battlefield.push(inst.iid);
      }
      log(state, ctx, pid, `${name} creates ${n} ${a.token.name}${a.token.power != null ? ` ${a.token.power}/${a.token.toughness}` : ''} token${n === 1 ? '' : 's'}.`);
      return null;
    }
    case 'copyCard': {
      const src = card(state, a.iid);
      if (!src || !src.cardId) return 'Can only copy a card';
      const face = faceOf(src, ctx.lookup);
      const inst = newInstance(state, ctx.rng, pid, 'battlefield', src.cardId, {
        name: face.name, typeLine: face.typeLine, colors: [], oracle: face.oracle, keywords: face.keywords, power: face.power, toughness: face.toughness,
      });
      inst.summoningSick = true;
      inst.transformed = src.transformed;
      if (face.loyalty) inst.counters.loyalty = parseInt(face.loyalty, 10) || 0;
      state.battlefield.push(inst.iid);
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
        c.attacking = a.target;
      } else c.attacking = undefined;
      return null;
    }
    case 'confirmAttackers': {
      if (state.activePlayer !== pid) return "It's not your turn";
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
        if (hasKeyword(att, ctx.lookup, 'Flying') && !hasKeyword(c, ctx.lookup, 'Flying') && !hasKeyword(c, ctx.lookup, 'Reach')) {
          // Not enforced: just warn in the log so odd cases (e.g. effects granting reach) still work.
          log(state, ctx, pid, `Warning: ${cardName(c, ctx.lookup)} blocks a flier without flying or reach.`);
        }
        c.blocking = a.attacker;
      } else c.blocking = undefined;
      return null;
    }
    case 'confirmBlockers': {
      if (state.activePlayer === pid) return 'Only the defending player blocks';
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
    case 'chat': {
      const text = a.text.trim().slice(0, 300);
      if (text) log(state, ctx, pid, `${name}: ${text}`);
      return null;
    }
  }
  return 'Unknown action';
}

function confirmAttackers(state: GameState, ctx: Ctx) {
  const atk = state.battlefield.filter((id) => state.cards[id].attacking);
  for (const id of atk) {
    const c = state.cards[id];
    if (!hasKeyword(c, ctx.lookup, 'Vigilance')) c.tapped = true;
  }
  state.combat.attackersDeclared = true;
  const names = atk.map((id) => cardName(state.cards[id], ctx.lookup));
  log(state, ctx, state.activePlayer, atk.length ? `${player(state, state.activePlayer).name} attacks with ${names.join(', ')}.` : 'No attackers.');
}

function confirmBlockers(state: GameState, ctx: Ctx, pid: string) {
  state.combat.blockersDeclared = true;
  const blocks = state.battlefield.filter((id) => state.cards[id].blocking && state.cards[id].controller === pid);
  log(state, ctx, pid, blocks.length
    ? `${player(state, pid).name} blocks: ${blocks.map((b) => `${cardName(state.cards[b], ctx.lookup)} → ${cardName(state.cards[state.cards[b].blocking!], ctx.lookup)}`).join(', ')}.`
    : `${player(state, pid).name} doesn't block.`);
}

function undo(state: GameState, ctx: Ctx, pid: string) {
  const prev = state.history.pop();
  if (!prev) return;
  const restored = JSON.parse(prev) as Omit<GameState, 'history' | 'log'>;
  const { log: logs, history } = state;
  Object.assign(state, restored, { log: logs, history, undoRequest: null, seq: state.seq });
  log(state, ctx, pid, `${player(state, pid).name} undid the last action.`);
}

export { PLAYER_ZONES };
