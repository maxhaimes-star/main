import { describe, expect, it } from 'vitest';
import { basicStacks } from '../src/basics.ts';
import { getCard } from '@ojb/shared/src/cube.ts';

describe('deck view: basic lands as card images', () => {
  it('one stack per basic type with a count, in WUBRG order, empty types left out', () => {
    const s = basicStacks({ W: 0, U: 7, B: 0, R: 1, G: 9 });
    expect(s.map((x) => [x.id, x.count])).toEqual([['basic_island', 7], ['basic_mountain', 1], ['basic_forest', 9]]);
    for (const x of s) expect(getCard(x.id)?.image).toBeTruthy();
  });

  it('shows at most a few stacked images, however many lands there are', () => {
    const [forest] = basicStacks({ W: 0, U: 0, B: 0, R: 0, G: 17 });
    expect(forest.shown).toBe(4);
    expect(basicStacks({ W: 2, U: 0, B: 0, R: 0, G: 0 })[0].shown).toBe(2);
  });
});
