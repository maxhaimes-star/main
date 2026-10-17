import { useSyncExternalStore } from 'react';

/** How picks / pools are grouped: by colour (sorted by mana value within) or by mana value (sorted by colour within). */
export type SortMode = 'color' | 'cmc';
const KEY = 'ojb:sort';

function read(): SortMode {
  try { return localStorage.getItem(KEY) === 'cmc' ? 'cmc' : 'color'; } catch { return 'color'; }
}

let mode: SortMode = read();
const listeners = new Set<() => void>();

export function setSortMode(m: SortMode) {
  mode = m;
  try { localStorage.setItem(KEY, m); } catch { /* storage unavailable: keep it for this session only */ }
  listeners.forEach((l) => l());
}

export function useSortMode(): SortMode {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => mode, () => mode);
}

export function SortToggle() {
  const m = useSortMode();
  return (
    <span className="sort-toggle" role="group" aria-label="Sort cards">
      <span className="muted">Sort:</span>
      <button className={m === 'color' ? 'active' : ''} aria-pressed={m === 'color'} onClick={() => setSortMode('color')}>Colour</button>
      <button className={m === 'cmc' ? 'active' : ''} aria-pressed={m === 'cmc'} onClick={() => setSortMode('cmc')}>Mana value</button>
    </span>
  );
}
