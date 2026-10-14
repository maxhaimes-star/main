/** Divided damage (DividedAsYouChoose$): validating the caster's division. */
import { flatten } from './script.ts';
import type { ParsedAbility, TargetRef } from './types.ts';

/** The DividedAsYouChoose step's target-spec index and total (undefined total = can't tell). */
function dividedSpec(ab: ParsedAbility, modes: string[] | undefined, x: number): { spec: number; total?: number } | undefined {
  let k = 0;
  for (const step of flatten(ab, modes)) {
    if (!step.params.ValidTgts) continue;
    if (step.params.DividedAsYouChoose) {
      const raw = step.params.DividedAsYouChoose;
      let total: number | undefined;
      if (/^\d+$/.test(raw)) total = parseInt(raw, 10);
      else if (step.svars?.[raw] === 'Count$xPaid') total = x;
      return { spec: k, total };
    }
    k++;
  }
  return undefined;
}

/** Validate a damage division against the chosen targets. */
export function divisionError(ab: ParsedAbility, modes: string[] | undefined, targets: TargetRef[][] | undefined, division: Record<string, number> | undefined, x: number): string | null {
  if (!division) return null;
  const d = dividedSpec(ab, modes, x);
  if (!d) return 'This spell or ability doesn’t divide damage';
  const keys = (targets?.[d.spec] ?? []).map((t) => (t.kind === 'card' ? t.iid : t.kind === 'player' ? t.pid : t.id));
  const given = Object.keys(division);
  if (given.some((k) => !keys.includes(k))) return 'Divide the damage only among the chosen targets';
  if (keys.length > 1 && keys.some((k) => !given.includes(k))) return 'Assign at least 1 damage to each target';
  if (Object.values(division).some((v) => !Number.isInteger(v) || v < 1)) return 'Each target must get at least 1 damage';
  const sum = Object.values(division).reduce((a, b) => a + b, 0);
  if (d.total != null && sum !== d.total) return `The damage must add up to ${d.total} (got ${sum})`;
  return null;
}
