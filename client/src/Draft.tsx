import { useEffect, useState } from 'react';
import { BUCKET_ORDER, type CardData, colorBucket, multisetDiff } from '@ojb/shared';
import type { RoomProps } from './Room.tsx';
import { CubeCard, getCard, PreviewPanel } from './cards.tsx';
import { useTick } from './net.ts';
import { navigate } from './App.tsx';
import { type SortMode, SortToggle, useSortMode } from './sort.tsx';

export function Countdown({ deadline, skew, total }: { deadline: number | null; skew: number; total?: number }) {
  useTick(250);
  if (!deadline) return null;
  const left = Math.max(0, deadline - (Date.now() + skew));
  const secs = Math.ceil(left / 1000);
  const pct = total ? Math.min(100, (left / total) * 100) : undefined;
  return (
    <div className={`countdown ${secs <= 5 ? 'urgent' : ''}`}>
      <span>{secs}s</span>
      {pct != null && <div className="bar"><div style={{ width: `${pct}%` }} /></div>}
    </div>
  );
}

const CMC_ORDER = ['0', '1', '2', '3', '4', '5', '6', '7+', 'Lands'];
const BUCKET_RANK = new Map(BUCKET_ORDER.map((b, i) => [b, i]));

/** Group key for the "mana value" sort: 0..6, 7+, with lands in their own group. */
export function cmcBucket(c: CardData): string {
  if (c.types.includes('Land')) return 'Lands';
  return c.cmc >= 7 ? '7+' : String(Math.max(0, Math.floor(c.cmc)));
}

/** Comparator within a group: by mana value first (colour sort) or by colour first (mana value sort). */
export function compareCards(mode: SortMode, x: CardData, y: CardData): number {
  const byCmc = x.cmc - y.cmc;
  const byColor = (BUCKET_RANK.get(colorBucket(x)) ?? 99) - (BUCKET_RANK.get(colorBucket(y)) ?? 99);
  return (mode === 'cmc' ? byColor || byCmc : byCmc) || x.name.localeCompare(y.name);
}

