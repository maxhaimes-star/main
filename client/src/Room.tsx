import { useEffect, useRef, useState } from 'react';
import type { RoomView } from '@ojb/shared';
import { api, forgetSeat, loadSeat, saveSeat, type Send, useRoom } from './net.ts';
import { Lobby } from './Lobby.tsx';
import { AwayBanner, Draft } from './Draft.tsx';
import { Auction } from './Auction.tsx';
import { Deckbuilder } from './Deckbuilder.tsx';
import { GameScreen } from './game/GameScreen.tsx';
import { navigate } from './App.tsx';
import { Chat } from './Chat.tsx';
import { getCard, useCardRegistry } from './cards.tsx';
import { eventName, namesFor, saveDeck, sourceName } from './decklib.ts';

export interface RoomProps { view: RoomView; send: Send; skew: number }

interface RoomInfo { id: string; name: string; phase: string; host: string | null; players: string[] }

export function Room({ roomId }: { roomId: string }) {
  const [seat, setSeat] = useState(() => loadSeat(roomId));
  const [name, setName] = useState(() => localStorage.getItem('ojb:name') ?? '');
  const [joinErr, setJoinErr] = useState<string | null>(null);
  const { view, send, fatal, connected, toast, clockSkew, restoring } = useRoom(roomId, seat?.token ?? null, (newId) => {
    // The server restarted and this room came back under a new code.
    if (seat) saveSeat(newId, seat);
    navigate(`/r/${newId}`);
  });
  const [info, setInfo] = useState<RoomInfo | 'missing' | null>(null);
  const [joining, setJoining] = useState(false);
  const [watching, setWatching] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  useCardRegistry(); // re-render when card data for non-cube cards arrives

  // Decks are saved to the browser's library when a game starts from a draft/sealed/auction pool (de-duplicated by content).
  const autoSaved = useRef(new Set<string>());
  useEffect(() => {
    if (!view || view.settings.mode === 'constructed' || !view.deck) return;
    const m = view.matches.find((x) => x.players.includes(view.me) && !x.winner && x.game && !autoSaved.current.has(x.id));
    if (!m) return;
    autoSaved.current.add(m.id);
    const d = view.deck;
    saveDeck({ main: d.main, side: d.side, basics: d.basics, cube: sourceName(view.settings), format: eventName(view.settings), names: namesFor([...d.main, ...d.side], getCard), auto: true });
  }, [view]);

  useEffect(() => {
    if (view) document.title = `${view.name} · OJB Cube`;
  }, [view?.name]);

  // Not joined yet: show which room this is (or that it doesn't exist).
  useEffect(() => {
    if (seat) return;
    let live = true;
    fetch(`/api/rooms/${roomId}`).then(async (r) => { if (live) setInfo(r.ok ? await r.json() as RoomInfo : 'missing'); }).catch(() => live && setInfo('missing'));
    return () => { live = false; };
  }, [roomId, seat]);

  async function join(as = name) {
    if (!as.trim()) return setJoinErr('Enter your name');
    try { localStorage.setItem('ojb:name', as.trim()); } catch { /* private mode */ }
    setJoining(true);
    try {
      const r = await api<{ token: string; pid: string }>(`/api/rooms/${roomId}/join`, { name: as });
      const s = { token: r.token, pid: r.pid, name: as };
      saveSeat(roomId, s);
      setSeat(s);
    } catch (e) { setJoinErr((e as Error).message); } finally { setJoining(false); }
  }

  // Coming from "Join" on the home page with a name typed: join straight away.
  useEffect(() => {
    let auto: string | null = null;
    try { auto = sessionStorage.getItem('ojb:autojoin'); sessionStorage.removeItem('ojb:autojoin'); } catch { /* ignore */ }
    if (!seat && auto === roomId && name.trim()) void join(name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!seat) {
    const missing = info === 'missing';
    const r = info && info !== 'missing' ? info : null;
    return (
      <div className="home"><div className="home-card join-card">
        <h2>{r ? <>Join <em>{r.name}</em></> : 'Join room'} <code className="room-code-input">{roomId}</code></h2>
        {r && <p className="muted">{r.host ? `Hosted by ${r.host}. ` : ''}{r.players.length} at the table{r.phase !== 'lobby' ? ' — the event has started, you can watch' : ''}.</p>}
        {missing && <p className="error">No room with code {roomId}. Check the code, or ask the host to open the room again (if the server just restarted, it comes back when the host returns).</p>}
        <form onSubmit={(e) => { e.preventDefault(); void join(); }}>
          <label>Your name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={24} placeholder="e.g. Max" /></label>
          <button className="primary" type="submit" disabled={joining}>{joining ? 'Joining…' : 'Join'}</button>
          <button type="button" onClick={() => navigate('/')}>Home</button>
        </form>
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
  if (!view) return <div className="loading">{restoring ? 'The server restarted — restoring the room…' : 'Connecting…'}</div>;

  const props: RoomProps = { view, send, skew: clockSkew };
  const myMatch = view.matches.find((m) => m.players.includes(view.me) && !dismissed.includes(m.id));
  const watchMatch = watching ? view.matches.find((m) => m.id === watching) : null;
  const shownMatch = myMatch ?? watchMatch;
  const isPlayer = view.players.some((p) => p.id === view.me);

  let body;
  const leave = myMatch ? (myMatch.winner ? () => setDismissed([...dismissed, myMatch.id]) : undefined) : () => setWatching(null);
  if (shownMatch) body = <GameScreen {...props} match={shownMatch} onLeave={leave} />;
  else if (view.phase === 'lobby') body = <Lobby {...props} />;
  else if (view.phase === 'drafting') body = isPlayer ? <Draft {...props} /> : <Spectating view={view} send={send} />;
  else if (view.phase === 'auction') body = <Auction {...props} />;
  else body = <Deckbuilder {...props} onWatch={setWatching} />;

  return (
    <div className="room">
      {!connected && <div className="banner warn">{restoring ? 'The server restarted — restoring the room…' : 'Reconnecting…'}</div>}
      {toast && <div className="toast">{toast}</div>}
      {!shownMatch && <AwayBanner view={view} send={send} />}
      {body}
      {!shownMatch && <Chat view={view} send={send} />}
    </div>
  );
}

function Spectating({ view, send }: { view: RoomView; send: Send }) {
  const away = view.players.filter((p) => p.away);
  return (
    <div className="center-msg">
      You're watching. {view.players.length} players are drafting — you'll see their matches when they start playing.
      {away.length > 0 && (
        <div className="away-claim">
          <p>Someone left and a bot is playing their seat. Were you one of them?</p>
          {away.map((p) => <button key={p.id} onClick={() => send({ t: 'takeSeat', pid: p.id })}>Take over {p.name}'s seat</button>)}
        </div>
      )}
    </div>
  );
}

export { saveSeat };
