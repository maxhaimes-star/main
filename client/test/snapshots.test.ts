import { describe, expect, it } from 'vitest';
import { forgetSnapshot, loadSnapshot, saveSnapshot, type RoomSnapshot, type StorageLike } from '../src/snapshots.ts';

/** In-memory storage; `quota` caps the total characters stored (like localStorage's ~5MB). */
function mem(quota = Infinity): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    removeItem: (k) => { data.delete(k); },
    setItem: (k, v) => {
      const used = [...data].reduce((n, [kk, vv]) => n + (kk === k ? 0 : vv.length), 0);
      if (used + v.length > quota) throw new Error('QuotaExceededError');
      data.set(k, v);
    },
  };
}

const snap = (roomId: string, v: number, takenAt = v, blob = 'x'.repeat(10)): RoomSnapshot => ({ roomId, v, takenAt, blob });

describe('room snapshot storage', () => {
  it('stores the newest snapshot per room', () => {
    const s = mem();
    expect(saveSnapshot(snap('ABCD', 5), s)).toBe(true);
    expect(saveSnapshot(snap('ABCD', 3), s)).toBe(false);
    expect(loadSnapshot('ABCD', s)?.v).toBe(5);
    expect(saveSnapshot(snap('ABCD', 7), s)).toBe(true);
    expect(loadSnapshot('ABCD', s)?.v).toBe(7);
    expect(loadSnapshot('WXYZ', s)).toBeNull();
    forgetSnapshot('ABCD', s);
    expect(loadSnapshot('ABCD', s)).toBeNull();
  });

  it('keeps at most 8 rooms and drops old ones', () => {
    const s = mem();
    const now = Date.now();
    saveSnapshot(snap('OLDD', 1, now - 30 * 24 * 3600 * 1000), s, now);
    for (let i = 0; i < 10; i++) saveSnapshot(snap(`R${String.fromCharCode(65 + i)}AA`, now + i, now + i), s, now + i);
    const keys = [...s.data.keys()];
    expect(keys).toHaveLength(8);
    expect(keys).not.toContain('ojb:snap:OLDD');
    expect(keys).toContain('ojb:snap:RJAA');
  });

  it('makes room when storage is full by dropping older rooms', () => {
    const s = mem(300);
    saveSnapshot(snap('AAAA', 1, 1, 'a'.repeat(100)), s);
    saveSnapshot(snap('BBBB', 2, 2, 'b'.repeat(100)), s);
    expect(saveSnapshot(snap('CCCC', 3, 3, 'c'.repeat(100)), s)).toBe(true);
    expect(loadSnapshot('AAAA', s)).toBeNull();
    expect(loadSnapshot('CCCC', s)?.v).toBe(3);
    expect(saveSnapshot(snap('DDDD', 4, 4, 'd'.repeat(1000)), s)).toBe(false);
  });

  it('ignores corrupt entries and missing storage', () => {
    const s = mem();
    s.setItem('ojb:snap:ABCD', '{not json');
    expect(loadSnapshot('ABCD', s)).toBeNull();
    expect(saveSnapshot(snap('ABCD', 1), s)).toBe(true);
    expect(saveSnapshot(snap('ABCD', 1), null)).toBe(false);
  });
});
