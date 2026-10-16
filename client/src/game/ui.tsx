import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { NumberField } from '../NumberField.tsx';
import { effectivePT, type Face, type GameAction, type GameView, isHidden, type ViewCard, faceOf, type TargetRef, type TargetSpec, type RevealEntry, type RevealedCard } from '@ojb/shared';
import { attackProblem, blockProblem, isStrict, manualOk, summoningSickNoHaste } from './engine.ts';
import { ATTACH_PEEK } from './boardLayout.ts';
import { CardBack, CardImage, getCard, setPreview } from '../cards.tsx';
import { isTouch, useLayout, useLongPress } from '../touch.ts';

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
  /** Touch: open the bottom sheet (large image + actions) for a card. */
  showCardSheet: (iid: string) => void;
  /** Touch: single tap opens the sheet, double-tap runs the default action. */
  tapCard: (iid: string) => void;
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
  /** Face of a card named in a choice whose card the client cannot see (library search picks): from my deck list. */
  faceByName: (name: string) => Face | undefined;
  /** Close every popup / prompt / targeting mode, then ask to undo. */
  undo: () => void;
}

export const Ctx = createContext<GameCtx>(null as unknown as GameCtx);
export const useGame = () => useContext(Ctx);

// ---------------------------------------------------------------- card on the table

