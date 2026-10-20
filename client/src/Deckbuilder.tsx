import { useEffect, useMemo, useRef, useState } from 'react';
import { BUCKET_ORDER, type CardData, type Color, colorBucket, COLORS, type Deck, deckToCockatrice, deckToText, deckToXmage, multisetDiff, parseManaSymbols, BASIC_LANDS } from '@ojb/shared';
import type { RoomProps } from './Room.tsx';
import { CubeCard, getCard, PreviewPanel } from './cards.tsx';
import { compareCards, cmcBucket, Curve, PoolSummary } from './Draft.tsx';
import { SortToggle, useSortMode } from './sort.tsx';
import { download } from './net.ts';
import { Constructed } from './Constructed.tsx';
import { PlayVsBot } from './BotControls.tsx';
import { basicStacks } from './basics.ts';
import { defaultDeckName, eventName, namesFor, saveDeck, sourceName } from './decklib.ts';

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

export function Deckbuilder(props: RoomProps & { onWatch: (id: string) => void }) {
  const isPlayer = props.view.players.some((p) => p.id === props.view.me);
  if (props.view.settings.mode === 'constructed' && isPlayer) return <Constructed {...props} />;
  return <LimitedDeckbuilder {...props} />;
}

function LimitedDeckbuilder({ view, send, onWatch }: RoomProps & { onWatch: (id: string) => void }) {
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

  const [deckName, setDeckName] = useState('');
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const cubeName = sourceName(view.settings);
  const evName = eventName(view.settings);
  function saveToLibrary() {
    const r = saveDeck({ name: deckName, main: deck.main, side, basics: deck.basics, cube: cubeName, format: evName, names: namesFor([...deck.main, ...side], getCard) });
    setSavedMsg(r.saved ? `${r.duplicate ? 'Updated' : 'Saved'} "${r.deck.name}" (${r.decks.length} in My decks)` : 'Could not save: browser storage is unavailable');
  }

  const toMain = (id: string) => setDeck((d) => ({ ...d, main: [...d.main, id] }));
  const toSide = (index: number) => setDeck((d) => ({ ...d, main: d.main.filter((_, i) => i !== index) }));

  // Main deck laid out in columns: by mana value (creatures above non-creatures) or by colour (mana value within).
  const sortMode = useSortMode();
  type Entry = { c: CardData; i: number };
  const columns: { label: string; cards: Entry[] }[] = (sortMode === 'cmc' ? ['0', '1', '2', '3', '4', '5', '6', '7+'] : BUCKET_ORDER.filter((b) => b !== 'Land')).map((label) => ({ label, cards: [] }));
  const landCol: Entry[] = [];
  deck.main.forEach((id, i) => {
    const c = getCard(id);
    if (!c) return;
    if (c.types.includes('Land')) { landCol.push({ c, i }); return; }
    const key = sortMode === 'cmc' ? cmcBucket(c) : colorBucket(c);
    columns.find((col) => col.label === key)?.cards.push({ c, i });
  });
  const visibleColumns = sortMode === 'cmc' ? columns : columns.filter((col) => col.cards.length > 0);
  const sortColumn = (cards: Entry[]) => cards.sort((x, y) => (sortMode === 'cmc'
    ? Number(y.c.types.includes('Creature')) - Number(x.c.types.includes('Creature')) || compareCards('cmc', x.c, y.c)
    : compareCards('color', x.c, y.c)));

  if (!isPlayer) return <div className="center-msg">Players are building decks. <MatchList view={view} send={send} onWatch={onWatch} /></div>;

  return (
    <div className="deckbuilder">
      <div className="db-main">
        <div className="db-head">
          <h2>Deckbuilding</h2>
          <span className={`count ${total === 40 ? 'good' : total < 40 ? 'warn' : ''}`}>{total} cards</span>
          <span className="muted">{mainCards.filter((c) => !c.types.includes('Land')).length} spells · {lands} lands · {side.length} in sideboard</span>
          <Curve cards={mainCards} />
        </div>
        <div className="basics">
          <b>Basic lands ({basicsCount}):</b>
          {COLORS.map((c) => (
            <span key={c} className="basic">
              <span className={`pip pip-${c}`}>{c}</span> {BASIC_LANDS[c]}
              <button className="tiny" aria-label={`Remove ${BASIC_LANDS[c]}`} disabled={deck.basics[c] <= 0} onClick={() => setDeck((d) => ({ ...d, basics: { ...d.basics, [c]: Math.max(0, d.basics[c] - 1) } }))}>−</button>
              <b className="basic-count" aria-label={`${BASIC_LANDS[c]} count`}>{deck.basics[c]}</b>
              <button className="tiny" aria-label={`Add ${BASIC_LANDS[c]}`} onClick={() => setDeck((d) => ({ ...d, basics: { ...d.basics, [c]: d.basics[c] + 1 } }))}>+</button>
            </span>
          ))}
          <button onClick={() => setDeck((d) => ({ ...d, basics: suggestBasics(d.main) }))}>Suggest lands (to 40)</button>
          <button onClick={() => setDeck((d) => ({ ...d, basics: { W: 0, U: 0, B: 0, R: 0, G: 0 } }))}>Clear</button>
        </div>
        <p className="muted"><SortToggle /> <span className="hide-touch">Click cards in your pool to add them; click cards in your deck to take them out.</span><span className="show-touch">Tap a card to zoom, then Add to / Remove from deck.</span></p>
        <div className="db-columns">
          {visibleColumns.map((col) => (
            <div key={col.label} className="db-col">
              <div className="db-col-title">{col.label} <small>({col.cards.length})</small></div>
              {sortColumn(col.cards).map(({ c, i }) => (
                <CubeCard key={`${c.id}-${i}`} id={c.id} onClick={() => toSide(i)} className="stacked" tapLabel="Remove from deck" />
              ))}
            </div>
          ))}
          <div className="db-col">
            <div className="db-col-title">Lands <small>({landCol.length + basicsCount})</small></div>
            {landCol.map(({ c, i }) => <CubeCard key={`${c.id}-${i}`} id={c.id} onClick={() => toSide(i)} className="stacked" tapLabel="Remove from deck" />)}
            {basicStacks(deck.basics).map((b) => (
              <div key={b.id} className="basic-stack" data-basic={b.color} aria-label={`${b.count} ${b.name}`}>
                {Array.from({ length: b.shown }, (_, k) => (
                  <CubeCard key={k} id={b.id} className="stacked" tapLabel={`Remove a ${b.name}`} title={`${b.count} ${b.name} (click to remove one)`}
                    onClick={() => setDeck((d) => ({ ...d, basics: { ...d.basics, [b.color]: Math.max(0, d.basics[b.color] - 1) } }))}>
                    {k === b.shown - 1 && <span className="basic-count-badge">×{b.count}</span>}
                  </CubeCard>
                ))}
              </div>
            ))}
          </div>
        </div>
        <PoolSummary ids={side} title="Pool / sideboard" onClick={(id) => toMain(id)} tapLabel="Add to deck" />
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
        <div className="exports save-deck">
          <h4>Save deck</h4>
          <input aria-label="Deck name" value={deckName} onChange={(e) => setDeckName(e.target.value)} placeholder={defaultDeckName(cubeName, evName)} maxLength={80} />
          <button className="primary" disabled={deck.main.length + basicsCount === 0} onClick={saveToLibrary}>Save deck</button>
          {savedMsg && <small className="muted" role="status">{savedMsg}</small>}
        </div>
        <MatchList view={view} send={send} onWatch={onWatch} ready={ready} onReady={setReady} />
        {view.hostId === view.me && <button className="link" onClick={() => { if (confirm('Start a new event? Pools and decks will be cleared.')) send({ t: 'backToLobby' }); }}>New event (back to lobby)</button>}
      </div>
    </div>
  );
}

