import { expect, it } from 'vitest';
import { CUBE, getCard } from '../src/cube.ts';
import { activatedAbilitiesOf, applyAction, createGame, type Ctx, type GameState, isValidTarget, moveCard, spellAbility, SYNTH_BASE, targetSpecs, type TargetRef } from '../src/index.ts';
import { seeded } from './helpers.ts';

function board(cardId: string, seed: number) {
  const ctx: Ctx = { rng: seeded(seed), lookup: getCard, now: 0 };
  const filler = ['goblin_guide', 'questing_beast', 'thalia_guardian_of_thraben', 'lightning_bolt', 'counterspell'];
  const deck = (x: string[]) => [...x, ...filler, ...Array(40 - x.length - filler.length).fill('basic_mountain')];
  const g = createGame('g', [{ pid: 'a', name: 'A', deck: deck([cardId]), side: [] }, { pid: 'b', name: 'B', deck: deck([]), side: [] }], 'a', ctx, { strict: false });
  applyAction(g, 'a', { t: 'keep' }, ctx); applyAction(g, 'b', { t: 'keep' }, ctx);
  for (const pid of ['a', 'b']) {
    const p = g.players.find((x) => x.pid === pid)!;
    const lib = p.zones.library;
    for (const id of ['goblin_guide', 'questing_beast', 'basic_mountain']) { const i = lib.find((x) => g.cards[x].cardId === id); if (i) { moveCard(g, ctx, i, 'battlefield', { controller: pid }); } }
    const t = lib.find((x) => g.cards[x].cardId === 'thalia_guardian_of_thraben'); if (t) moveCard(g, ctx, t, 'graveyard');
  }
  return { g, ctx };
}
function pickTargets(g: GameState, specs: ReturnType<typeof targetSpecs>, src: string | undefined, controller = 'a') {
  const out: TargetRef[][] = [];
  for (const spec of specs) {
    const cands: TargetRef[] = [...g.players.map((p) => ({ kind: 'player', pid: p.pid }) as TargetRef), ...Object.keys(g.cards).map((iid) => ({ kind: 'card', iid }) as TargetRef), ...g.stack.map((s) => ({ kind: 'stack', id: s.id }) as TargetRef)];
    const ok = cands.filter((r) => isValidTarget(g, spec, r, controller, src, getCard));
    out.push(ok.slice(0, Math.max(spec.min, Math.min(1, spec.max))));
  }
  return out;
}
function drain(g: GameState, ctx: Ctx) {
  for (let k = 0; k < 30; k++) {
    if (g.pending.length) {
      const q = g.pending[0];
      if (q.targets) {
        const e = applyAction(g, q.pid, { t: 'chooseTargets', id: q.id, targets: pickTargets(g, q.targets.specs, q.targets.sourceIid, q.targets.controller) }, ctx);
        if (!e) continue;
        if (!q.options.length) throw new Error('chooseTargets: ' + e);
      }
      const e = applyAction(g, q.pid, { t: 'choose', id: q.id, value: q.options[0].value }, ctx);
      if (e) throw new Error('choose: ' + e);
      continue;
    }
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
  let synth = 0, fromHand = 0;
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
        const err = applyAction(g, 'a', { t: 'cast', iid: hand, face, targets, x: 2, modes, force: true }, ctx);
        if (err) continue; // e.g. no legal target on this board
        n++;
        drain(g, ctx);
      } catch (e) { errors.push(`${card.id}/${face}: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`); }
    }
    for (let face = 0; face < 2; face++) {
      for (const ab of activatedAbilitiesOf(card.id, face)) {
        const { g, ctx } = board(card.id, 5);
        const iid = g.players[0].zones.library.concat(g.players[0].zones.hand).find((i) => g.cards[i].cardId === card.id)!;
        // Activation zone: battlefield, or hand / graveyard (cycling, channel ...).
        moveCard(g, ctx, iid, ab.zone ?? 'battlefield', { controller: 'a' });
        g.pending = []; // e.g. a shockland's "pay 2 life?" question
        g.cards[iid].transformed = face === 1;
        g.cards[iid].counters.loyalty = 20;
        try {
          const targets = pickTargets(g, targetSpecs(ab.ability), iid);
          const err = applyAction(g, 'a', { t: 'activate', iid, text: '', ability: ab.index, targets, x: 1, force: true }, ctx);
          if (err) continue;
          n++;
          if (ab.index >= SYNTH_BASE) synth++;
          if (ab.zone) fromHand++;
          drain(g, ctx);
        } catch (e) { errors.push(`${card.id}/ab${ab.index}: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`); }
      }
    }
  }
  expect(errors).toEqual([]);
  expect(n).toBeGreaterThan(250);
  expect(synth).toBeGreaterThan(25); // Equip, Cycling, Level up, Reconfigure, Crew ...
  expect(fromHand).toBeGreaterThan(15);
});

/** Smoke test (Stage 2): every cube permanent enters the battlefield, its triggers go on the stack and resolve. */
it('smoke: ETB / landfall triggers of every cube permanent resolve without throwing', () => {
  const errors: string[] = [];
  let triggered = 0;
  for (const card of CUBE.cards) {
    const sp = spellAbility(card.id, 0);
    const types = card.types ?? [];
    if (!['Creature', 'Artifact', 'Enchantment', 'Land', 'Planeswalker', 'Battle'].some((t) => types.includes(t)) && sp && sp.index >= 0) continue;
    const { g, ctx } = board(card.id, 11);
    const iid = g.players[0].zones.library.concat(g.players[0].zones.hand).find((i) => g.cards[i].cardId === card.id);
    if (!iid) continue;
    try {
      const stack0 = g.stack.length;
      const err = applyAction(g, 'a', { t: 'move', iid, to: 'battlefield' }, ctx);
      if (err) throw new Error(err);
      if (g.stack.length > stack0 || g.pending.length) triggered++;
      drain(g, ctx);
      // a land for landfall triggers
      const land = g.players[0].zones.library.find((i) => g.cards[i].cardId === 'basic_mountain');
      if (land && g.cards[iid]?.zone === 'battlefield') {
        moveCard(g, ctx, land, 'hand');
        applyAction(g, 'a', { t: 'playLand', iid: land }, ctx);
        drain(g, ctx);
      }
      const bad = g.log.filter((l) => /Trigger detection error/.test(l.text));
      if (bad.length) errors.push(`${card.id}: ${bad[0].text}`);
    } catch (e) { errors.push(`${card.id}: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`); }
  }
  expect(errors).toEqual([]);
  expect(triggered).toBeGreaterThan(80);
});
