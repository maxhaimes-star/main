import { useEffect, useMemo, useRef, useState } from 'react';
import { type CardData, type Color, COLORS, type Deck, deckToCockatrice, deckToText, deckToXmage, multisetDiff, parseManaSymbols, BASIC_LANDS } from '@ojb/shared';
import type { RoomProps } from './Room.tsx';
import { CubeCard, getCard, PreviewPanel } from './cards.tsx';
import { Curve, PoolSummary } from './Draft.tsx';
import { download } from './net.ts';

type DeckState = { main: string[]; basics: Record<Color, number> };

export function suggestBasics(main: string[], total = 40): Record<Color, number> {
  const pips: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let nonbasicLands = 0;
  for (const id of main) {
    const c = getCard(id);
    if (!c) continue;
    if (c.types.includes('Land')) { nonbasicLands++; continue; }
    for (const s of parseManaSymbols(c.manaCost)) for (const col of COLORS) if (s.includes(col)) pips[col]++;
  }
  const need = Math.max(0, total - main.length);
  const sum = Object.values(pips).reduce((a, b) => a + b, 0);
  const out: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  if (!sum || !need) return out;
  const raw = COLORS.map((c) => [c, (pips[c] / sum) * need] as const);
  let given = 0;
  for (const [c, v] of raw) { out[c] = Math.floor(v); given += out[c]; }
  const order = [...raw].sort((x, y) => (y[1] % 1) - (x[1] % 1));
  for (let i = 0; given < need; i++, given++) out[order[i % order.length][0]]++;
  void nonbasicLands;
  return out;
}

export function Deckbuilder({ view, send, onWatch }: RoomProps & { onWatch: (id: string) => void }) {
  const pool = view.pool;
  const isPlayer = !!view.players.find((p) => p.id === view.me);
  const [deck, setDeck] = useState<DeckState>(() => ({ main: view.deck?.main ?? [], basics: view.deck?.basics ?? { W: 0, U: 0, B: 0, R: 0, G: 0 } }));
  const [ready, setReady] = useState(view.deck?.ready ?? false);
  const side = useMemo(() => multisetDiff(pool, deck.main), [pool, deck.main]);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => send({ t: 'saveDeck', deck: { main: deck.main, side, basics: deck.basics }, ready }), 400);
    return () => clearTimeout(t);
  }, [deck, ready]);

  const mainCards = deck.main.map((id) => getCard(id)!).filter(Boolean);
  const basicsCount = Object.values(deck.basics).reduce((a, b) => a + b, 0);
  const total = deck.main.length + basicsCount;
  const lands = mainCards.filter((c) => c.types.includes('Land')).length + basicsCount;
  const fullDeck: Deck = { main: deck.main, side, basics: deck.basics, ready };
  const me = view.players.find((p) => p.id === view.me);

  const toMain = (id: string) => setDeck((d) => ({ ...d, main: [...d.main, id] }));
  const toSide = (index: number) => setDeck((d) => ({ ...d, main: d.main.filter((_, i) => i !== index) }));

  // Main deck laid out in CMC columns, creatures above non-creatures.
  const columns: { label: string; cards: { c: CardData; i: number }[] }[] = [];
  for (let cmc = 0; cmc <= 7; cmc++) columns.push({ label: cmc === 7 ? '7+' : String(cmc), cards: [] });
  const landCol: { c: CardData; i: number }[] = [];
  deck.main.forEach((id, i) => {
    const c = getCard(id);
    if (!c) return;
    if (c.types.includes('Land')) landCol.push({ c, i });
    else columns[Math.min(7, Math.floor(c.cmc))].cards.push({ c, i });
  });

  if (!isPlayer) return <div className="center-msg">Players are building decks. <MatchList view={view} send={send} onWatch={onWatch} /></div>;

  return (
    <div className="deckbuilder">
      <div className="db-main">
        <div className="db-head">
          <h2>Deckbuilding</h2>
          <span className={`count ${total === 40 ? 'good' : total < 40 ? 'warn' : ''}`}>{total} cards</span>
          <span className="muted">{mainCards.filter((c) => !c.types.includes('Land')).length} spells · {lands} lands · {side.length} in sideboard</span>
          <Curve cards={mainCards} />
          <label className="ready"><input type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} /> Deck ready</label>
        </div>
        <p className="muted">Click cards in your pool to add them; click cards in your deck to take them out.</p>
        <div className="db-columns">
          {columns.map((col) => (
            <div key={col.label} className="db-col">
              <div className="db-col-title">{col.label} <small>({col.cards.length})</small></div>
              {col.cards.sort((x, y) => Number(y.c.types.includes('Creature')) - Number(x.c.types.includes('Creature')) || x.c.name.localeCompare(y.c.name)).map(({ c, i }) => (
                <CubeCard key={`${c.id}-${i}`} id={c.id} onClick={() => toSide(i)} className="stacked" />
              ))}
            </div>
          ))}
          <div className="db-col">
            <div className="db-col-title">Lands <small>({landCol.length + basicsCount})</small></div>
            {landCol.map(({ c, i }) => <CubeCard key={`${c.id}-${i}`} id={c.id} onClick={() => toSide(i)} className="stacked" />)}
          </div>
        </div>
        <div className="basics">
          <b>Basic lands:</b>
          {COLORS.map((c) => (
            <span key={c} className="basic">
              <span className={`pip pip-${c}`}>{c}</span> {BASIC_LANDS[c]}
              <button className="tiny" onClick={() => setDeck((d) => ({ ...d, basics: { ...d.basics, [c]: Math.max(0, d.basics[c] - 1) } }))}>−</button>
              <b>{deck.basics[c]}</b>
              <button className="tiny" onClick={() => setDeck((d) => ({ ...d, basics: { ...d.basics, [c]: d.basics[c] + 1 } }))}>+</button>
            </span>
          ))}
          <button onClick={() => setDeck((d) => ({ ...d, basics: suggestBasics(d.main) }))}>Suggest lands (to 40)</button>
          <button onClick={() => setDeck((d) => ({ ...d, basics: { W: 0, U: 0, B: 0, R: 0, G: 0 } }))}>Clear</button>
        </div>
        <PoolSummary ids={side} title="Pool / sideboard" onClick={(id) => toMain(id)} />
      </div>
      <div className="side">
        <PreviewPanel />
        <div className="exports">
          <h4>Export deck</h4>
          <button onClick={() => download(`${me?.name ?? 'deck'}.dck`, deckToXmage(fullDeck, getCard, `${view.name} - ${me?.name}`))}>XMage (.dck)</button>
          <button onClick={() => download(`${me?.name ?? 'deck'}.txt`, deckToText(fullDeck, getCard))}>Text (MTGA/MTGO)</button>
          <button onClick={() => download(`${me?.name ?? 'deck'}.cod`, deckToCockatrice(fullDeck, getCard, `${view.name} - ${me?.name}`))}>Cockatrice (.cod)</button>
          <button onClick={() => navigator.clipboard?.writeText(deckToText(fullDeck, getCard))}>Copy as text</button>
        </div>
        <MatchList view={view} send={send} onWatch={onWatch} />
        {view.hostId === view.me && <button className="link" onClick={() => { if (confirm('Start a new event? Pools and decks will be cleared.')) send({ t: 'backToLobby' }); }}>New event (back to lobby)</button>}
      </div>
    </div>
  );
}