export function MatchList({ view, send, onWatch, ready, onReady }: { view: RoomProps['view']; send: RoomProps['send']; onWatch: (id: string) => void; ready?: boolean; onReady?: (ready: boolean) => void }) {
  const [bestOf, setBestOf] = useState(view.settings.bestOf ?? 3);
  const humans = view.players.filter((p) => !p.isBot && p.id !== view.me);
  const name = (pid: string) => view.players.find((p) => p.id === pid)?.name ?? '?';
  const iAmPlayer = view.players.some((p) => p.id === view.me);
  const isHost = view.hostId === view.me;
  const [pa, setPa] = useState('');
  const [pb, setPb] = useState('');
  const isReady = (pid: string) => (pid === view.me && ready != null ? ready : !!view.decksReady[pid]);
  const readyCount = view.players.filter((p) => isReady(p.id)).length;
  return (
    <div className="matches">
      <h4>Play</h4>
      {iAmPlayer && (
        <>
          <div className="play-controls">
            {onReady && <label className="ready"><input type="checkbox" checked={!!ready} onChange={(e) => onReady(e.target.checked)} /> Deck ready</label>}
            <label>Best of <select value={bestOf} onChange={(e) => setBestOf(Number(e.target.value))}><option value={1}>1</option><option value={3}>3</option><option value={5}>5</option></select></label>
          </div>
          <ul className="ready-status" aria-label="Who is ready">
            {view.players.map((p) => (
              <li key={p.id} className={isReady(p.id) ? 'is-ready' : 'building'}>
                <span className={`dot ${p.connected ? 'on' : ''}`} />{p.name}{p.id === view.me ? ' (you)' : ''}{p.isBot ? ' · bot' : ''}
                <b>{isReady(p.id) ? 'Ready' : 'Building…'}</b>
              </li>
            ))}
            <li className="ready-summary muted">{readyCount}/{view.players.length} ready</li>
          </ul>
          <PlayVsBot view={view} send={send} bestOf={bestOf} myReady={isReady(view.me)} />
          {humans.map((p) => (
            <div key={p.id} className="challenge">
              <span><span className={`dot ${p.connected ? 'on' : ''}`} />{p.name} {isReady(p.id) ? '✅' : <small className="muted">(building)</small>}</span>
              <button disabled={!isReady(p.id) || !isReady(view.me)} onClick={() => send({ t: 'createMatch', players: [view.me, p.id], bestOf })}>Play</button>
            </div>
          ))}
          {onReady && !isReady(view.me) && <p className="muted">Tick "Deck ready" to play.</p>}
        </>
      )}
      {isHost && humans.length >= 2 && (
        <div className="pairing">
          <small>Host: pair two players</small>
          <select value={pa} onChange={(e) => setPa(e.target.value)}><option value="">…</option>{view.players.filter((p) => !p.isBot).map((p) => <option key={p.id} value={p.id}>{p.name}{isReady(p.id) ? ' ✅' : ' (building)'}</option>)}</select>
          vs
          <select value={pb} onChange={(e) => setPb(e.target.value)}><option value="">…</option>{view.players.filter((p) => !p.isBot).map((p) => <option key={p.id} value={p.id}>{p.name}{isReady(p.id) ? ' ✅' : ' (building)'}</option>)}</select>
          <button disabled={!pa || !pb || pa === pb || !isReady(pa) || !isReady(pb)} title={pa && pb && (!isReady(pa) || !isReady(pb)) ? 'Both players must tick "Deck ready" first' : undefined}
            onClick={() => send({ t: 'createMatch', players: [pa as string, pb as string], bestOf })}>Pair</button>
          {pa && pb && (!isReady(pa) || !isReady(pb)) && <small className="muted"> Waiting for {[pa, pb].filter((x) => !isReady(x)).map(name).join(' and ')} to be ready.</small>}
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
