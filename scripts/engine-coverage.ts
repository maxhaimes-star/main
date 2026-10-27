/**
 * How much of the cube the card-effects engine automates (spells + activated abilities).
 * Usage: npx tsx scripts/engine-coverage.ts
 */
import { CUBE } from '../shared/src/cube.ts';
import { activatedAbilitiesOf, flatten, getScript, isAutomatable, spellAbility, SUPPORTED_MODES, triggerSupport, type ParsedAbility } from '../shared/src/engine/index.ts';
import { triggersOf } from '../shared/src/engine/script.ts';
import { reportStatics } from './static-coverage.ts';

const count = (ab: ParsedAbility) => {
  let n = 0;
  const visit = (a: ParsedAbility) => { for (const s of flatten(a)) { n++; if (s.choices) s.choices.forEach((c) => visit(c.ability)); } };
  visit(ab);
  return n;
};

let full = 0, partial = 0, none = 0, nothing = 0, missing = 0;
let abFull = 0, abTotal = 0;
const apis = new Map<string, number>();
const partialCards: string[] = [];

for (const card of CUBE.cards) {
  const faces = getScript(card.id);
  if (!faces) { missing++; continue; }
  const chains: ParsedAbility[] = [];
  faces.forEach((_f, i) => {
    const sp = spellAbility(card.id, i);
    if (sp) chains.push(sp.ability);
    for (const a of activatedAbilitiesOf(card.id, i)) chains.push(a.ability);
  });
  if (!chains.length) { nothing++; continue; }
  let ok = 0, some = 0;
  for (const ab of chains) {
    abTotal++;
    const r = isAutomatable(ab);
    for (const u of new Set(r.unsupported.map((x) => x.split(' ')[0]))) apis.set(u, (apis.get(u) ?? 0) + 1);
    if (r.ok) { ok++; abFull++; } else if (r.unsupported.length < count(ab)) some++;
  }
  if (ok === chains.length) full++;
  else if (ok + some > 0) { partial++; partialCards.push(card.name); } else none++;
}

const withChains = full + partial + none;
console.log(`Cube cards: ${CUBE.cards.length} (no Forge script: ${missing})`);
console.log(`Cards without a spell ability or non-mana activated ability (permanents with only triggers/statics): ${nothing}`);
console.log(`Cards with spells/abilities: ${withChains}`);
console.log(`  fully automatable:     ${full} (${Math.round((100 * full) / withChains)}%)`);
console.log(`  partially automatable: ${partial} (${Math.round((100 * partial) / withChains)}%)`);
console.log(`  not automatable:       ${none} (${Math.round((100 * none) / withChains)}%)`);
console.log(`Abilities (spells + activated): ${abFull}/${abTotal} fully automatable`);
console.log('Top unsupported APIs (abilities affected):');
for (const [api, n] of [...apis].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${api.padEnd(22)} ${n}`);

// ------------------------------------------------------------------ Stage 2: triggered abilities
let trTotal = 0, trDetect = 0, trFull = 0, trCards = 0, trCardsFull = 0;
const modes = new Map<string, { n: number; ok: boolean }>();
const reasons = new Map<string, number>();
for (const card of CUBE.cards) {
  const faces = getScript(card.id);
  if (!faces) continue;
  let any = false, all = true;
  faces.forEach((f, face) => f.triggers.forEach((_l, i) => {
    const t = triggersOf(card.id, face)[i];
    any = true;
    trTotal++;
    const m = modes.get(t.params.Mode) ?? { n: 0, ok: SUPPORTED_MODES.has(t.params.Mode) };
    m.n++;
    modes.set(t.params.Mode, m);
    const s = triggerSupport(card.id, face, i);
    if (s.detect) trDetect++;
    if (s.detect && s.chain) trFull++;
    else all = false;
    const why = s.reason ?? '?';
    if (!(s.detect && s.chain)) reasons.set(why, (reasons.get(why) ?? 0) + 1);
  }));
  if (any) { trCards++; if (all) trCardsFull++; }
}
console.log('');
console.log(`Triggered abilities (T: lines): ${trTotal} on ${trCards} cards`);
console.log(`  detected automatically:              ${trDetect} (${Math.round((100 * trDetect) / trTotal)}%)`);
console.log(`  detected + Execute chain automatable: ${trFull} (${Math.round((100 * trFull) / trTotal)}%)`);
console.log(`  cards whose triggers are all fully automatic: ${trCardsFull}/${trCards}`);
console.log(`Trigger modes (supported ✓): ${[...modes].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `${k}${v.ok ? '✓' : ''}:${v.n}`).join('  ')}`);
console.log('Why triggers are not fully automatic:');
for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`  ${r.padEnd(32)} ${n}`);

reportStatics();
