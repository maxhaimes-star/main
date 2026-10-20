import { describe, expect, it } from 'vitest';
import { CUBE, getCard } from '../src/cube.ts';
import * as shared from '../src/index.ts';
import { auctionTick, DEFAULT_SETTINGS, nominate, passLot, placeBid, type RoomState, startAuction, highBid, setAuctionMain, passRest, lotContenders } from '../src/index.ts';
import { seeded } from './helpers.ts';

function room(n: number, humans: number, over: Partial<RoomState['settings']> = {}): RoomState {
  return {
    id: 'r', name: 'r', hostId: 'p0', settings: { ...DEFAULT_SETTINGS, ...over },
    players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, seat: i, isBot: i >= humans, connected: true })),
    phase: 'lobby', draft: null, auction: null, pools: {}, decks: {}, matches: [], chat: [], createdAt: 0, updatedAt: 0,
  };
}

describe('auction: main deck / sideboard split', () => {
  it('won cards go to the main deck; the player can move them to the sideboard and the split carries into deckbuilding', () => {
    const r = room(2, 2, { auctionPacksPerPlayer: 2, auctionPackSize: 3 });
    startAuction(r, CUBE.list, seeded(1), getCard, 0);
    const a = r.auction!;
    const won: string[] = [];
    // p0 and p1 alternate nominating; each opens at the minimum and the other passes.
    for (let i = 0; i < 4 && !a.done; i++) {
      const nom = r.players[a.nominatorSeat].id;
      const other = nom === 'p0' ? 'p1' : 'p0';
      const card = a.open[0];
      expect(nominate(r, nom, card, i, 2)).toBeNull();
      expect(passLot(r, other, i)).toBeNull();
      if (nom === 'p0') won.push(card);
    }
    expect(a.main!.p0).toEqual(won);
    expect(setAuctionMain(r, 'p0', ['not_a_card'])).toMatch(/not in your pool/);
    expect(setAuctionMain(r, 'p0', won.slice(1))).toBeNull();
    expect(a.main!.p0).toEqual(won.slice(1));
    // Finish: everything else goes unsold.
    expect(passRest(r, 'p0', true, 100)).toBeNull();
    expect(passRest(r, 'p1', true, 100)).toBeNull();
    expect(r.phase).toBe('deckbuilding');
    expect(r.decks.p0.main).toEqual(won.slice(1));
    expect(r.decks.p0.side).toEqual([won[0]]);
  });
});

describe('auction: pass on the rest', () => {
  it('ends the auction only when every player has selected it, and players can unselect it', () => {
    const r = room(3, 3);
    startAuction(r, CUBE.list, seeded(2), getCard, 0);
    const a = r.auction!;
    nominate(r, 'p0', a.open[0], 0, 2);
    passLot(r, 'p1', 1); passLot(r, 'p2', 1);
    expect(a.pools.p0).toHaveLength(1);
    expect(passRest(r, 'p0', true, 2)).toBeNull();
    expect(passRest(r, 'p1', true, 2)).toBeNull();
    expect(a.passRest).toEqual(['p0', 'p1']);
    expect(passRest(r, 'p1', false, 3)).toBeNull();
    expect(a.passRest).toEqual(['p0']);
    expect(passRest(r, 'p2', true, 3)).toBeNull();
    expect(r.phase).toBe('auction');
    const left = a.open.length + a.packs.flat().length;
    expect(passRest(r, 'p1', true, 4)).toBeNull();
    expect(a.done).toBe(true);
    expect(r.phase).toBe('deckbuilding');
    // Everything not yet sold went unsold; nobody got extra cards or paid anything more.
    expect(a.results.filter((x) => x.pid === null)).toHaveLength(left);
    expect(r.pools.p0).toHaveLength(1);
    expect(r.pools.p1).toHaveLength(0);
    expect(a.budgets.p0).toBe(198);
  });

  it('bots go along once every human has selected it', () => {
    const r = room(3, 1);
    startAuction(r, CUBE.list, seeded(3), getCard, 0);
    expect(passRest(r, 'p0', true, 0)).toBeNull();
    auctionTick(r, 5000, getCard, seeded(1));
    expect(r.phase).toBe('deckbuilding');
  });

  it('a lot that already has a bid is still sold to the high bidder', () => {
    const r = room(2, 2);
    startAuction(r, CUBE.list, seeded(4), getCard, 0);
    const a = r.auction!;
    const card = a.open[0];
    nominate(r, 'p0', card, 0, 5);
    passRest(r, 'p0', true, 1);
    passRest(r, 'p1', true, 1);
    expect(r.phase).toBe('deckbuilding');
    expect(r.pools.p0).toEqual([card]);
    expect(a.budgets.p0).toBe(195);
  });
});

