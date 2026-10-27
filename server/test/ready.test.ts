import { describe, expect, it } from 'vitest';
import { Rooms } from '../src/rooms.ts';

function sealedRoom() {
  const rooms = new Rooms();
  const host = rooms.create('Ready', 'Max');
  const a = rooms.join(host.roomId, 'Sam')!;
  const b = rooms.join(host.roomId, 'Kim')!;
  const rec = rooms.rooms.get(host.roomId)!;
  rooms.handle(rec, host.pid, { t: 'updateSettings', settings: { mode: 'sealed', seats: 3, sealedPacks: 3, fillWithBots: false } });
  expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
  const save = (pid: string, ready: boolean) => rooms.handle(rec, pid, {
    t: 'saveDeck', deck: { main: rec.state.pools[pid].slice(0, 23), side: [], basics: { W: 0, U: 0, B: 0, R: 17, G: 0 } }, ready,
  });
  return { rooms, rec, host, a, b, save };
}

describe("the host's pair/start controls respect each player's ready state", () => {
  it('the host cannot pair a player who has not said they are ready', () => {
    const { rooms, rec, host, a, b, save } = sealedRoom();
    expect(save(a.pid, true)).toBeNull();
    expect(save(b.pid, false)).toBeNull();
    expect(rooms.handle(rec, host.pid, { t: 'createMatch', players: [a.pid, b.pid], bestOf: 3 })).toMatch(/Kim.*not ready/);
    expect(rec.state.matches).toHaveLength(0);
    expect(save(b.pid, true)).toBeNull();
    expect(rooms.handle(rec, host.pid, { t: 'createMatch', players: [a.pid, b.pid], bestOf: 3 })).toBeNull();
  });

  it('a player cannot start a match against someone who is still building', () => {
    const { rooms, rec, a, b, save } = sealedRoom();
    save(a.pid, true);
    save(b.pid, false);
    expect(rooms.handle(rec, a.pid, { t: 'createMatch', players: [a.pid, b.pid], bestOf: 1 })).toMatch(/not ready/);
  });

  it("pairing and finishing a match never changes anyone's ready flag", () => {
    const { rooms, rec, host, a, b, save } = sealedRoom();
    save(a.pid, true);
    save(b.pid, true);
    save(host.pid, false);
    expect(rooms.handle(rec, host.pid, { t: 'createMatch', players: [a.pid, b.pid], bestOf: 1 })).toBeNull();
    const m = rec.state.matches[0];
    expect(rooms.handle(rec, a.pid, { t: 'game', matchId: m.id, action: { t: 'concede' } })).toBeNull();
    expect(rec.state.decks[a.pid].ready).toBe(true);
    expect(rec.state.decks[b.pid].ready).toBe(true);
    expect(rec.state.decks[host.pid].ready).toBe(false);
    expect(rooms.view(rec, host.pid).decksReady).toMatchObject({ [a.pid]: true, [b.pid]: true, [host.pid]: false });
  });
});
