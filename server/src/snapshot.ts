/**
 * Room snapshots: lets rooms survive server restarts on hosts without a persistent disk (Render's free tier).
 *
 * The server seals the whole room record (state + seat tokens) into an opaque blob and sends it to every member's browser,
 * which keeps the newest one in localStorage. When the server comes back without the room, the first browser to reconnect
 * uploads its blob, the server checks it and restores the room under the same code, and the other members' browsers reconnect
 * with their old seat tokens.
 *
 * Security trade-off: every member holds the full room, including hidden information (other players' hands and picks, library
 * order, unopened packs, everyone's seat tokens). So the blob is
 *   - encrypted (AES-256-GCM): a player can't read hidden information out of their own localStorage, and
 *   - signed (HMAC-SHA256 over the whole envelope): the server only restores blobs it made itself, so nobody can forge a
 *     room, a pool or a game state.
 * Keys come from ROOM_SECRET. What a member *can* do is replay an older blob of a room the server has lost (a rollback to
 * a state they already saw); restore prefers the newest snapshot offered while the restored room is untouched, and only
 * members of the room (holding a seat token inside the blob) can restore it.
 *
 * ROOM_SECRET must stay the same across restarts: set it as an environment variable on the host. Without it the server makes a
 * random secret and keeps it in DATA_DIR/room-secret, which survives restarts only where DATA_DIR survives (not on Render free).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { canonicalRoomId } from '@ojb/shared/src/roomcode.ts';
import type { RoomRecord, Rooms } from './rooms.ts';
import { ensureCards } from './roomcards.ts';

const FORMAT = 's1';

/** ROOM_SECRET from the environment, else one kept in DATA_DIR (created on first run). */
export function loadRoomSecret(dataDir: string, env: NodeJS.ProcessEnv = process.env): { secret: string; source: 'env' | 'file' | 'generated' } {
  const fromEnv = env.ROOM_SECRET?.trim();
  if (fromEnv) return { secret: fromEnv, source: 'env' };
  const file = path.join(dataDir, 'room-secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s) return { secret: s, source: 'file' };
  } catch { /* first run */ }
  const secret = crypto.randomBytes(32).toString('base64url');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch { /* read-only disk: secret lives for this process only */ }
  return { secret, source: 'generated' };
}

export interface OpenedSnapshot { rec: RoomRecord; takenAt: number }

export class SnapshotCodec {
  private encKey: Buffer;
  private macKey: Buffer;

  constructor(secret: string) {
    if (!secret) throw new Error('empty room secret');
    const derive = (info: string) => Buffer.from(crypto.hkdfSync('sha256', secret, 'ojb-room-snapshot', info, 32));
    this.encKey = derive('enc');
    this.macKey = derive('mac');
  }

  /** Encrypted, signed blob of the room. Undo history is left out (as in rooms.json). */
  seal(rec: RoomRecord, takenAt = Date.now()): string {
    const json = JSON.stringify({ takenAt, rec }, (k, v) => (k === 'history' ? [] : v));
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.encKey, iv);
    const ct = Buffer.concat([c.update(zlib.deflateRawSync(json)), c.final()]);
    const body = [FORMAT, iv.toString('base64url'), ct.toString('base64url'), c.getAuthTag().toString('base64url')].join('.');
    return `${body}.${this.mac(body)}`;
  }

  /** The room in a blob, or null when it isn't one this server (this ROOM_SECRET) sealed. */
  open(blob: unknown): OpenedSnapshot | null {
    if (typeof blob !== 'string' || blob.length > 50_000_000) return null;
    const parts = blob.split('.');
    if (parts.length !== 5 || parts[0] !== FORMAT) return null;
    const body = parts.slice(0, 4).join('.');
    const want = Buffer.from(this.mac(body));
    const got = Buffer.from(parts[4]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.encKey, Buffer.from(parts[1], 'base64url'));
      d.setAuthTag(Buffer.from(parts[3], 'base64url'));
      const plain = Buffer.concat([d.update(Buffer.from(parts[2], 'base64url')), d.final()]);
      const x = JSON.parse(zlib.inflateRawSync(plain, { maxOutputLength: 200_000_000 }).toString('utf8')) as OpenedSnapshot;
      return validRecord(x?.rec) && typeof x.takenAt === 'number' ? x : null;
    } catch {
      return null;
    }
  }

  private mac(body: string): string {
    return crypto.createHmac('sha256', this.macKey).update(body).digest('base64url');
  }
}

