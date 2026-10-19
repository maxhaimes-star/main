/**
 * Mechanics of recent sets outside the cube (Standard / set drafts), dispatched from engine/ext.ts:
 *  - Blight N (Lorwyn Eclipsed): "put N -1/-1 counters on a creature you control". As an effect (DB$ Blight,
 *    "each opponent blights 1") each blighting player chooses one of their creatures; as a cost (Blight<N>, in
 *    activated abilities, optional trigger costs and additional casting costs) see costs.ts / paycost.ts / turns.ts.
 */
import { cardName, isCreature } from '../game/rules.ts';
import { type Ctx, emit, log, randomId } from '../game/state.ts';
import type { GameState } from '../game/types.ts';
import { counterAmount } from './replacements.ts';
import type { StepApi } from './ext.ts';
import type { AutoCont, ParsedAbility, Pending } from './types.ts';
import { resumeAuto } from './resolve.ts';

export const SET_APIS = new Set(['Blight']);

// ------------------------------------------------------------------ blight

/** Creatures `pid` could blight. */
export function blightCandidates(state: GameState, ctx: Ctx | { lookup: Ctx['lookup'] }, pid: string): string[] {
  return state.battlefield.filter((iid) => state.cards[iid].controller === pid && isCreature(state.cards[iid], ctx.lookup, state));
}

/** Put `n` -1/-1 counters on `iid` (its controller blights n). */
export function blightOn(state: GameState, ctx: Ctx, iid: string, n: number, why: string) {
  const c = state.cards[iid];
  if (!c || c.zone !== 'battlefield' || n <= 0) return;
  const m = counterAmount(state, ctx, c, '-1/-1', n);
  c.counters['-1/-1'] = (c.counters['-1/-1'] ?? 0) + m;
  if (m > 0) emit(state, { t: 'counterAdded', iid, kind: '-1/-1', n: m });
  const who = state.players.find((p) => p.pid === c.controller)?.name ?? 'Someone';
  log(state, ctx, c.controller, `${who} blights ${n}: ${cardName(c, ctx.lookup)} gets ${m} -1/-1 counter${m === 1 ? '' : 's'} (${why}).`);
}

interface BlightData { kind: 'setmech'; sub: 'blight'; players: string[]; n: number; label: string; cont: AutoCont }

/** Ask the next player in `d.players` which creature to blight (forced choices are made at once). 'wait' when asked. */
function nextBlight(state: GameState, ctx: Ctx, d: BlightData): 'ok' | 'wait' {
  while (d.players.length) {
    const pid = d.players[0];
    const cands = blightCandidates(state, ctx, pid);
    if (cands.length > 1) {
      const pend: Pending = {
        id: randomId(ctx.rng), pid, prompt: `${d.label}: blight ${d.n} — put ${d.n} -1/-1 counter${d.n === 1 ? '' : 's'} on a creature you control`,
        options: cands.map((iid) => ({ value: iid, label: cardName(state.cards[iid], ctx.lookup) })), data: d as unknown as Record<string, unknown>,
      };
      state.pending.push(pend);
      return 'wait';
    }
    d.players.shift();
    if (cands.length === 1) blightOn(state, ctx, cands[0], d.n, d.label);
    else log(state, ctx, pid, `${state.players.find((p) => p.pid === pid)?.name ?? 'Someone'} controls no creature to blight (${d.label}).`);
  }
  return 'ok';
}

// ------------------------------------------------------------------ dispatch (ext.ts)

export function setMechUnsupported(step: ParsedAbility): string | null {
  const p = step.params;
  switch (step.api) {
    case 'Blight':
      if (p.Num && !/^\d+$/.test(p.Num) && !step.svars?.[p.Num]) return 'Blight (Num$)';
      return null;
  }
  return step.api;
}

export function execSetMech(state: GameState, ctx: Ctx, step: ParsedAbility, api: StepApi): 'ok' | 'wait' {
  const p = step.params;
  switch (step.api) {
    case 'Blight': {
      const n = api.amount(p.Num, 1);
      const o = api.objects('You');
      if (n == null || !o) { api.manual(); return 'ok'; }
      // APNAP order of the blighting players.
      const order = state.players.map((x) => x.pid);
      const ai = order.indexOf(state.activePlayer);
      const players = [...new Set(o.players)].sort((a, b) => ((order.indexOf(a) - ai + order.length) % order.length) - ((order.indexOf(b) - ai + order.length) % order.length));
      const d: BlightData = { kind: 'setmech', sub: 'blight', players, n, label: api.sourceName, cont: api.cont() };
      return nextBlight(state, ctx, d);
    }
  }
  api.manual();
  return 'ok';
}

/** Answer a setmech Pending. undefined = not ours. */
export function answerSetMechPending(state: GameState, ctx: Ctx, pend: Pending, value: string): string | null | undefined {
  const d = pend.data as unknown as BlightData;
  if (d?.kind !== 'setmech') return undefined;
  if (d.sub === 'blight') {
    const pid = d.players.shift();
    if (pid && blightCandidates(state, ctx, pid).includes(value)) blightOn(state, ctx, value, d.n, d.label);
    if (nextBlight(state, ctx, d) === 'ok') resumeAuto(state, ctx, d.cont);
  }
  return null;
}
