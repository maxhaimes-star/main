/**
 * The monarch and the initiative (with the Undercity dungeon):
 *  - becomeMonarch / takeInitiative: one player at a time; emits a 'monarch' / 'initiative' event (Mode$ BecomeMonarch
 *    triggers: Palace Jailer's return, Custodi Lich).
 *  - At the beginning of the monarch's end step, they draw a card. Combat damage to the monarch / the player with the
 *    initiative: the creature's controller becomes the monarch / takes the initiative.
 *  - Taking the initiative and the initiative holder's upkeep: venture into Undercity. Rooms are triggered abilities
 *    (synthesized lines); with two next rooms the player chooses (Pending). Completing it counts in counters.dungeons.
 * designationTriggers() runs from triggers.ts processTriggers with the action's events.
 */
import { type Ctx, emit, log, randomId } from '../game/state.ts';
import type { GameEvent, GameState } from '../game/types.ts';
import type { AutoInfo, Pending, QueuedTrigger } from './types.ts';

const pname = (state: GameState, pid: string) => state.players.find((p) => p.pid === pid)?.name ?? 'someone';

/** `pid` becomes the monarch. */
export function becomeMonarch(state: GameState, ctx: Ctx, pid: string) {
  const me = state.players.find((p) => p.pid === pid);
  if (!me || me.designations.includes('Monarch')) return;
  for (const pl of state.players) pl.designations = pl.designations.filter((d) => d !== 'Monarch');
  me.designations.push('Monarch');
  log(state, ctx, pid, `${me.name} becomes the monarch.`);
  emit(state, { t: 'monarch', pid } as GameEvent);
}

/** `pid` takes the initiative (and ventures into Undercity). */
export function takeInitiative(state: GameState, ctx: Ctx, pid: string) {
  const me = state.players.find((p) => p.pid === pid);
  if (!me) return;
  for (const pl of state.players) pl.designations = pl.designations.filter((d) => d !== 'Initiative');
  me.designations.push('Initiative');
  log(state, ctx, pid, `${me.name} takes the initiative.`);
  venture(state, ctx, pid);
}

// ------------------------------------------------------------------ Undercity

interface Room { name: string; line: string; next: number[] }

const UNDERCITY: Room[] = [
  { name: 'Secret Entrance', line: 'DB$ ChangeZone | Origin$ Library | Destination$ Hand | ChangeType$ Land.Basic | ChangeNum$ 1 | Shuffle$ True | SpellDescription$ Secret Entrance — Search your library for a basic land card, reveal it, put it into your hand, then shuffle.', next: [1, 2] },
  { name: 'Forge', line: 'DB$ PutCounter | ValidTgts$ Creature | TgtPrompt$ Select target creature | CounterType$ P1P1 | CounterNum$ 2 | SpellDescription$ Forge — Put two +1/+1 counters on target creature.', next: [3, 4] },
  { name: 'Lost Well', line: 'DB$ Scry | ScryNum$ 2 | SpellDescription$ Lost Well — Scry 2.', next: [4, 5] },
  { name: 'Trap!', line: 'DB$ LoseLife | ValidTgts$ Player | TgtPrompt$ Select target player | LifeAmount$ 5 | SpellDescription$ Trap! — Target player loses 5 life.', next: [6] },
  { name: 'Arena', line: 'DB$ Pump | ValidTgts$ Creature | TgtPrompt$ Select target creature | KW$ Goaded | Duration$ UntilYourNextTurn | SpellDescription$ Arena — Goad target creature.', next: [6, 7] },
  { name: 'Stash', line: 'DB$ Token | TokenScript$ c_a_treasure_sac | SpellDescription$ Stash — Create a Treasure token.', next: [7] },
  { name: 'Archives', line: 'DB$ Draw | Defined$ You | NumCards$ 1 | SpellDescription$ Archives — Draw a card.', next: [8] },
  { name: 'Catacombs', line: 'DB$ Token | TokenScript$ b_4_1_skeleton_menace | SpellDescription$ Catacombs — Create a 4/1 black Skeleton creature token with menace.', next: [8] },
  { name: 'Throne of the Dead Three', line: 'DB$ _Throne | SpellDescription$ Throne of the Dead Three — Reveal the top ten cards of your library. Put a creature card from among them onto the battlefield with three +1/+1 counters on it. It gains hexproof until your next turn. Then shuffle.', next: [] },
];

