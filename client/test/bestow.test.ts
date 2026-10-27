import { describe, expect, it } from 'vitest';
import { getCard } from '../../shared/src/cube.ts';
import { applyAction, createGame, moveCard, viewFor, type Ctx, type GameAction, type GameState } from '@ojb/shared';
import { castWithX } from '../src/game/actions.ts';

const seeded = (s: number) => () => { s = (s * 16807) % 2147483647; return s / 2147483647; };

describe('client cast flow: bestow (Springheart Nantuko)', () => {
  it('picking Bestow asks for a creature and the server attaches it', async () => {
    const ctx: Ctx = { rng: seeded(7) as never, lookup: getCard, now: 0 };
    const deck = (x: string[]) => [...x, ...Array(40 - x.length).fill('basic_forest')];
    const g: GameState = createGame('g', [
      { pid: 'a', name: 'A', deck: deck(['springheart_nantuko', 'containment_priest']), side: [] },
      { pid: 'b', name: 'B', deck: deck([]), side: [] },
    ], 'a', ctx, { strict: true });
    for (const p of ['a', 'b']) expect(applyAction(g, p, { t: 'keep' }, ctx)).toBeFalsy();
    const pa = g.players.find((p) => p.pid === 'a')!;
    const all = () => [...pa.zones.hand, ...pa.zones.library];
    const byId = (id: string, skip: string[] = []) => all().find((i) => g.cards[i].cardId === id && !skip.includes(i))!;
    const priest = byId('containment_priest'); moveCard(g, ctx, priest, 'battlefield', { controller: 'a' }); g.cards[priest].summoningSick = false;
    const used: string[] = [];
    for (let i = 0; i < 2; i++) { const f = byId('basic_forest', [...used, ...g.battlefield]); used.push(f); moveCard(g, ctx, f, 'battlefield', { controller: 'a' }); }
    const sn = byId('springheart_nantuko'); if (g.cards[sn].zone !== 'hand') moveCard(g, ctx, sn, 'hand');
    g.events = []; g.triggerQueue = [];
    let sent: GameAction | undefined; const offered: string[] = [];
    const base = {
      g: viewFor(g, 'a'), me: 'a', opp: 'b', mode: null,
      act: async (a: GameAction) => { sent = a; },
      pickOption: async (_t: string, opts: { value: string; disabled?: boolean }[]) => { offered.push(...opts.filter((o) => !o.disabled).map((o) => o.value)); return 'bestow'; },
      target: async () => [[{ kind: 'card', iid: priest }]],
      ask: async () => 1, askText: async () => '', pickModes: async () => null, divide: async () => null, setMode: () => {}, toast: () => {},
    };
    await castWithX(base as never, sn);
    expect(offered).toContain('bestow');
    expect(sent).toMatchObject({ t: 'cast', costOption: 'bestow' });
    expect((sent as { targets?: unknown }).targets).toBeTruthy();
    const err = applyAction(g, 'a', sent!, ctx);
    expect(err).toBeFalsy();
    for (let i = 0; i < 6 && g.stack.length; i++) applyAction(g, g.priority, { t: 'pass' }, ctx);
    expect(g.cards[sn].attachedTo).toBe(priest);
  });
});
