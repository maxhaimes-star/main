import { expect, it } from 'vitest';
import { CUBE, getCard } from '../src/cube.ts';
import { activatedAbilitiesOf, applyAction, createGame, type Ctx, type GameState, isValidTarget, moveCard, spellAbility, targetSpecs, type TargetRef } from '../src/index.ts';
import { seeded } from './helpers.ts';

function board(cardId: string, seed: number) {
  const ctx: Ctx = { rng: seeded(seed), lookup: getCard, now: 0 };
  const filler = ['goblin_guide', 'questing_beast', 'thalia_guardian_of_thraben', 'lightning_bolt', 'counterspell'];
  const deck = (x: string[]) => [...x, ...filler, ...Array(40 - x.length - filler.length).fill('basic_mountain')];
  const g = createGame('g', [{ pid: 'a', name: 'A', deck: deck([cardId]), side: [] }, { pid: 'b', name: 'B', deck: deck([]), side: [] }], 'a', ctx);
  applyAction(g, 'a', { t: 'keep' }, ctx); applyAction(g, 'b', { t: 'keep' }, ctx);
  for (const pid of ['a', 'b']) {
    const p = g.players.find((x) => x.pid === pid)!;
    const lib = p.zones.library;
    for (const id of ['goblin_guide', 'questing_beast', 'basic_mountain']) { const i = lib.find((x) => g.cards[x].cardId === id); if (i) { moveCard(g, ctx, i, 'battlefield', { controller: pid }); } }
    const t = lib.find((x) => g.cards[x].cardId === 'thalia_guardian_of_thraben'); if (t) moveCard(g, ctx, t, 'graveyard');
  }
  return { g, ctx };
}
function pickTargets(g: GameState, specs: ReturnType<typeof targetSpecs>, src: string) {
  const out: TargetRef[][] = [];
  for (const spec of specs) {
    const cands: TargetRef[] = [...g.players.map((p) => ({ kind: 'player', pid: p.pid }) as TargetRef), ...Object.keys(g.cards).map((iid) => ({ kind: 'card', iid }) as TargetRef), ...g.stack.map((s) => ({ kind: 'stack', id: s.id }) as TargetRef)];
    const ok = cands.filter((r) => isValidTarget(g, spec, r, 'a', src, getCard));
    out.push(ok.slice(0, Math.max(spec.min, Math.min(1, spec.max))));
  }
  return out;
}
function drain(g: GameState, ctx: Ctx) {
  for (let k = 0; k < 30; k++) {
    if (g.pending.length) { const q = g.pending[0]; const e = applyAction(g, q.pid, { t: 'choose', id: q.id, value: q.options[0].value }, ctx); if (e) throw new Error('choose: ' + e); continue; }
    const pk = g.players.find((p) => p.peek);
    if (pk) { applyAction(g, pk.pid, { t: 'resolvePeek', top: pk.peek!.iids, bottom: [], graveyard: [], hand: [], battlefield: [], exile: [], shuffle: false }, ctx); continue; }
    if (g.stack.length) { applyAction(g, g.priority, { t: 'pass' }, ctx); continue; }
    break;
  }
}
/** Smoke test: cast every cube spell / activate every ability with some legal targets and resolve it, answering every question. */
it('smoke: every cube spell and ability resolves without throwing', () => {
  const errors: string[] = [];
  let n = 0;
  for (const card of CUBE.cards) {
    for (let face = 0; face < 2; face++) {
      const sp = spellAbility(card.id, face);
      if (!sp) continue;
      const { g, ctx } = board(card.id, 3);
      const hand = g.players[0].zones.library.concat(g.players[0].zones.hand).find((i) => g.cards[i].cardId === card.id)!;
      moveCard(g, ctx, hand, 'hand');
      // a spell on the stack to target
      const bolt = g.players[1].zones.library.find((i) => g.cards[i].cardId === 'lightning_bolt')!;
      moveCard(g, ctx, bolt, 'hand');
      const modes = sp.ability.choices ? sp.ability.choices.slice(0, sp.ability.charmMax ?? 1).map((c) => c.name) : undefined;
      try {
        applyAction(g, 'a', { t: 'pass' }, ctx);
        const specs = targetSpecs(sp.ability, modes);
        const targets = pickTargets(g, specs, hand);
        const err = applyAction(g, 'a', { t: 'cast', iid: hand, face, targets, x: 2, modes }, ctx);
        if (err) continue; // e.g. no legal target on this board
        n++;
        drain(g, ctx);
      } catch (e) { errors.push(`${card.id}/${face}: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`); }
    }
    for (let face = 0; face < 2; face++) {
      for (const ab of activatedAbilitiesOf(card.id, face)) {
        const { g, ctx } = board(card.id, 5);
        const iid = g.players[0].zones.library.concat(g.players[0].zones.hand).find((i) => g.cards[i].cardId === card.id)!;
        moveCard(g, ctx, iid, 'battlefield', { controller: 'a' });
        g.cards[iid].transformed = face === 1;
        g.cards[iid].counters.loyalty = 20;
        try {
          const targets = pickTargets(g, targetSpecs(ab.ability), iid);
          const err = applyAction(g, 'a', { t: 'activate', iid, text: '', ability: ab.index, targets, x: 1 }, ctx);
          if (err) continue;
          n++;
          drain(g, ctx);
        } catch (e) { errors.push(`${card.id}/ab${ab.index}: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`); }
      }
    }
  }
  expect(errors).toEqual([]);
  expect(n).toBeGreaterThan(250);
});
