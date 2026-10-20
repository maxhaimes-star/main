import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type RoomRecord, Rooms } from '../src/rooms.ts';
import { loadRoomSecret, Restorer, SnapshotCodec } from '../src/snapshot.ts';

const codec = new SnapshotCodec('test-secret');
const seatOf = (rec: RoomRecord, pid: string) => rec.state.players.find((p) => p.id === pid)!.seat;

/** A room with two humans and two bots, mid-draft, the host's first pick made. */
function draftRoom() {
  const rooms = new Rooms();
  const host = rooms.create('Snap', 'Max');
  const friend = rooms.join(host.roomId, 'Sam')!;
  const rec = rooms.rooms.get(host.roomId)!;
  expect(rooms.handle(rec, host.pid, { t: 'updateSettings', settings: { mode: 'draft', seats: 4, pickTimer: 60 } })).toBeNull();
  expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
  const pack = rec.state.draft!.queues[seatOf(rec, host.pid)][0];
  expect(rooms.handle(rec, host.pid, { t: 'pick', cardId: pack[0] })).toBeNull();
  return { rooms, host, friend, rec };
}

describe('room snapshots', () => {
  it('seal/open round-trips and hides the contents', () => {
    const { rec, host } = draftRoom();
    const blob = codec.seal(rec, 1000);
    // Opaque: no names, tokens or card ids in the clear.
    expect(blob).not.toContain('Max');
    expect(blob).not.toContain(host.token);
    expect(blob).not.toContain(rec.state.draft!.picks[0][0]);
    const out = codec.open(blob)!;
    expect(out.takenAt).toBe(1000);
    expect(out.rec.state.draft!.picks).toEqual(rec.state.draft!.picks);
    expect(out.rec.tokens).toEqual(rec.tokens);
  });

  it('rejects tampered blobs and blobs from another secret', () => {
    const { rec } = draftRoom();
    const blob = codec.seal(rec);
    const parts = blob.split('.');
    const ct = parts[2].slice(0, 5) + (parts[2][5] === 'A' ? 'B' : 'A') + parts[2].slice(6);
    expect(codec.open([parts[0], parts[1], ct, parts[3], parts[4]].join('.'))).toBeNull();
    expect(codec.open(blob.slice(0, -2) + 'xx')).toBeNull();
    expect(new SnapshotCodec('other-secret').open(blob)).toBeNull();
    expect(codec.open('garbage')).toBeNull();
    expect(codec.open(42)).toBeNull();
  });

  it('restores a lost room under the same code, with draft state, seats and tokens', () => {
    const { rec, host, friend } = draftRoom();
    const before = JSON.parse(JSON.stringify(rec.state));
    const takenAt = Date.now();
    const blob = codec.seal(rec, takenAt);

    // "Restart": a fresh server with no rooms.
    const rooms2 = new Rooms();
    const restorer = new Restorer(rooms2, codec);
    expect(restorer.restore(blob, 'not-a-token')).toMatchObject({ ok: false, status: 403 });
    const r = restorer.restore(blob, friend.token, takenAt + 30_000);
    expect(r).toEqual({ ok: true, roomId: host.roomId, restored: true });
    const back = rooms2.rooms.get(host.roomId)!;
    expect(back.state.draft!.picks).toEqual(before.draft.picks);
    expect(back.state.draft!.queues).toEqual(before.draft.queues);
    expect(back.state.players.map((p) => p.name)).toEqual(before.players.map((p: { name: string }) => p.name));
    // Timers keep the time they had left.
    const fs_ = seatOf(back, friend.pid);
    expect(back.state.draft!.deadlines[fs_]).toBe(before.draft.deadlines[fs_] + 30_000);
    // Members are back with their old seat tokens; humans show as offline until they reconnect.
    expect(rooms2.auth(host.roomId, host.token)?.pid).toBe(host.pid);
    expect(rooms2.auth(host.roomId, friend.token)?.pid).toBe(friend.pid);
    expect(back.state.players.filter((p) => !p.isBot).every((p) => !p.connected)).toBe(true);
    // The draft goes on.
    const pack = back.state.draft!.queues[fs_][0];
    expect(rooms2.handle(back, friend.pid, { t: 'pick', cardId: pack[0] })).toBeNull();
    // A second member uploading the same snapshot doesn't reset it.
    expect(restorer.restore(blob, host.token)).toEqual({ ok: true, roomId: host.roomId, restored: false });
    expect(rooms2.rooms.get(host.roomId)!.state.draft!.picks[fs_]).toHaveLength(1);
  });

  it('prefers a newer snapshot while the restored room is untouched', () => {
    const { rooms, rec, host, friend } = draftRoom();
    rec.state.updatedAt -= 10; // the next action gets a later timestamp
    const old = codec.seal(rec);
    const fs_ = seatOf(rec, friend.pid);
    const pack = rec.state.draft!.queues[fs_][0];
    expect(rooms.handle(rec, friend.pid, { t: 'pick', cardId: pack[0] })).toBeNull();
    const newer = codec.seal(rec);
    const rooms2 = new Rooms();
    const restorer = new Restorer(rooms2, codec);
    expect(restorer.restore(old, host.token)).toMatchObject({ ok: true, restored: true });
    expect(rooms2.rooms.get(host.roomId)!.state.draft!.picks[fs_]).toHaveLength(0);
    expect(restorer.restore(newer, friend.token)).toMatchObject({ ok: true, restored: true });
    expect(rooms2.rooms.get(host.roomId)!.state.draft!.picks[fs_]).toHaveLength(1);
    // Once someone acts, uploads no longer replace the live room.
    const live = rooms2.rooms.get(host.roomId)!;
    live.state.updatedAt -= 10;
    rooms2.handle(live, host.pid, { t: 'chat', text: 'hi' });
    expect(restorer.restore(newer, friend.token)).toMatchObject({ ok: true, restored: false });
    expect(rooms2.rooms.get(host.roomId)!.state.chat).toHaveLength(1);
  });

  it('moves a restored room to a new code when its code was taken meanwhile', () => {
    const { rec, host, friend } = draftRoom();
    const blob = codec.seal(rec);
    const rooms2 = new Rooms();
    const other = rooms2.create('Someone else', 'Zed');
    const otherRec = rooms2.rooms.get(other.roomId)!;
    rooms2.rooms.delete(other.roomId);
    otherRec.state.id = host.roomId;
    rooms2.rooms.set(host.roomId, otherRec);
    const restorer = new Restorer(rooms2, codec);
    const r = restorer.restore(blob, host.token);
    if (!r.ok) throw new Error(r.error);
    expect(r.restored).toBe(true);
    expect(r.roomId).not.toBe(host.roomId);
    expect(rooms2.rooms.get(host.roomId)).toBe(otherRec);
    expect(rooms2.auth(r.roomId, friend.token)?.pid).toBe(friend.pid);
    // The other members land in the same moved room.
    expect(restorer.restore(blob, friend.token)).toEqual({ ok: true, roomId: r.roomId, restored: false });
  });

  it('keeps games (minus undo history) in the snapshot', () => {
    const rooms = new Rooms();
    const host = rooms.create('Test', 'Max');
    const friend = rooms.join(host.roomId, 'Sam')!;
    const rec = rooms.rooms.get(host.roomId)!;
    rooms.handle(rec, host.pid, { t: 'updateSettings', settings: { mode: 'sealed', seats: 2, sealedPacks: 3 } });
    rooms.handle(rec, host.pid, { t: 'start' });
    for (const p of [host.pid, friend.pid]) {
      rooms.handle(rec, p, { t: 'saveDeck', deck: { main: rec.state.pools[p].slice(0, 23), side: [], basics: { W: 0, U: 0, B: 0, R: 17, G: 0 } }, ready: true });
    }
    expect(rooms.handle(rec, host.pid, { t: 'createMatch', players: [host.pid, friend.pid], bestOf: 3 })).toBeNull();
    const rooms2 = new Rooms();
    expect(new Restorer(rooms2, codec).restore(codec.seal(rec), host.token)).toMatchObject({ ok: true, restored: true });
    const back = rooms2.rooms.get(host.roomId)!;
    const g = back.state.matches[0].game!;
    expect(g.players[0].zones.hand).toEqual(rec.state.matches[0].game!.players[0].zones.hand);
    expect(g.players[1].zones.library).toEqual(rec.state.matches[0].game!.players[1].zones.library);
    expect(rooms2.view(back, host.pid).matches[0].game).toBeTruthy();
  });
});

describe('room secret', () => {
  it('uses ROOM_SECRET, else keeps a generated one in DATA_DIR', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ojb-secret-'));
    expect(loadRoomSecret(dir, { ROOM_SECRET: 'abc' })).toEqual({ secret: 'abc', source: 'env' });
    const a = loadRoomSecret(dir, {});
    expect(a.source).toBe('generated');
    expect(loadRoomSecret(dir, {})).toEqual({ secret: a.secret, source: 'file' });
    fs.rmSync(dir, { recursive: true });
  });
});
