import { useEffect, useMemo, useState } from 'react';
import { NumberField } from './NumberField.tsx';
import { CONSTRUCTED_FORMATS, cubeToText, overrideNames, type RoomSettings } from '@ojb/shared';
import type { SetSummary } from '@ojb/shared/src/carddb-types.ts';
import { CUBE } from '@ojb/shared/src/cube.ts';
import type { RoomProps } from './Room.tsx';
import { CubeCard, getCard, PreviewPanel, setImageSource, useImageSource } from './cards.tsx';
import { api, download } from './net.ts';
import { MyDecks } from './MyDecks.tsx';
import { InviteBar } from './Invite.tsx';
import { BotLobbyOption } from './BotControls.tsx';
import { cobraIdOf, deleteCube, loadCubes, saveCube, type SavedCube } from './cubelib.ts';

type EventId = 'cube-draft' | 'cube-sealed' | 'cube-auction' | 'set-draft' | 'set-sealed' | 'constructed';

const EVENTS: { id: EventId; label: string; blurb: string; settings: Partial<RoomSettings>; db?: boolean }[] = [
  { id: 'cube-draft', label: 'Cube draft', blurb: 'Open packs, pick one, pass the rest. Left, right, left.', settings: { mode: 'draft', source: 'cube' } },
  { id: 'cube-sealed', label: 'Cube sealed', blurb: 'Everyone gets a pile of cube packs and builds straight away.', settings: { mode: 'sealed', source: 'cube' } },
  { id: 'cube-auction', label: 'Cube auction', blurb: 'Packs open one at a time; each card is auctioned off with a shared budget.', settings: { mode: 'auction', source: 'cube' } },
  { id: 'set-draft', label: 'Set draft', blurb: 'Real boosters from any set (or mix sets per pack). Bots fill the table.', settings: { mode: 'draft', source: 'set' }, db: true },
  { id: 'set-sealed', label: 'Set sealed', blurb: 'Open six boosters of a set and build a 40-card deck.', settings: { mode: 'sealed', source: 'set' }, db: true },
  { id: 'constructed', label: 'Constructed', blurb: 'Bring your own deck list (Standard, Pioneer, Modern, Legacy, Vintage, Pauper…) or play a deck you saved earlier.', settings: { mode: 'constructed' } },
];

function eventOf(s: RoomSettings): EventId {
  if (s.mode === 'constructed') return 'constructed';
  if (s.source === 'set' && s.mode !== 'auction') return s.mode === 'draft' ? 'set-draft' : 'set-sealed';
  return s.mode === 'draft' ? 'cube-draft' : s.mode === 'sealed' ? 'cube-sealed' : 'cube-auction';
}

// ------------------------------------------------------------- set list (fetched once)

let setsCache: Promise<SetSummary[]> | null = null;
function loadSets(): Promise<SetSummary[]> {
  setsCache ??= fetch('/api/sets').then((r) => (r.ok ? r.json() : [])).catch(() => []) as Promise<SetSummary[]>;
  return setsCache;
}
export function useBoosterSets(): SetSummary[] {
  const [sets, setSets] = useState<SetSummary[]>([]);
  useEffect(() => {
    let live = true;
    loadSets().then((all) => live && setSets(all.filter((x) => x.booster).sort((a, b) => b.date.localeCompare(a.date))));
    return () => { live = false; };
  }, []);
  return sets;
}
const setLabel = (x: SetSummary) => `${x.code} — ${x.name} (${x.date.slice(0, 4)})`;

/** Searchable set picker: type a code or name; only sets with boosters, newest first. */
function SetPicker({ value, onChange, sets, disabled }: { value: string; onChange: (code: string) => void; sets: SetSummary[]; disabled?: boolean }) {
  const cur = sets.find((x) => x.code === value);
  const [text, setText] = useState(cur ? setLabel(cur) : value);
  useEffect(() => { setText(cur ? setLabel(cur) : value); }, [value, cur?.code]);
  const id = useMemo(() => `sets-${Math.random().toString(36).slice(2)}`, []);
  function commit(t: string) {
    const code = t.split(' — ')[0].trim().toUpperCase();
    const hit = sets.find((x) => x.code === code) ?? sets.find((x) => x.name.toLowerCase() === t.trim().toLowerCase());
    if (hit) { if (hit.code !== value) onChange(hit.code); setText(setLabel(hit)); } else setText(cur ? setLabel(cur) : value);
  }
  return (
    <>
      <input className="set-picker" list={id} value={text} disabled={disabled} placeholder="Type a set name or code…"
        onFocus={(e) => e.target.select()}
        onChange={(e) => { setText(e.target.value); if (sets.some((x) => setLabel(x) === e.target.value)) commit(e.target.value); }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }} />
      <datalist id={id}>{sets.map((x) => <option key={x.code} value={setLabel(x)} />)}</datalist>
    </>
  );
}

