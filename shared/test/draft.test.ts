import { describe, expect, it } from 'vitest';
import { CUBE, getCard } from '../src/cube.ts';
import { auctionTick, DEFAULT_SETTINGS, draftPick, draftTick, nominate, placeBid, type RoomState, startAuction, startDraft, startSealed, botDeck, highBid } from '../src/index.ts';
import { seeded } from './helpers.ts';

function room(n: number, humans: number, over: Partial<RoomState['settings']> = {}): RoomState {
  return {
    id: 'r', name: 'r', hostId: 'p0', settings: { ...DEFAULT_SETTINGS, ...over },
    players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, seat: i, isBot: i >= humans, connected: true })),
    phase: 'lobby', draft: null, auction: null, pools: {}, decks: {}, matches: [], chat: [], createdAt: 0, updatedAt: 0,
  };
}

describe('cube data', () => {
  it('resolves every card in the list', () => {
    expect(CUBE.missing).toEqual([]);
    expect(CUBE.list.length).toBe(606);
    for (const id of CUBE.list) expect(getCard(id)).toBeTruthy();
  });
});

describe('booster draft', () => {
  it('passes packs and finishes with full pools (all bots)', () => {
    const r = room(8, 0);
    const rng = seeded(3);
    startDraft(r, CUBE.list, rng, getCard, 0);
    let t = 0;
    while (r.phase === 'drafting' && t < 10000) { draftTick(r, t, getCard, rng); t++; }
    expect(r.phase).toBe('deckbuilding');
    for (const p of r.players) expect(r.pools[p.id]).toHaveLength(45);
    const all = Object.values(r.pools).flat();
    // No card dealt twice beyond its count in the list.
    const listCount = new Map<string, number>();
    for (const id of CUBE.list) listCount.set(id, (listCount.get(id) ?? 0) + 1);
    const used = new Map<string, number>();
    for (const id of all) used.set(id, (used.get(id) ?? 0) + 1);
    for (const [id, n] of used) expect(n).toBeLessThanOrEqual(listCount.get(id)!);
  });

  it('passes left in pack 1 and right in pack 2', () => {
    const r = room(3, 3, { packs: 2, packSize: 3, pickTimer: 0 });
    startDraft(r, CUBE.list, seeded(1), getCard, 0);
    const d = r.draft!;
    const seat1Pack = d.queues[1][0].slice();
    draftPick(r, 1, seat1Pack[0], 0);
    expect(d.queues[2].at(-1)).toEqual(seat1Pack.slice(1)); // seat 1 → seat 2
    // finish round 1
    while (d.round === 0) for (let s = 0; s < 3; s++) if (d.queues[s][0]) draftPick(r, s, d.queues[s][0][0], 0);
    const p = d.queues[1][0].slice();
    draftPick(r, 1, p[0], 0);
    expect(d.queues[0].at(-1)).toEqual(p.slice(1)); // seat 1 → seat 0
  });

  it('auto-picks when the timer runs out', () => {
    const r = room(2, 2, { pickTimer: 30 });
    startDraft(r, CUBE.list, seeded(2), getCard, 0);
    expect(r.draft!.deadlines[0]).toBe(30000);
    draftTick(r, 29999, getCard, seeded(1));
    expect(r.draft!.picks[0]).toHaveLength(0);
    draftTick(r, 30000, getCard, seeded(1));
    expect(r.draft!.picks[0]).toHaveLength(1);
    expect(r.draft!.picks[1]).toHaveLength(1);
  });

  it('rejects picks not in the pack', () => {
    const r = room(2, 2);
    startDraft(r, CUBE.list, seeded(2), getCard, 0);
    expect(draftPick(r, 0, 'not_a_card', 0)).toMatch(/not in pack/);
  });
});

describe('sealed', () => {
  it('deals separate pools', () => {
    const r = room(4, 4);
    startSealed(r, CUBE.list, seeded(5), getCard);
    expect(r.phase).toBe('deckbuilding');
    for (const p of r.players) expect(r.pools[p.id]).toHaveLength(90);
  });
  it('bot builds a 40-card deck', () => {
    const r = room(2, 0);
    startSealed(r, CUBE.list, seeded(5), getCard);
    const d = botDeck(r.pools.p0, getCard);
    const total = d.main.length + Object.values(d.basics).reduce((a, b) => a + b, 0);
    expect(total).toBe(40);
    expect(d.main.length + d.side.length).toBe(90);
  });
});

describe('auction', () => {
  it('enforces bid rules', () => {
    const r = room(3, 3, { auctionBudget: 10 });
    startAuction(r, CUBE.list, seeded(1), getCard, 0);
    const a = r.auction!;
    expect(nominate(r, 'p1', a.open[0], 0)).toMatch(/Waiting/);
    const card = a.open[0];
    expect(nominate(r, 'p0', card, 0)).toBeNull();
    expect(highBid(a)).toMatchObject({ pid: 'p0', amount: 0 });
    expect(placeBid(r, 'p0', 1, 100)).toMatch(/already/);
    expect(placeBid(r, 'p1', 0, 100)).toMatch(/more than/);
    expect(placeBid(r, 'p1', 11, 100)).toMatch(/only have/);
    expect(placeBid(r, 'p1', 3, 100)).toBeNull();
    expect(placeBid(r, 'p2', 3, 200)).toMatch(/more than/);
    expect(placeBid(r, 'p2', 4, 5000)).toBeNull();
    // timer resets on bid
    expect(a.lot!.deadline).toBe(15000);
    auctionTick(r, 14999, getCard, seeded(1));
    expect(a.lot).not.toBeNull();
    auctionTick(r, 15000, getCard, seeded(1));
    expect(a.lot).toBeNull();
    expect(a.pools.p2).toEqual([card]);
    expect(a.budgets.p2).toBe(6);
    expect(a.nominatorSeat).toBe(1);
  });

  it('nominator gets the card free when nobody bids', () => {
    const r = room(2, 2);
    startAuction(r, CUBE.list, seeded(1), getCard, 0);
    const card = r.auction!.open[2];
    nominate(r, 'p0', card, 0);
    auctionTick(r, 10000, getCard, seeded(1));
    expect(r.auction!.pools.p0).toEqual([card]);
    expect(r.auction!.budgets.p0).toBe(100);
  });

  it('runs to completion with bots and caps pools', () => {
    const r = room(4, 0, { auctionPoolSize: 20 });
    const rng = seeded(9);
    startAuction(r, CUBE.list, rng, getCard, 0);
    let t = 0;
    while (r.phase === 'auction' && t < 2_000_000) { auctionTick(r, t, getCard, rng); t += 250; }
    expect(r.phase).toBe('deckbuilding');
    for (const p of r.players) {
      expect(r.pools[p.id].length).toBeLessThanOrEqual(20);
      expect(r.auction!.budgets[p.id]).toBeGreaterThanOrEqual(0);
    }
    expect(Object.values(r.pools).flat().length).toBe(80);
  });
});
