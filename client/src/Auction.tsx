import { useEffect, useState } from 'react';
import { highBid } from '@ojb/shared';
import type { RoomProps } from './Room.tsx';
import { CubeCard, getCard, PreviewPanel } from './cards.tsx';
import { Countdown, PoolSummary } from './Draft.tsx';

export function Auction({ view, send, skew }: RoomProps) {
  const a = view.auction!;
  const st = view.settings;
  const players = view.players;
  const me = players.find((p) => p.id === view.me);
  const nominator = players[a.nominatorSeat];
  const myTurn = nominator?.id === view.me && !a.lot;
  const high = highBid(a);
  const budget = me ? a.budgets[me.id] : 0;
  const capped = me ? st.auctionPoolSize > 0 && a.pools[me.id].length >= st.auctionPoolSize : true;
  const [custom, setCustom] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [openAt, setOpenAt] = useState(String(st.auctionMinBid));
  const [watchPool, setWatchPool] = useState<string>(view.me);
  const name = (pid: string | null) => players.find((p) => p.id === pid)?.name ?? '—';

  const bid = (amount: number) => send({ t: 'bid', amount });
  const minBid = Math.max(st.auctionMinBid, (high?.amount ?? 0) + 1);
  const isHigh = high?.pid === view.me;
  const canBid = !!me && !!a.lot && !capped && !isHigh && minBid <= budget;
  const passes = a.lot?.passes ?? [];
  const iPassed = passes.includes(view.me);

  useEffect(() => { setCustom(''); }, [a.lot?.cardId]);
  useEffect(() => { setPicked(null); setOpenAt(String(st.auctionMinBid)); }, [a.open.length, a.lot?.cardId, st.auctionMinBid]);

  return (
    <div className="auction">
      <div className="auction-main">
        <div className="draft-head">
          <h2>Auction · Pack {a.packNumber}/{a.totalPacks}</h2>
          <span className="muted">Min bid {st.auctionMinBid}{st.auctionPoolSize > 0 ? ` · pool cap ${st.auctionPoolSize}` : ''} · {a.open.length} card(s) left in this pack</span>
        </div>

        <div className="lot">
          {a.lot ? (
            <>
              <div className="lot-card"><CubeCard id={a.lot.cardId} /></div>
              <div className="lot-info">
                <h3>{getCard(a.lot.cardId)?.name}</h3>
                <div className="high-bid">
                  {a.lot.bids.length > 1 ? <>High bid <b>${high?.amount}</b> by <b>{name(high?.pid ?? null)}</b></> : <>Opened by <b>{name(a.lot.nominatedBy)}</b> at <b>${high?.amount}</b></>}
                </div>
                <Countdown deadline={a.lot.deadline} skew={skew} total={st.auctionTimer * 1000} />
                {me && (
                  <div className="bid-buttons">
                    {[1, 2, 5, 10].map((inc) => {
                      const amt = (high?.amount ?? 0) + inc;
                      return <button key={inc} className={inc === 1 ? 'primary' : ''} disabled={!canBid || amt > budget} onClick={() => bid(amt)}>Bid {amt}</button>;
                    })}
                    <input type="number" placeholder="amount" value={custom} min={minBid} max={budget} onChange={(e) => setCustom(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && custom) bid(Number(custom)); }} />
                    <button disabled={!canBid || !custom} onClick={() => bid(Number(custom))}>Bid</button>
                    <button className="pass-btn" disabled={isHigh || iPassed} onClick={() => send({ t: 'passLot' })}>{iPassed ? 'Passed' : 'Pass'}</button>
                  </div>
                )}
                {isHigh && <div className="good">You're winning this one. The lot closes when everyone else passes.</div>}
                {capped && me && <div className="muted">Your pool is full.</div>}
                {passes.length > 0 && <div className="passes muted">{passes.map(name).join(', ')} passed</div>}
                <div className="bid-history">
                  {a.lot.bids.slice().reverse().slice(0, 8).map((b, i) => <div key={i}>{name(b.pid)}: {b.amount}</div>)}
                </div>
              </div>
            </>
          ) : (
            <div className="center-msg">
              {myTurn ? (
                <>
                  <b>Your turn: pick a card, then open the bidding (min {st.auctionMinBid}) or skip it (the card is discarded).</b>
                  {picked && (
                    <div className="nominate-panel">
                      <h3>{getCard(picked)?.name}</h3>
                      <div className="bid-buttons">
                        <input type="number" value={openAt} min={st.auctionMinBid} max={budget} onChange={(e) => setOpenAt(e.target.value)} />
                        <button className="primary" disabled={!(Number(openAt) >= st.auctionMinBid && Number(openAt) <= budget)}
                          onClick={() => send({ t: 'nominate', cardId: picked, amount: Number(openAt) })}>Open at ${openAt || '?'}</button>
                        <button className="skip-btn" onClick={() => send({ t: 'skipLot', cardId: picked })}>Skip (discard)</button>
                      </div>
                    </div>
                  )}
                </>
              ) : <>Waiting for <b>{nominator?.name}</b> to choose a card…</>}
              <Countdown deadline={a.nominateDeadline} skew={skew} total={st.nominateTimer * 1000} />
            </div>
          )}
        </div>

        <h3>Open pack</h3>
        <div className="card-grid">
          {a.open.map((id, i) => (
            <CubeCard key={`${id}-${i}`} id={id} className={`${myTurn ? 'clickable' : ''} ${picked === id ? 'selected' : ''}`} onClick={myTurn ? () => setPicked(id) : undefined}
              title={myTurn ? 'Select this card' : undefined} />
          ))}
        </div>

        <div className="pool-view">
          <div className="pool-tabs">
            {players.map((p) => (
              <button key={p.id} className={watchPool === p.id ? 'sel' : ''} onClick={() => setWatchPool(p.id)}>
                {p.name}{p.id === view.me ? ' (you)' : ''} · {a.pools[p.id].length}
              </button>
            ))}
          </div>
          <PoolSummary ids={a.pools[watchPool] ?? []} />
        </div>
      </div>
      <div className="side">
        <table className="budgets">
          <thead><tr><th>Player</th><th title="Budget left = the most you can bid">Budget / max bid</th><th>Won</th></tr></thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.id} className={`${p.id === view.me ? 'me' : ''} ${p.id === nominator?.id ? 'nominator' : ''}`}>
                <td>{p.id === nominator?.id ? '▶ ' : ''}{p.name}{passes.includes(p.id) ? <small className="muted"> (passed)</small> : null}</td>
                <td>${a.budgets[p.id]}</td><td>{a.pools[p.id].length}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <PreviewPanel />
        <h4>Recent sales</h4>
        <div className="results">
          {a.results.slice(0, 30).map((r, i) => (
            <div key={i}>{getCard(r.cardId)?.name} → {r.pid ? <>{name(r.pid)} (${r.amount})</> : <span className="muted">unsold</span>}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