function validRecord(rec: RoomRecord | undefined): rec is RoomRecord {
  const s = rec?.state;
  return !!s && typeof s.id === 'string' && canonicalRoomId(s.id) === s.id && Array.isArray(s.players) && typeof s.settings === 'object'
    && typeof rec.tokens === 'object' && rec.tokens !== null && typeof rec.spectators === 'object' && typeof s.updatedAt === 'number';
}

export type RestoreResult =
  | { ok: true; roomId: string; restored: boolean }
  | { ok: false; status: number; error: string };

/** Puts rooms back from snapshot blobs (see the top of this file). */
export class Restorer {
  /** Restored rooms: id -> state.updatedAt of the snapshot they came from (changes as soon as anyone acts). */
  private restored = new Map<string, number>();
  /** "oldId:createdAt" -> new id, when a lost room's code was taken by a new room before it came back. */
  private moved = new Map<string, string>();

  constructor(private rooms: Rooms, private codec: SnapshotCodec) {}

  restore(blob: unknown, token: unknown, now = Date.now()): RestoreResult {
    const snap = this.codec.open(blob);
    if (!snap) return { ok: false, status: 400, error: 'This room snapshot is not valid on this server (was ROOM_SECRET changed?)' };
    const { rec, takenAt } = snap;
    if (typeof token !== 'string' || !rec.tokens[token]) return { ok: false, status: 403, error: 'You are not a member of this room' };
    const s = rec.state;
    const movedKey = `${s.id}:${s.createdAt}`;
    const movedTo = this.moved.get(movedKey);
    if (movedTo && this.rooms.rooms.has(movedTo)) return { ok: true, roomId: movedTo, restored: false };

    const live = this.rooms.rooms.get(s.id);
    if (live) {
      const same = live.state.createdAt === s.createdAt && live.state.hostId === s.hostId;
      if (same) {
        // Another member restored it first. Swap in this snapshot only if it is newer and nobody has acted since.
        const version = this.restored.get(s.id);
        if (version !== undefined && live.state.updatedAt === version && s.updatedAt > version) {
          this.install(rec, takenAt, now);
          return { ok: true, roomId: s.id, restored: true };
        }
        return { ok: true, roomId: s.id, restored: false };
      }
      // A new room took the code while this one was gone: bring it back under a fresh code.
      s.id = this.rooms.newCode();
      this.moved.set(movedKey, s.id);
    }
    this.install(rec, takenAt, now);
    return { ok: true, roomId: s.id, restored: true };
  }

  private install(rec: RoomRecord, takenAt: number, now: number) {
    const s = rec.state;
    for (const p of s.players) p.connected = p.isBot && !p.away;
    shiftDeadlines(rec, Math.max(0, now - takenAt));
    ensureCards(cardIdsIn(s));
    this.rooms.rooms.set(s.id, rec);
    this.rooms.dirty.add(s.id);
    this.restored.set(s.id, s.updatedAt);
  }
}

/** Timers keep the time they had left when the snapshot was taken (the server was down in between). */
export function shiftDeadlines(rec: RoomRecord, delta: number) {
  const d = rec.state.draft;
  if (d) d.deadlines = d.deadlines.map((x) => (x == null ? x : x + delta));
  const a = rec.state.auction;
  if (a) {
    if (a.nominateDeadline != null) a.nominateDeadline += delta;
    if (a.lot?.deadline != null) a.lot.deadline += delta;
  }
}

/** Every string in the room that could be a card id (outside chat and games), so database cards are registered again. */
function cardIdsIn(s: RoomRecord['state']): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk([s.settings.customList, s.pools, s.decks, s.draft, s.auction, s.matches.map((m) => m.decks)]);
  return out;
}
