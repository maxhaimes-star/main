import { describe, expect, it } from 'vitest';
import { Rooms } from '../src/rooms.ts';

describe('room codes on the server', () => {
  it('new rooms get 4-letter codes, found in any case', () => {
    const rooms = new Rooms();
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(rooms.create('x', 'y').roomId);
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-HJ-NP-Z]{4}$/);
    const id = [...ids][0];
    expect(rooms.find(id.toLowerCase())?.state.id).toBe(id);
    expect(rooms.join(id.toLowerCase(), 'Sam')).not.toBeNull();
  });

  it('legacy lowercase ids keep working', () => {
    const rooms = new Rooms();
    const r = rooms.create('x', 'Max');
    const rec = rooms.rooms.get(r.roomId)!;
    rooms.rooms.delete(r.roomId);
    rec.state.id = 'ab3xk9';
    rooms.rooms.set('ab3xk9', rec);
    expect(rooms.find('ab3xk9')).toBe(rec);
    expect(rooms.find('AB3XK9')).toBe(rec);
    expect(rooms.auth('ab3xk9', r.token)?.pid).toBe(r.pid);
  });
});
