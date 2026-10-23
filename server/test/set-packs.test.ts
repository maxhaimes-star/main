import { describe, expect, it } from 'vitest';
import { rareFirst, seededRng } from '@ojb/shared/src/boosters.ts';
import type { BoosterCard } from '@ojb/shared/src/carddb-types.ts';
import { carddbAvailable, getSet } from '../src/carddb.ts';
import { setBooster } from '../src/roomcards.ts';

describe('set packs show rares and mythics first', () => {
  it('rareFirst: mythics, then rares, then the rest in their original order', () => {
    const b = (id: string, rarity: BoosterCard['rarity']): BoosterCard => ({ id, set: 'X', rarity });
    const pack = [b('c1', 'C'), b('u1', 'U'), b('r1', 'R'), b('c2', 'C'), b('m1', 'M'), b('l1', 'L'), b('u2', 'U')];
    expect(rareFirst(pack).map((c) => c.id)).toEqual(['m1', 'r1', 'u1', 'u2', 'c1', 'c2', 'l1']);
  });

  it.skipIf(!carddbAvailable())('set boosters dealt to rooms put the rare/mythic at the top of the pack', () => {
    const rng = seededRng(7);
    const rarity = (id: string) => getSet('DMU')!.cards.find((p) => p[0] === id)?.[1];
    for (let i = 0; i < 30; i++) {
      const { ids } = setBooster('DMU', rng);
      expect('RM').toContain(rarity(ids[0]));
    }
  }, 60_000);
});
