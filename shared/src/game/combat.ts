import type { CombatProposal, GameState } from './types.ts';
import { cardName, effectivePT, faceOf, hasKeyword, type Lookup } from './rules.ts';
import { damagePrevented, modifiedDamage } from '../engine/replacements.ts';
import { lifeGainPrevented } from '../engine/statics.ts';

/**
 * Computes combat damage for the current attackers/blockers, including first strike,
 * double strike, trample, deathtouch, lifelink, infect and indestructible.
 * The result is a proposal that both players confirm (anything the math can't see,
 * like anthems or damage prevention, can be fixed by hand afterwards).
 */
export function computeCombat(state: GameState, lookup: Lookup): CombatProposal {
  const cards = state.cards;
  const attackers = state.battlefield.filter((id) => cards[id].attacking);
  const lifeChange: Record<string, number> = {};
  const poison: Record<string, number> = {};
  const damage: Record<string, number> = {};
  const deathtouched = new Set<string>();
  const lines: string[] = [];
  const hits: { source: string; target: string; amount: number }[] = [];
  const alive = (id: string) => {
    const c = cards[id];
    const [, t] = effectivePT(c, lookup, state);
    if (hasKeyword(c, lookup, 'Indestructible', state)) return t > 0;
    const dmg = c.damage + (damage[id] ?? 0);
    return t > 0 && dmg < t && !deathtouched.has(id);
  };
  const isPW = (id: string) => !!cards[id] && faceOf(cards[id], lookup).types.includes('Planeswalker');
  const addLife = (pid: string, d: number) => { lifeChange[pid] = (lifeChange[pid] ?? 0) + d; };

  const deal = (src: string, target: string, amount: number) => {
    if (amount <= 0) return;
    const s = cards[src];
    const name = cardName(s, lookup);
    // Protection, Maze of Ith ... (engine/replacements.ts); players' "prevent all damage" too.
    const stopped = damagePrevented(state, lookup, target, src, true);
    if (stopped) { lines.push(`${name}'s damage to ${cards[target] ? cardName(cards[target], lookup) : state.players.find((p) => p.pid === target)?.name ?? 'player'} is prevented (${stopped})`); return; }
    amount = modifiedDamage(state, lookup, target, src, amount); // "deals double that damage instead" (Lightning, Army of One)
    hits.push({ source: src, target, amount });
    const infect = hasKeyword(s, lookup, 'Infect', state);
    if (cards[target]) {
      if (infect && !isPW(target)) {
        damage[target] = damage[target] ?? 0;
        lines.push(`${name} puts ${amount} -1/-1 counters on ${cardName(cards[target], lookup)}`);
        damage[target] += amount; // treated as lethal-damage equivalent
      } else {
        damage[target] = (damage[target] ?? 0) + amount;
        lines.push(`${name} deals ${amount} to ${cardName(cards[target], lookup)}`);
      }
      if (hasKeyword(s, lookup, 'Deathtouch', state) && !isPW(target)) deathtouched.add(target);
    } else {
      const pl = state.players.find((p) => p.pid === target);
      if (infect) {
        poison[target] = (poison[target] ?? 0) + amount;
        lines.push(`${name} gives ${pl?.name ?? 'player'} ${amount} poison`);
      } else {
        addLife(target, -amount);
        lines.push(`${name} deals ${amount} to ${pl?.name ?? 'player'}`);
      }
    }
    if (hasKeyword(s, lookup, 'Lifelink', state) && !lifeGainPrevented(state, s.controller, lookup)) addLife(s.controller, amount);
  };

  const blockersOf = (a: string) => state.battlefield.filter((id) => cards[id].blocking === a);

  for (const phase of ['first', 'regular'] as const) {
    // Combat damage in a step is dealt simultaneously: who deals damage (and which blockers are still there) is decided
    // by the damage marked before the step, not by damage assigned earlier in this loop.
    const before = { ...damage };
    const deadBefore = new Set(Object.keys(cards).filter((id) => cards[id].zone === 'battlefield' && (cards[id].attacking || cards[id].blocking) && !alive(id)));
    const standing = (id: string) => !deadBefore.has(id);
    // Damage assigned (not dealt: doublers / prevention don't count, rule 510.1c) to each creature so far in this step.
    const assignedNow: Record<string, number> = {};
    const strikes = (id: string) => {
      const fs = hasKeyword(cards[id], lookup, 'First strike', state);
      const ds = hasKeyword(cards[id], lookup, 'Double strike', state);
      return phase === 'first' ? fs || ds : !fs || ds;
    };
    // Collect all damage for this phase first (simultaneous), then apply.
    for (const a of attackers) {
      const blockers = blockersOf(a);
      const ac = cards[a];
      const target = ac.attacking!;
      if (standing(a) && strikes(a)) {
        const [power] = effectivePT(ac, lookup, state);
        if (blockers.length === 0) {
          deal(a, target, power);
        } else {
          let left = power;
          const dt = hasKeyword(ac, lookup, 'Deathtouch', state);
          const liveBlockers = blockers.filter(standing);
          liveBlockers.forEach((b, i) => {
            const bc = cards[b];
            const [, bt] = effectivePT(bc, lookup, state);
            // Lethal damage (rule 702.19b / 510.1c): damage already marked (as actually dealt, e.g. doubled first-strike
            // damage) plus damage assigned by other creatures this step — ignoring effects that would change the
            // amount dealt (a damage doubler doesn't let an attacker assign less, nor does prevention force more).
            const already = bc.damage + (before[b] ?? 0) + (assignedNow[b] ?? 0);
            const lethal = dt ? (already > 0 && deathtouched.has(b) ? 0 : 1) : Math.max(0, bt - already);
            const isLast = i === liveBlockers.length - 1;
            const trample = hasKeyword(ac, lookup, 'Trample', state);
            const assign = isLast && !trample ? left : Math.min(left, lethal);
            assignedNow[b] = (assignedNow[b] ?? 0) + assign;
            deal(a, b, assign);
            left -= assign;
          });
          if (left > 0 && hasKeyword(ac, lookup, 'Trample', state)) deal(a, target, left);
        }
      }
      for (const b of blockers) {
        if (standing(b) && strikes(b)) deal(b, a, effectivePT(cards[b], lookup, state)[0]);
      }
    }
  }

  const dies = Object.keys(damage).filter((id) => {
    const c = cards[id];
    if (!c) return false;
    if (isPW(id)) return (c.counters['loyalty'] ?? 0) - damage[id] <= 0;
    if (hasKeyword(c, lookup, 'Indestructible', state)) return false;
    const [, t] = effectivePT(c, lookup, state);
    return c.damage + damage[id] >= t || deathtouched.has(id);
  });
  for (const [pid, n] of Object.entries(poison)) lifeChange[`poison:${pid}`] = n;
  if (!lines.length) lines.push('No combat damage.');
  return { lifeChange, damage, dies, lines, confirmed: [], hits };
}
