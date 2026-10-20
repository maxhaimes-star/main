import { BASIC_LANDS, type Color, COLORS } from '@ojb/shared';

/** How many stacked images a basic-land pile shows at most (the count says the rest). */
export const MAX_SHOWN = 4;

export interface BasicStack { color: Color; id: string; name: string; count: number; shown: number }

/** The deck's basic lands as image stacks for the deck view: one per type in use, WUBRG order. */
export function basicStacks(basics: Record<Color, number>): BasicStack[] {
  return COLORS.filter((c) => (basics[c] ?? 0) > 0).map((c) => ({
    color: c,
    id: `basic_${BASIC_LANDS[c].toLowerCase()}`,
    name: BASIC_LANDS[c],
    count: basics[c],
    shown: Math.min(MAX_SHOWN, basics[c]),
  }));
}
