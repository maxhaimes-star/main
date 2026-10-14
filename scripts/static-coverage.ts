/** Stage 3 coverage: how many of the cube's static abilities (S: lines) the engine handles. Used by engine-coverage.ts. */
import { CUBE } from '../shared/src/cube.ts';
import { getScript, parseStatic, staticGaps, staticSupport } from '../shared/src/engine/index.ts';

export function reportStatics() {
  let cardsWith = 0, cardsFull = 0, total = 0;
  const bySupport = { full: 0, partial: 0, none: 0 };
  const modes = new Map<string, { n: number; full: number }>();
  const gaps = new Map<string, number>();
  for (const card of CUBE.cards) {
    const faces = getScript(card.id);
    if (!faces) continue;
    const statics = faces.flatMap((f) => f.statics.map((l) => parseStatic(l, f.svars)));
    if (!statics.length) continue;
    cardsWith++;
    let allFull = true;
    for (const s of statics) {
      total++;
      const sup = staticSupport(s);
      bySupport[sup]++;
      if (sup !== 'full') allFull = false;
      for (const m of s.modes) {
        const e = modes.get(m) ?? { n: 0, full: 0 };
        e.n++;
        if (sup === 'full') e.full++;
        modes.set(m, e);
      }
      for (const g of new Set(staticGaps(s).map((x) => x.split(' ')[0]))) gaps.set(g, (gaps.get(g) ?? 0) + 1);
    }
    if (allFull) cardsFull++;
  }
  console.log('');
  console.log(`Static abilities (S: lines): ${total} on ${cardsWith} cards`);
  console.log(`  fully handled: ${bySupport.full}, partially: ${bySupport.partial}, reminder/unsupported: ${bySupport.none}`);
  console.log(`  cards whose statics are all fully handled: ${cardsFull}/${cardsWith} (${Math.round((100 * cardsFull) / cardsWith)}%)`);
  console.log('Static modes (fully handled / total):');
  for (const [m, e] of [...modes].sort((a, b) => b[1].n - a[1].n)) console.log(`  ${m.padEnd(22)} ${e.full}/${e.n}`);
  console.log('Top static gaps:');
  for (const [g, n] of [...gaps].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${g.padEnd(22)} ${n}`);
}
