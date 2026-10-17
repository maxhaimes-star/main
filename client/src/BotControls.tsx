import { useState } from 'react';
import type { BotLevel, RoomView } from '@ojb/shared';
import type { Send } from './net.ts';
import { deckSize, loadDecks, type SavedDeck } from './decklib.ts';

/** Computer opponents in the UI: the lobby "Play vs bot" option, the deckbuilding "Play vs bot" panel and the badge. */

export const BOT_LEVEL_LABEL: Record<BotLevel, string> = { easy: 'Easy', normal: 'Normal' };

/** Lobby: the host turns on a computer opponent for the event (it drafts / opens a pool, or brings a cube deck). */
export function BotLobbyOption({ view, send }: { view: RoomView; send: Send }) {
  const isHost = view.hostId === view.me;
  const level = view.settings.vsBot ?? null;
  return (
    <div className="settings bot-option">
      <label className="setting check">
        <input type="checkbox" aria-label="Play vs bot" checked={!!level} disabled={!isHost}
          onChange={(e) => send({ t: 'updateSettings', settings: { vsBot: e.target.checked ? 'normal' : null } })} /> Play vs bot
      </label>
      {level && (
        <label className="setting"><span>Bot difficulty</span>
          <select aria-label="Bot difficulty" value={level} disabled={!isHost} onChange={(e) => send({ t: 'updateSettings', settings: { vsBot: e.target.value as BotLevel } })}>
            {(Object.keys(BOT_LEVEL_LABEL) as BotLevel[]).map((l) => <option key={l} value={l}>{BOT_LEVEL_LABEL[l]}</option>)}
          </select>
        </label>
      )}
      {level && <small className="muted">A computer opponent joins the {view.settings.mode === 'constructed' ? 'event with a cube deck (or one of your saved decks)' : view.settings.mode === 'auction' ? 'auction' : view.settings.mode === 'sealed' ? 'event and opens a pool' : 'draft'}; challenge it once your deck is ready.</small>}
    </div>
  );
}

/** Deckbuilding: challenge a bot, or add one (with a difficulty, and in constructed optionally one of my saved decks). */
export function PlayVsBot({ view, send, bestOf, myReady }: { view: RoomView; send: Send; bestOf: number; myReady: boolean }) {
  const bots = view.players.filter((p) => p.isBot && !p.away);
  const busy = (pid: string) => view.matches.some((m) => !m.winner && m.players.includes(pid));
  const [level, setLevel] = useState<BotLevel>(view.settings.vsBot ?? 'normal');
  const constructed = view.settings.mode === 'constructed';
  const [saved] = useState<SavedDeck[]>(() => (constructed ? loadDecks() : []));
  const [deckId, setDeckId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  async function add() {
    setErr(null);
    const d = saved.find((x) => x.id === deckId);
    const e = await send({ t: 'addBot', level, ...(d ? { deck: { main: d.main, side: d.side, basics: d.basics } } : {}) });
    if (e) setErr(e);
  }
  async function play(pid: string) {
    setErr(null);
    const e = await send({ t: 'createMatch', players: [view.me, pid], bestOf });
    if (e) setErr(e);
  }
  return (
    <div className="play-bot">
      {bots.map((b) => (
        <div key={b.id} className="challenge bot-row">
          <span><span className="dot on" />{b.name} <span className="bot-badge">Bot</span> <small className="muted">{BOT_LEVEL_LABEL[b.botLevel ?? 'normal']}{view.decksReady[b.id] ? '' : ' · building'}</small></span>
          <button disabled={!myReady || busy(b.id) || !view.decksReady[b.id]} onClick={() => play(b.id)} aria-label={`Play vs ${b.name}`}>Play vs bot</button>
        </div>
      ))}
      <div className="add-bot">
        <select aria-label="New bot difficulty" value={level} onChange={(e) => setLevel(e.target.value as BotLevel)}>
          {(Object.keys(BOT_LEVEL_LABEL) as BotLevel[]).map((l) => <option key={l} value={l}>{BOT_LEVEL_LABEL[l]}</option>)}
        </select>
        {constructed && saved.length > 0 && (
          <select aria-label="Bot deck" value={deckId} onChange={(e) => setDeckId(e.target.value)}>
            <option value="">Random cube deck</option>
            {saved.map((d) => <option key={d.id} value={d.id}>{d.name} ({deckSize(d)})</option>)}
          </select>
        )}
        <button onClick={add}>Add bot opponent</button>
      </div>
      {err && <div className="error">{err}</div>}
    </div>
  );
}

export function BotBadge() {
  return <span className="bot-badge" title="Computer opponent">Bot</span>;
}