/** `stack`: identical basic lands shown as one card with a count (iid is the one acted on). */
export function TableCard({ iid, small, attachments, stack }: { iid: string; small?: boolean; attachments?: string[]; stack?: string[] }) {
  const { g, me, opp, openMenu, menuFor, defaultAction, mode, pickTarget, isLegal, hoverTargets, payPreview, tapCard } = useGame();
  const c = g.cards[iid];
  const lp = useLongPress((x, y) => { const cc = g.cards[iid]; if (cc) openMenu(x, y, menuFor(iid), isHidden(cc) ? undefined : faceOf(cc, getCard).name); });
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
    && (c.tapped || summoningSickNoHaste(g, iid) || !!attackProblem(g, me, iid, opp));
  // Declare attackers / blockers: softly highlight my creatures that can still be declared.
  const declaringAttack = !hidden && !!me && g.step === 'attackers' && g.activePlayer === me && !g.combat.attackersDeclared && c.controller === me && !!isCreature;
  const canAttack = declaringAttack && !c.attacking && !c.tapped && !noAttack && !summoningSickNoHaste(g, iid) && !attackProblem(g, me, iid, opp);
  const canBlock = !hidden && !!me && g.step === 'blockers' && g.activePlayer !== me && !g.combat.blockersDeclared && c.controller === me && !!isCreature && !c.blocking && !c.tapped
    && g.battlefield.some((a) => { const ac = g.cards[a]; return !!ac?.attacking && ac.controller !== me && !blockProblem(g, iid, a); });
  const combatLabel = combatLabelOf(g, c);
  // Strict: an opponent's card has nothing to offer outside targeting / blocking (no menu button, no menu).
  const actionable = !hidden && (manualOk(g) || c.controller === me || c.owner === me);
  const openFor = (x: number, y: number) => { const items = menuFor(iid); if (items.length) openMenu(x, y, items, face?.name); };
  const kws = !hidden && c.tempKeywords?.length ? c.tempKeywords : [];

  return (
    <div
      className={`tcard ${small ? 'small' : ''} ${c.tapped ? 'tapped' : ''} ${c.attacking ? 'attacking' : ''} ${c.blocking ? 'blocking' : ''} ${selectable ? 'targetable' : ''} ${targeting ? (legal ? 'legal-target' : 'dim') : ''} ${chosen || (stack ?? [iid]).some((x) => hoverTargets.includes(x)) ? 'targeted' : ''} ${mode && 'iid' in mode && mode.iid === iid ? 'selected' : ''} ${!hidden && c.summoningSick && isCreature ? 'sick' : ''} ${(stack ?? [iid]).some((x) => payPreview.includes(x)) ? 'pay-preview' : ''} ${noAttack ? 'no-attack' : ''} ${canAttack ? 'can-attack' : ''} ${canBlock ? 'can-block' : ''} ${stack ? 'stacked' : ''}`}
      data-iid={iid}
      draggable={!isTouch() && (!hidden || c.faceDown)}
      {...lp.props}
      onDragStart={(e) => { e.dataTransfer.setData('text/iid', iid); e.dataTransfer.effectAllowed = 'move'; }}
      onMouseEnter={() => face && !c.faceDown ? setPreview({ face, extra: describe(c) }) : face ? setPreview({ face, extra: 'Face down (only you can see this). ' + describe(c) }) : undefined}
      onMouseLeave={(e) => { e.stopPropagation(); setPreview(null); }}
      onClick={(e) => {
        e.stopPropagation();
        if (lp.consumed()) return;
        if (targeting) pickTarget({ kind: 'card', iid });
        else if (isTouch() && !mode) tapCard(iid);
        else defaultAction(iid);
      }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (!isTouch()) openFor(e.clientX, e.clientY); }}
    >
      {attachments?.map((a, i) => (
        <div key={a} className="attachment" style={{ top: `calc(var(--rcw, 84px) * ${-ATTACH_PEEK * (i + 1)})` }}><TableCard iid={a} small /></div>
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
        {combatLabel && <div className={`combat-badge ${combatLabel.kind}`} data-target={combatLabel.target} title={combatLabel.title}>{combatLabel.kind === 'attack' ? '⚔' : '🛡'} {combatLabel.target}</div>}
        {!hidden && c.note && <div className="note" title={c.note}>{c.note}</div>}
        {!hidden && c.noUntap && <div className="nountap" title="Doesn't untap">⛓</div>}
        {kws.length > 0 && <div className="kw-badge" title={`Until end of turn: ${kws.join(', ')}`}>{kws.map((k) => k.slice(0, 3)).join(' ')}</div>}
        {!hidden && c.token && <div className="token-badge">token</div>}
        {stack && <div className="stack-count" title={`${stack.length} identical lands`}>×{stack.length}</div>}
      </div>
      {actionable && <button className="dots" aria-label="Card actions" onClick={(e) => { e.stopPropagation(); openFor(e.clientX, e.clientY); }}>⋯</button>}
    </div>
  );
}

/** What an attacker attacks (player or planeswalker) / what a blocker blocks, for the badge on the card. */
export function combatLabelOf(g: GameView, c: ViewCard): { kind: 'attack' | 'block'; target: string; title: string } | null {
  const nameOf = (iid: string, fallback: string) => { const t = g.cards[iid]; return t && !isHidden(t) && !t.faceDown ? faceOf(t, getCard).name : fallback; };
  if (c.attacking) {
    const pw = g.cards[c.attacking];
    const target = pw ? nameOf(c.attacking, 'a planeswalker') : g.players.find((p) => p.pid === c.attacking)?.name ?? 'a player';
    return { kind: 'attack', target, title: `Attacking ${target}` };
  }
  if (c.blocking) {
    const target = nameOf(c.blocking, 'an attacker');
    return { kind: 'block', target, title: `Blocking ${target}` };
  }
  return null;
}

export function describe(c: ViewCard): string {
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

// ---------------------------------------------------------------- viewport clamping for menus / popovers / pickers

const EDGE = 6;
type Box = { x: number; y: number };

/**
 * Where to put a fixed box of size w×h opened at the point (x, y) so it stays fully inside the viewport: flip to the
 * other side of the point when it does not fit, then shift it in. A box larger than the viewport is pinned to the edge
 * (its max-height keeps it scrollable).
 */
export function placeAtPoint(x: number, y: number, w: number, h: number): Box {
  const vw = innerWidth, vh = innerHeight;
  let px = x, py = y;
  if (px + w > vw - EDGE && x - w >= EDGE) px = x - w;
  if (py + h > vh - EDGE && y - h >= EDGE) py = y - h;
  return { x: Math.max(EDGE, Math.min(px, vw - w - EDGE)), y: Math.max(EDGE, Math.min(py, vh - h - EDGE)) };
}

/** Beside an anchor rectangle (submenus, popovers from a button): right of it, else left of it; shifted vertically to fit. */
export function placeBeside(r: { left: number; right: number; top: number; bottom: number }, w: number, h: number, below = false): Box {
  const vw = innerWidth, vh = innerHeight;
  if (below) {
    let y = r.bottom + 2;
    if (y + h > vh - EDGE && r.top - h - 2 >= EDGE) y = r.top - h - 2;
    return { x: Math.max(EDGE, Math.min(r.left, vw - w - EDGE)), y: Math.max(EDGE, Math.min(y, vh - h - EDGE)) };
  }
  let x = r.right - 2;
  if (x + w > vw - EDGE) x = r.left - w + 2 >= EDGE ? r.left - w + 2 : vw - w - EDGE;
  return { x: Math.max(EDGE, x), y: Math.max(EDGE, Math.min(r.top - 4, vh - h - EDGE)) };
}

/**
 * Measures a fixed-position element and returns its clamped position (null until measured: render it hidden).
 * Re-measures when its size or the window changes.
 */
export function useClamped(ref: React.RefObject<HTMLElement>, place: (w: number, h: number) => Box, key: unknown): Box | null {
  const [pos, setPos] = useState<Box | null>(null);
  const placeRef = useRef(place);
  placeRef.current = place;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const p = placeRef.current(el.offsetWidth, el.offsetHeight);
      setPos((cur) => (cur && Math.abs(cur.x - p.x) < 0.5 && Math.abs(cur.y - p.y) < 0.5 ? cur : p));
    };
    update();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    ro?.observe(el);
    window.addEventListener('resize', update);
    return () => { ro?.disconnect(); window.removeEventListener('resize', update); };
  }, [ref, key]);
  return pos;
}

