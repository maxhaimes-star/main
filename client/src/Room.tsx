import { useEffect, useState } from 'react';
import type { RoomView } from '@ojb/shared';
import { api, forgetSeat, loadSeat, saveSeat, type Send, useRoom } from './net.ts';
import { Lobby } from './Lobby.tsx';
import { Draft } from './Draft.tsx';
import { Auction } from './Auction.tsx';
import { Deckbuilder } from './Deckbuilder.tsx';
import { GameScreen } from './game/GameScreen.tsx';
import { navigate } from './App.tsx';
import { Chat } from './Chat.tsx';

export interface RoomProps { view: RoomView; send: Send; skew: number }

export function Room({ roomId }: { roomId: string }) {
  const [seat, setSeat] = useState(() => loadSeat(roomId));
  const [name, setName] = useState(() => localStorage.getItem('ojb:name') ?? '');
  const [joinErr, setJoinErr] = useState<string | null>(null);
  const { view, send, fatal, connected, toast, clockSkew } = useRoom(roomId, seat?.token ?? null);
  const [watching, setWatching] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    if (view) document.title = `${view.name} · OJB Cube`;
  }, [view?.name]);

  async function join() {
    if (!name.trim()) return setJoinErr('Enter your name');
    localStorage.setItem('ojb:name', name.trim());
    try {
      const r = await api<{ token: string; pid: string }>(`/api/rooms/${roomId}/join`, { name });
      const s = { token: r.token, pid: r.pid, name };
      saveSeat(roomId, s);
      setSeat(s);
    } catch (e) { setJoinErr((e as Error).message); }
  }

  if (!seat) {
    return (
      <div className="home"><div className="home-card">
        <h2>Join room <code>{roomId}</code></h2>
        <label>Your name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && join()} maxLength={24} /></label>
        <button className="primary" onClick={join}>Join</button>
        {joinErr && <div className="error">{joinErr}</div>}
      </div></div>
    );
  }
  if (fatal) {
    return (
      <div className="home"><div className="home-card">
        <h2>Can't open this room</h2><p>{fatal}</p>
        <button onClick={() => { forgetSeat(roomId); setSeat(null); }}>Join again</button>
        <button onClick={() => navigate('/')}>Home</button>
      </div></div>
    );
  }
  if (!view) return <div className="loading">Connecting…</div>;

  const props: RoomProps = { view, send, skew: clockSkew };
  const myMatch = view.matches.find((m) => m.players.includes(view.me) && !dismissed.includes(m.id));
  const watchMatch = watching ? view.matches.find((m) => m.id === watching) : null;
  const shownMatch = myMatch ?? watchMatch;
  const isPlayer = view.players.some((p) => p.id === view.me);

  let body;
  const leave = myMatch ? (myMatch.winner ? () => setDismissed([...dismissed, myMatch.id]) : undefined) : () => setWatching(null);
  if (shownMatch) body = <GameScreen {...props} match={shownMatch} onLeave={leave} />;
  else if (view.phase === 'lobby') body = <Lobby {...props} />;
  else if (view.phase === 'drafting') body = isPlayer ? <Draft {...props} /> : <Spectating view={view} />;
  else if (view.phase === 'auction') body = <Auction {...props} />;
  else body = <Deckbuilder {...props} onWatch={setWatching} />;

  return (
    <div className="room">
      {!connected && <div className="banner warn">Reconnecting…</div>}
      {toast && <div className="toast">{toast}</div>}
      {body}
      {!shownMatch && <Chat view={view} send={send} />}
    </div>
  );
}

function Spectating({ view }: { view: RoomView }) {
  return <div className="center-msg">You're watching. {view.players.length} players are drafting — you'll see their matches when they start playing.</div>;
}

export { saveSeat };
