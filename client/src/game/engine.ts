import {
  activatedAbilitiesOf, activeStatics, castOptions, divisionError, effectiveCost, flatten, faceManaCost, isAutomatable, isValidTarget, spellAbility, targetSpecs,
  type ActiveStatic, type CastOption, type GameView, type ParsedAbility, type TargetRef, type TargetSpec,
} from '@ojb/shared';
import { getCard } from '../cards.tsx';

/** The engine is optional on the client: any throw / undefined means "no automation". */
function safe<T>(f: () => T): T | undefined {
  try { return f(); } catch { return undefined; }
}

export const safeSpell = (cardId: string | undefined, face: number) => cardId ? safe(() => spellAbility(cardId, face)) : undefined;
export const safeActivated = (cardId: string | undefined, face: number) => (cardId ? safe(() => activatedAbilitiesOf(cardId, face)) : undefined) ?? [];
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
