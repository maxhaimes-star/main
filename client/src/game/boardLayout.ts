// Battlefield sizing: how big the cards of each battlefield row are, and how they are laid out, so that every card is
// always whole and inside its board, whatever the number of cards and the screen size.
//
// A board has a front band (creatures) and a back band (other permanents on the left, lands on the right). For each row:
//   1. one line, cards as large as fit (between the row's min and max width);
//   2. at the minimum width: the cards of the line overlap, each keeping at least OVERLAP_VISIBLE of its width uncovered;
//   3. then the row wraps onto more lines, and steps 1-2 repeat;
//   4. when even that does not fit: the largest size that fits with more overlap (VISIBLE uncovered), below the
//      minimum if need be.
// Pure functions (no DOM), so they are unit-tested.

/** Card height / width. */
export const RATIO = 88 / 63;
/** How far each attached card (aura, equipment) peeks out above its permanent, as a fraction of the card width. */
export const ATTACH_PEEK = 0.18;
/** How far attackers / blockers step toward the opponent, as a fraction of the card width (styles.css uses the same). */
export const COMBAT_SHIFT = 0.17;
/** Uncovered part of an overlapped card before the row wraps instead, as a fraction of its width. */
export const OVERLAP_VISIBLE = 0.5;
/** Smallest uncovered part of an overlapped card (last resort), as a fraction of its width: it stays clickable. */
export const VISIBLE = 0.3;
/** Width of a tapped card's slot (a rotated card is RATIO wide), in card widths. */
export const TAPPED_UNITS = 1.4;
/** Width of a stack of identical basic lands (the layers behind it show on the right), in card widths. */
export const STACK_UNITS = 1.12;

/** One slot of a row: a permanent (with its attachments) or a stack of identical basic lands. */
export interface Slot { units: number; attachments: number }

export interface RowSpec {
  slots: Slot[];
  /** Card width bounds in px. */
  min: number;
  max: number;
  /** Extra room per line on the opponent's side (combat shift), as a fraction of the card width. */
  reserve: number;
}

export interface Gaps { x: number; y: number }

export interface RowFit {
  /** Card width in px. */
  cw: number;
  /** Slot indices of each line, in order. */
  lines: number[][];
  /** How much each slot overlaps the previous one in its line, in px (no gap then); 0 = no overlap, slots gaps.x apart. */
  overlap: number;
  /** Size of the laid-out row in px. */
  width: number;
  height: number;
}

const EMPTY: RowFit = { cw: 0, lines: [], overlap: 0, width: 0, height: 0 };

/** n slots in L consecutive, balanced lines. */
export function splitLines(n: number, L: number): number[][] {
  const out: number[][] = [];
  let i = 0;
  for (let l = 0; l < L; l++) {
    const k = Math.floor(n / L) + (l < n % L ? 1 : 0);
    out.push(Array.from({ length: k }, () => i++));
  }
  return out.filter((x) => x.length);
}

interface LineInfo { units: number; count: number; heightUnits: number }

function lineInfo(spec: RowSpec, lines: number[][]): LineInfo[] {
  return lines.map((ix) => {
    let units = 0, att = 0;
    for (const i of ix) { units += spec.slots[i].units; att = Math.max(att, spec.slots[i].attachments); }
    return { units, count: ix.length, heightUnits: RATIO + ATTACH_PEEK * att + spec.reserve };
  });
}

/** Largest card width for these lines by height. */
const byHeight = (info: LineInfo[], H: number, g: Gaps) => (H - (info.length - 1) * g.y) / info.reduce((a, l) => a + l.heightUnits, 0);
/** Largest card width for these lines by width, without overlap. */
const byWidth = (info: LineInfo[], W: number, g: Gaps) => Math.min(...info.map((l) => (W - (l.count - 1) * g.x) / l.units));
/** Largest card width for these lines by width, with the most overlap allowed. */
const byWidthOverlapped = (info: LineInfo[], W: number, visible: number) => Math.min(...info.map((l) => W / Math.max(l.units - (l.count - 1) * (1 - visible), 1)));

function result(spec: RowSpec, lines: number[][], cw: number, W: number, g: Gaps): RowFit {
  cw = Math.max(1, Math.floor(cw * 10) / 10);
  const info = lineInfo(spec, lines);
  // A line that does not fit with gaps overlaps instead: no gap, each slot pulled left by `overlap` over the previous one.
  // The overlap is the same for every line: what the widest line needs.
  let overlap = 0;
  for (const l of info) {
    if (l.count > 1 && l.units * cw + (l.count - 1) * g.x > W) overlap = Math.max(overlap, 0.1, (l.units * cw - W) / (l.count - 1));
  }
  overlap = Math.ceil(overlap * 10) / 10;
  const lineWidth = (l: LineInfo) => l.units * cw + (l.count - 1) * (overlap ? -overlap : g.x);
  const height = info.reduce((a, l) => a + l.heightUnits * cw, 0) + (info.length - 1) * g.y;
  return { cw, lines, overlap, width: Math.max(...info.map(lineWidth)), height };
}

