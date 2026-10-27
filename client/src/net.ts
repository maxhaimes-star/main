import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { CardPayload, ClientMsg, RoomView } from '@ojb/shared';
import { receiveCards } from './cards.tsx';
import { loadSnapshot, type RoomSnapshot, saveSnapshot } from './snapshots.ts';

const KEY = (roomId: string) => `ojb:seat:${roomId}`;

export interface Seat { token: string; pid: string; name: string }

export function loadSeat(roomId: string): Seat | null {
  try {
    const raw = localStorage.getItem(KEY(roomId));
    return raw ? (JSON.parse(raw) as Seat) : null;
  } catch {
    return null;
  }
}

export function saveSeat(roomId: string, seat: Seat) {
  try { localStorage.setItem(KEY(roomId), JSON.stringify(seat)); } catch { /* private mode */ }
}

export function forgetSeat(roomId: string) {
  try { localStorage.removeItem(KEY(roomId)); } catch { /* ignore */ }
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json as T;
}

export type Send = (msg: ClientMsg) => Promise<string | null>;

/** How long a member without a usable snapshot waits for another member to restore a room the server lost. */
const RESTORE_WAIT_TRIES = 40;
const RESTORE_RETRY_MS = 3000;

/**
 * Live room connection. When the server has lost the room (restart / spin-down) the browser uploads its stored snapshot
 * (client/src/snapshots.ts) and reconnects; members without one keep retrying until someone restores it. `onMoved` gets
 * the room's new code if it had to come back under a different one.
 */
export function useRoom(roomId: string, token: string | null, onMoved?: (newId: string) => void) {
  const [view, setView] = useState<RoomView | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [clockSkew, setClockSkew] = useState(0);
  /** The server lost the room and we're bringing it back (or waiting for someone who can). */
  const [restoring, setRestoring] = useState(false);
  const sock = useRef<Socket | null>(null);
  const movedRef = useRef(onMoved);
  movedRef.current = onMoved;

  useEffect(() => {
    if (!token) return;
    const s = io({ auth: { roomId, token }, transports: ['websocket', 'polling'] });
    sock.current = s;
    let stopped = false;
    let waits = 0;
    let triedOnFatal = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const reconnect = (ms: number) => { clearTimeout(retry); retry = setTimeout(() => { if (!stopped) s.connect(); }, ms); };

    /** Upload this browser's snapshot of the room. */
    async function restore(): Promise<'ok' | 'moved' | 'none' | 'failed'> {
      const snap = loadSnapshot(roomId);
      if (!snap) return 'none';
      try {
        const r = await api<{ roomId: string; restored: boolean }>('/api/rooms/restore', { blob: snap.blob, token });
        if (r.restored) setToast('The server restarted — room restored');
        if (r.roomId !== roomId) {
          saveSnapshot({ ...snap, roomId: r.roomId });
          movedRef.current?.(r.roomId);
          return 'moved';
        }
        return 'ok';
      } catch { return 'failed'; }
    }

    s.on('connect', () => { setConnected(true); setRestoring(false); waits = 0; });
    s.on('disconnect', () => setConnected(false));
    s.on('cards', (p: CardPayload) => receiveCards(p));
    s.on('room', (v: RoomView) => {
      setView(v);
      setClockSkew(v.serverNow - Date.now());
    });
    s.on('snapshot', (snap: RoomSnapshot) => { saveSnapshot(snap); });
    s.on('missing', async () => {
      setRestoring(true);
      const r = await restore();
      if (stopped || r === 'moved') return;
      if (r === 'ok') return reconnect(0);
      if (++waits > RESTORE_WAIT_TRIES) {
        setRestoring(false);
        setFatal('The server restarted and lost this room, and nobody who has a copy of it has come back yet.');
        return;
      }
      reconnect(RESTORE_RETRY_MS);
    });
    s.on('fatal', async (m: string) => {
      // The code may now belong to another room (ours came back under a new code): our snapshot finds it.
      if (!triedOnFatal && loadSnapshot(roomId)) {
        triedOnFatal = true;
        if (await restore() === 'moved' || stopped) return;
      }
      setFatal(m);
    });
    return () => { stopped = true; clearTimeout(retry); s.disconnect(); };
  }, [roomId, token]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const send: Send = useCallback((msg) => new Promise((resolve) => {
    const s = sock.current;
    if (!s) return resolve('Not connected');
    s.timeout(8000).emit('msg', msg, (err: Error | null, r?: { error: string | null }) => {
      const e = err ? 'Server did not respond' : r?.error ?? null;
      if (e) setToast(e);
      resolve(e);
    });
  }), []);

  return { view, send, fatal, connected, toast, setToast, clockSkew, restoring };
}

/** Re-render every `ms` (for countdowns). */
export function useTick(ms = 250) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function download(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
