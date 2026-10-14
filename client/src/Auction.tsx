import { useEffect, useState } from 'react';
import { highBid } from '@ojb/shared';
import type { RoomProps } from './Room.tsx';
import { CubeCard, getCard, PreviewPanel } from './cards.tsx';
import { Countdown, PoolSummary } from './Draft.tsx';

export function Auction({ view, send, skew }: RoomProps) {
  const a = view.auction!;
  const players = view.players;
  const me = players.find((p) => p.id === view.me);
  const nominator = players[a.nominatorSeat];
  const myTurn = nominator?.id === view.me && !a.lot;
  const high = highBid(a);
  const budget = me ? a.budgets[me.id] : 0;
  const capped = me ? a.pools[me.id].length >= view.settings.auctionPoolSize : true;
  const [custom, setCustom] = useState('');
  const [watchPool, setWatchPool] = useState<string>(view.me);
  const name = (pid: string | null) => players.find((p) => p.id === pid)?.name ?? '—';

  const bid = (amount: number) => send({ t: 'bid', amount });
  const minBid = (high?.amount ?? -1) + 1;
  const canBid = !!me && !!a.lot && !capped && high?.pid !== view.me && minBid <= budget;

  useEffect(() => { setCustom(''); }, [a.lot?.cardId]);

  return (
    <div className="auction">
      <div className="auction-main">
        <div className="draft-head">
          <h2>Auction · Pack {a.packNumber}/{a.totalPacks}</h2>
          <span className="muted">Pool size {view.settings.auctionPoolSize} · {a.open.length} card(s) left in this pack</span>
        </div>

        <div className="lot">
          {a.lot ? (
            <>
              <div className="lot-card"><CubeCard id={a.lot.cardId} /></div>
              <div className="lot-info">
                <h3>{getCard(a.lot.cardId)?.name}</h3>
                <div className="high-bid">
                  {high && high.amount > 0 ? <>High bid <b>{high.amount}</b> by <b>{name(high.pid)}</b></> : <>Opened by <b>{name(a.lot.nominatedBy)}</b> at 0</>}
                </div>
                <Countdown deadline={a.lot.deadline} skew={skew} total={view.settings.auctionTimer * 1000} />
                {me && (
                  <div className="bid-buttons">
                    {[1, 2, 5, 10].map((inc) => {
                      const amt = (high?.amount ?? 0) + inc;
                      return <button key={inc} className={inc === 1 ? 'primary' : ''} disabled={!canBid || amt > budget} onClick={() => bid(amt)}>Bid {amt}</button>;
                    })}
                    <input type="number" placeholder="amount" value={custom} min={minBid} max={budget} onChange={(e) => setCustom(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && custom) bid(Number(custom)); }} />
                    <button disabled={!canBid || !custom} onClick={() => bid(Number(custom))}>Bid</button>
                  </div>
                )}
                {me && high?.pid === view.me && <div className="good">You're winning this one.</div>}
                {capped && me && <div className="muted">Your pool is full.</div>}
                <div className="bid-history">
                  {a.lot.bids.slice().reverse().slice(0, 8).map((b, i) => <div key={i}>{name(b.pid)}: {b.amount}</div>)}
                </div>
              </div>
            </>
          ) : (
            <div className="center-msg">
              {myTurn ? <b>Your turn: choose a card from the pack to put up for auction (you open the bidding at 0).</b> : <>Waiting for <b>{nominator?.name}</b> to choose a card…</>}
              <Countdown deadline={a.nominateDeadline} skew={skew} total={view.settings.nominateTimer * 1000} />
            </div>
          )}
        </div>

        <h3>Open pack</h3>
        <div className="card-grid">
          {a.open.map((id, i) => (
            <CubeCard key={`${id}-${i}`} id={id} className={myTurn ? 'clickable' : ''} onClick={myTurn ? () => send({ t: 'nominate', cardId: id }) : undefined}
              title={myTurn ? 'Put this card up for auction' : undefined} />
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
          <thead><tr><th>Player</th><th>Budget</th><th>Cards</th></tr></thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.id} className={`${p.id === view.me ? 'me' : ''} ${p.id === nominator?.id ? 'nominator' : ''}`}>
                <td>{p.id === nominator?.id ? '▶ ' : ''}{p.name}</td><td>{a.budgets[p.id]}</td><td>{a.pools[p.id].length}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <PreviewPanel />
        <h4>Recent sales</h4>
        <div className="results">
          {a.results.slice(0, 30).map((r, i) => <div key={i}>{getCard(r.cardId)?.name} → {name(r.pid)} ({r.amount})</div>)}
        </div>
      </div>
    </div>
  );
}
