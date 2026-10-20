// Room snapshots kept in the browser so a room survives a server restart (see server/src/snapshot.ts). The blob is opaque:
// encrypted and signed by the server; the browser only stores the newest one per room and hands it back when the server lost
// the room.

export interface RoomSnapshot {
  roomId: string;
  /** The room's updatedAt when the snapshot was sealed (newer wins). */
  v: number;
  takenAt: number;
  blob: string;
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key'> & { readonly length: number };

const PREFIX = 'ojb:snap:';
const MAX_ROOMS = 8;
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

function defaultStorage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function valid(x: unknown): x is RoomSnapshot {
  const s = x as RoomSnapshot;
  return !!s && typeof s.roomId === 'string' && typeof s.v === 'number' && typeof s.takenAt === 'number' && typeof s.blob === 'string';
}

export function loadSnapshot(roomId: string, storage: StorageLike | null = defaultStorage()): RoomSnapshot | null {
  try {
    const raw = storage?.getItem(PREFIX + roomId);
    const s = raw ? JSON.parse(raw) as unknown : null;
    return valid(s) && s.roomId === roomId ? s : null;
  } catch { return null; }
}

/** All stored snapshots, oldest first. */
function all(storage: StorageLike): RoomSnapshot[] {
  const out: RoomSnapshot[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (!k?.startsWith(PREFIX)) continue;
    const s = loadSnapshot(k.slice(PREFIX.length), storage);
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.takenAt - b.takenAt);
}

/**
 * Keep this snapshot unless a newer one of the room is already stored. Old rooms are pruned (at most MAX_ROOMS, none older
 * than two weeks); when storage is full, the oldest other snapshots make room. Returns whether it was stored.
 */
export function saveSnapshot(snap: RoomSnapshot, storage: StorageLike | null = defaultStorage(), now = Date.now()): boolean {
  if (!storage || !valid(snap)) return false;
  const cur = loadSnapshot(snap.roomId, storage);
  if (cur && cur.v > snap.v) return false;
  const others = all(storage).filter((s) => s.roomId !== snap.roomId);
  const drop = others.filter((s, i) => now - s.takenAt > MAX_AGE_MS || i < others.length - (MAX_ROOMS - 1));
  for (const s of drop) storage.removeItem(PREFIX + s.roomId);
  const keep = others.filter((s) => !drop.includes(s));
  const text = JSON.stringify(snap);
  for (;;) {
    try { storage.setItem(PREFIX + snap.roomId, text); return true; } catch {
      const victim = keep.shift();
      if (!victim) return false;
      storage.removeItem(PREFIX + victim.roomId);
    }
  }
}

export function forgetSnapshot(roomId: string, storage: StorageLike | null = defaultStorage()) {
  try { storage?.removeItem(PREFIX + roomId); } catch { /* ignore */ }
}
