import { useMemo, useState } from 'react';
import { cubeToText, type RoomSettings } from '@ojb/shared';
import { CUBE } from '@ojb/shared/src/cube.ts';
import type { RoomProps } from './Room.tsx';
import { CubeCard, getCard, PreviewPanel, setImageSource, useImageSource } from './cards.tsx';
import { download } from './net.ts';

const MODES: { id: RoomSettings['mode']; label: string; blurb: string }[] = [
  { id: 'draft', label: 'Booster draft', blurb: 'Open packs, pick one, pass the rest. Left, right, left.' },
  { id: 'auction', label: 'Auction draft', blurb: 'Packs are opened one at a time; each card is auctioned off with a shared budget.' },
  { id: 'sealed', label: 'Sealed', blurb: 'Everyone gets a pile of packs and builds straight away.' },
];

export function Lobby({ view, send }: RoomProps) {
  const isHost = view.hostId === view.me;
  const s = view.settings;
  const set = (patch: Partial<RoomSettings>) => send({ t: 'updateSettings', settings: patch });
  const humans = view.players.filter((p) => !p.isBot);
  const link = `${location.origin}/r/${view.id}`;
  const [copied, setCopied] = useState(false);
  const [showCube, setShowCube] = useState(false);
  const imgSrc = useImageSource();

  const n = Math.max(s.seats, humans.length);
  const cardsNeeded = s.mode === 'draft' ? n * s.packs * s.packSize : s.mode === 'sealed' ? n * s.sealedPacks * s.sealedPackSize : n * s.auctionPoolSize;

  const num = (label: string, key: keyof RoomSettings, min: number, max: number, hint?: string) => (
    <label className="setting">
      <span>{label}{hint && <small className="muted"> {hint}</small>}</span>
      <input type="number" min={min} max={max} value={s[key] as number} disabled={!isHost}
        onChange={(e) => set({ [key]: Number(e.target.value) } as Partial<RoomSettings>)} />
    </label>
  );

  return (
    <div className="lobby">
      <div className="lobby-main">
        <h1>{view.name}</h1>
        <div className="share">
          <span>Invite friends:</span>
          <code>{link}</code>
          <button onClick={() => { navigator.clipboard?.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied!' : 'Copy link'}</button>
        </div>

        <h3>Players ({humans.length})</h3>
        <ul className="players">
          {view.players.map((p) => (
            <li key={p.id}>
              <span className={`dot ${p.connected ? 'on' : ''}`} />
              {p.name}{p.id === view.hostId && ' 👑'}{p.id === view.me && ' (you)'}
              {isHost && p.id !== view.me && <button className="tiny" onClick={() => send({ t: 'kick', pid: p.id })}>remove</button>}
            </li>
          ))}
        </ul>

        <h3>Format</h3>
        <div className="modes">
          {MODES.map((m) => (
            <button key={m.id} className={`mode ${s.mode === m.id ? 'sel' : ''}`} disabled={!isHost} onClick={() => set({ mode: m.id })}>
              <b>{m.label}</b><span>{m.blurb}</span>
            </button>
          ))}
        </div>

        <div className="settings">
          {num('Seats at the table', 'seats', 1, 8)}
          <label className="setting check"><input type="checkbox" checked={s.fillWithBots} disabled={!isHost} onChange={(e) => set({ fillWithBots: e.target.checked })} /> Fill empty seats with bots</label>
          {s.mode === 'draft' && <>
            {num('Packs per player', 'packs', 1, 5)}
            {num('Cards per pack', 'packSize', 5, 20)}
            {num('Pick timer (sec, 0 = off)', 'pickTimer', 0, 600, 'shrinks as packs get smaller')}
          </>}
          {s.mode === 'sealed' && <>
            {num('Packs per player', 'sealedPacks', 1, 12)}
            {num('Cards per pack', 'sealedPackSize', 5, 20)}
          </>}
          {s.mode === 'auction' && <>
            {num('Budget per player', 'auctionBudget', 10, 10000)}
            {num('Cards per player', 'auctionPoolSize', 10, 90, 'pool size cap')}
            {num('Cards per pack', 'auctionPackSize', 3, 30)}
            {num('Bid timer (sec)', 'auctionTimer', 3, 120, 'resets on each bid')}
            {num('Time to choose a card (sec)', 'nominateTimer', 0, 300)}
          </>}
          <label className="setting check"><input type="checkbox" checked={s.colorBalance} disabled={!isHost} onChange={(e) => set({ colorBalance: e.target.checked })} /> Color-balanced packs</label>
        </div>
        <p className="muted">
          Cube: {view.cubeSize} cards{s.customList?.length ? ' (custom list)' : ''}. This format uses {cardsNeeded} cards for {n} seats.
          {cardsNeeded > view.cubeSize && <b className="error"> Not enough cards!</b>}
        </p>

        {isHost
          ? <button className="primary big" onClick={() => send({ t: 'start' })}>Start {MODES.find((m) => m.id === s.mode)!.label.toLowerCase()}</button>
          : <p className="muted">Waiting for the host to start…</p>}

        <div className="lobby-extra">
          <button onClick={() => setShowCube(!showCube)}>{showCube ? 'Hide' : 'Browse'} the cube</button>
          <button onClick={() => download('orangejuicebox-cube.txt', cubeToText(view.settings.customList?.length ? view.settings.customList : CUBE.list, getCard))}>Download cube list (XMage / CubeCobra)</button>
          <label className="setting check">Card images:
            <select value={imgSrc} onChange={(e) => setImageSource(e.target.value as 'local' | 'scryfall')}>
              <option value="local">Print-and-play scans (fast)</option>
              <option value="scryfall">Scryfall (high-res, needs internet)</option>
            </select>
          </label>
        </div>
        {isHost && <CustomList view={view} set={set} />}
        {showCube && <CubeBrowser />}
      </div>
      <div className="lobby-side"><PreviewPanel /></div>
    </div>
  );
}

function CustomList({ view, set }: { view: RoomProps['view']; set: (p: Partial<RoomSettings>) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [missing, setMissing] = useState<string[]>([]);
  if (!open) return <button className="link" onClick={() => setOpen(true)}>Use a custom card list for this room…</button>;
  const byName = new Map(CUBE.cards.map((c) => [c.name.toLowerCase(), c.id]));
  function apply() {
    const ids: string[] = [];
    const miss: string[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^(\d+)x?\s+(.*)$/.exec(line);
      const count = m ? parseInt(m[1], 10) : 1;
      const name = (m ? m[2] : line).toLowerCase();
      const id = byName.get(name) ?? byName.get(name.split(' // ')[0]) ?? CUBE.cards.find((c) => c.name.toLowerCase().startsWith(name + ' //'))?.id;
      if (id) for (let i = 0; i < count; i++) ids.push(id);
      else miss.push(line);
    }
    setMissing(miss);
    set({ customList: ids });
  }
  return (
    <div className="custom-list">
      <p className="muted">Paste card names (one per line) — any subset of the cube, with optional counts like "2 Lightning Bolt". Cards outside this cube's database can't be used yet (add them to <code>cube/orangejuicebox.txt</code> and rebuild).</p>
      <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Lightning Bolt\nCounterspell\n…'} />
      <div>
        <button onClick={apply}>Use this list</button>
        {view.settings.customList?.length ? <button onClick={() => set({ customList: [] })}>Back to full cube</button> : null}
      </div>
      {missing.length > 0 && <div className="error">Not found: {missing.join(', ')}</div>}
    </div>
  );
}

function CubeBrowser() {
  const [q, setQ] = useState('');
  const [color, setColor] = useState('');
  const cards = useMemo(() => CUBE.cards.filter((c) => {
    if (q && !`${c.name} ${c.typeLine} ${c.oracle}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (color === 'C') return c.colors.length === 0 && !c.types.includes('Land');
    if (color === 'M') return c.colors.length > 1;
    if (color === 'L') return c.types.includes('Land');
    if (color) return c.colors.length === 1 && c.colors[0] === color;
    return true;
  }), [q, color]);
  return (
    <div className="cube-browser">
      <div className="filters">
        <input placeholder="Search name, type or text…" value={q} onChange={(e) => setQ(e.target.value)} />
        {['', 'W', 'U', 'B', 'R', 'G', 'M', 'C', 'L'].map((c) => (
          <button key={c} className={color === c ? 'sel' : ''} onClick={() => setColor(c)}>{c || 'All'}</button>
        ))}
        <span className="muted">{cards.length} cards</span>
      </div>
      <div className="card-grid small">
        {cards.map((c) => <CubeCard key={c.id} id={c.id} />)}
      </div>
    </div>
  );
}
