import { describe, expect, it } from 'vitest';
import { getCard, CUBE } from '../src/cube.ts';
import { DEFAULT_SETTINGS, draftPick, draftTick, setDraftMain, startDraft, type RoomState } from '../src/index.ts';
import { seeded } from './helpers.ts';

function room(n: number, humans: number, over: Partial<RoomState['settings']> = {}): RoomState {
  return {
    id: 'r', name: 'r', hostId: 'p0', settings: { ...DEFAULT_SETTINGS, ...over },
    players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, seat: i, isBot: i >= humans, connected: true })),
    phase: 'lobby', draft: null, auction: null, pools: {}, decks: {}, matches: [], chat: [], createdAt: 0, updatedAt: 0,
  };
}

describe('draft main/sideboard split', () => {
  it('validates the split and carries it into the deckbuilder', () => {
    const r = room(2, 1, { packs: 1, packSize: 5, pickTimer: 0 });
    const rng = seeded(4);
    startDraft(r, CUBE.list, rng, getCard, 0);
    const d = r.draft!;
    draftPick(r, 0, d.queues[0][0][0], 0);
    const first = d.picks[0][0];
    expect(setDraftMain(r, 0, ['nope'])).toMatch(/not in your picks/);
    expect(setDraftMain(r, 0, [first, first])).toMatch(/not in your picks/);
    expect(setDraftMain(r, 0, [first])).toBeNull();
    let t = 0;
    while (r.phase === 'drafting' && t < 1000) {
      if (d.queues[0][0]) draftPick(r, 0, d.queues[0][0][0], t);
      draftTick(r, t, getCard, rng);
      t++;
    }
    expect(r.phase).toBe('deckbuilding');
    expect(r.decks.p0.main).toEqual([first]);
    expect(r.decks.p0.side).toHaveLength(r.pools.p0.length - 1);
    expect([...r.decks.p0.main, ...r.decks.p0.side].sort()).toEqual(r.pools.p0.slice().sort());
  });
});
