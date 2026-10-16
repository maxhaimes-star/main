import { describe, expect, it } from 'vitest';
import { CUBE, getCard } from '../src/cube.ts';
import { DEFAULT_SETTINGS, draftPick, draftTick, leaveSeat, reclaimSeat, startDraft, type RoomState } from '../src/index.ts';
import { seeded } from './helpers.ts';

function room(n: number, over: Partial<RoomState['settings']> = {}): RoomState {
  return {
    id: 'r', name: 'r', hostId: 'p0', settings: { ...DEFAULT_SETTINGS, ...over },
    players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, seat: i, isBot: false, connected: true })),
    phase: 'lobby', draft: null, auction: null, pools: {}, decks: {}, matches: [], chat: [], createdAt: 0, updatedAt: 0,
  };
}

describe('seat takeover', () => {
  it('a bot picks for a player who left; the player keeps their picks and gets the seat back', () => {
    const r = room(3, { packs: 1, packSize: 6, pickTimer: 30 });
    const rng = seeded(9);
    startDraft(r, CUBE.list, rng, getCard, 0);
    const d = r.draft!;
    draftPick(r, 1, d.queues[1][0][0], 0);
    const mine = d.picks[1].slice();
    expect(leaveSeat(r, 'p1')).toBeNull();
    expect(r.players[1]).toMatchObject({ isBot: true, away: true });
    // Humans p0 and p2 keep picking; the seat of p1 is picked by a bot without waiting for its timer.
    let t = 1;
    while (d.picks[1].length < 4 && t < 500) {
      for (const seat of [0, 2]) if (d.queues[seat][0]) draftPick(r, seat, d.queues[seat][0][0], t);
      draftTick(r, t, getCard, rng);
      t++;
    }
    expect(d.picks[1].length).toBeGreaterThanOrEqual(4);
    expect(d.picks[1].slice(0, mine.length)).toEqual(mine);
    // Take the seat back: the bot stops picking, so packs now wait for the human (with a fresh pick timer).
    expect(reclaimSeat(r, 'p1', t)).toBeNull();
    expect(r.players[1]).toMatchObject({ isBot: false, connected: true });
    expect(r.players[1].away).toBeUndefined();
    const before = d.picks[1].length;
    for (let i = 0; i < 50 && !d.queues[1][0]; i++) {
      for (const seat of [0, 2]) if (d.queues[seat][0]) draftPick(r, seat, d.queues[seat][0][0], t);
      draftTick(r, t, getCard, rng);
      t++;
    }
    expect(d.queues[1][0]).toBeDefined();
    expect(d.deadlines[1]).toBeGreaterThan(t - 1);
    draftTick(r, t, getCard, rng);
    expect(d.picks[1].length).toBe(before); // human seat: no bot pick
    expect(reclaimSeat(r, 'p1', t)).toMatch(/not waiting/);
  });

  it('only works while drafting or in an auction', () => {
    const r = room(2);
    expect(leaveSeat(r, 'p0')).toMatch(/while drafting/);
    r.phase = 'drafting';
    expect(leaveSeat(r, 'nobody')).toMatch(/not seated/);
  });
});