function MatchList({ view, send, onWatch }: { view: RoomProps['view']; send: RoomProps['send']; onWatch: (id: string) => void }) {
  const [bestOf, setBestOf] = useState(3);
  const humans = view.players.filter((p) => !p.isBot && p.id !== view.me);
  const name = (pid: string) => view.players.find((p) => p.id === pid)?.name ?? '?';
  const iAmPlayer = view.players.some((p) => p.id === view.me);
  const isHost = view.hostId === view.me;
  const [pa, setPa] = useState('');
  const [pb, setPb] = useState('');
  return (
    <div className="matches">
      <h4>Play</h4>
      {iAmPlayer && (
        <>
          <label>Best of <select value={bestOf} onChange={(e) => setBestOf(Number(e.target.value))}><option value={1}>1</option><option value={3}>3</option><option value={5}>5</option></select></label>
          {humans.length === 0 && <p className="muted">Invite a friend to play — bots only draft.</p>}
          {humans.map((p) => (
            <div key={p.id} className="challenge">
              <span><span className={`dot ${p.connected ? 'on' : ''}`} />{p.name} {view.decksReady[p.id] ? '✅' : <small className="muted">(building)</small>}</span>
              <button disabled={!view.decksReady[p.id] || !view.decksReady[view.me]} onClick={() => send({ t: 'createMatch', players: [view.me, p.id], bestOf })}>Play</button>
            </div>
          ))}
          {!view.decksReady[view.me] && <p className="muted">Tick "Deck ready" to play.</p>}
        </>
      )}
      {isHost && humans.length >= 2 && (
        <div className="pairing">
          <small>Host: pair two players</small>
          <select value={pa} onChange={(e) => setPa(e.target.value)}><option value="">…</option>{view.players.filter((p) => !p.isBot).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          vs
          <select value={pb} onChange={(e) => setPb(e.target.value)}><option value="">…</option>{view.players.filter((p) => !p.isBot).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <button disabled={!pa || !pb} onClick={() => send({ t: 'createMatch', players: [pa as string, pb as string], bestOf })}>Pair</button>
        </div>
      )}
      {view.matches.length > 0 && <h4>Matches</h4>}
      {view.matches.map((m) => (
        <div key={m.id} className="match-row">
          {name(m.players[0])} {m.wins[m.players[0]]}–{m.wins[m.players[1]]} {name(m.players[1])}
          {m.winner ? <b> · {name(m.winner)} wins</b> : <button className="tiny" onClick={() => onWatch(m.id)}>Watch</button>}
        </div>
      ))}
    </div>
  );
}
