import { useEffect, useMemo, useState } from 'react';
import { type CardData, deckToText } from '@ojb/shared';
import type { RoomProps } from './Room.tsx';
import { CubeCard, getCard, PreviewPanel } from './cards.tsx';
import { MatchList } from './Deckbuilder.tsx';
import { download } from './net.ts';
import { deckSize, loadDecks, type SavedDeck } from './decklib.ts';

interface Entry { id: string; name: string; count: number; section: 'main' | 'side' | 'commander' }
interface Validation { ok: boolean; errors: string[]; deck: { entries: Entry[] } }

const STORE = (format: string) => `ojb:deck:${format}`;

/** Add one copy of a card to a deck list text (increments an existing main-deck line). */
export function addToList(text: string, name: string): string {
  const lines = text.replace(/\r/g, '').split('\n');
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^(\\d+)(x?\\s+)${esc}(\\s.*)?$`, 'i');
  let sideAt = lines.findIndex((l) => /^(sideboard|side)\s*:?$/i.test(l.trim()));
  if (sideAt < 0 && !lines.some((l) => /^(deck|main)/i.test(l.trim()))) {
    const blank = lines.findIndex((l, i) => !l.trim() && lines.slice(i + 1).some((x) => x.trim()));
    if (blank >= 0) sideAt = blank;
  }
  const end = sideAt < 0 ? lines.length : sideAt;
  for (let i = 0; i < end; i++) {
    const m = re.exec(lines[i].trim());
    if (m) { lines[i] = `${Number(m[1]) + 1}${m[2]}${name}${m[3] ?? ''}`; return lines.join('\n'); }
  }
  // Insert after the last non-empty main-deck line.
  let at = end;
  while (at > 0 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, `1 ${name}`);
  return lines.join('\n').replace(/^\n+/, '');
}

export function Constructed({ view, send, onWatch }: RoomProps & { onWatch: (id: string) => void }) {
  const format = view.settings.format;
  const legalFormat = format === 'Freeform' ? undefined : format;
  const [text, setText] = useState(() => {
    if (view.deck && (view.deck.main.length || Object.values(view.deck.basics).some(Boolean))) return deckToText(view.deck, getCard);
    try { return localStorage.getItem(STORE(format)) ?? ''; } catch { return ''; }
  });
  const [check, setCheck] = useState<Validation | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const me = view.players.find((p) => p.id === view.me);
  const [saved] = useState<SavedDeck[]>(() => loadDecks());
  const [savedId, setSavedId] = useState('');
  const [usedSaved, setUsedSaved] = useState<string | null>(null);

  useEffect(() => {
    try { localStorage.setItem(STORE(format), text); } catch { /* ignore */ }
    if (!text.trim()) { setCheck(null); return; }
    const t = setTimeout(async () => {
      setChecking(true);
      try {
        const res = await fetch('/api/decks/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, ...(legalFormat ? { format: legalFormat } : {}) }) });
        const j = await res.json();
        if (res.ok) setCheck(j as Validation);
        else setCheck({ ok: false, errors: [j.error ?? 'Could not check the deck'], deck: { entries: [] } });
      } catch { /* offline */ }
      setChecking(false);
    }, 450);
    return () => clearTimeout(t);
  }, [text, legalFormat]);

  const entries = check?.deck.entries ?? [];
  const mainCount = entries.filter((e) => e.section !== 'side').reduce((n, e) => n + e.count, 0);
  const sideCount = entries.filter((e) => e.section === 'side').reduce((n, e) => n + e.count, 0);
  const submitted = !!view.deck?.ready;

  async function submit() {
    setSubmitErr(null);
    const err = await send({ t: 'submitDeck', text });
    if (err) setSubmitErr(err);
  }

  async function useSaved() {
    const d = saved.find((x) => x.id === savedId);
    if (!d) return;
    setSubmitErr(null);
    const err = await send({ t: 'submitSavedDeck', deck: { main: d.main, side: d.side, basics: d.basics } });
    if (err) setSubmitErr(err); else setUsedSaved(d.name);
  }

  return (
    <div className="deckbuilder constructed">
      <div className="db-main">
        <div className="db-head">
          <h2>{format} deck</h2>
          <span className={`count ${check?.ok ? 'good' : 'warn'}`}>{mainCount} main · {sideCount} side</span>
          {checking && <span className="muted">checking…</span>}
          {submitted && <span className="good">✅ Deck submitted</span>}
        </div>
        <div className="saved-picker">
          <label>Saved deck: <select value={savedId} onChange={(e) => setSavedId(e.target.value)} aria-label="Saved deck">
            <option value="">{saved.length ? 'Choose one of your saved decks…' : 'No saved decks yet'}</option>
            {saved.map((d) => <option key={d.id} value={d.id}>{d.name} ({deckSize(d)} cards)</option>)}
          </select></label>
          <button className="primary" disabled={!savedId} onClick={useSaved}>Use saved deck</button>
          {usedSaved && submitted && <span className="good" role="status">Using saved deck “{usedSaved}” ({view.deck!.main.length + Object.values(view.deck!.basics).reduce((a, b) => a + b, 0)} cards)</span>}
          {legalFormat && <small className="muted">Saved cube decks usually aren't {format}-legal; the host can pick Freeform in the lobby.</small>}
        </div>
        <p className="muted">Or paste a deck list exported from MTG Arena, MTGO or any site (“4 Lightning Bolt”, optional “Sideboard” section). {legalFormat ? `It's checked against ${format} legality.` : 'Freeform: any cards, no restrictions.'}</p>
        <div className="deck-import">
          <textarea rows={18} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Deck\n4 Lightning Bolt\n4 Monastery Swiftspear\n…\n20 Mountain\n\nSideboard\n2 Abrade'} spellCheck={false} />
          <div className="deck-check">
            {check && (check.ok
              ? <div className="good">Legal{legalFormat ? ` in ${format}` : ''} ✓</div>
              : <ul className="errors">{check.errors.map((e, i) => <li key={i} className="error">{e}</li>)}</ul>)}
            <button className="primary" disabled={!text.trim()} onClick={submit}>{submitted ? 'Resubmit deck' : 'Submit deck'}</button>
            {submitErr && <pre className="error">{submitErr}</pre>}
          </div>
        </div>
        <CardSearch format={legalFormat} onAdd={(c) => setText((t) => addToList(t, c.name))} />
        {entries.length > 0 && <DeckPreview entries={entries} />}
      </div>
      <div className="side">
        <PreviewPanel />
        {view.deck && submitted && (
          <div className="exports">
            <h4>Export deck</h4>
            <button onClick={() => download(`${me?.name ?? 'deck'}.txt`, deckToText(view.deck!, getCard))}>Text (MTGA/MTGO)</button>
          </div>
        )}
        <MatchList view={view} send={send} onWatch={onWatch} />
        {view.hostId === view.me && <button className="link" onClick={() => { if (confirm('Start a new event? Decks will be cleared.')) send({ t: 'backToLobby' }); }}>New event (back to lobby)</button>}
      </div>
    </div>
  );
}

