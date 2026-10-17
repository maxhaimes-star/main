import type { Deck } from './room.ts';

/** Elements of `a` left over after removing one occurrence per element of `b`. */
export function multisetDiff(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1);
  return a.filter((x) => {
    const c = counts.get(x) ?? 0;
    if (c > 0) { counts.set(x, c - 1); return false; }
    return true;
  });
}

export const emptyDeck = (): Deck => ({ main: [], side: [], basics: { W: 0, U: 0, B: 0, R: 0, G: 0 }, ready: false });