export function PoolSummary({ ids, onClick, title, tapLabel }: { ids: string[]; onClick?: (id: string, index: number) => void; title?: string; tapLabel?: string }) {
  const mode = useSortMode();
  const cards = ids.map((id, i) => ({ id, i, c: getCard(id)! })).filter((x) => x.c);
  const groups = new Map<string, typeof cards>();
  for (const x of cards) {
    const b = mode === 'cmc' ? cmcBucket(x.c) : colorBucket(x.c);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b)!.push(x);
  }
  const order = mode === 'cmc' ? CMC_ORDER : BUCKET_ORDER;
  return (
    <div className="pool-summary">
      {title && <h4>{title} ({ids.length})</h4>}
      {order.filter((b) => groups.has(b)).map((b) => (
        <div key={b} className="pool-group">
          <div className={`pool-group-title ${mode === 'cmc' ? '' : `b-${b}`}`}>{mode === 'cmc' && b !== 'Lands' ? `Mana value ${b}` : b} ({groups.get(b)!.length})</div>
          <div className="pool-stack">
            {groups.get(b)!.sort((x, y) => compareCards(mode, x.c, y.c)).map((x) => (
              <CubeCard key={`${x.id}-${x.i}`} id={x.id} onClick={onClick ? () => onClick(x.id, x.i) : undefined} tapLabel={tapLabel} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Curve({ cards }: { cards: CardData[] }) {
  const counts = Array(8).fill(0);
  for (const c of cards) if (!c.types.includes('Land')) counts[Math.min(7, Math.floor(c.cmc))]++;
  const max = Math.max(1, ...counts);
  return (
    <div className="curve">
      {counts.map((n, i) => (
        <div key={i} className="curve-col"><div className="curve-bar" style={{ height: `${(n / max) * 48}px` }} /><span>{n}</span><small>{i === 7 ? '7+' : i}</small></div>
      ))}
    </div>
  );
}

/** Leave mid-event: a bot takes the seat and the player can take it back from the banner (or the room link). */
export function LeaveButton({ view, send, label = 'Leave draft' }: Pick<RoomProps, 'view' | 'send'> & { label?: string }) {
  const me = view.players.find((p) => p.id === view.me);
  if (!me || me.away || me.isBot) return null;
  return (
    <button className="link leave-seat" onClick={() => { if (confirm('Leave? A bot takes over your seat and the event carries on. You can rejoin from this page and take your seat back.')) send({ t: 'leaveSeat' }); }}>{label}</button>
  );
}

/** Shown to a player whose seat a bot is playing, in any phase. */
export function AwayBanner({ view, send }: Pick<RoomProps, 'view' | 'send'>) {
  const me = view.players.find((p) => p.id === view.me);
  if (!me?.away) return null;
  return (
    <div className="away-banner">
      <span>You left — a bot is playing your seat{view.phase === 'drafting' ? ' and drafting for you' : ''}.</span>
      <button className="primary" onClick={() => send({ t: 'takeSeat' })}>Take my seat back</button>
      <button onClick={() => navigate('/')}>Home</button>
    </div>
  );
}

export function Draft({ view, send, skew }: RoomProps) {
  const d = view.draft!;
  const [sel, setSelState] = useState<string | null>(null);
  // The server remembers the selection: if the pick timer runs out, you get the card you selected.
  const setSel = (id: string | null) => { setSelState(id); send({ t: 'highlight', cardId: id }); };
  const pick = (id: string) => { send({ t: 'pick', cardId: id }); setSelState(null); };
  // A new pack: drop a selection from the previous one.
  const packKey = `${d.round}:${d.pickNumber}`;
  useEffect(() => { setSelState(null); }, [packKey]);
  const setMain = (main: string[]) => send({ t: 'draftMain', main });
  const sideboard = multisetDiff(d.picks, d.main);
  const away = !!view.players.find((p) => p.id === view.me)?.away;
  const players = view.players;
  const mySeat = players.find((p) => p.id === view.me)?.seat ?? 0;
  const packTotal = view.settings.pickTimer && d.pack ? Math.max(8, Math.round(view.settings.pickTimer * d.pack.length / view.settings.packSize)) * 1000 : undefined;

  return (
    <div className="draft">
      <div className="draft-main">
        <div className="draft-head">
          <h2>Pack {d.round + 1}/{d.rounds} · Pick {d.pickNumber + 1}</h2>
          <span className="muted">Passing {d.direction === 1 ? 'left →' : '← right'}</span>
          <LeaveButton view={view} send={send} />
          <Countdown deadline={d.deadline} skew={skew} total={packTotal} />
        </div>
        <div className="table-ring">
          {players.map((p) => (
            <div key={p.id} className={`seat ${p.seat === mySeat ? 'me' : ''} ${d.waiting[p.seat] ? 'busy' : ''}`} title={`${d.waiting[p.seat]} pack(s) waiting`}>
              <span className={`dot ${p.connected ? 'on' : ''}`} />{p.name}{p.away ? ' (away · bot)' : ''}
              <span className="packs">{'▮'.repeat(Math.min(5, d.waiting[p.seat]))}</span>
            </div>
          ))}
        </div>
        {away ? (
          <div className="center-msg">A bot is drafting for you. Take your seat back to keep picking yourself — your picks so far are below.</div>
        ) : d.pack ? (
          <>
            <p className="muted"><span className="hide-touch">Click a card to select it, then click again (or double-click) to pick. If time runs out you get the selected card (or the best-rated one).</span><span className="show-touch">Tap a card to zoom in, then tap Pick.</span> {d.queued > 0 && <b>{d.queued} more pack(s) waiting for you.</b>}</p>
            <div className="card-grid">
              {d.pack.map((id, i) => (
                <CubeCard key={`${id}-${i}`} id={id} className={sel === id ? 'selected' : ''}
                  onClick={() => (sel === id ? pick(id) : setSel(id))} tapLabel="Pick" tapAction={() => pick(id)} />
              ))}
            </div>
            {sel && <div className="sticky-actions"><button className="primary big" onClick={() => pick(sel)}>Pick {getCard(sel)?.name}</button></div>}
          </>
        ) : (
          <div className="center-msg">Waiting for the next pack… {players.filter((p) => d.waiting[p.seat] > 0).map((p) => p.name).join(', ') && `(still picking: ${players.filter((p) => d.waiting[p.seat] > 0).map((p) => p.name).join(', ')})`}</div>
        )}
        <div className="picks">
          <div className="picks-head"><h3>Your picks ({d.picks.length})</h3><SortToggle /><Curve cards={(d.main.length ? d.main : d.picks).map((id) => getCard(id)!).filter(Boolean)} /></div>
          <p className="muted"><span className="hide-touch">Click a pick to move it between your main deck and sideboard — the split carries over to your deck.</span><span className="show-touch">Tap a pick, then move it between main deck and sideboard.</span></p>
          <div className="picks-main">
            <PoolSummary ids={d.main} title="Main deck" tapLabel="Move to sideboard"
              onClick={(id) => setMain(multisetDiff(d.main, [id]))} />
          </div>
          <div className="picks-side">
            <PoolSummary ids={sideboard} title="Sideboard" tapLabel="Move to main deck"
              onClick={(id) => setMain([...d.main, id])} />
          </div>
        </div>
      </div>
      <div className="side"><PreviewPanel /></div>
    </div>
  );
}
