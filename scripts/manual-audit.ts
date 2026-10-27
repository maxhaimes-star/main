/**
 * Which cube cards still need a manual fallback anywhere (spell / activated abilities, triggers, statics,
 * replacement effects, keywords, costs), card by card.
 *
 *   npx tsx scripts/manual-audit.ts            summary + top gap kinds
 *   npx tsx scripts/manual-audit.ts --cards    every card with its gaps
 */
import { CUBE } from '../shared/src/cube.ts';
import {
  activatedAbilitiesOf, getScript, isAutomatable, keywordGap, parseCost, parseStatic, replacementGap, spellAbility, staticGaps, triggerSupport,
} from '../shared/src/engine/index.ts';
import { isUniqueCost } from '../shared/src/engine/turns.ts';
import { parseAbility } from '../shared/src/engine/script.ts';

/** Activated-ability cost tokens the engine pays (play.ts + turns.ts). */
function costTokenGap(tok: string): string | null {
  if (/^(\d+|[WUBRGCSX]|[WUBRG2]\/[WUBRGP]|[WUBRG]{2})$/.test(tok) || tok === 'T' || tok === 'Q') return null;
  if (/^PayLife<(\d+|X)>$/.test(tok) || /^(Sac|Exile|ExileFromGrave|Discard)<1\/(CARDNAME|Self|NICKNAME)>$/.test(tok)) return null;
  if (/^(Add|Sub)Counter<(\d+|X)\/[A-Za-z0-9]+>$/.test(tok) || isUniqueCost(tok)) return null;
  if (/^XMin\d+$/.test(tok) || /^Waterbend<\d+>$/.test(tok)) return null;
  return `cost ${tok.replace(/<.*/, '')}`;
}

const rows: { name: string; gaps: string[] }[] = [];
for (const card of CUBE.cards) {
  const faces = getScript(card.id);
  if (!faces) { rows.push({ name: card.name, gaps: ['no script'] }); continue; }
  const gaps: string[] = [];
  faces.forEach((f, face) => {
    const sp = spellAbility(card.id, face);
    if (sp) for (const u of isAutomatable(sp.ability).unsupported) gaps.push(`spell: ${u}`);
    if (sp?.ability.params.Cost) for (const p of parseCost(sp.ability.params.Cost).parts) if (/\(by hand\)$/.test(p.text)) gaps.push(`spell cost: ${p.text}`);
    for (const a of activatedAbilitiesOf(card.id, face)) {
      for (const u of isAutomatable(a.ability).unsupported) gaps.push(`ability: ${u}`);
      for (const tok of a.cost.match(/\S+<[^>]*>|\S+/g) ?? []) { const g = costTokenGap(tok); if (g) gaps.push(`ability ${g}`); }
    }
    // Mana abilities with parts done by hand.
    for (const line of f.abilities) {
      if (!/^\s*AB\$\s*Mana\b/.test(line)) continue;
      const ab = parseAbility(line, f.svars, f.name);
      if (!ab || ab.params.Planeswalker === 'True') continue; // loyalty abilities use the stack (play.ts)
      for (const p of parseCost(ab.params.Cost ?? '').parts) if (/^tapXType<1\//.test(p.text)) continue; else if (p.kind === 'other' || p.kind === 'discard' || p.kind === 'sac' || p.kind === 'exileHand' || p.kind === 'exileGrave' || p.kind === 'return') gaps.push(`mana cost: ${p.text}`);
      for (let s = ab.sub; s; s = s.sub) if (!(s.api === 'DealDamage' && s.params.Defined === 'You')) gaps.push(`mana sub: ${s.api}`);
      if (ab.params.Produced && !/^(Any|Combo [WUBRGC ]+|[WUBRGC]( [WUBRGC])*)$/.test(ab.params.Produced)) gaps.push(`mana: Produced$ ${ab.params.Produced}`);
    }
    f.triggers.forEach((_l, i) => {
      const s = triggerSupport(card.id, face, i);
      if (!(s.detect && s.chain)) gaps.push(`trigger: ${s.reason ?? '?'}`);
    });
    for (const line of f.statics) for (const g of staticGaps(parseStatic(line, f.svars))) gaps.push(`static: ${g}`);
    for (const line of f.replacements) { const g = replacementGap(line, f.svars); if (g) gaps.push(`replacement: ${g}`); }
    for (const k of f.keywords) { const g = keywordGap(k, f.svars); if (g) gaps.push(`keyword: ${g}`); }
  });
  rows.push({ name: card.name, gaps: [...new Set(gaps)] });
}

const bad = rows.filter((r) => r.gaps.length);
console.log(`Cube cards: ${rows.length}; with no manual fallback: ${rows.length - bad.length} (${Math.round((100 * (rows.length - bad.length)) / rows.length)}%); with gaps: ${bad.length}`);
const kinds = new Map<string, number>();
for (const r of bad) for (const g of new Set(r.gaps.map((x) => x.replace(/ \(.*$/, '').replace(/\$ .*/, '$')))) kinds.set(g, (kinds.get(g) ?? 0) + 1);
console.log('Gap kinds (cards):');
for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, process.argv.includes('--cards') ? 200 : 40)) console.log(`  ${String(n).padStart(4)}  ${k}`);
if (process.argv.includes('--cards')) for (const r of bad) console.log(`- ${r.name}: ${r.gaps.join('; ')}`);
