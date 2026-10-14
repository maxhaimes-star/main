import {
  activatedAbilitiesOf, activeStatics, effectiveCost, faceManaCost, isAutomatable, isValidTarget, spellAbility, targetSpecs,
  type ActiveStatic, type GameView, type ParsedAbility, type TargetRef, type TargetSpec,
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