/** Inline style for a clamped fixed box: hidden until measured so it never flashes off-screen. */
export const clampedStyle = (pos: Box | null): React.CSSProperties => ({ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? 'visible' : 'hidden' });

function SubMenu({ items, anchor, onPick }: { items: MenuItem[]; anchor: DOMRect; onPick: (s: MenuItem) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useClamped(ref, (w, h) => placeBeside(anchor, w, h), anchor);
  return (
    <div ref={ref} className="ctx-sub" style={clampedStyle(pos)} onClick={(e) => e.stopPropagation()}>
      {items.map((s, j) => (
        <div key={j} className={`ctx-item ${s.disabled ? 'disabled' : ''}`} title={s.disabled && s.hint ? s.hint : undefined}
          onClick={(e) => { e.stopPropagation(); if (s.disabled) return; onPick(s); }}>{s.label}{s.hint && <small> {s.hint}</small>}</div>
      ))}
    </div>
  );
}

export function ContextMenu({ x, y, items, title, onClose }: { x: number; y: number; items: MenuItem[]; title?: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useClamped(ref, (w, h) => placeAtPoint(x, y, w, h), `${x},${y},${items.length}`);
  const [open, setOpen] = useState<{ i: number; rect: DOMRect } | null>(null);
  useEffect(() => {
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const t = setTimeout(() => { window.addEventListener('mousedown', close); window.addEventListener('touchstart', close); }, 0);
    window.addEventListener('keydown', esc);
    return () => { clearTimeout(t); window.removeEventListener('mousedown', close); window.removeEventListener('touchstart', close); window.removeEventListener('keydown', esc); };
  }, [onClose]);
  const openSub = (i: number, el: HTMLElement) => setOpen({ i, rect: el.getBoundingClientRect() });
  return (
    <div ref={ref} className="ctx-menu" style={clampedStyle(pos)} onScroll={() => setOpen(null)}>
      {title && <div className="ctx-title">{title}</div>}
      {items.length === 0 && <div className="ctx-item disabled">No actions available</div>}
      {items.map((it, i) => it.sub ? (
        <div key={i} className={`ctx-item has-sub ${open?.i === i ? 'open' : ''} ${it.sub.length === 0 ? 'disabled' : ''}`}
          onMouseEnter={(e) => { if (it.sub!.length) openSub(i, e.currentTarget); }}
          onClick={(e) => { if (it.sub!.length) openSub(i, e.currentTarget); }}>
          <span>{it.label}</span><span className="ctx-arrow">▸</span>
          {open?.i === i && <SubMenu items={it.sub} anchor={open.rect} onPick={(s) => { onClose(); s.onClick?.(); }} />}
        </div>
      ) : (
        <div key={i} className={`ctx-item ${it.disabled ? 'disabled' : ''}`} title={it.disabled && it.hint ? it.hint : undefined} onMouseEnter={() => setOpen(null)} onClick={() => { if (it.disabled) return; onClose(); it.onClick?.(); }}>
          {it.label}{it.hint && <small> {it.hint}</small>}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- prompt

/** Undo button for popups (closes the popup, then undoes); nothing outside a game or when there is nothing to undo. */
function UndoButton() {
  const ctx = useContext(Ctx);
  if (!ctx?.g.canUndo || !ctx.me) return null;
  return <button className="tiny undo-btn" onClick={ctx.undo} title="Ctrl+Z">Undo</button>;
}

export function Prompt({ label, initial, numeric, onDone }: { label: string; initial: string; numeric: boolean; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  return (
    <div className="modal-bg" onMouseDown={() => onDone(null)}>
      <div className="modal prompt" onMouseDown={(e) => e.stopPropagation()}>
        <label>{label}
          <input autoFocus type={numeric ? 'number' : 'text'} value={v} onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onDone(v); if (e.key === 'Escape') onDone(null); }} />
        </label>
        <div className="row"><button className="primary" onClick={() => onDone(v)}>OK</button><button onClick={() => onDone(null)}>Cancel</button><UndoButton /></div>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>{title}</h3><span className="modal-head-btns"><UndoButton /><button className="tiny" onClick={onClose}>✕</button></span></div>
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

export function DivideModal({ title, total, targets, validate, onDone, even }: {
  /** even: a suggested split (button "Even split"). */
  even?: Record<string, number>;
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
            <NumberField min={0} value={vals[t.key]} onCommit={(n) => setVals((v) => ({ ...v, [t.key]: n }))} />
          </label>
        ))}
      </div>
      {err && <p className="muted divide-err">{err}</p>}
      <div className="row"><button className="primary" disabled={!!err} onClick={() => onDone(vals)}>OK</button>{even && <button onClick={() => setVals(even)}>Even split</button>}<button onClick={() => onDone(null)}>Cancel</button></div>
    </Modal>
  );
}

// ------------------------------------------------------------------ Revealed zone

function revealFace(c: RevealedCard): Face {
  return faceOf({ iid: c.iid, cardId: c.cardId, token: c.token, owner: '', controller: '', zone: 'library', tapped: false, faceDown: false, transformed: false, counters: {}, damage: 0, tempPT: [0, 0], permPT: [0, 0], summoningSick: false, noUntap: false, revealedTo: [] }, getCard);
}

function RevealRow({ r, compact }: { r: RevealEntry; compact?: boolean }) {
  const { g } = useGame();
  const who = g.players.find((p) => p.pid === r.by)?.name ?? 'A player';
  return (
    <div className={`rz-entry ${compact ? 'compact' : ''}`} data-testid="reveal-entry">
      <div className="rz-cards">
        {r.cards.map((c) => {
          const face = revealFace(c);
          return <div key={c.iid} className="rz-card" title={c.name} onMouseEnter={() => setPreview({ face })} onMouseLeave={() => setPreview(null)}><CardImage face={face} /></div>;
        })}
      </div>
      <div className="rz-meta">
        <b>{who}</b> revealed {r.cards.length > 1 ? `${r.cards.length} cards` : r.cards[0]?.name}
        <span className="rz-src">{r.source}{compact ? '' : ` · turn ${r.turn}`}</span>
      </div>
    </div>
  );
}

/**
 * The "Revealed" strip: this turn's reveals (who revealed what, and what revealed it), dismissible; expands to the
 * whole history. It is an ordinary flex row of the board column, so it never covers the hand or the buttons.
 */
export function RevealedZone() {
  const { g } = useGame();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(0);
  const landscape = useLayout() === 'landscape'; // too short for an inline history: it opens as a dialog there
  const all = g.reveals ?? [];
  if (!all.length) return null;
  const current = all.filter((r) => r.turn === g.turn && r.id > dismissed);
  const latest = current[current.length - 1];
  if (!open && !latest) {
    return <div className="rz rz-chip" data-testid="revealed-zone"><button className="tiny" onClick={() => setOpen(true)}>Revealed ({all.length}) ▾</button></div>;
  }
  return (
    <div className={`rz ${open && !landscape ? 'open' : ''}`} data-testid="revealed-zone">
      {open && landscape && (
        <Modal title="Revealed cards" onClose={() => setOpen(false)}>
          <div className="rz-list rz-modal">{all.slice().reverse().map((r) => <RevealRow key={r.id} r={r} compact />)}</div>
        </Modal>
      )}
      <div className="rz-head">
        <span className="rz-title">Revealed{current.length > 1 ? ` (+${current.length - 1} more this turn)` : ''}</span>
        <button className="tiny" onClick={() => setOpen(!open)}>{open && !landscape ? 'Hide history ▴' : `History (${all.length}) ▾`}</button>
        {latest && <button className="tiny" aria-label="Dismiss revealed cards" title="Dismiss" onClick={() => setDismissed(all[all.length - 1].id)}>✕</button>}
      </div>
      {open && !landscape
        ? <div className="rz-list">{all.slice().reverse().map((r) => <RevealRow key={r.id} r={r} compact />)}</div>
        : latest && <RevealRow r={latest} />}
    </div>
  );
}