describe('auction: no unilateral discard', () => {
  it('there is no skip: the nominator can only put a card up', () => {
    expect((shared as Record<string, unknown>).skipCard).toBeUndefined();
  });

  it('a card put up without a bid goes unsold only when every player who can afford it passes', () => {
    const r = room(3, 3);
    startAuction(r, CUBE.list, seeded(5), getCard, 0);
    const a = r.auction!;
    const card = a.open[0];
    expect(nominate(r, 'p0', card, 0, 0)).toBeNull();
    expect(highBid(a)).toBeUndefined();
    expect(lotContenders(r).sort()).toEqual(['p0', 'p1', 'p2']);
    passLot(r, 'p0', 1);
    passLot(r, 'p1', 1);
    expect(a.lot).not.toBeNull();
    passLot(r, 'p2', 1);
    expect(a.lot).toBeNull();
    expect(a.results[0]).toMatchObject({ cardId: card, pid: null });
    expect(Object.values(a.pools).flat()).not.toContain(card);
  });

  it('anyone, the nominator included, can bid on a card put up without a bid', () => {
    const r = room(2, 2);
    startAuction(r, CUBE.list, seeded(6), getCard, 0);
    const a = r.auction!;
    const card = a.open[0];
    nominate(r, 'p0', card, 0, 0);
    expect(placeBid(r, 'p1', 1, 1)).toMatch(/Minimum/);
    expect(placeBid(r, 'p1', 2, 1)).toBeNull();
    expect(placeBid(r, 'p0', 3, 2)).toBeNull();
    passLot(r, 'p1', 3);
    expect(a.pools.p0).toEqual([card]);
  });
});

describe('auction: a player who is out of money', () => {
  it('does not cause a timed-out nomination to be auto-awarded', () => {
    // p1 is broke; p0 lets the nomination timer run out.
    const r = room(2, 2, { nominateTimer: 10, auctionTimer: 0 });
    startAuction(r, CUBE.list, seeded(7), getCard, 0);
    const a = r.auction!;
    a.budgets.p1 = 1;
    auctionTick(r, 10_000, getCard, seeded(1));
    // The card is up for auction but nobody has bid, so nobody owns it.
    expect(a.lot).not.toBeNull();
    expect(a.lot!.bids).toHaveLength(0);
    expect(a.pools.p0).toHaveLength(0);
    expect(a.budgets.p0).toBe(200);
    // p0 (the only player who can afford it) gets to bid or pass.
    expect(lotContenders(r)).toEqual(['p0']);
    const card = a.lot!.cardId;
    expect(passLot(r, 'p0', 10_001)).toBeNull();
    expect(a.results[0]).toMatchObject({ cardId: card, pid: null });
    expect(a.pools.p0).toHaveLength(0);
  });

  it('a lot with no bids that times out goes unsold', () => {
    const r = room(2, 2, { auctionTimer: 5 });
    startAuction(r, CUBE.list, seeded(8), getCard, 0);
    const a = r.auction!;
    a.budgets.p1 = 0;
    nominate(r, 'p0', a.open[0], 0, 0);
    auctionTick(r, 5000, getCard, seeded(1));
    expect(a.results[0].pid).toBeNull();
    expect(a.pools.p0).toHaveLength(0);
  });

  it('everyone who can still afford it gets to bid or pass; the broke player is not waited on', () => {
    const r = room(3, 3);
    startAuction(r, CUBE.list, seeded(9), getCard, 0);
    const a = r.auction!;
    a.budgets.p2 = 1;
    nominate(r, 'p0', a.open[0], 0, 2);
    expect(a.lot).not.toBeNull(); // p1 can still bid
    expect(lotContenders(r)).toEqual(['p1']);
    expect(placeBid(r, 'p2', 3, 1)).toMatch(/only have/);
    passLot(r, 'p1', 1);
    expect(a.pools.p0).toHaveLength(1);
  });

  it('a bot nominator does not award itself a card nobody else can bid on without bidding', () => {
    const r = room(2, 1, { auctionTimer: 0 });
    startAuction(r, CUBE.list, seeded(10), getCard, 0);
    const a = r.auction!;
    a.nominatorSeat = 1;
    a.budgets.p0 = 0;
    const rg = seeded(11);
    let t = 0;
    while (!a.done && t < 400_000) { auctionTick(r, t, getCard, rg); t += 250; }
    // Every card the bot got, it got by bidding, and it paid for it.
    const sold = a.results.filter((x) => x.pid === 'p1');
    expect(sold.every((x) => x.amount >= 2)).toBe(true);
    expect(200 - a.budgets.p1).toBe(sold.reduce((s, x) => s + x.amount, 0));
  });
});
