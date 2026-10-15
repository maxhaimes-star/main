import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Face } from '@ojb/shared';
import { CardImage, ManaCost } from './cards.tsx';

// Bottom sheet with a large card image and action buttons. Used on touch devices instead of hover previews / context menus.

export interface SheetItem { label: string; onClick?: () => void; disabled?: boolean; hint?: string; sub?: SheetItem[]; primary?: boolean }
export interface SheetData { face: Face; backFace?: Face; extra?: string; items: SheetItem[] }

let cur: SheetData | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export function showSheet(d: SheetData) { cur = d; emit(); }
export function hideSheet() { if (cur) { cur = null; emit(); } }
const useSheet = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => cur);

export function SheetHost() {
  const s = useSheet();
  const [back, setBack] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { setBack(false); setOpen(null); }, [s]);
  useEffect(() => {
    if (!s) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') hideSheet(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [s]);
  if (!s) return null;
  const face = back && s.backFace ? s.backFace : s.face;
  const run = (it: SheetItem) => { if (it.disabled) return; hideSheet(); it.onClick?.(); };
  const btn = (it: SheetItem, i: number) => it.sub ? (
    <div key={i} className="sheet-group">
      <button className={open === i ? 'sel' : ''} onClick={() => setOpen(open === i ? null : i)}>{it.label} {open === i ? '▾' : '▸'}</button>
      {open === i && <div className="sheet-sub">{it.sub.map((x, j) => <button key={j} disabled={x.disabled} onClick={() => run(x)}>{x.label}{x.hint && <small> {x.hint}</small>}</button>)}</div>}
    </div>
  ) : (
    <button key={i} className={it.primary ? 'primary' : ''} disabled={it.disabled} onClick={() => run(it)}>{it.label}{it.hint && <small> {it.hint}</small>}</button>
  );
  return (
    <div className="sheet-bg" onClick={hideSheet}>
      <div className="sheet" role="dialog" aria-label={face.name} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <b>{face.name}</b> <ManaCost cost={face.manaCost} />
          <button className="sheet-close" aria-label="Close" onClick={hideSheet}>✕</button>
        </div>
        <div className="sheet-body">
          <div className="sheet-card"><CardImage face={face} large /></div>
          <div className="sheet-actions">
            {s.extra && <div className="sheet-extra">{s.extra}</div>}
            {s.backFace && <button onClick={() => setBack(!back)}>{back ? 'Show front' : `Show back (${s.backFace.name})`}</button>}
            {s.items.map(btn)}
            <button className="sheet-dismiss" onClick={hideSheet}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
