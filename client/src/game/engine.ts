import {
  abilitiesOfInstance, activatedAbilitiesOf, activeStatics, castOptions, divisionError, effectiveCost, flatten, faceManaCost, isAutomatable, isValidTarget, spellAbility, targetSpecs,
  type ActiveStatic, type CastOption, type GameView, type ParsedAbility, type TargetRef, type TargetSpec, type ViewCard,
} from '@ojb/shared';
import * as Shared from '@ojb/shared';
import { faceOf } from '@ojb/shared';
import { getCard } from '../cards.tsx';

/** The engine is optional on the client: any throw / undefined means "no automation". */
function safe<T>(f: () => T): T | undefined {
  try { return f(); } catch { return undefined; }
}

/** What a click on a card in my hand does (engine/strict.ts handClick); 'menu' when the engine can't tell. */
export const safeHandClick = (g: GameView, me: string, iid: string) => safe(() => Shared.handClick(g, me, iid, getCard)) ?? 'menu';
export const safeSpell = (cardId: string | undefined, face: number) => cardId ? safe(() => spellAbility(cardId, face)) : undefined;
export const safeActivated = (cardId: string | undefined, face: number) => (cardId ? safe(() => activatedAbilitiesOf(cardId, face)) : undefined) ?? [];
/** Activated abilities of a permanent now: script + animate grants + abilities other cards grant it (indexes >= GRANT_BASE / FOREIGN_BASE). */
export const safeAbilities = (g: GameView, c: { iid: string; cardId?: string; transformed?: boolean }): ReturnType<typeof safeActivated> =>
  safe(() => abilitiesOfInstance(c as never, g as never, getCard)) ?? safeActivated(c.cardId, c.transformed ? 1 : 0);
export const safeSpecs = (ab: ParsedAbility, modes?: string[]): TargetSpec[] => safe(() => targetSpecs(ab, modes)) ?? [];

export function chainLength(ab: ParsedAbility): number {
  let n = 0;
  for (let a: ParsedAbility | undefined = ab; a; a = a.sub) n++;
  return n;
}

/** 'auto' = fully automatic, 'partial' = some steps automated, null = nothing. */
export function autoStatus(ab: ParsedAbility | undefined): 'auto' | 'partial' | null {
  if (!ab) return null;
  const r = safe(() => isAutomatable(ab));
  if (!r) return null;
  if (r.ok) return 'auto';
  return r.unsupported.length < chainLength(ab) ? 'partial' : null;
}

export const AUTO_LABEL = { auto: '⚡ automatic', partial: '⚡ partly automatic' } as const;

export function castStatus(cardId: string | undefined, face: number) {
  return autoStatus(safeSpell(cardId, face)?.ability);
}

export function legalTarget(g: GameView, spec: TargetSpec, ref: TargetRef, controller: string, sourceIid: string | undefined): boolean {
  return !!safe(() => isValidTarget(g as never, spec, ref, controller, sourceIid, getCard));
}

export const safeStatics = (g: GameView): ActiveStatic[] => safe(() => activeStatics(g as never, getCard)) ?? [];

/** Cost note like "Cost: {1}{U} (+{1} Thalia)" when statics change the printed cost; undefined otherwise. */
export function costNote(g: GameView, iid: string, face: number, me: string | null): string | undefined {
  return safe(() => {
    const c = g.cards[iid];
    if (!c || !me || 'hidden' in c && (c as never as { hidden?: boolean }).hidden) return undefined;
    const printed = faceManaCost(c as never, face, getCard);
    const eff = effectiveCost(g as never, iid, face, getCard, me);
    if (!printed || !eff || eff === printed) return undefined;
    const names = [...new Set(activeStatics(g as never, getCard)
      .filter((s) => /cost/i.test(s.mode))
      .map((s) => { const sc = g.cards[s.sourceIid]; return sc && !(sc as never as { hidden?: boolean }).hidden ? (getCard((sc as never as { cardId?: string }).cardId ?? '')?.name ?? '') : ''; })
      .filter(Boolean))];
    return `Cost: ${eff} (printed ${printed}${names.length ? '; ' + names.join(', ') : ''})`;
  });
}

export function safeCastOptions(g: GameView, iid: string, face?: number): CastOption[] {
  return safe(() => castOptions(g as never, iid, face, getCard)) ?? [];
}

