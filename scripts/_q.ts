// scratch query tool (not committed)
import { CUBE } from '../shared/src/cube.ts';
import { getScript, triggerSupport, isAutomatable, spellAbility, activatedAbilitiesOf } from '../shared/src/engine/index.ts';
import { triggersOf } from '../shared/src/engine/script.ts';
const mode = process.argv[2];
const want = process.argv[3] ?? '';
const showSv = (f: { svars: Record<string, string> }, start: string | undefined) => {
  const seen = new Set<string>();
  const show = (name: string | undefined, d = 0) => {
    if (!name || seen.has(name) || d > 8) return; seen.add(name);
    const v = f.svars[name]; if (!v) return;
    console.log(`   ${name} = ${v.slice(0, 300)}`);
    for (const m of v.matchAll(/(SubAbility|Execute|RepeatSubAbility|ChosenPile|VoteSubAbility|TrueSubAbility|FalseSubAbility|Choices|StaticAbilities|Triggers|ReplacementEffects|ReplaceWith|Abilities)\$ ([\w,]+)/g)) for (const n of m[2].split(',')) show(n.trim(), d + 1);
  };
  show(start);
};
for (const card of CUBE.cards) {
  const faces = getScript(card.id) ?? [];
  faces.forEach((f, face) => {
    if (mode === 'trig') f.triggers.forEach((_l, i) => {
      const s = triggerSupport(card.id, face, i);
      if (s.detect && s.chain) return;
      if (want && !(s.reason ?? '').includes(want)) return;
      const t = triggersOf(card.id, face)[i];
      console.log(`== ${card.name} [${s.reason}]: ${f.triggers[i].slice(0, 300)}`);
      showSv(f, t.params.Execute);
    });
    if (mode === 'ab') {
      const chains = [spellAbility(card.id, face)?.ability, ...activatedAbilitiesOf(card.id, face).map((a) => a.ability)].filter(Boolean);
      for (const ab of chains) {
        const u = isAutomatable(ab!).unsupported;
        if (!u.length || (want && !u.some((x) => x.includes(want)))) continue;
        console.log(`== ${card.name} [${u.join('; ')}]`);
        console.log(`   ${Object.entries(ab!.params).map(([k, v]) => `${k}$ ${v}`).join(' | ').slice(0, 300)}`);
        for (const v of Object.values(ab!.params)) for (const n of v.split(',')) if (f.svars[n.trim()]) showSv(f, n.trim());
      }
    }
    if (mode === 'card' && want.split('|').some((w) => card.name.toLowerCase() === w.toLowerCase())) {
      console.log(`== ${card.name} face ${face}`);
      for (const l of f.abilities) console.log(`A: ${l}`);
      for (const l of f.triggers) console.log(`T: ${l}`);
      for (const l of f.statics) console.log(`S: ${l}`);
      for (const l of f.replacements) console.log(`R: ${l}`);
      console.log(`K: ${f.keywords.join(' | ')}`);
      for (const [k, v] of Object.entries(f.svars)) console.log(`   ${k} = ${v.slice(0, 400)}`);
    }
  });
}
