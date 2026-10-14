import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { effectivePT, type GameAction, type GameView, isHidden, type ViewCard, faceOf } from '@ojb/shared';
import { CardBack, CardImage, getCard, setPreview } from '../cards.tsx';

// ---------------------------------------------------------------- context

export interface MenuItem { label: string; onClick?: () => void; disabled?: boolean; hint?: string; sub?: MenuItem[] }

export type Mode = null | { kind: 'attach'; iid: string } | { kind: 'block'; iid: string } | { kind: 'attackPW'; iid: string };

export interface GameCtx {
  g: GameView;
  me: string | null;
  /** Player shown at the bottom. */
  self: string;
  opp: string;
  act: (a: GameAction) => Promise<string | null>;
  openMenu: (x: number, y: number, items: MenuItem[], title?: string) => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  ask: (label: string, dflt?: number) => Promise<number | null>;
  askText: (label: string, dflt?: string) => Promise<string | null>;
  openZone: (pid: string, zone: 'graveyard' | 'exile' | 'sideboard' | 'command' | 'hand') => void;
  openTokens: () => void;
  menuFor: (iid: string) => MenuItem[];
  defaultAction: (iid: string) => void;
}

export const Ctx = createContext<GameCtx>(null as unknown as GameCtx);
export const useGame = () => useContext(Ctx);

// ---------------------------------------------------------------- card on the table

export function TableCard({ iid, small, attachments }: { iid: string; small?: boolean; attachments?: string[] }) {
  const { g, openMenu, menuFor, defaultAction, mode } = useGame();
  const c = g.cards[iid];
  if (!c) return null;
  const hidden = isHidden(c);
  const face = !hidden ? faceOf(c, getCard) : null;
  const isCreature = face && (face.types.includes('Creature') || c.faceDown);
  const pt = !hidden && isCreature ? effectivePT(c, getCard) : null;
  const basePT = face && face.power != null ? `${face.power}/${face.toughness}` : null;
  const ptChanged = pt && basePT !== `${pt[0]}/${pt[1]}`;
  const counters = Object.entries(c.counters);
  const damage = isHidden(c) ? 0 : c.damage;
  const lethal = pt && damage > 0 && damage >= pt[1];
  const selectable = mode && mode.kind !== 'attackPW';

  return (
    <div
      className={`tcard ${small ? 'small' : ''} ${c.tapped ? 'tapped' : ''} ${c.attacking ? 'attacking' : ''} ${c.blocking ? 'blocking' : ''} ${selectable ? 'targetable' : ''} ${mode && 'iid' in mode && mode.iid === iid ? 'selected' : ''} ${!hidden && c.summoningSick && isCreature ? 'sick' : ''}`}
      data-iid={iid}
      draggable={!hidden || c.faceDown}
      onDragStart={(e) => { e.dataTransfer.setData('text/iid', iid); e.dataTransfer.effectAllowed = 'move'; }}
      onMouseEnter={() => face && !c.faceDown ? setPreview({ face, extra: describe(c) }) : face ? setPreview({ face, extra: 'Face down (only you can see this). ' + describe(c) }) : undefined}
      onClick={(e) => { e.stopPropagation(); defaultAction(iid); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, menuFor(iid), face?.name); }}
    >
      {attachments?.map((a, i) => (
        <div key={a} className="attachment" style={{ top: `${-14 * (i + 1)}px` }}><TableCard iid={a} small /></div>
      ))}
      {hidden || c.faceDown ? <CardBack label={c.faceDown && !hidden ? '↓' : undefined} /> : <CardImage face={face!} />}
      {c.faceDown && !hidden && <div className="facedown-peek">{face!.name}</div>}
      <div className="overlays">
        {counters.length > 0 && (
          <div className="counters">{counters.map(([k, v]) => <span key={k} className={`ctr ctr-${k.replace(/[^a-z]/gi, '')}`}>{k === 'loyalty' ? '◆' : `${k} `}{v}</span>)}</div>
        )}
        {pt && <div className={`pt ${ptChanged ? 'changed' : ''} ${lethal ? 'lethal' : ''}`}>{pt[0]}/{pt[1]}{damage > 0 && <span className="dmg"> ✹{damage}</span>}</div>}
        {!pt && damage > 0 && <div className="pt lethal">✹{damage}</div>}
        {c.attacking && <div className="combat-badge">⚔</div>}
        {c.blocking && <div className="combat-badge">🛡</div>}
        {!hidden && c.note && <div className="note" title={c.note}>{c.note}</div>}
        {!hidden && c.noUntap && <div className="nountap" title="Doesn't untap">⛓</div>}
        {!hidden && c.token && <div className="token-badge">token</div>}
      </div>
      <button className="dots" onClick={(e) => { e.stopPropagation(); openMenu(e.clientX, e.clientY, menuFor(iid), face?.name); }}>⋯</button>
    </div>
  );
}