/** One-line description of a cast option: "Alt: <label> {cost}, extra; extra". */
export function optionText(o: CastOption): string {
  return [o.cost, ...o.extra].filter(Boolean).join(' + ') || 'free';
}

/** For DividedAsYouChoose$ abilities: which target spec is divided and the total (undefined = unknown). */
export function dividedInfo(ab: ParsedAbility, modes: string[] | undefined, x: number): { spec: number; total?: number } | undefined {
  return safe(() => {
    let k = 0;
    for (const step of flatten(ab, modes)) {
      if (!step.params.ValidTgts) continue;
      const raw = step.params.DividedAsYouChoose;
      if (raw) {
        let total: number | undefined;
        if (/^\d+$/.test(raw)) total = parseInt(raw, 10);
        else if (step.svars?.[raw] === 'Count$xPaid') total = x;
        return { spec: k, total };
      }
      k++;
    }
    return undefined;
  });
}

export const safeDivisionError = (ab: ParsedAbility, modes: string[] | undefined, targets: TargetRef[][], division: Record<string, number>, x: number): string | null =>
  safe(() => divisionError(ab, modes, targets, division, x)) ?? null;

// ------------------------------------------------------------ strict mode (engine contract: /tmp/claude-0/strict-contract.md)
// Everything below is defensive: the engine exports may not exist yet, in which case nothing is shown or restricted.

const shared = Shared as unknown as Record<string, ((...args: never[]) => unknown) | undefined>;
const loose = (g: GameView) => g as unknown as { strict?: boolean; fixMode?: { on: boolean; requestedBy: string | null } };

export const isStrict = (g: GameView) => loose(g).strict === true;
export const fixModeOn = (g: GameView) => !!loose(g).fixMode?.on;
/** Manual tools (free moves, tap toggles, counters, life, ...) are available when not strict or while fix mode is on. */
export const manualOk = (g: GameView) => !isStrict(g) || fixModeOn(g);
/** Player who asked to fix the board and is waiting for an answer, if any. */
export const fixRequest = (g: GameView) => { const f = loose(g).fixMode; return f && !f.on && f.requestedBy ? f.requestedBy : null; };

export interface Usable { ok: boolean; reason?: string }

/** Can this card be cast / played now? undefined = unknown (not strict, or the engine has no castability yet). */
export function castability(g: GameView, pid: string | null, iid: string, face?: number): Usable | undefined {
  const fn = shared.castability;
  if (!pid || !fn || !isStrict(g)) return undefined;
  return safe(() => (fn as unknown as (...a: unknown[]) => Usable)(g, pid, iid, getCard, face));
}

export function landPlaysLeft(g: GameView, pid: string | null): number | undefined {
  const fn = shared.landPlaysLeft;
  if (!pid || !fn || !isStrict(g)) return undefined;
  return safe(() => (fn as unknown as (...a: unknown[]) => number)(g, pid));
}

/** Instance ids of the sources auto-pay would tap for this cast. */
export function autoPayPreview(g: GameView, pid: string | null, iid: string, face?: number): { ok: boolean; taps: string[]; reason?: string } | undefined {
  const fn = shared.autoPayPreview;
  if (!pid || !fn || !isStrict(g)) return undefined;
  const r = safe(() => (fn as unknown as (...a: unknown[]) => { ok: boolean; taps: { iid: string }[]; reason?: string })(g, pid, iid, face, undefined, undefined, getCard));
  return r ? { ok: r.ok, taps: (r.taps ?? []).map((t) => t.iid), reason: r.reason } : undefined;
}

/**
 * Phyrexian mana choice for a cast (strict): how auto-pay would pay with mana first vs. with life. undefined = the
 * cost has no Phyrexian symbols (or not strict). Each entry: can it be paid that way, and the life it would cost.
 */
export function phyrexianChoice(g: GameView, pid: string | null, iid: string, face?: number, costOption?: string, x?: number):
  { mana: { ok: boolean; life: number }; life: { ok: boolean; life: number } } | undefined {
  const fn = shared.autoPayPreview;
  if (!pid || !fn || !isStrict(g)) return undefined;
  type Pv = { ok: boolean; life?: number; phyrexian?: boolean };
  const run = (how: 'mana' | 'life') => safe(() => (fn as unknown as (...a: unknown[]) => Pv)(g, pid, iid, face, costOption, x, getCard, how));
  const m = run('mana');
  if (!m?.phyrexian) return undefined;
  const l = run('life');
  return { mana: { ok: m.ok, life: m.life ?? 0 }, life: { ok: !!l?.ok, life: l?.life ?? 0 } };
}