export function Lobby({ view, send }: RoomProps) {
  const isHost = view.hostId === view.me;
  const s = view.settings;
  const set = (patch: Partial<RoomSettings>) => send({ t: 'updateSettings', settings: patch });
  const humans = view.players.filter((p) => !p.isBot);
  const [showCube, setShowCube] = useState(false);
  const imgSrc = useImageSource();
  const ev = eventOf(s);
  const event = EVENTS.find((e) => e.id === ev)!;
  const sets = useBoosterSets();
  const isCube = ev.startsWith('cube');

  const n = Math.max(s.seats, humans.length);
  const cardsNeeded = s.mode === 'draft' ? n * s.packs * s.packSize : s.mode === 'sealed' ? n * s.sealedPacks * s.sealedPackSize : n * s.auctionPacksPerPlayer * s.auctionPackSize;

  const num = (label: string, key: keyof RoomSettings, min: number, max: number, hint?: string) => (
    <label className="setting">
      <span>{label}{hint && <small className="muted"> {hint}</small>}</span>
      <NumberField min={min} max={max} value={s[key] as number} disabled={!isHost}
        onCommit={(v) => set({ [key]: v } as Partial<RoomSettings>)} />
    </label>
  );

  function chooseEvent(e: (typeof EVENTS)[number]) {
    const patch: Partial<RoomSettings> = { ...e.settings };
    const newest = sets[0]?.code;
    if (e.id === 'set-draft' && s.setCodes.length === 0 && newest) patch.setCodes = [newest, newest, newest];
    if (e.id === 'set-sealed') {
      if (s.setCodes.length === 0 && newest) patch.setCodes = [newest];
      if (s.source !== 'set') patch.sealedPacks = 6;
    }
    set(patch);
  }

  const codes = s.setCodes;
  const draftCodes = codes.length ? codes : [];
  const setPackCount = (k: number) => {
    const base = draftCodes.length ? draftCodes : [sets[0]?.code ?? 'DMU'];
    set({ setCodes: Array.from({ length: k }, (_, i) => base[i] ?? base[base.length - 1]) });
  };

  return (
    <div className="lobby">
      <div className="lobby-main">
        <h1>{view.name}</h1>
        <InviteBar roomId={view.id} roomName={view.name} />

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

        <h3>Event type</h3>
        <div className="modes">
          {EVENTS.map((m) => (
            <button key={m.id} className={`mode ${ev === m.id ? 'sel' : ''}`} disabled={!isHost || (m.db && !view.carddb)} title={m.db && !view.carddb ? 'Needs the card database (not built on this server)' : undefined} onClick={() => chooseEvent(m)}>
              <b>{m.label}</b><span>{m.blurb}</span>
            </button>
          ))}
        </div>

        {ev === 'set-draft' && (
          <div className="set-packs">
            <label className="setting"><span>Packs per player</span>
              <NumberField min={1} max={5} value={Math.max(1, draftCodes.length)} disabled={!isHost} onCommit={setPackCount} />
            </label>
            {draftCodes.map((code, i) => (
              <label key={i} className="setting"><span>Pack {i + 1}</span>
                <SetPicker sets={sets} value={code} disabled={!isHost} onChange={(c) => set({ setCodes: i === 0 && draftCodes.every((x) => x === code) ? draftCodes.map(() => c) : draftCodes.map((x, j) => (j === i ? c : x)) })} />
              </label>
            ))}
            <small className="muted">Changing pack 1 while all packs match changes them all; then pick other sets for a mixed draft.</small>
          </div>
        )}
        {ev === 'set-sealed' && (
          <div className="set-packs">
            {(codes.length ? codes : ['']).map((code, i) => (
              <label key={i} className="setting"><span>{i === 0 ? 'Set' : `Set ${i + 1}`}{i > 0 && isHost && <button className="tiny" onClick={() => set({ setCodes: codes.filter((_, j) => j !== i) })}>remove</button>}</span>
                <SetPicker sets={sets} value={code} disabled={!isHost} onChange={(c) => set({ setCodes: codes.length ? codes.map((x, j) => (j === i ? c : x)) : [c] })} />
              </label>
            ))}
            {isHost && codes.length > 0 && codes.length < 6 && <button className="link" onClick={() => set({ setCodes: [...codes, codes[codes.length - 1]] })}>+ mix in another set (packs alternate)</button>}
          </div>
        )}
        {ev === 'constructed' && (
          <div className="settings">
            <label className="setting"><span>Format</span>
              <select value={s.format} disabled={!isHost} onChange={(e) => set({ format: e.target.value })}>
                {CONSTRUCTED_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <label className="setting"><span>Matches</span>
              <select value={s.bestOf} disabled={!isHost} onChange={(e) => set({ bestOf: Number(e.target.value) })}>
                <option value={1}>Best of 1</option><option value={3}>Best of 3</option><option value={5}>Best of 5</option>
              </select>
            </label>
          </div>
        )}

        {ev !== 'constructed' && (
          <div className="settings">
            {num('Seats at the table', 'seats', 1, 8)}
            <label className="setting check"><input type="checkbox" checked={s.fillWithBots} disabled={!isHost} onChange={(e) => set({ fillWithBots: e.target.checked })} /> Fill empty seats with bots</label>
            {s.mode === 'draft' && <>
              {isCube && num('Packs per player', 'packs', 1, 5)}
              {isCube && num('Cards per pack', 'packSize', 5, 20)}
              {num('Pick timer (sec, 0 = off)', 'pickTimer', 0, 600, 'shrinks as packs get smaller')}
            </>}
            {s.mode === 'sealed' && <>
              {num('Packs per player', 'sealedPacks', 1, 12)}
              {isCube && num('Cards per pack', 'sealedPackSize', 5, 20)}
            </>}
            {s.mode === 'auction' && <>
              {num('Budget per player', 'auctionBudget', 10, 10000)}
              {num('Minimum bid', 'auctionMinBid', 1, 100)}
              {num('Packs per player', 'auctionPacksPerPlayer', 1, 8)}
              {num('Cards per pack', 'auctionPackSize', 3, 30)}
              {num('Pool size cap', 'auctionPoolSize', 0, 90, '0 = no cap')}
              {num('Bid timer (sec, 0 = off)', 'auctionTimer', 0, 120, 'backstop; lots close when everyone passes')}
              {num('Time to choose a card (sec)', 'nominateTimer', 0, 300)}
            </>}
            {isCube && <label className="setting check"><input type="checkbox" checked={s.colorBalance} disabled={!isHost} onChange={(e) => set({ colorBalance: e.target.checked })} /> Color-balanced packs</label>}
            {isCube && <label className="setting check" title="Adds Black Lotus, the five Moxen, Ancestral Recall, Time Walk, Timetwister, Mana Vault, Sol Ring and Mana Crypt (any the cube doesn't already have)"><input type="checkbox" data-testid="power-up" checked={!!s.powerUp} disabled={!isHost} onChange={(e) => set({ powerUp: e.target.checked })} /> Power up</label>}
          </div>
        )}
        {isCube && (
          <p className="muted">
            Cube: {s.customList?.length ? <>{s.customListName ?? 'Imported list'} ({view.cubeSize} cards)</> : <>{CUBE.name} ({view.cubeSize} cards)</>}. This format uses {cardsNeeded} cards for {n} seats.
            {cardsNeeded > view.cubeSize && <b className="error"> Not enough cards!</b>}
          </p>
        )}
        {ev === 'constructed' && <p className="muted">After the host starts, everyone pastes a deck list (MTGA / MTGO / plain text) or picks one of their saved decks. Decks are checked for {s.format} legality before matches start{s.format !== 'Freeform' ? ' — choose Freeform to play saved cube decks with any cards' : ''}.</p>}
        <BotLobbyOption view={view} send={send} />
        <MyDecks />

        {isHost
          ? <button className="primary big" onClick={() => send({ t: 'start' })}>Start {event.label.toLowerCase()}</button>
          : <p className="muted">Waiting for the host to start…</p>}

        {isCube && (
          <div className="lobby-extra">
            <button onClick={() => setShowCube(!showCube)}>{showCube ? 'Hide' : 'Browse'} the cube</button>
            <button onClick={() => download(`${(s.customListName ?? 'orangejuicebox').replace(/[^\w-]+/g, '-')}-cube.txt`, cubeToText(s.customList?.length ? s.customList : CUBE.list, getCard))}>Download cube list (XMage / CubeCobra)</button>
            <label className="setting check">Card images:
              <select value={imgSrc} onChange={(e) => setImageSource(e.target.value as 'local' | 'scryfall')}>
                <option value="local">Print-and-play scans (fast)</option>
                <option value="scryfall">Scryfall (high-res, needs internet)</option>
              </select>
            </label>
          </div>
        )}
        {isHost && isCube && <CustomList view={view} set={set} />}
        {showCube && isCube && <CubeBrowser ids={s.customList?.length ? s.customList : undefined} />}
      </div>
      <div className="lobby-side"><PreviewPanel /></div>
    </div>
  );
}

/** Card names from a pasted list: plain names / "2 Name" lines, or a CubeCobra CSV export. */
export function cubeListText(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n');
  if (/^\s*"?name"?\s*,/i.test(lines[0] ?? '')) {
    // CubeCobra CSV: first column is the name (quoted when it contains commas).
    return lines.slice(1).map((l) => {
      const m = /^\s*"((?:[^"]|"")*)"|^([^,]*)/.exec(l);
      return (m?.[1]?.replace(/""/g, '"') ?? m?.[2] ?? '').trim();
    }).filter(Boolean).join('\n');
  }
  return text;
}

