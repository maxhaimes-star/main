import { useMemo, useState } from 'react';
import { type CardInstance, faceOf, isHidden, type TokenData, type Color, multisetDiff } from '@ojb/shared';
import { CardBack, CardImage, CubeCard, getCard, setPreview, tokenToFace } from '../cards.tsx';
import { Modal, useGame } from './ui.tsx';
import { PoolSummary } from '../Draft.tsx';

// ---------------------------------------------------------------- zone viewer

export function ZoneViewer({ pid, zone, onClose }: { pid: string; zone: 'graveyard' | 'exile' | 'sideboard' | 'command' | 'hand'; onClose: () => void }) {
  const { g, openMenu, menuFor } = useGame();
  const p = g.players.find((x) => x.pid === pid)!;
  const ids = p.zones[zone];
  const title = `${p.name}'s ${zone} (${ids.length})`;
  return (
    <Modal title={title} onClose={onClose} wide>
      <p className="muted">Click or right-click a card for options.</p>
      <div className="zone-grid">
        {ids.map((iid) => {
          const c = g.cards[iid];
          if (!c) return null;
          if (isHidden(c)) return <div key={iid} className="zcard"><CardBack /></div>;
          const face = faceOf(c, getCard);
          return (
            <div key={iid} className="zcard" onMouseEnter={() => setPreview({ face })}
              onClick={(e) => openMenu(e.clientX, e.clientY, menuFor(iid), face.name)}
              onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, menuFor(iid), face.name); }}>
              {c.faceDown && <div className="fd-label">face down</div>}
              <CardImage face={face} />
            </div>
          );
        })}
        {ids.length === 0 && <p className="muted">Empty.</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- scry / surveil / search

type Dest = 'top' | 'bottom' | 'graveyard' | 'hand' | 'battlefield' | 'exile' | 'stay';

export function PeekModal() {
  const { g, me, act, openMenu, menuFor } = useGame();
  const p = g.players.find((x) => x.pid === me)!;
  const peek = p.peek!;
  const search = peek.mode === 'search';
  const [order, setOrder] = useState<string[]>(peek.iids);
  const [dest, setDest] = useState<Record<string, Dest>>(() => Object.fromEntries(peek.iids.map((i) => [i, search ? 'stay' : 'top'])));
  const [filter, setFilter] = useState('');
  const [shuffle, setShuffle] = useState(search);
  const cards = order.map((iid) => g.cards[iid]).filter((c): c is CardInstance => !!c && !isHidden(c) && c.zone === 'library');
  const shown = useMemo(() => {
    const list = search ? cards.slice().sort((a, b) => faceOf(a, getCard).name.localeCompare(faceOf(b, getCard).name)) : cards;
    return filter ? list.filter((c) => { const f = faceOf(c, getCard); return `${f.name} ${f.typeLine}`.toLowerCase().includes(filter.toLowerCase()); }) : list;
  }, [cards, filter, search]);

  const move = (iid: string, d: number) => setOrder((o) => {
    const i = o.indexOf(iid);
    const j = i + d;
    if (j < 0 || j >= o.length) return o;
    const n = o.slice();
    [n[i], n[j]] = [n[j], n[i]];
    return n;
  });

  function done() {
    const by = (d: Dest) => order.filter((i) => dest[i] === d);
    act({ t: 'resolvePeek', top: by('top'), bottom: by('bottom'), graveyard: by('graveyard'), hand: by('hand'), battlefield: by('battlefield'), exile: by('exile'), shuffle });
  }

  const options: Dest[] = search ? ['stay', 'hand', 'battlefield', 'graveyard', 'exile', 'top', 'bottom'] : peek.mode === 'scry' ? ['top', 'bottom'] : peek.mode === 'surveil' ? ['top', 'graveyard'] : ['top', 'bottom', 'hand', 'graveyard', 'exile', 'battlefield'];
  const titles = { scry: 'Scry', surveil: 'Surveil', look: 'Look at the top', search: 'Search your library' };
  return (
    <Modal title={`${titles[peek.mode]} (${peek.iids.length})`} onClose={done} wide>
      {search ? <input placeholder="Filter by name or type (e.g. Island, Equipment, Creature)…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />
        : <p className="muted">Leftmost card ends up on top. Use the arrows to reorder.</p>}
      <div className="zone-grid peek">
        {shown.map((c) => {
          const face = faceOf(c, getCard);
          return (
            <div key={c.iid} className={`zcard dest-${dest[c.iid]}`} onMouseEnter={() => setPreview({ face })}>
              <div title="Click for more (cast / play from library)" onClick={(e) => openMenu(e.clientX, e.clientY, menuFor(c.iid), face.name)}><CardImage face={face} /></div>
              <select value={dest[c.iid]} onChange={(e) => setDest({ ...dest, [c.iid]: e.target.value as Dest })}>
                {options.map((o) => <option key={o} value={o}>{o === 'stay' ? 'leave in library' : o === 'top' ? 'top of library' : o === 'bottom' ? 'bottom of library' : o}</option>)}
              </select>
              {!search && <div className="order"><button className="tiny" onClick={() => move(c.iid, -1)}>◀</button><button className="tiny" onClick={() => move(c.iid, 1)}>▶</button></div>}
            </div>
          );
        })}
      </div>
      <div className="row">
        <label><input type="checkbox" checked={shuffle} onChange={(e) => setShuffle(e.target.checked)} /> Shuffle afterwards</label>
        <button className="primary" onClick={done}>Done</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- tokens

const COMMON_TOKENS: TokenData[] = [
  { name: 'Treasure', typeLine: 'Token Artifact — Treasure', colors: [], oracle: '{T}, Sacrifice this artifact: Add one mana of any color.', keywords: [] },
  { name: 'Clue', typeLine: 'Token Artifact — Clue', colors: [], oracle: '{2}, Sacrifice this artifact: Draw a card.', keywords: [] },
  { name: 'Food', typeLine: 'Token Artifact — Food', colors: [], oracle: '{2}, {T}, Sacrifice this artifact: You gain 3 life.', keywords: [] },
  { name: 'Soldier', typeLine: 'Token Creature — Soldier', colors: ['W'], power: '1', toughness: '1', oracle: '', keywords: [] },
  { name: 'Spirit', typeLine: 'Token Creature — Spirit', colors: ['W'], power: '1', toughness: '1', oracle: 'Flying', keywords: ['Flying'] },
  { name: 'Goblin', typeLine: 'Token Creature — Goblin', colors: ['R'], power: '1', toughness: '1', oracle: '', keywords: [] },
  { name: 'Zombie', typeLine: 'Token Creature — Zombie', colors: ['B'], power: '2', toughness: '2', oracle: '', keywords: [] },
  { name: 'Beast', typeLine: 'Token Creature — Beast', colors: ['G'], power: '3', toughness: '3', oracle: '', keywords: [] },
  { name: 'Germ', typeLine: 'Token Creature — Phyrexian Germ', colors: ['B'], power: '0', toughness: '0', oracle: '', keywords: [] },
  { name: 'Construct', typeLine: 'Token Artifact Creature — Construct', colors: [], power: '0', toughness: '0', oracle: 'This creature gets +1/+1 for each artifact you control.', keywords: [] },
];

export function TokenModal({ onClose }: { onClose: () => void }) {
  const { g, me, act } = useGame();
  const [count, setCount] = useState(1);
  const [custom, setCustom] = useState({ name: '', type: 'Creature — ', p: '1', t: '1', colors: '', text: '' });
  // Tokens referenced by cards I own in this game.
  const fromCards = useMemo(() => {
    const seen = new Map<string, TokenData>();
    for (const c of Object.values(g.cards)) {
      if (isHidden(c) || c.owner !== me || !c.cardId) continue;
      for (const t of getCard(c.cardId)?.tokens ?? []) seen.set(`${t.name}|${t.power}|${t.oracle}`, t);
    }
    return [...seen.values()];
  }, [g.cards, me]);
  const make = (t: TokenData) => { act({ t: 'createToken', token: t, n: count }); onClose(); };
  const Tok = ({ t }: { t: TokenData }) => (
    <div className="zcard" onMouseEnter={() => setPreview({ face: tokenToFace(t) })} onClick={() => make(t)}><CardImage face={tokenToFace(t)} /></div>
  );
  return (
    <Modal title="Create tokens" onClose={onClose} wide>
      <label>How many? <input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} /></label>
      {fromCards.length > 0 && <><h4>From your cards</h4><div className="zone-grid">{fromCards.map((t, i) => <Tok key={i} t={t} />)}</div></>}
      <h4>Common</h4>
      <div className="zone-grid">{COMMON_TOKENS.map((t) => <Tok key={t.name} t={t} />)}</div>
      <h4>Custom</h4>
      <div className="custom-token">
        <input placeholder="Name" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
        <input placeholder="Type (e.g. Creature — Elf Warrior)" value={custom.type} onChange={(e) => setCustom({ ...custom, type: e.target.value })} />
        <input className="short" placeholder="P" value={custom.p} onChange={(e) => setCustom({ ...custom, p: e.target.value })} />
        <input className="short" placeholder="T" value={custom.t} onChange={(e) => setCustom({ ...custom, t: e.target.value })} />
        <input className="short" placeholder="WUBRG" value={custom.colors} onChange={(e) => setCustom({ ...custom, colors: e.target.value.toUpperCase() })} />
        <input placeholder="Text (e.g. Flying, haste)" value={custom.text} onChange={(e) => setCustom({ ...custom, text: e.target.value })} />
        <button className="primary" disabled={!custom.name} onClick={() => make({
          name: custom.name, typeLine: `Token ${custom.type}`, colors: (custom.colors.match(/[WUBRG]/g) ?? []) as Color[],
          power: /Creature/.test(custom.type) ? custom.p : undefined, toughness: /Creature/.test(custom.type) ? custom.t : undefined,
          oracle: custom.text, keywords: [],
        })}>Create</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- mulligan

export function MulliganOverlay() {
  const { g, me, act } = useGame();
  const p = g.players.find((x) => x.pid === me);
  const [sel, setSel] = useState<string[]>([]);
  if (!p) return <div className="overlay-msg">Players are choosing their opening hands…</div>;
  const others = g.players.filter((x) => x.pid !== me);
  const waiting = p.kept && p.needsBottom === 0;
  return (
    <div className="mulligan">
      <h2>{g.startingPlayer === me ? 'You are on the play.' : 'You are on the draw.'} {p.mulligans > 0 && `Mulligans: ${p.mulligans}`}</h2>
      <div className="mull-hand">
        {p.zones.hand.map((iid) => {
          const c = g.cards[iid];
          if (!c || isHidden(c)) return null;
          const face = faceOf(c, getCard);
          return (
            <div key={iid} className={`zcard ${sel.includes(iid) ? 'selected' : ''}`} onMouseEnter={() => setPreview({ face })}
              onClick={() => p.needsBottom > 0 && setSel(sel.includes(iid) ? sel.filter((x) => x !== iid) : sel.length < p.needsBottom ? [...sel, iid] : sel)}>
              <CardImage face={face} />
            </div>
          );
        })}
      </div>
      {!p.kept && (
        <div className="row">
          <button className="primary big" onClick={() => act({ t: 'keep' })}>Keep {7 - p.mulligans}</button>
          <button className="big" onClick={() => act({ t: 'mulligan' })} disabled={p.mulligans >= 6}>Mulligan to {6 - p.mulligans}</button>
        </div>
      )}
      {p.kept && p.needsBottom > 0 && (
        <div className="row">
          <span>Choose {p.needsBottom} card(s) to put on the bottom ({sel.length} selected).</span>
          <button className="primary" disabled={sel.length !== p.needsBottom} onClick={() => act({ t: 'bottom', iids: sel })}>Put on bottom</button>
        </div>
      )}
      {waiting && <p className="muted">Waiting for {others.filter((o) => !o.kept || o.needsBottom > 0).map((o) => o.name).join(', ') || 'opponent'}…</p>}
    </div>
  );
}

// ---------------------------------------------------------------- sideboarding between games

export function Sideboarding({ main, side, onSave, onReady, ready }: { main: string[]; side: string[]; onSave: (main: string[]) => void; onReady: () => void; ready: boolean }) {
  const all = [...main, ...side];
  const [m, setM] = useState(main);
  const s = multisetDiff(all, m);
  return (
    <div className="sideboarding">
      <p>Click cards to swap them between deck and sideboard. Deck: <b>{m.length}</b> cards.</p>
      <div className="row">
        <button onClick={() => onSave(m)}>Save changes</button>
        <button className="primary" disabled={ready} onClick={() => { onSave(m); onReady(); }}>{ready ? 'Waiting for opponent…' : 'Ready for next game'}</button>
      </div>
      <div className="sb-cols">
        <PoolSummary ids={m} title="Deck" onClick={(_id, i) => setM(m.filter((_, j) => j !== i))} />
        <PoolSummary ids={s} title="Sideboard" onClick={(id) => setM([...m, id])} />
      </div>
    </div>
  );
}

export { CubeCard };
