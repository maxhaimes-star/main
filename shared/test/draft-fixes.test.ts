import { describe, expect, it } from 'vitest';
import { CUBE, getCard } from '../src/cube.ts';
import { botPick, cardScore, DEFAULT_SETTINGS, draftPick, draftTick, finishPoolsWithBots, highlightCard, leaveSeat, reclaimSeat, type RoomState, setDraftMain, startDraft, multisetDiff } from '../src/index.ts';
import { isMustPick } from '../src/power.ts';
import { seeded } from './helpers.ts';

function room(n: number, humans: number, over: Partial<RoomState['settings']> = {}): RoomState {
  return {
    id: 'r', name: 'r', hostId: 'p0', settings: { ...DEFAULT_SETTINGS, ...over },
    players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, seat: i, isBot: i >= humans, connected: true })),
    phase: 'lobby', draft: null, auction: null, pools: {}, decks: {}, matches: [], chat: [], createdAt: 0, updatedAt: 0,
  };
}

describe('draft auto-pick (timer runs out)', () => {
  it('gives the player the card they highlighted', () => {
    const r = room(2, 2, { pickTimer: 30 });
    startDraft(r, CUBE.list, seeded(2), getCard, 0);
    const d = r.draft!;
    const pack = d.queues[0][0].slice();
    const want = pack[pack.length - 1];
    expect(highlightCard(r, 0, 'not_in_pack')).toMatch(/not in/);
    expect(highlightCard(r, 0, want)).toBeNull();
    draftTick(r, 30_000, getCard, seeded(1));
    expect(d.picks[0]).toEqual([want]);
    expect(d.main![0]).toEqual([want]);
  });

  it('gives the best-rated card when nothing is highlighted (no random noise)', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = room(2, 2, { pickTimer: 30 });
      startDraft(r, CUBE.list, seeded(seed), getCard, 0);
      const d = r.draft!;
      const pack = d.queues[0][0].slice();
      // Best-rated: a must-pick bomb if the pack has one, else the highest score for the player's picks.
      const bombs = pack.filter((id) => isMustPick(getCard(id)!));
      const best = bombs.length ? botPick(pack, [], getCard, () => 0) : pack.slice().sort((x, y) => cardScore(getCard(y)!, [], getCard) - cardScore(getCard(x)!, [], getCard))[0];
      draftTick(r, 30_000, getCard, () => 0.999);
      expect(d.picks[0]).toEqual([best]);
    }
  });

  it('a highlight is for one pack only: the next pack falls back to the best-rated card', () => {
    const r = room(2, 2, { pickTimer: 30 });
    startDraft(r, CUBE.list, seeded(3), getCard, 0);
    const d = r.draft!;
    highlightCard(r, 0, d.queues[0][0][0]);
    draftPick(r, 0, d.queues[0][0][1], 10);
    expect(d.highlight?.[0] ?? null).toBeNull();
  });

  it('every timed-out pick lands in the picks: a full timed-out draft gives each player exactly 45 cards', () => {
    const r = room(2, 2, { pickTimer: 10 });
    startDraft(r, CUBE.list.slice(0, 200), seeded(4), getCard, 0);
    let t = 0;
    while (r.phase === 'drafting' && t < 10_000_000) { t += 1000; draftTick(r, t, getCard, seeded(t)); }
    expect(r.phase).toBe('deckbuilding');
    for (const p of r.players) expect(r.pools[p.id]).toHaveLength(45);
  });
});

describe('end of the draft: the pool is exactly the picks', () => {
  it("a player who left mid-draft keeps their own picks and main/sideboard split (no bot-built deck with other cards)", () => {
    const r = room(3, 2, { pickTimer: 0, packs: 1, packSize: 6 });
    startDraft(r, CUBE.list, seeded(5), getCard, 0);
    const d = r.draft!;
    // p1 picks two cards, sideboards one, then leaves: the bot finishes the draft for them.
    draftPick(r, 1, d.queues[1][0][0], 0);
    setDraftMain(r, 1, []);
    leaveSeat(r, 'p1');
    let t = 0;
    while (r.phase === 'drafting' && t < 1000) {
      t++;
      if (d.queues[0][0]) draftPick(r, 0, d.queues[0][0][0], t);
      draftTick(r, t, getCard, seeded(t));
    }
    expect(r.phase).toBe('deckbuilding');
    finishPoolsWithBots(r, getCard);
    reclaimSeat(r, 'p1', t);
    const pool = r.pools.p1;
    expect(pool.slice().sort()).toEqual(d.picks[1].slice().sort());
    const deck = r.decks.p1;
    expect(multisetDiff(pool, deck.main)).toEqual(deck.side);
    expect(deck.main).toEqual(d.main![1]);
    expect(Object.values(deck.basics).reduce((a, b) => a + b, 0)).toBe(0);
    expect(deck.ready).toBe(false);
  });
});