function describe(c: ViewCard): string {
  if (isHidden(c)) return '';
  const parts: string[] = [];
  const ctr = Object.entries(c.counters).map(([k, v]) => `${v}× ${k}`);
  if (ctr.length) parts.push(`Counters: ${ctr.join(', ')}`);
  if (c.damage) parts.push(`Damage: ${c.damage}`);
  if (c.tempPT[0] || c.tempPT[1]) parts.push(`Until EOT: ${c.tempPT[0] >= 0 ? '+' : ''}${c.tempPT[0]}/${c.tempPT[1] >= 0 ? '+' : ''}${c.tempPT[1]}`);
  if (c.permPT[0] || c.permPT[1]) parts.push(`Modifier: ${c.permPT[0] >= 0 ? '+' : ''}${c.permPT[0]}/${c.permPT[1] >= 0 ? '+' : ''}${c.permPT[1]}`);
  if (c.note) parts.push(`Note: ${c.note}`);
  if (c.summoningSick) parts.push('Summoning sick');
  return parts.join(' · ');
}

// ---------------------------------------------------------------- context menu

export function ContextMenu({ x, y, items, title, onClose }: { x: number; y: number; items: MenuItem[]; title?: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(x, innerWidth - r.width - 8)), y: Math.max(4, Math.min(y, innerHeight - r.height - 8)) });
  }, [x, y]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => window.addEventListener('mousedown', close), 0);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [onClose]);
  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }}>
      {title && <div className="ctx-title">{title}</div>}
      {items.map((it, i) => it.sub ? (
        <div key={i} className="ctx-item has-sub" onMouseEnter={() => setOpen(i)} onClick={() => setOpen(open === i ? null : i)}>
          {it.label} ▸
          {open === i && (
            <div className="ctx-sub">
              {it.sub.map((s, j) => (
                <div key={j} className={`ctx-item ${s.disabled ? 'disabled' : ''}`} onClick={(e) => { e.stopPropagation(); if (s.disabled) return; onClose(); s.onClick?.(); }}>{s.label}{s.hint && <small> {s.hint}</small>}</div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div key={i} className={`ctx-item ${it.disabled ? 'disabled' : ''}`} onMouseEnter={() => setOpen(null)} onClick={() => { if (it.disabled) return; onClose(); it.onClick?.(); }}>
          {it.label}{it.hint && <small> {it.hint}</small>}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- prompt

export function Prompt({ label, initial, numeric, onDone }: { label: string; initial: string; numeric: boolean; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  return (
    <div className="modal-bg" onMouseDown={() => onDone(null)}>
      <div className="modal prompt" onMouseDown={(e) => e.stopPropagation()}>
        <label>{label}
          <input autoFocus type={numeric ? 'number' : 'text'} value={v} onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onDone(v); if (e.key === 'Escape') onDone(null); }} />
        </label>
        <div className="row"><button className="primary" onClick={() => onDone(v)}>OK</button><button onClick={() => onDone(null)}>Cancel</button></div>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>{title}</h3><button className="tiny" onClick={onClose}>✕</button></div>
        {children}
      </div>
    </div>
  );
}
