import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import { applyAction, createGame, type Ctx, viewFor } from '../src/index.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[]) => [...extra, ...Array(40 - extra.length).fill('basic_mountain')];

function setup() {
  const ctx: Ctx = { rng: seeded(3), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(['lightning_bolt']), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(['questing_beast']), side: [] },
  ], 'a', ctx, { strict: false });
  const act = (pid: string, a: Parameters<typeof applyAction>[2]) => { const e = applyAction(g, pid, a, ctx); if (e) throw new Error(e); };
  act('a', { t: 'keep' }); act('b', { t: 'keep' });
  return { g, ctx, act };
}

describe('reveal records', () => {
  it('records a manual reveal for both players, with who and what', () => {
    const { g, act } = setup();
    const iid = g.players[0].zones.hand[0];
    act('a', { t: 'reveal', iid });
    for (const v of ['a', 'b']) {
      const r = viewFor(g, v).reveals!;
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ by: 'a', source: 'Reveal a card', turn: g.turn });
      expect(r[0].cards[0].iid).toBe(iid);
    }
    expect(viewFor(g, null).reveals).toHaveLength(1);
  });
  it('records a revealed hand', () => {
    const { g, act } = setup();
    act('b', { t: 'revealHand' });
    const r = viewFor(g, 'a').reveals!;
    expect(r[0].cards).toHaveLength(g.players[1].zones.hand.length);
    expect(r[0].by).toBe('b');
  });
  it('does not show a private reveal to others', () => {
    const { g, act } = setup();
    act('a', { t: 'reveal', iid: g.players[0].zones.hand[0] });
    g.reveals![0].to = ['a']; // as for a reveal shown to one player only
    expect(viewFor(g, 'a').reveals).toHaveLength(1);
    expect(viewFor(g, 'b').reveals).toHaveLength(0);
    expect(viewFor(g, null).reveals).toHaveLength(0);
  });
  it('keeps the record when the action is undone', () => {
    const { g, act } = setup();
    act('a', { t: 'reveal', iid: g.players[0].zones.hand[0] });
    act('a', { t: 'requestUndo' }); act('b', { t: 'answerUndo', accept: true });
    expect(g.cards[g.players[0].zones.hand[0]].revealedTo).toEqual([]);
    expect(g.reveals).toHaveLength(1);
  });
});