function DeckPreview({ entries }: { entries: Entry[] }) {
  const groups = useMemo(() => {
    const main = entries.filter((e) => e.section !== 'side');
    const side = entries.filter((e) => e.section === 'side');
    return [['Main deck', main], ['Sideboard', side]] as const;
  }, [entries]);
  return (
    <div className="deck-preview">
      {groups.map(([title, list]) => list.length > 0 && (
        <div key={title}>
          <h4>{title} ({list.reduce((n, e) => n + e.count, 0)})</h4>
          <div className="card-grid small">
            {list.map((e) => <CubeCard key={`${title}-${e.id}`} id={e.id} title={e.name}><span className="count-badge">×{e.count}</span></CubeCard>)}
          </div>
        </div>
      ))}
    </div>
  );
}

function CardSearch({ format, onAdd }: { format?: string; onAdd: (c: CardData) => void }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<{ total: number; cards: CardData[] } | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q, limit: '30', ...(format ? { format } : {}) });
        const r = await fetch(`/api/cards/search?${params}`);
        if (r.ok) setRes(await r.json());
      } catch { /* offline */ }
    }, 300);
    return () => clearTimeout(t);
  }, [q, format]);
  return (
    <div className="card-search">
      <h4>Add cards</h4>
      <input placeholder={`Search${format ? ` ${format}-legal` : ''} cards… (t:creature c:r cmc:2 o:"draw a card")`} value={q} onChange={(e) => setQ(e.target.value)} />
      {res && <div className="muted">{res.total} found{res.total > res.cards.length ? `, showing ${res.cards.length}` : ''} — click to add one copy</div>}
      {res && (
        <div className="search-results">
          {res.cards.map((c) => (
            <button key={c.id} className="search-hit" onClick={() => onAdd(c)} title={c.oracle}>
              <b>{c.name}</b> <span className="muted">{c.manaCost.replace(/[{}]/g, '')} · {c.typeLine}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
