import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { effectivePT, type GameAction, type GameView, isHidden, type ViewCard, faceOf, type TargetRef, type TargetSpec } from '@ojb/shared';
import { isStrict, summoningSickNoHaste } from './engine.ts';
import { CardBack, CardImage, getCard, setPreview } from '../cards.tsx';

// ---------------------------------------------------------------- context

export interface MenuItem { label: string; onClick?: () => void; disabled?: boolean; hint?: string; sub?: MenuItem[] }

export interface PickOption { value: string; label: string; detail?: string; disabled?: string }

export interface TargetMode {
  kind: 'target';
  label: string;
  specs: TargetSpec[];
  specIndex: number;
  /** Chosen targets, one list per spec. */
  chosen: TargetRef[][];
  controller: string;
  sourceIid?: string;
  /** Called with the targets, or null when cancelled. */
  onDone: (targets: TargetRef[][] | null) => void;
}

export type Mode = null | { kind: 'attach'; iid: string } | { kind: 'block'; iid: string } | { kind: 'attackPW'; iid: string } | TargetMode;

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
  /** Charm-style mode picker: resolves to the chosen option values, or null if cancelled. */
  pickModes: (label: string, options: { value: string; label: string }[], min: number, max: number) => Promise<string[] | null>;
  /** Pick one of several options (cast options ...): resolves to the option value, or null if cancelled. */
  pickOption: (title: string, options: PickOption[]) => Promise<string | null>;
  /** Split `total` among targets (divided damage): resolves to key -> amount, or null if cancelled. */
  divide: (title: string, total: number | undefined, targets: { key: string; label: string }[], validate: (d: Record<string, number>) => string | null) => Promise<Record<string, number> | null>;
  openZone: (pid: string, zone: 'graveyard' | 'exile' | 'sideboard' | 'command' | 'hand') => void;
  openTokens: () => void;
  menuFor: (iid: string) => MenuItem[];
  defaultAction: (iid: string) => void;
  /** Enter targeting mode; resolves with one list per spec, or null if cancelled. */
  target: (label: string, specs: TargetSpec[], sourceIid?: string) => Promise<TargetRef[][] | null>;
  /** Click on a potential target while in targeting mode. */
  pickTarget: (ref: TargetRef) => void;
  /** null when not targeting; otherwise whether `ref` is a legal choice for the current spec. */
  isLegal: (ref: TargetRef) => boolean | null;
  /** Cast a card (handles X, targeting and the automatic/manual choice). */
  cast: (iid: string, face?: number) => void;
  toast: (msg: string) => void;
  /** Battlefield cards to outline (stack item hover). */
  hoverTargets: string[];
  setHoverTargets: (iids: string[]) => void;
  /** Sources auto-pay would tap (hand card hover). */
  payPreview: string[];
  setPayPreview: (iids: string[]) => void;
}

export const Ctx = createContext<GameCtx>(null as unknown as GameCtx);
export const useGame = () => useContext(Ctx);

// ---------------------------------------------------------------- card on the table