const OJB = 'ojb';
const IMPORT = 'import';
const CURRENT = 'current';

function CustomList({ view, set }: { view: RoomProps['view']; set: (p: Partial<RoomSettings>) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [cobra, setCobra] = useState('');
  const [loadedCobra, setLoadedCobra] = useState<string | null>(null);
  const [save, setSave] = useState(true);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [cubes, setCubes] = useState<SavedCube[]>(() => loadCubes());
  const s = view.settings;
  const active = s.customList?.length ? s.customList : null;
  const saved = active ? cubes.find((c) => c.name === (s.customListName ?? 'Imported list') && c.cards.length === active.length && c.cards[0] === active[0]) : undefined;
  const selected = open ? IMPORT : !active ? OJB : saved ? saved.id : CURRENT;

  function pick(v: string) {
    setMsg(null); setMissing([]);
    if (v === IMPORT) { setOpen(true); return; }
    setOpen(false);
    if (v === OJB) set({ customList: [], customListName: undefined });
    else { const c = cubes.find((x) => x.id === v); if (c) set({ customList: c.cards, customListName: c.name }); }
  }

  /** Names/lines to card ids: through the card database when the server has one, else against the built-in cube. */
  async function resolve(list: string): Promise<{ ids: string[]; missing: string[] }> {
    if (view.carddb) {
      const r = await api<{ deck: { entries: { id: string; count: number }[]; errors: string[] } }>('/api/decks/validate', { text: cubeListText(list) });
      return { ids: r.deck.entries.flatMap((e) => Array(e.count).fill(e.id) as string[]), missing: r.deck.errors.map((e) => e.replace(/^Line \d+: unknown card /, '')) };
    }
    const byName = new Map([...CUBE.cards.map((c) => [c.name.toLowerCase(), c.id] as const), ...Object.entries(overrideNames())]);
    const ids: string[] = [];
    const miss: string[] = [];
    for (const raw of cubeListText(list).split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^(\d+)x?\s+(.*)$/.exec(line);
      const count = m ? parseInt(m[1], 10) : 1;
      const nm = (m ? m[2] : line).toLowerCase();
      const id = byName.get(nm) ?? byName.get(nm.split(' // ')[0]) ?? CUBE.cards.find((c) => c.name.toLowerCase().startsWith(nm + ' //'))?.id;
      if (id) for (let i = 0; i < count; i++) ids.push(id);
      else miss.push(line);
    }
    return { ids, missing: miss };
  }

  async function fetchCobra(id: string): Promise<{ name?: string; text: string }> {
    const res = await fetch(`/api/cubecobra/${encodeURIComponent(id)}`);
    const j = await res.json() as { name?: string; text?: string; error?: string };
    if (!res.ok || !j.text) throw new Error(j.error ?? 'Could not load that cube');
    return { name: j.name, text: j.text };
  }

  async function apply() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await resolve(text);
      setMissing(r.missing);
      if (!r.ids.length) throw new Error('No cards were recognised in that list.');
      const nm = name.trim() || undefined;
      set({ customList: r.ids, customListName: nm });
      let note = `Using ${r.ids.length} cards.`;
      if (save) {
        const out = saveCube({ name: nm ?? 'Imported list', cards: r.ids, cobraId: loadedCobra ?? undefined });
        setCubes(out.cubes);
        note += out.saved ? ' Saved to your library.' : ' (Could not save: browser storage is unavailable.)';
      }
      setMsg(note);
      setOpen(false);
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  }

  async function fromCobra() {
    const id = cobraIdOf(cobra);
    if (!id) return;
    setBusy(true);
    setMsg(null);
    try {
      const j = await fetchCobra(id);
      setText(j.text);
      setLoadedCobra(id);
      if (j.name && !name) setName(j.name);
      setMsg('Loaded — check the list and press "Use this list".');
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  }

  async function refresh(c: SavedCube) {
    if (!c.cobraId) return;
    setBusy(true);
    setMsg(null);
    try {
      const j = await fetchCobra(c.cobraId);
      const r = await resolve(j.text);
      if (!r.ids.length) throw new Error('CubeCobra returned no recognisable cards.');
      const out = saveCube({ id: c.id, name: c.name, cards: r.ids, cobraId: c.cobraId });
      setCubes(out.cubes);
      setMissing(r.missing);
      if (saved?.id === c.id) set({ customList: r.ids, customListName: c.name });
      setMsg(`Refreshed ${c.name}: ${r.ids.length} cards.`);
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  }

  function remove(c: SavedCube) {
    setCubes(deleteCube(c.id));
    setMsg(`Deleted ${c.name} from your library.`);
  }

  return (
    <div className="cube-choice-wrap">
      <div className="cube-choice">
        <label className="setting">Cube:{' '}
          <select value={selected} onChange={(e) => pick(e.target.value)}>
            <option value={OJB}>{CUBE.name}</option>
            {cubes.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.cards.length} cards)</option>)}
            {selected === CURRENT && <option value={CURRENT}>{s.customListName ?? 'Imported list'} ({active?.length} cards, this room only)</option>}
            <option value={IMPORT}>Import new…</option>
          </select>
        </label>
        {saved && <button className="link" disabled={busy} onClick={() => remove(saved)}>Delete from library</button>}
        {saved?.cobraId && <button className="link" disabled={busy} onClick={() => refresh(saved)}>Refresh from CubeCobra</button>}
      </div>
      {!open && msg && <div className="muted">{msg}</div>}
      {!open && missing.length > 0 && <div className="error">Not found ({missing.length}): {missing.slice(0, 40).join(', ')}{missing.length > 40 ? '…' : ''}</div>}
      {open && (
        <div className="custom-list">
          <p className="muted">
            Paste a cube list: one card per line (optional counts like "2 Lightning Bolt"), or a CubeCobra CSV / text export.
            {view.carddb ? ' Any Magic card works.' : ' This server has no card database, so only cards from the built-in cube can be used.'}
          </p>
          {view.carddb && (
            <div className="cobra-row">
              <input placeholder="CubeCobra cube ID or link (optional)" value={cobra} onChange={(e) => setCobra(e.target.value)} />
              <button disabled={busy || !cobra.trim()} onClick={fromCobra}>Load from CubeCobra</button>
            </div>
          )}
          <input placeholder="Cube name (optional)" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <textarea rows={8} value={text} onChange={(e) => { setText(e.target.value); setLoadedCobra(null); }} placeholder={'Lightning Bolt\nCounterspell\n…'} />
          <label className="setting check"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Save to library</label>
          <div>
            <button disabled={busy || !text.trim()} onClick={apply}>Use this list</button>
            <button className="link" onClick={() => setOpen(false)}>Close</button>
          </div>
          {msg && <div className="muted">{msg}</div>}
          {missing.length > 0 && <div className="error">Not found ({missing.length}): {missing.slice(0, 40).join(', ')}{missing.length > 40 ? '…' : ''}</div>}
        </div>
      )}
    </div>
  );
}

