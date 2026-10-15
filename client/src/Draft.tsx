import { useState } from 'react';
import { BUCKET_ORDER, type CardData, colorBucket } from '@ojb/shared';
import type { RoomProps } from './Room.tsx';
import { CubeCard, getCard, PreviewPanel } from './cards.tsx';
import { useTick } from './net.ts';

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

export function PoolSummary({ ids, onClick, title, tapLabel }: { ids: string[]; onClick?: (id: string, index: number) => void; title?: string; tapLabel?: string }) {
  const cards = ids.map((id, i) => ({ id, i, c: getCard(id)! })).filter((x) => x.c);
  const groups = new Map<string, typeof cards>();
  for (const x of cards) {
    const b = colorBucket(x.c);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b)!.push(x);
  }
  return (
    <div className="pool-summary">
      {title && <h4>{title} ({ids.length})</h4>}
      {BUCKET_ORDER.filter((b) => groups.has(b)).map((b) => (
        <div key={b} className="pool-group">
          <div className={`pool-group-title b-${b}`}>{b} ({groups.get(b)!.length})</div>
          <div className="pool-stack">
            {groups.get(b)!.sort((x, y) => x.c.cmc - y.c.cmc || x.c.name.localeCompare(y.c.name)).map((x) => (
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

export function Draft({ view, send, skew }: RoomProps) {
  const d = view.draft!;
  const [sel, setSel] = useState<string | null>(null);
  const pick = (id: string) => { send({ t: 'pick', cardId: id }); setSel(null); };
  const players = view.players;
  const mySeat = players.find((p) => p.id === view.me)?.seat ?? 0;
  const packTotal = view.settings.pickTimer && d.pack ? Math.max(8, Math.round(view.settings.pickTimer * d.pack.length / view.settings.packSize)) * 1000 : undefined;

  return (
    <div className="draft">
      <div className="draft-main">
        <div className="draft-head">
          <h2>Pack {d.round + 1}/{d.rounds} · Pick {d.pickNumber + 1}</h2>
          <span className="muted">Passing {d.direction === 1 ? 'left →' : '← right'}</span>
          <Countdown deadline={d.deadline} skew={skew} total={packTotal} />
        </div>
        <div className="table-ring">
          {players.map((p) => (
            <div key={p.id} className={`seat ${p.seat === mySeat ? 'me' : ''} ${d.waiting[p.seat] ? 'busy' : ''}`} title={`${d.waiting[p.seat]} pack(s) waiting`}>
              <span className={`dot ${p.connected ? 'on' : ''}`} />{p.name}
              <span className="packs">{'▮'.repeat(Math.min(5, d.waiting[p.seat]))}</span>
            </div>
          ))}
        </div>
        {d.pack ? (
          <>
            <p className="muted"><span className="hide-touch">Click a card to select it, then click again (or double-click) to pick.</span><span className="show-touch">Tap a card to zoom in, then tap Pick.</span> {d.queued > 0 && <b>{d.queued} more pack(s) waiting for you.</b>}</p>
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
          <div className="picks-head"><h3>Your picks ({d.picks.length})</h3><Curve cards={d.picks.map((id) => getCard(id)!).filter(Boolean)} /></div>
          <PoolSummary ids={d.picks} />
        </div>
      </div>
      <div className="side"><PreviewPanel /></div>
    </div>
  );
}
