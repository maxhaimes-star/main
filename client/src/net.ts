import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { CardPayload, ClientMsg, RoomView } from '@ojb/shared';
import { receiveCards } from './cards.tsx';

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

/** Live room connection. */
export function useRoom(roomId: string, token: string | null) {
  const [view, setView] = useState<RoomView | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [clockSkew, setClockSkew] = useState(0);
  const sock = useRef<Socket | null>(null);

  useEffect(() => {
    if (!token) return;
    const s = io({ auth: { roomId, token }, transports: ['websocket', 'polling'] });
    sock.current = s;
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    s.on('cards', (p: CardPayload) => receiveCards(p));
    s.on('room', (v: RoomView) => {
      setView(v);
      setClockSkew(v.serverNow - Date.now());
    });
    s.on('fatal', (m: string) => setFatal(m));
    return () => { s.disconnect(); };
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

  return { view, send, fatal, connected, toast, setToast, clockSkew };
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
