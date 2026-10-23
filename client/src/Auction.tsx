import { useEffect, useState } from 'react';
import { highBid, multisetDiff } from '@ojb/shared';
import type { RoomProps } from './Room.tsx';
import { CubeCard, getCard, PreviewPanel } from './cards.tsx';
import { Countdown, LeaveButton, PoolSummary } from './Draft.tsx';

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
  const passRest = a.passRest ?? [];
  const iPassRest = passRest.includes(view.me);
  const humans = players.filter((p) => !p.isBot);
  const myPool = me ? a.pools[me.id] ?? [] : [];
  const myMain = me ? a.main?.[me.id] ?? myPool : [];
  const mySide = multisetDiff(myPool, myMain);
  const setMain = (main: string[]) => send({ t: 'auctionMain', main });

  useEffect(() => { setCustom(''); }, [a.lot?.cardId]);
  useEffect(() => { setPicked(null); setOpenAt(String(st.auctionMinBid)); }, [a.open.length, a.lot?.cardId, st.auctionMinBid]);

  return (
    <div className="auction">
      <div className="auction-main">
        <div className="draft-head">
          <h2>Auction · Pack {a.packNumber}/{a.totalPacks}</h2>
          <LeaveButton view={view} send={send} label="Leave auction" />
          <span className="muted">Min bid {st.auctionMinBid}{st.auctionPoolSize > 0 ? ` · pool cap ${st.auctionPoolSize}` : ''} · {a.open.length} card(s) left in this pack</span>
        </div>

        <div className="lot">
          {a.lot ? (
            <>
              <div className="lot-card"><CubeCard id={a.lot.cardId} /></div>
              <div className="lot-info">
                <h3>{getCard(a.lot.cardId)?.name}</h3>
                <div className="high-bid">
                  {!high ? <>Put up by <b>{name(a.lot.nominatedBy)}</b> · <b>no bids yet</b> (min {st.auctionMinBid})</>
                    : a.lot.bids.length > 1 ? <>High bid <b>${high.amount}</b> by <b>{name(high.pid)}</b></> : <>Opened by <b>{name(high.pid)}</b> at <b>${high.amount}</b></>}
                </div>
                <Countdown deadline={a.lot.deadline} skew={skew} total={st.auctionTimer * 1000} />
                {me && (
                  <div className="bid-buttons sticky-actions">
                    {[1, 2, 5, 10].map((inc) => {
                      const amt = high ? high.amount + inc : st.auctionMinBid + inc - 1;
                      return <button key={inc} className={inc === 1 ? 'primary' : ''} disabled={!canBid || amt > budget} onClick={() => bid(amt)}>Bid {amt}</button>;
                    })}
                    <input type="number" inputMode="numeric" placeholder="amount" value={custom} min={minBid} max={budget} onChange={(e) => setCustom(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && custom) bid(Number(custom)); }} />
                    <button disabled={!canBid || !custom} onClick={() => bid(Number(custom))}>Bid</button>
                    <button className="pass-btn" disabled={isHigh || iPassed} onClick={() => send({ t: 'passLot' })}>{iPassed ? 'Passed' : 'Pass'}</button>
                  </div>
                )}
                {isHigh && <div className="good">You're winning this one. The lot closes when everyone else passes.</div>}
                {!high && <div className="muted">Nobody has bid yet. If everyone who can afford it passes, the card goes unsold.</div>}
                {me && !isHigh && !capped && budget < minBid && <div className="muted">You can't afford a bid on this one; it won't wait for you.</div>}
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
                  <b>Your turn: pick a card, then open the bidding (min {st.auctionMinBid}) or put it up without a bid (it goes unsold only if nobody bids).</b>
                  {picked && (
                    <div className="nominate-panel">
                      <h3>{getCard(picked)?.name}</h3>
                      <div className="bid-buttons sticky-actions">
                        <input type="number" inputMode="numeric" value={openAt} min={st.auctionMinBid} max={budget} onChange={(e) => setOpenAt(e.target.value)} />
                        <button className="primary" disabled={!(Number(openAt) >= st.auctionMinBid && Number(openAt) <= budget)}
                          onClick={() => send({ t: 'nominate', cardId: picked, amount: Number(openAt) })}>Open at ${openAt || '?'}</button>
                        <button className="nobid-btn" onClick={() => send({ t: 'nominate', cardId: picked, amount: 0 })}>Put up, no bid</button>
                      </div>
                    </div>
                  )}
                </>
              ) : <>Waiting for <b>{nominator?.name}</b> to choose a card…</>}
              <Countdown deadline={a.nominateDeadline} skew={skew} total={st.nominateTimer * 1000} />
            </div>
          )}
        </div>

        {me && (
          <div className="pass-rest">
            <label>
              <input type="checkbox" checked={iPassRest} onChange={(e) => send({ t: 'passRest', on: e.target.checked })} /> Pass on the rest
            </label>
            <small className="muted">
              {' '}When every player ticks this, the remaining cards go unsold and the auction ends
              {passRest.length ? ` · ${humans.filter((p) => passRest.includes(p.id)).length}/${humans.length} agreed (${humans.filter((p) => passRest.includes(p.id)).map((p) => p.name).join(', ')})` : ''}.
            </small>
          </div>
        )}

        <h3>Open pack</h3>
        <div className="card-grid">
          {a.open.map((id, i) => (
            <CubeCard key={`${id}-${i}`} id={id} className={`${myTurn ? 'clickable' : ''} ${picked === id ? 'selected' : ''}`} onClick={myTurn ? () => setPicked(id) : undefined} tapLabel="Choose this card"
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
          {me && watchPool === view.me ? (
            <div className="picks">
              <p className="muted">Click a card to move it between your main deck and sideboard; the split carries over to your deck.</p>
              <div className="picks-main"><PoolSummary ids={myMain} title="Main deck" tapLabel="Move to sideboard" onClick={(id) => setMain(multisetDiff(myMain, [id]))} /></div>
              <div className="picks-side"><PoolSummary ids={mySide} title="Sideboard" tapLabel="Move to main deck" onClick={(id) => setMain([...myMain, id])} /></div>
            </div>
          ) : <PoolSummary ids={a.pools[watchPool] ?? []} />}
        </div>
      </div>
      <div className="side">
        <table className="budgets">
          <thead><tr><th>Player</th><th title="Budget left = the most you can bid">Budget / max bid</th><th>Won</th></tr></thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.id} className={`${p.id === view.me ? 'me' : ''} ${p.id === nominator?.id ? 'nominator' : ''}`}>
                <td>{p.id === nominator?.id ? '▶ ' : ''}{p.name}{passes.includes(p.id) ? <small className="muted"> (passed)</small> : null}{passRest.includes(p.id) ? <small className="muted"> (pass on the rest)</small> : null}</td>
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