/** Lay out one row in a W×H box (px). */
export function fitRow(W: number, H: number, spec: RowSpec, g: Gaps): RowFit {
  const n = spec.slots.length;
  if (!n) return EMPTY;
  if (W <= 0 || H <= 0) return result(spec, [spec.slots.map((_, i) => i)], spec.min, Math.max(W, 0), g);
  for (let L = 1; L <= n; L++) {
    const lines = splitLines(n, L);
    const info = lineInfo(spec, lines);
    const h = byHeight(info, H, g);
    if (h < spec.min && L > 1) break; // more lines only make the cards smaller
    // 1. scale down
    const cw = Math.min(spec.max, h, byWidth(info, W, g));
    if (cw >= spec.min) return result(spec, lines, cw, W, g);
    // 2. overlap, at the minimum width
    if (h >= spec.min && byWidthOverlapped(info, W, OVERLAP_VISIBLE) >= spec.min) return result(spec, lines, spec.min, W, g);
    // 3. wrap
  }
  // 4. the best layout that fits with more overlap, below the minimum if need be
  let best: RowFit | null = null;
  for (let L = 1; L <= n; L++) {
    const lines = splitLines(n, L);
    const info = lineInfo(spec, lines);
    const cw = Math.min(spec.max, byHeight(info, H, g), byWidthOverlapped(info, W, VISIBLE));
    if (cw <= 0) continue;
    const f = result(spec, lines, cw, W, g);
    if (!best || quality(f) > quality(best)) best = f;
  }
  return best ?? result(spec, [spec.slots.map((_, i) => i)], 1, W, g);
}

/** How good a row's layout is: its card width, less the more its cards are covered by their neighbours. */
function quality(f: RowFit): number {
  if (!f.lines.length) return Infinity;
  const visible = f.overlap ? Math.max(0, f.cw - f.overlap) / f.cw : 1;
  return f.cw * (0.3 + 0.7 * visible);
}

export interface BoardSpec {
  front: RowSpec;
  others: RowSpec;
  lands: RowSpec;
  gaps: Gaps;
  /** Gap between the two bands, and between others and lands. */
  bandGap: number;
  groupGap: number;
}

export interface BoardFit {
  frontHeight: number;
  backHeight: number;
  othersWidth: number;
  landsWidth: number;
  front: RowFit;
  others: RowFit;
  lands: RowFit;
}

/** Split the back band's width between other permanents and lands so their cards come out about the same size. */
function fitBack(W: number, H: number, s: BoardSpec): { others: RowFit; lands: RowFit; othersWidth: number; landsWidth: number } {
  const o = s.others.slots.length, l = s.lands.slots.length;
  if (!o || !l) {
    return { others: fitRow(o ? W : 0, H, s.others, s.gaps), lands: fitRow(l ? W : 0, H, s.lands, s.gaps), othersWidth: o ? W : 0, landsWidth: l ? W : 0 };
  }
  const avail = W - s.groupGap;
  let lo = 0.12, hi = 0.88;
  let best: ReturnType<typeof fitBack> | null = null, bestQ = -1;
  for (let i = 0; i < 14; i++) {
    const f = (lo + hi) / 2;
    const ow = Math.floor(avail * f), lw = Math.floor(avail - ow);
    const others = fitRow(ow, H, s.others, s.gaps), lands = fitRow(lw, H, s.lands, s.gaps);
    const q = Math.min(quality(others), quality(lands));
    if (q > bestQ) { bestQ = q; best = { others, lands, othersWidth: ow, landsWidth: lw }; }
    if (quality(others) < quality(lands)) lo = f; else hi = f;
  }
  return best!;
}

/** Lay out a whole board in a W×H box (px). */
export function fitBoard(W: number, H: number, s: BoardSpec): BoardFit {
  W = Math.max(0, Math.floor(W) - 1);
  H = Math.max(0, Math.floor(H) - 1);
  const hasFront = s.front.slots.length > 0, hasBack = s.others.slots.length + s.lands.slots.length > 0;
  if (!hasFront || !hasBack) {
    const back = fitBack(W, hasBack ? H : 0, s);
    return { frontHeight: hasFront ? H : 0, backHeight: hasBack ? H : 0, front: fitRow(W, hasFront ? H : 0, s.front, s.gaps), ...back };
  }
  // Split the height: creatures nominally get cards 1/0.8 the size of the back band's; try splits, keep the best.
  const avail = H - s.bandGap;
  let best: BoardFit | null = null, bestQ = -1, bestSum = -1;
  for (let f = 0.25; f <= 0.751; f += 0.025) {
    const fh = Math.floor(avail * f), bh = Math.floor(avail - fh);
    const front = fitRow(W, fh, s.front, s.gaps);
    const back = fitBack(W, bh, s);
    const qb = Math.min(quality(back.others), quality(back.lands));
    const q = Math.min(quality(front), qb / 0.8);
    const sum = quality(front) + qb;
    if (q > bestQ + 0.01 || (Math.abs(q - bestQ) <= 0.01 && sum > bestSum)) { bestQ = q; bestSum = sum; best = { frontHeight: fh, backHeight: bh, front, ...back }; }
  }
  return best!;
}
