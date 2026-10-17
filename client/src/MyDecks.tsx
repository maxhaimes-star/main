import { useState } from 'react';
import { BASIC_LANDS, type Color, deckToText, deckToXmage } from '@ojb/shared';
import { getCard } from './cards.tsx';
import { download } from './net.ts';
import { asDeck, deleteDeck, deckSize, loadDecks, nameLookup, renameDeck, type SavedDeck } from './decklib.ts';

const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];

function counts(ids: string[], d: SavedDeck): [number, string][] {
  const m = new Map<string, number>();
  for (const id of ids) { const n = d.names[id] ?? getCard(id)?.name ?? id; m.set(n, (m.get(n) ?? 0) + 1); }
  return [...m.entries()].map(([n, c]) => [c, n] as [number, string]).sort((a, b) => a[1].localeCompare(b[1]));
}

const fileName = (d: SavedDeck) => d.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'deck';

/** The player's saved decks (browser localStorage): view, rename, delete, export. */
export function MyDecks({ open }: { open?: boolean }) {
  const [decks, setDecks] = useState<SavedDeck[]>(() => loadDecks());
  const [shown, setShown] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const commit = (id: string) => { setDecks(renameDeck(id, draft)); setEditing(null); };

  return (
    <details className="my-decks" open={open} onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) setDecks(loadDecks()); }}>
      <summary>My decks ({decks.length})</summary>
      {decks.length === 0 && <p className="muted">No saved decks yet. Save one from the deckbuilder, or play a game from a draft and it is saved automatically.</p>}
      <ul className="deck-lib">
        {decks.map((d) => {
          const lookup = nameLookup(d, getCard);
          return (
            <li key={d.id} className="saved-deck">
              <div className="saved-deck-row">
                {editing === d.id
                  ? <>
                    <input aria-label="Deck name" value={draft} maxLength={80} autoFocus onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commit(d.id); if (e.key === 'Escape') setEditing(null); }} />
                    <button className="tiny" onClick={() => commit(d.id)}>Save name</button>
                  </>
                  : <b className="deck-name">{d.name}</b>}
                <span className="muted">{deckSize(d)} cards · {d.side.length} side · {d.cube} · {new Date(d.updatedAt).toLocaleDateString()}</span>
                <span className="deck-actions">
                  <button className="tiny" onClick={() => setShown(shown === d.id ? null : d.id)}>{shown === d.id ? 'Hide list' : 'View list'}</button>
                  <button className="tiny" onClick={() => { setEditing(d.id); setDraft(d.name); }}>Rename</button>
                  <button className="tiny" onClick={() => download(`${fileName(d)}.txt`, deckToText(asDeck(d), lookup))}>Export text</button>
                  <button className="tiny" onClick={() => download(`${fileName(d)}.dck`, deckToXmage(asDeck(d), lookup, d.name))}>Export XMage</button>
                  <button className="tiny danger" onClick={() => { if (confirm(`Delete "${d.name}"?`)) { setDecks(deleteDeck(d.id)); if (shown === d.id) setShown(null); } }}>Delete</button>
                </span>
              </div>
              {shown === d.id && (
                <div className="saved-deck-list">
                  <div>
                    <h5>Main deck ({deckSize(d)})</h5>
                    <ul>
                      {counts(d.main, d).map(([n, name]) => <li key={name}>{n} {name}</li>)}
                      {COLORS.filter((c) => d.basics[c] > 0).map((c) => <li key={c}>{d.basics[c]} {BASIC_LANDS[c]}</li>)}
                    </ul>
                  </div>
                  {d.side.length > 0 && (
                    <div>
                      <h5>Sideboard ({d.side.length})</h5>
                      <ul>{counts(d.side, d).map(([n, name]) => <li key={name}>{n} {name}</li>)}</ul>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