/**
 * Show the summoning-sick badge / styling: only creatures (a face-down permanent counts). Lands and other noncreature
 * permanents never look summoning sick, even though the engine tracks the flag for every permanent (manlands, Mutavault).
 */
export function showsSummoningSick(g: GameView | null, c: ViewCard): boolean {
  if (Shared.isHidden(c) || !c.summoningSick || c.zone !== 'battlefield') return false;
  if (c.faceDown) return true;
  return !!safe(() => (g ? Shared.isCreature(c as never, getCard, g as never) : faceOf(c as never, getCard).types.includes('Creature')));
}

/** A creature that cannot attack this turn because of summoning sickness (no haste). */
export function summoningSickNoHaste(g: GameView, iid: string): boolean {
  const c = g.cards[iid] as never as { summoningSick?: boolean; tempKeywords?: string[] } | undefined;
  if (!c || !c.summoningSick) return false;
  return !safe(() => (c.tempKeywords ?? []).includes('Haste') || faceOf(c as never, getCard).keywords.includes('Haste'));
}

/** Revealed cards of a pending question (e.g. Duress shows the hand): iids, whatever shape the engine uses. */
export function pendingRevealed(p: unknown): string[] {
  const r = (p as { revealed?: unknown }).revealed;
  if (!Array.isArray(r)) return [];
  return r.map((x) => (typeof x === 'string' ? x : (x as { iid?: string })?.iid)).filter((x): x is string => !!x);
}

// ------------------------------------------------------------ legality up front (strict): hide / disable what the engine would refuse

/** Can I activate ability `index` (as in safeAbilities / safeActivated) of this card now? undefined = unknown (not strict). */
export function abilityUsable(g: GameView, pid: string | null, iid: string, index: number): Usable | undefined {
  const fn = shared.abilityUsability;
  if (!pid || !fn || !isStrict(g) || fixModeOn(g)) return undefined;
  return safe(() => (fn as unknown as (...a: unknown[]) => Usable)(g, pid, iid, index, getCard));
}

/** Why this creature can't attack `target` (a player or planeswalker) now; null = it can (or unknown). */
export function attackProblem(g: GameView, pid: string | null, iid: string, target: string): string | null {
  const fn = shared.attackError;
  if (!pid || !fn || !isStrict(g) || fixModeOn(g)) return null;
  const e = safe(() => (fn as unknown as (...a: unknown[]) => string | null)(g, pid, iid, target, getCard));
  if (e) return e;
  const r = shared.attackRestriction;
  return (r && safe(() => (r as unknown as (...a: unknown[]) => string | null)(g, iid, getCard))) || null;
}

/**
 * "Attack with all": my untapped creatures, not yet attacking, that can legally attack `opp` now
 * (no summoning sickness without haste, attackProblem null). Only while I'm declaring attackers.
 */
export function attackAllCandidates(g: GameView, me: string | null, opp: string): string[] {
  if (!me || g.phase !== 'playing' || g.step !== 'attackers' || g.activePlayer !== me || g.combat.attackersDeclared) return [];
  return g.battlefield.filter((iid) => {
    const c = g.cards[iid];
    if (!c || c.controller !== me || c.attacking || c.tapped || Shared.isHidden(c)) return false;
    const creature = c.faceDown || !!safe(() => Shared.isCreature(c as never, getCard, g as never));
    return creature && !summoningSickNoHaste(g, iid) && !attackProblem(g, me, iid, opp);
  });
}

/** Why `blocker` can't block `attacker` now; null = it can (or unknown). */
export function blockProblem(g: GameView, blocker: string, attacker: string): string | null {
  const fn = shared.blockError;
  if (!fn || !isStrict(g) || fixModeOn(g)) return null;
  const e = safe(() => (fn as unknown as (...a: unknown[]) => string | null)(g, blocker, attacker, getCard));
  if (e) return e;
  const r = shared.blockRestriction;
  return (r && safe(() => (r as unknown as (...a: unknown[]) => string | null)(g, blocker, attacker, getCard))) || null;
}
