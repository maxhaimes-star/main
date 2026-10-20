import { describe, expect, it } from 'vitest';
import { fitBoard, fitRow, splitLines, TAPPED_UNITS, VISIBLE, type RowSpec, type Slot } from '../src/game/boardLayout.ts';

const gaps = { x: 8, y: 6 };
const slots = (n: number, tappedEvery = 0, att = 0): Slot[] => Array.from({ length: n }, (_, i) => ({ units: tappedEvery && i % tappedEvery === 0 ? TAPPED_UNITS : 1, attachments: i === 0 ? att : 0 }));
const spec = (s: Slot[], min = 56, max = 150, reserve = 0): RowSpec => ({ slots: s, min, max, reserve });

/** Every line of the fit fits the box, and overlapped cards keep their visible part. */
function checkFits(W: number, H: number, sp: RowSpec) {
  const f = fitRow(W, H, sp, gaps);
  expect(f.width).toBeLessThanOrEqual(W + 0.01);
  expect(f.height).toBeLessThanOrEqual(H + 0.01);
  expect(f.cw).toBeLessThanOrEqual(sp.max);
  if (f.overlap) expect(f.overlap).toBeLessThanOrEqual(f.cw * (1 - VISIBLE) + 0.11);
  expect(f.lines.flat()).toEqual(sp.slots.map((_, i) => i));
  return f;
}

describe('battlefield row fit', () => {
  it('splits slots into balanced consecutive lines', () => {
    expect(splitLines(5, 2)).toEqual([[0, 1, 2], [3, 4]]);
    expect(splitLines(3, 5)).toEqual([[0], [1], [2]]);
  });

  it('a few cards: one line, as large as the height allows (up to the max)', () => {
    const f = checkFits(1000, 200, spec(slots(3)));
    expect(f.lines.length).toBe(1);
    expect(f.overlap).toBe(0);
    expect(f.cw).toBeCloseTo(200 / (88 / 63), 0);
    expect(checkFits(1000, 1000, spec(slots(3))).cw).toBe(150);
  });

  it('scales down first, then overlaps, then wraps', () => {
    // 10 cards in 700px: about 62px each, still above the minimum, so no overlap
    const a = checkFits(700, 160, spec(slots(10)));
    expect(a.lines.length).toBe(1);
    expect(a.overlap).toBe(0);
    expect(a.cw).toBeGreaterThanOrEqual(56);
    // 14 cards: below the minimum without overlap -> overlap at the minimum, one line
    const b = checkFits(700, 160, spec(slots(14)));
    expect(b.lines.length).toBe(1);
    expect(b.cw).toBe(56);
    expect(b.overlap).toBeGreaterThan(0);
    // 30 cards: half-covered cards are not enough on one line -> two lines (the height allows it), overlapping
    const c = checkFits(480, 170, spec(slots(30)));
    expect(c.lines.length).toBe(2);
    expect(c.cw).toBe(56);
    expect(c.overlap).toBeLessThanOrEqual(28);
    // no room for that either: the best layout that fits, whole cards rather than mostly covered ones
    const d = checkFits(400, 170, spec(slots(30)));
    expect(d.lines.length).toBeGreaterThan(1);
  });

  it('goes below the minimum only when nothing else fits', () => {
    const f = checkFits(300, 60, spec(slots(40)));
    expect(f.cw).toBeLessThan(56);
    expect(f.cw).toBeGreaterThan(0);
  });

  it('accounts for tapped cards, attachments and the combat reserve', () => {
    for (const [W, H] of [[400, 120], [900, 300], [250, 90], [1600, 500]]) {
      for (const n of [1, 5, 15, 25, 40]) {
        checkFits(W, H, spec(slots(n, 3, 2), 30, 150, 0.17));
        checkFits(W, H, spec(slots(n, 2), 24, 62));
      }
    }
  });
});

describe('battlefield board fit', () => {
  const board = (c: number, o: number, l: number) => ({
    front: spec(slots(c), 56, 150, 0.17), others: spec(slots(o), 44, 120), lands: spec(slots(l, 4), 44, 120), gaps, bandGap: 4, groupGap: 18,
  });
  it('both bands and both back groups fit the box', () => {
    for (const [W, H] of [[700, 250], [1300, 400], [330, 180], [600, 120]]) {
      for (const [c, o, l] of [[0, 0, 1], [6, 3, 6], [11, 4, 10], [18, 6, 16], [0, 10, 0], [20, 0, 0]]) {
        const f = fitBoard(W, H, board(c, o, l));
        expect(f.frontHeight + f.backHeight).toBeLessThanOrEqual(H);
        expect(f.front.height).toBeLessThanOrEqual(f.frontHeight + 0.01);
        expect(f.others.height).toBeLessThanOrEqual(f.backHeight + 0.01);
        expect(f.lands.height).toBeLessThanOrEqual(f.backHeight + 0.01);
        expect(f.front.width).toBeLessThanOrEqual(W);
        expect(f.others.width).toBeLessThanOrEqual(f.othersWidth + 0.01);
        expect(f.lands.width).toBeLessThanOrEqual(f.landsWidth + 0.01);
        expect(f.othersWidth + f.landsWidth).toBeLessThanOrEqual(W);
      }
    }
  });
});
