import {
  activatedAbilitiesOf, isAutomatable, isValidTarget, spellAbility, targetSpecs,
  type GameView, type ParsedAbility, type TargetRef, type TargetSpec,
} from '@ojb/shared';
import { getCard } from '../cards.tsx';

/** The engine is optional on the client: any throw / undefined means "no automation". */
function safe<T>(f: () => T): T | undefined {
  try { return f(); } catch { return undefined; }
}

export const safeSpell = (cardId: string | undefined, face: number) => cardId ? safe(() => spellAbility(cardId, face)) : undefined;
export const safeActivated = (cardId: string | undefined, face: number) => (cardId ? safe(() => activatedAbilitiesOf(cardId, face)) : undefined) ?? [];
export const safeSpecs = (ab: ParsedAbility): TargetSpec[] => safe(() => targetSpecs(ab)) ?? [];

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
