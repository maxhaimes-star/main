import { useState } from 'react';
import { CUBE } from '@ojb/shared/src/cube.ts';
import { navigate } from './App.tsx';
import { api, saveSeat } from './net.ts';
import { MyDecks } from './MyDecks.tsx';

export function Home() {
  const [name, setName] = useState(() => localStorage.getItem('ojb:name') ?? '');
  const [roomName, setRoomName] = useState('Cube night');
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const remember = () => localStorage.setItem('ojb:name', name.trim());

  async function create() {
    if (!name.trim()) return setErr('Enter your name first');
    remember();
    try {
      const r = await api<{ roomId: string; token: string; pid: string }>('/api/rooms', { name, roomName });
      saveSeat(r.roomId, { token: r.token, pid: r.pid, name });
      navigate(`/r/${r.roomId}`);
    } catch (e) { setErr((e as Error).message); }
  }

  function join() {
    const id = code.trim().replace(/.*\/r\//, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!id) return setErr('Paste a room link or code');
    remember();
    navigate(`/r/${id}`);
  }

  return (
    <div className="home">
      <div className="home-card">
        <h1>🍊 OJB Cube</h1>
        <p className="muted">Draft, auction or sealed with the {CUBE.name} cube ({CUBE.list.length} cards), your own imported cube, or real boosters from any set — or bring constructed decks — then play against friends anywhere.</p>
        <label>Your name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Max" maxLength={24} /></label>
        <div className="home-cols">
          <div>
            <h3>Start a room</h3>
            <label>Room name<input value={roomName} onChange={(e) => setRoomName(e.target.value)} maxLength={60} /></label>
            <button className="primary" onClick={create}>Create room</button>
          </div>
          <div>
            <h3>Join a friend</h3>
            <label>Room link or code<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="https://…/r/abc123" onKeyDown={(e) => e.key === 'Enter' && join()} /></label>
            <button onClick={join}>Join</button>
          </div>
        </div>
        {err && <div className="error">{err}</div>}
        <MyDecks />
      </div>
    </div>
  );
}
