/**
 * Combat requirements the engine enforces automatically when attackers / blockers are confirmed:
 *  - "attacks each combat if able" (MustAttack statics: Goblin Rabblemaster, Dragon's Rage Channeler with delirium,
 *    Ursine Monstrosity's chosen opponent): creatures that can attack and weren't declared are added.
 *  - blocks that break menace / "can't be blocked except by N or more creatures" (Troll of Khazad-dûm) or evasion
 *    are removed (with a log line saying why).
 *  - tokens created "tapped and attacking" join the combat.
 */
import { cardName, faceOf, hasKeyword, isCreature } from '../game/rules.ts';
import { type Ctx, emit, log } from '../game/state.ts';
import type { CardInstance, GameState } from '../game/types.ts';
import { evasionRestriction, illegalBlocks } from './protection.ts';
import { attackRestriction, staticsOfKind } from './statics.ts';
import { matchCard } from './targets.ts';
import { turnInfo } from './durations.ts';

/** "After this phase, there is an additional combat phase" (AddPhase$ ExtraPhase$ Combat). */
export function addExtraCombat(state: GameState) {
  const ti = turnInfo(state);
  ti.activations.extraCombat = (ti.activations.extraCombat ?? 0) + 1;
}

/** Called by the reducer when the end of combat step ends: true = go to another beginning of combat. */
export function takeExtraCombat(state: GameState, ctx: Ctx): boolean {
  const ti = turnInfo(state);
  const n = ti.activations.extraCombat ?? 0;
  if (n <= 0) return false;
  ti.activations.extraCombat = n - 1;
  log(state, ctx, null, 'There is an additional combat phase.');
  return true;
}

/** Creatures that must attack this combat and could, with what they must attack. */
export function mustAttackers(state: GameState, ctx: Ctx): { iid: string; target: string }[] {
  const out: { iid: string; target: string }[] = [];
  const opp = state.players.find((p) => p.pid !== state.activePlayer && !p.conceded)?.pid;
  if (!opp) return out;
  for (const { s, env } of staticsOfKind(state, ctx.lookup, 'MustAttack')) {
    for (const iid of state.battlefield) {
      const c = state.cards[iid];
      if (c.controller !== state.activePlayer || c.tapped || c.attacking || !isCreature(c, ctx.lookup, state)) continue;
      if (c.summoningSick && !hasKeyword(c, ctx.lookup, 'Haste', state)) continue;
      if (!s.params.ValidCreature || matchCard(c, s.params.ValidCreature, env) !== true) continue;
      if (attackRestriction(state, iid, ctx.lookup)) continue;
      let target = opp;
      if (s.params.MustAttack === 'ChosenPlayer') target = state.cards[s.sourceIid]?.chosen?.player ?? opp;
      if (out.some((o) => o.iid === iid)) continue;
      out.push({ iid, target });
    }
  }
  // Goaded creatures (Undercity's Arena) attack each combat if able.
  for (const iid of state.battlefield) {
    const c = state.cards[iid];
    if (c.controller !== state.activePlayer || c.tapped || c.attacking || !c.tempKeywords?.includes('Goaded') || out.some((o) => o.iid === iid)) continue;
    if (!isCreature(c, ctx.lookup, state) || (c.summoningSick && !hasKeyword(c, ctx.lookup, 'Haste', state)) || attackRestriction(state, iid, ctx.lookup)) continue;
    out.push({ iid, target: opp });
  }
  return out;
}

/** Called as attackers are confirmed: creatures that must attack are added. */
export function enforceAttackRequirements(state: GameState, ctx: Ctx) {
  const added: string[] = [];
  for (const { iid, target } of mustAttackers(state, ctx)) {
    state.cards[iid].attacking = target;
    added.push(cardName(state.cards[iid], ctx.lookup));
  }
  if (added.length) log(state, ctx, state.activePlayer, `${added.join(', ')} attack${added.length === 1 ? 's' : ''} (attacks each combat if able).`);
}

/** Called as blockers are confirmed: illegal blocks (menace, minimum blockers, evasion) are removed. */
export function enforceBlockRestrictions(state: GameState, ctx: Ctx, defender: string) {
  for (const iid of state.battlefield) {
    const b = state.cards[iid];
    if (b.controller !== defender || !b.blocking) continue;
    const a = state.cards[b.blocking];
    const why = a ? evasionRestriction(state, b, a, ctx.lookup) : null;
    if (why) { log(state, ctx, defender, `${cardName(b, ctx.lookup)} can't block — ${why}.`); b.blocking = undefined; }
  }
  for (const { blocker, why } of illegalBlocks(state, defender, ctx.lookup)) {
    const b = state.cards[blocker];
    if (!b?.blocking) continue;
    log(state, ctx, defender, `${cardName(b, ctx.lookup)} can't block alone — ${why}.`);
    b.blocking = undefined;
  }
  emitUnblocked(state);
}

/** "Whenever one or more creatures attack you and aren't blocked" (Coveted Jewel): emitted once per combat when blocks are final. */
export function emitUnblocked(state: GameState) {
  const attackers = state.battlefield.filter((iid) => state.cards[iid].attacking);
  if (!attackers.length) return;
  const ti = turnInfo(state);
  const key = `unblocked|${[...attackers].sort().join(',')}`;
  if (ti.activations[key]) return;
  ti.activations[key] = 1;
  const blocked = new Set(state.battlefield.map((iid) => state.cards[iid].blocking).filter(Boolean));
  const byDefender = new Map<string, string[]>();
  for (const iid of attackers) {
    if (blocked.has(iid)) continue;
    const target = state.cards[iid].attacking!;
    const defender = state.cards[target]?.controller ?? target;
    byDefender.set(defender, [...(byDefender.get(defender) ?? []), iid]);
  }
  for (const [defender, list] of byDefender) emit(state, { t: 'unblocked', attackers: list, attackingPlayer: state.activePlayer, defender });
}

/** A token created "tapped and attacking": it attacks what `attackerOf` (or the source) attacks, else the defending player. */
export function enterAttacking(state: GameState, ctx: Ctx, inst: CardInstance, sourceIid: string | undefined) {
  if (!['attackers', 'blockers', 'damage'].includes(state.step) || inst.controller !== state.activePlayer) return;
  const src = sourceIid ? state.cards[sourceIid] : undefined;
  const target = src?.attacking ?? state.players.find((p) => p.pid !== inst.controller && !p.conceded)?.pid;
  if (!target) return;
  inst.attacking = target;
  inst.tapped = true;
  log(state, ctx, inst.controller, `${faceOf(inst, ctx.lookup).name} enters attacking.`);
}
