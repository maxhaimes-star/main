import { describe, expect, it } from 'vitest';
import { Rooms } from '../src/rooms.ts';

describe('rooms', () => {
  it('runs a sealed event into a best-of-3 match', () => {
    const rooms = new Rooms();
    const host = rooms.create('Test', 'Max');
    const friend = rooms.join(host.roomId, 'Sam')!;
    const rec = rooms.rooms.get(host.roomId)!;
    expect(rooms.handle(rec, friend.pid, { t: 'start' })).toMatch(/host/);
    expect(rooms.handle(rec, host.pid, { t: 'updateSettings', settings: { mode: 'sealed', seats: 2, sealedPacks: 3 } })).toBeNull();
    expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
    expect(rec.state.phase).toBe('deckbuilding');
    for (const p of [host.pid, friend.pid]) {
      const pool = rec.state.pools[p];
      expect(pool).toHaveLength(45);
      expect(rooms.handle(rec, p, { t: 'saveDeck', deck: { main: pool.slice(0, 23), side: [], basics: { W: 0, U: 0, B: 0, R: 17, G: 0 } }, ready: true })).toBeNull();
      expect(rec.state.decks[p].side).toHaveLength(22);
    }
    // can't sneak in cards
    expect(rooms.handle(rec, host.pid, { t: 'saveDeck', deck: { main: ['black_lotus'], side: [], basics: { W: 0, U: 0, B: 0, R: 0, G: 0 } }, ready: true })).toMatch(/not in your pool/);
    expect(rooms.handle(rec, host.pid, { t: 'createMatch', players: [host.pid, friend.pid], bestOf: 3 })).toBeNull();
    const m = rec.state.matches[0];
    expect(m.game!.players[0].zones.hand).toHaveLength(7);
    expect(m.game!.players[0].zones.library).toHaveLength(33);
    // Views hide the opponent's hand
    const v = rooms.view(rec, host.pid);
    const g = v.matches[0].game!;
    const oppHand = g.players.find((p) => p.pid === friend.pid)!.zones.hand;
    expect(oppHand.every((iid) => 'hidden' in g.cards[iid])).toBe(true);
    // concede → sideboarding → next game
    expect(rooms.handle(rec, host.pid, { t: 'game', matchId: m.id, action: { t: 'concede' } })).toBeNull();
    expect(m.wins[friend.pid]).toBe(1);
    expect(m.sideboarding).toBe(true);
    rooms.handle(rec, host.pid, { t: 'readyNext', matchId: m.id });
    rooms.handle(rec, friend.pid, { t: 'readyNext', matchId: m.id });
    expect(m.gameNumber).toBe(2);
    expect(m.game!.startingPlayer).toBe(host.pid);
  });

  it('games are rules-enforced; a player at 0 life loses and the match records the win', () => {
    const rooms = new Rooms();
    const host = rooms.create('Test', 'Max');
    const friend = rooms.join(host.roomId, 'Sam')!;
    const rec = rooms.rooms.get(host.roomId)!;
    rooms.handle(rec, host.pid, { t: 'updateSettings', settings: { mode: 'sealed', seats: 2, sealedPacks: 3 } });
    rooms.handle(rec, host.pid, { t: 'start' });
    for (const p of [host.pid, friend.pid]) {
      rooms.handle(rec, p, { t: 'saveDeck', deck: { main: rec.state.pools[p].slice(0, 23), side: [], basics: { W: 0, U: 0, B: 0, R: 17, G: 0 } }, ready: true });
    }
    rooms.handle(rec, host.pid, { t: 'createMatch', players: [host.pid, friend.pid], bestOf: 3 });
    const m = rec.state.matches[0];
    const g = m.game!;
    expect(g.strict).toBe(true);
    rooms.handle(rec, host.pid, { t: 'game', matchId: m.id, action: { t: 'keep' } });
    rooms.handle(rec, friend.pid, { t: 'game', matchId: m.id, action: { t: 'keep' } });
    expect(rooms.handle(rec, host.pid, { t: 'game', matchId: m.id, action: { t: 'life', pid: friend.pid, delta: -20 } })).toMatch(/fix mode/);
    g.players.find((p) => p.pid === friend.pid)!.life = 0; // e.g. after damage
    expect(rooms.handle(rec, host.pid, { t: 'game', matchId: m.id, action: { t: 'setStops', own: ['main1'], opp: [] } })).toBeNull();
    expect(g.phase).toBe('over');
    expect(g.winner).toBe(host.pid);
    expect(m.wins[host.pid]).toBe(1);
    expect(m.sideboarding).toBe(true);
  });

  it('fills a draft with bots and drafts to completion via ticks', () => {
    const rooms = new Rooms();
    const host = rooms.create('Test', 'Max');
    const rec = rooms.rooms.get(host.roomId)!;
    rooms.handle(rec, host.pid, { t: 'updateSettings', settings: { mode: 'draft', seats: 4, fillWithBots: true, pickTimer: 0 } });
    expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
    expect(rec.state.players).toHaveLength(4);
    let guard = 0;
    while (rec.state.phase === 'drafting' && guard++ < 1000) {
      rooms.tick(Date.now());
      const view = rooms.view(rec, host.pid);
      if (view.draft?.pack) rooms.handle(rec, host.pid, { t: 'pick', cardId: view.draft.pack[0] });
    }
    expect(rec.state.phase).toBe('deckbuilding');
    expect(rec.state.pools[host.pid]).toHaveLength(45);
    for (const p of rec.state.players.filter((x) => x.isBot)) expect(rec.state.decks[p.id].ready).toBe(true);
  });
});