function CubeBrowser({ ids }: { ids?: string[] }) {
  const [q, setQ] = useState('');
  const [color, setColor] = useState('');
  const all = ids ? [...new Set(ids)].map((id) => getCard(id)).filter((c): c is NonNullable<typeof c> => !!c) : CUBE.cards;
  const cards = useMemo(() => all.filter((c) => {
    if (q && !`${c.name} ${c.typeLine} ${c.oracle}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (color === 'C') return c.colors.length === 0 && !c.types.includes('Land');
    if (color === 'M') return c.colors.length > 1;
    if (color === 'L') return c.types.includes('Land');
    if (color) return c.colors.length === 1 && c.colors[0] === color;
    return true;
  }), [q, color, all]);
  return (
    <div className="cube-browser">
      <div className="filters">
        <input placeholder="Search name, type or text…" value={q} onChange={(e) => setQ(e.target.value)} />
        {['', 'W', 'U', 'B', 'R', 'G', 'M', 'C', 'L'].map((c) => (
          <button key={c} className={color === c ? 'sel' : ''} onClick={() => setColor(c)}>{c || 'All'}</button>
        ))}
        <span className="muted">{cards.length} cards{ids && all.length < new Set(ids).size ? ` (loading ${new Set(ids).size - all.length}…)` : ''}</span>
      </div>
      <div className="card-grid small">
        {cards.map((c) => <CubeCard key={c.id} id={c.id} />)}
      </div>
    </div>
  );
}