function queueRoom(state: GameState, ctx: Ctx, pid: string, room: number) {
  const r = UNDERCITY[room];
  const auto: AutoInfo = { cardId: '', face: 0, source: 'trigger', index: -1, targets: [], line: r.line, trigger: { mode: 'Venture', player: pid } };
  const q: QueuedTrigger = { id: randomId(ctx.rng), controller: pid, sourceName: 'Undercity', text: `Undercity: ${r.line.split('SpellDescription$ ')[1] ?? r.name}`, auto };
  (state.triggerQueue ??= []).push(q);
}

function enterRoom(state: GameState, ctx: Ctx, pid: string, room: number) {
  const me = state.players.find((p) => p.pid === pid)!;
  log(state, ctx, pid, `${me.name} ventures into Undercity: ${UNDERCITY[room].name}.`);
  queueRoom(state, ctx, pid, room);
  if (UNDERCITY[room].next.length) me.counters.undercity = room + 1;
  else {
    delete me.counters.undercity;
    me.counters.dungeons = (me.counters.dungeons ?? 0) + 1;
    log(state, ctx, pid, `${me.name} completes Undercity.`);
  }
}

/** Venture into Undercity (asks which room when there are two). */
export function venture(state: GameState, ctx: Ctx, pid: string) {
  const me = state.players.find((p) => p.pid === pid);
  if (!me) return;
  const cur = (me.counters.undercity ?? 0) - 1;
  if (cur < 0) { enterRoom(state, ctx, pid, 0); return; }
  const next = UNDERCITY[cur].next;
  if (next.length === 1) { enterRoom(state, ctx, pid, next[0]); return; }
  const pending: Pending = {
    id: randomId(ctx.rng), pid, prompt: `Venture into Undercity — choose the next room (from ${UNDERCITY[cur].name})`,
    options: next.map((n) => ({ value: String(n), label: `${UNDERCITY[n].name}: ${UNDERCITY[n].line.split('— ')[1] ?? ''}` })),
    data: { kind: 'venture', pid } as unknown as Record<string, unknown>,
  };
  state.pending.push(pending);
}

/** Answer the room choice. undefined = not ours. */
export function answerVenture(state: GameState, ctx: Ctx, pend: Pending, value: string): string | null | undefined {
  const d = pend.data as { kind?: string; pid?: string };
  if (d.kind !== 'venture') return undefined;
  enterRoom(state, ctx, pend.pid, parseInt(value, 10));
  return null;
}

// ------------------------------------------------------------------ rules as events happen

/** Monarch / initiative rules for this action's events (called by triggers.ts before trigger detection). */
export function designationTriggers(state: GameState, ctx: Ctx, events: GameEvent[]) {
  const holder = (d: string) => state.players.find((p) => p.designations.includes(d))?.pid;
  for (const ev of events) {
    if (ev.t === 'phase' && ev.step === 'end' && holder('Monarch') === ev.active) {
      const pid = ev.active;
      const auto: AutoInfo = { cardId: '', face: 0, source: 'trigger', index: -1, targets: [], line: 'DB$ Draw | Defined$ You | NumCards$ 1 | SpellDescription$ The monarch draws a card.', trigger: { mode: 'Phase', player: pid } };
      (state.triggerQueue ??= []).push({ id: randomId(ctx.rng), controller: pid, sourceName: 'The monarch', text: 'The monarch: at the beginning of your end step, draw a card.', auto });
    }
    if (ev.t === 'phase' && ev.step === 'upkeep' && holder('Initiative') === ev.active) venture(state, ctx, ev.active);
    if (ev.t === 'damage' && ev.combat && state.players.some((p) => p.pid === ev.target)) {
      const src = state.cards[ev.source] ?? ev.sourceSnap;
      const by = src?.controller;
      if (!by || by === ev.target) continue;
      if (holder('Monarch') === ev.target) becomeMonarch(state, ctx, by);
      if (holder('Initiative') === ev.target) takeInitiative(state, ctx, by);
    }
  }
  void pname;
}