export function TableCard({ iid, small, attachments }: { iid: string; small?: boolean; attachments?: string[] }) {
  const { g, me, openMenu, menuFor, defaultAction, mode, pickTarget, isLegal, hoverTargets, payPreview } = useGame();
  const c = g.cards[iid];
  if (!c) return null;
  const hidden = isHidden(c);
  const face = !hidden ? faceOf(c, getCard) : null;
  const isCreature = face && (face.types.includes('Creature') || c.faceDown);
  const pt = !hidden && isCreature ? effectivePT(c, getCard, g) : null;
  const basePT = face && face.power != null ? `${face.power}/${face.toughness}` : null;
  const ptChanged = pt && basePT !== `${pt[0]}/${pt[1]}`;
  const isSaga = !!face && /\bSaga\b/.test(face.typeLine ?? '');
  const lore = isSaga ? c.counters.lore ?? 0 : 0;
  const counters = Object.entries(c.counters).filter(([k, v]) => !(isSaga && k === 'lore' && v > 0));
  const damage = isHidden(c) ? 0 : c.damage;
  const lethal = pt && damage > 0 && damage >= pt[1];
  const targeting = mode?.kind === 'target';
  const selectable = mode && mode.kind !== 'attackPW' && !targeting;
  const legal = targeting ? isLegal({ kind: 'card', iid }) : null;
  const chosen = mode?.kind === 'target' && mode.chosen.some((l) => l.some((r) => r.kind === 'card' && r.iid === iid));
  // Strict mode: grey out my creatures that cannot attack right now.
  const noAttack = !hidden && !!me && isStrict(g) && g.step === 'attackers' && g.activePlayer === me && !g.combat.attackersDeclared && c.controller === me && !!isCreature && !c.attacking
    && (c.tapped || summoningSickNoHaste(g, iid));
  const kws = !hidden && c.tempKeywords?.length ? c.tempKeywords : [];

  return (
    <div
      className={`tcard ${small ? 'small' : ''} ${c.tapped ? 'tapped' : ''} ${c.attacking ? 'attacking' : ''} ${c.blocking ? 'blocking' : ''} ${selectable ? 'targetable' : ''} ${targeting ? (legal ? 'legal-target' : 'dim') : ''} ${chosen || hoverTargets.includes(iid) ? 'targeted' : ''} ${mode && 'iid' in mode && mode.iid === iid ? 'selected' : ''} ${!hidden && c.summoningSick && isCreature ? 'sick' : ''} ${payPreview.includes(iid) ? 'pay-preview' : ''} ${noAttack ? 'no-attack' : ''}`}
      data-iid={iid}
      draggable={!hidden || c.faceDown}
      onDragStart={(e) => { e.dataTransfer.setData('text/iid', iid); e.dataTransfer.effectAllowed = 'move'; }}
      onMouseEnter={() => face && !c.faceDown ? setPreview({ face, extra: describe(c) }) : face ? setPreview({ face, extra: 'Face down (only you can see this). ' + describe(c) }) : undefined}
      onClick={(e) => { e.stopPropagation(); if (targeting) pickTarget({ kind: 'card', iid }); else defaultAction(iid); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, menuFor(iid), face?.name); }}
    >
      {attachments?.map((a, i) => (
        <div key={a} className="attachment" style={{ top: `${-14 * (i + 1)}px` }}><TableCard iid={a} small /></div>
      ))}
      {hidden || c.faceDown ? <CardBack label={c.faceDown && !hidden ? '↓' : undefined} /> : <CardImage face={face!} />}
      {c.faceDown && !hidden && <div className="facedown-peek">{face!.name}</div>}
      <div className="overlays">
        {lore > 0 && <div className="saga-chapter" title={`${lore} lore counter${lore === 1 ? '' : 's'}`}>Chapter {lore}</div>}
        {counters.length > 0 && (
          <div className="counters">{counters.map(([k, v]) => <span key={k} className={`ctr ctr-${k.replace(/[^a-z]/gi, '')}`}>{k === 'loyalty' ? '◆' : `${k} `}{v}</span>)}</div>
        )}
        {pt && <div className={`pt ${ptChanged ? 'changed' : ''} ${lethal ? 'lethal' : ''}`}>{pt[0]}/{pt[1]}{damage > 0 && <span className="dmg"> ✹{damage}</span>}</div>}
        {!pt && damage > 0 && <div className="pt lethal">✹{damage}</div>}
        {c.attacking && <div className="combat-badge">⚔</div>}
        {c.blocking && <div className="combat-badge">🛡</div>}
        {!hidden && c.note && <div className="note" title={c.note}>{c.note}</div>}
        {!hidden && c.noUntap && <div className="nountap" title="Doesn't untap">⛓</div>}
        {kws.length > 0 && <div className="kw-badge" title={`Until end of turn: ${kws.join(', ')}`}>{kws.map((k) => k.slice(0, 3)).join(' ')}</div>}
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
  if (c.tempKeywords?.length) parts.push(`Gains until EOT: ${c.tempKeywords.join(', ')}`);
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

export function ModesModal({ label, options, min, max, onDone }: { label: string; options: { value: string; label: string }[]; min: number; max: number; onDone: (v: string[] | null) => void }) {
  const [sel, setSel] = useState<string[]>([]);
  const toggle = (v: string) => setSel((s) => s.includes(v) ? s.filter((x) => x !== v) : max === 1 ? [v] : s.length < max ? [...s, v] : s);
  return (
    <Modal title={label} onClose={() => onDone(null)}>
      <p className="muted">Choose {min === max ? min : `${min}–${max}`} mode{max === 1 ? '' : 's'}.</p>
      <div className="modes-list">
        {options.map((o) => (
          <label key={o.value} className={`mode-opt ${sel.includes(o.value) ? 'sel' : ''}`}>
            <input type={max === 1 ? 'radio' : 'checkbox'} checked={sel.includes(o.value)} onChange={() => toggle(o.value)} /> {o.label}
          </label>
        ))}
      </div>
      <div className="row"><button className="primary" disabled={sel.length < min || sel.length > max} onClick={() => onDone(sel)}>OK</button><button onClick={() => onDone(null)}>Cancel</button></div>
    </Modal>
  );
}

export function OptionsModal({ title, options, onDone }: { title: string; options: PickOption[]; onDone: (v: string | null) => void }) {
  return (
    <Modal title={title} onClose={() => onDone(null)}>
      <div className="opt-list">
        {options.map((o) => (
          <button key={o.value} className={`opt-item ${o.disabled ? 'disabled' : ''}`} disabled={!!o.disabled} onClick={() => onDone(o.value)}>
            <b>{o.label}</b>
            {o.detail && <span className="opt-detail">{o.detail}</span>}
            {o.disabled && <span className="opt-why">{o.disabled}</span>}
          </button>
        ))}
      </div>
      <div className="row"><button onClick={() => onDone(null)}>Cancel</button></div>
    </Modal>
  );
}

export function DivideModal({ title, total, targets, validate, onDone }: {
  title: string; total: number | undefined; targets: { key: string; label: string }[]; validate: (d: Record<string, number>) => string | null; onDone: (v: Record<string, number> | null) => void;
}) {
  const [vals, setVals] = useState<Record<string, number>>(() => {
    const v: Record<string, number> = {};
    targets.forEach((t, i) => { v[t.key] = total != null ? Math.floor(total / targets.length) + (i < total % targets.length ? 1 : 0) : 1; });
    return v;
  });
  const sum = Object.values(vals).reduce((a, b) => a + b, 0);
  const err = validate(vals);
  return (
    <Modal title={title} onClose={() => onDone(null)}>
      <p className="muted">Divide {total ?? 'the damage'} among the targets{total != null ? ` (${sum}/${total})` : ''}.</p>
      <div className="divide-list">
        {targets.map((t) => (
          <label key={t.key}>{t.label}
            <input type="number" min={1} value={vals[t.key]} onChange={(e) => setVals({ ...vals, [t.key]: Math.trunc(Number(e.target.value)) || 0 })} />
          </label>
        ))}
      </div>
      {err && <p className="muted divide-err">{err}</p>}
      <div className="row"><button className="primary" disabled={!!err} onClick={() => onDone(vals)}>OK</button><button onClick={() => onDone(null)}>Cancel</button></div>
    </Modal>
  );
}
