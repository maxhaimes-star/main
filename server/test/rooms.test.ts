import type { GameAction } from '@ojb/shared';
import { describe, expect, it } from 'vitest';
import { CUBE } from '@ojb/shared/src/cube.ts';
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
    // A random sealed pool may hold Arcane Savant with sideboard instants: decline its pre-game question.
    for (let i = 0; i < 20 && g.pregame; i++) { const q = g.pending[0]; rooms.handle(rec, q.pid, { t: 'game', matchId: m.id, action: { t: 'choose', id: q.id, value: 'no' } }); }
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

  it('free mulligan: proposed and accepted through the room; kept for the next game of the match', () => {
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
    const game = (action: GameAction, pid: string) => rooms.handle(rec, pid, { t: 'game', matchId: m.id, action });
    for (let i = 0; i < 20 && m.game!.pregame; i++) { const q = m.game!.pending[0]; game({ t: 'choose', id: q.id, value: 'no' }, q.pid); } // Arcane Savant in a random pool
    expect(game({ t: 'requestFreeMulligan' }, host.pid)).toBeNull();
    expect(game({ t: 'answerFreeMulligan', accept: true }, friend.pid)).toBeNull();
    expect(m.game!.freeMulligan?.on).toBe(true);
    expect(game({ t: 'mulligan' }, host.pid)).toBeNull();
    expect(game({ t: 'keep' }, host.pid)).toBeNull();
    expect(m.game!.players.find((p) => p.pid === host.pid)!.needsBottom).toBe(0);
    expect(game({ t: 'keep' }, friend.pid)).toBeNull();
    expect(game({ t: 'concede' }, friend.pid)).toBeNull();
    rooms.handle(rec, host.pid, { t: 'readyNext', matchId: m.id });
    rooms.handle(rec, friend.pid, { t: 'readyNext', matchId: m.id });
    expect(m.gameNumber).toBe(2);
    expect(m.game!.freeMulligan?.on).toBe(true);
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

  describe('leaving mid-draft', () => {
    function startDraft4() {
      const rooms = new Rooms();
      const host = rooms.create('Test', 'Max');
      const friend = rooms.join(host.roomId, 'Sam')!;
      const rec = rooms.rooms.get(host.roomId)!;
      rooms.handle(rec, host.pid, { t: 'updateSettings', settings: { mode: 'draft', seats: 4, fillWithBots: true, pickTimer: 0, packs: 1, packSize: 8 } });
      expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
      const player = (pid: string) => rec.state.players.find((p) => p.id === pid)!;
      const picks = (pid: string) => rec.state.draft!.picks[player(pid).seat];
      /** Friend picks whenever they have a pack, then the clock ticks (bots and the away seat pick). */
      const step = () => {
        const v = rooms.view(rec, friend.pid);
        if (v.draft?.pack) rooms.handle(rec, friend.pid, { t: 'pick', cardId: v.draft.pack[0] });
        rooms.tick(Date.now());
      };
      return { rooms, host, friend, rec, player, picks, step };
    }

    it('a bot takes over the seat so the draft continues, and the player can take it back', () => {
      const { rooms, host, friend, rec, player, picks, step } = startDraft4();
      expect(rooms.handle(rec, friend.pid, { t: 'takeSeat' })).toMatch(/not waiting/);
      expect(rooms.handle(rec, host.pid, { t: 'leaveSeat' })).toBeNull();
      expect(player(host.pid)).toMatchObject({ isBot: true, away: true, connected: false });
      expect(rooms.handle(rec, host.pid, { t: 'leaveSeat' })).toMatch(/already/);
      // Manual picks are refused while the bot has the seat.
      const v = rooms.view(rec, host.pid);
      if (v.draft?.pack) expect(rooms.handle(rec, host.pid, { t: 'pick', cardId: v.draft.pack[0] })).toMatch(/bot is playing/);
      for (let i = 0; i < 40 && picks(host.pid).length < 4; i++) step();
      expect(picks(host.pid).length).toBeGreaterThanOrEqual(4); // the bot drafted for them
      expect(rec.state.phase).toBe('drafting');
      const botPicks = picks(host.pid).slice();

      // Take the seat back and carry on by hand.
      expect(rooms.handle(rec, host.pid, { t: 'takeSeat' })).toBeNull();
      expect(player(host.pid)).toMatchObject({ isBot: false, connected: true });
      expect(player(host.pid).away).toBeUndefined();
      expect(picks(host.pid)).toEqual(botPicks);
      for (let i = 0; i < 400 && rec.state.phase === 'drafting'; i++) {
        step();
        const hv = rooms.view(rec, host.pid);
        if (hv.draft?.pack) expect(rooms.handle(rec, host.pid, { t: 'pick', cardId: hv.draft.pack[0] })).toBeNull();
      }
      expect(rec.state.phase).toBe('deckbuilding');
      expect(rec.state.pools[host.pid]).toHaveLength(8);
      expect(rec.state.pools[host.pid].slice(0, botPicks.length)).toEqual(botPicks);
    });

    it('a spectator can claim an away seat from a fresh browser', () => {
      const { rooms, host, rec, player } = startDraft4();
      const stranger = rooms.join(host.roomId, 'Max again')!;
      expect(stranger.spectator).toBe(true);
      expect(rooms.handle(rec, stranger.pid, { t: 'takeSeat', pid: host.pid })).toMatch(/not available/);
      rooms.handle(rec, host.pid, { t: 'leaveSeat' });
      expect(rooms.handle(rec, stranger.pid, { t: 'takeSeat', pid: host.pid })).toBeNull();
      expect(player(host.pid).isBot).toBe(false);
      expect(rec.tokens[stranger.token]).toBe(host.pid);
      expect(rec.spectators[stranger.pid]).toBeUndefined();
    });

    it('cannot leave outside a draft or auction', () => {
      const rooms = new Rooms();
      const host = rooms.create('Test', 'Max');
      const rec = rooms.rooms.get(host.roomId)!;
      expect(rooms.handle(rec, host.pid, { t: 'leaveSeat' })).toMatch(/while drafting/);
    });
  });

  it('constructed: saved decks (exact ids, cube cards) are accepted in a Freeform room and start a game', () => {
    const rooms = new Rooms();
    const host = rooms.create('Test', 'Max');
    const friend = rooms.join(host.roomId, 'Sam')!;
    const rec = rooms.rooms.get(host.roomId)!;
    expect(rooms.handle(rec, host.pid, { t: 'updateSettings', settings: { mode: 'constructed', format: 'Freeform' } })).toBeNull();
    expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
    const ids = CUBE.list.slice(0, 40);
    const saved = { main: ids.slice(0, 23), side: ids.slice(23), basics: { W: 0, U: 0, B: 0, R: 17, G: 0 } };
    expect(rooms.handle(rec, host.pid, { t: 'submitSavedDeck', deck: { ...saved, main: ['no_such_card'] } })).toMatch(/Unknown card/);
    expect(rooms.handle(rec, host.pid, { t: 'submitSavedDeck', deck: { main: [], side: [], basics: { W: 0, U: 0, B: 0, R: 0, G: 0 } } })).toMatch(/empty/);
    expect(rooms.handle(rec, host.pid, { t: 'submitSavedDeck', deck: saved })).toBeNull();
    expect(rooms.handle(rec, friend.pid, { t: 'submitSavedDeck', deck: saved })).toBeNull();
    expect(rec.state.decks[host.pid]).toMatchObject({ main: saved.main, side: saved.side, ready: true });
    expect(rooms.handle(rec, host.pid, { t: 'createMatch', players: [host.pid, friend.pid], bestOf: 1 })).toBeNull();
    const g = rec.state.matches[0].game!;
    expect(g.players[0].zones.hand).toHaveLength(7);
    expect(g.players[0].zones.library).toHaveLength(33);
  });

  it("a saved deck's sideboard reaches the game: Arcane Savant asks before the opening hands", () => {
    const rooms = new Rooms();
    const host = rooms.create('Test', 'Max');
    const friend = rooms.join(host.roomId, 'Sam')!;
    const rec = rooms.rooms.get(host.roomId)!;
    expect(rooms.handle(rec, host.pid, { t: 'updateSettings', settings: { mode: 'constructed', format: 'Freeform' } })).toBeNull();
    expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
    const savant = { main: ['arcane_savant'], side: ['lightning_bolt', 'questing_beast'], basics: { W: 0, U: 39, B: 0, R: 0, G: 0 } };
    const plain = { main: [], side: [], basics: { W: 0, U: 0, B: 0, R: 40, G: 0 } };
    expect(rooms.handle(rec, host.pid, { t: 'submitSavedDeck', deck: savant })).toBeNull();
    expect(rooms.handle(rec, friend.pid, { t: 'submitSavedDeck', deck: plain })).toBeNull();
    expect(rooms.handle(rec, host.pid, { t: 'createMatch', players: [host.pid, friend.pid], bestOf: 1 })).toBeNull();
    const match = rec.state.matches[0];
    const g = match.game!;
    const me = g.players.find((p) => p.pid === host.pid)!;
    expect(me.zones.hand).toHaveLength(0);
    const q = g.pending.find((x) => x.pid === host.pid)!;
    expect(q.options.filter((o) => o.value !== 'no').map((o) => g.cards[o.value].cardId)).toEqual(['lightning_bolt']);
    const bolt = q.options.find((o) => o.value !== 'no')!.value;
    expect(rooms.handle(rec, host.pid, { t: 'game', matchId: match.id, action: { t: 'choose', id: q.id, value: bolt } })).toBeNull();
    expect(me.zones.exile).toEqual([bolt]);
    expect(me.zones.hand).toHaveLength(7);
  });
});
