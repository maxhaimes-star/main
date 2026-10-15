import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { type CardData, type Face, type TokenData, faceOf, tokenFace } from '@ojb/shared';
import { CUBE, cardRegistryVersion, getCard, onCardsRegistered, registerCards, setCardResolver } from '@ojb/shared/src/cube.ts';
import type { CardInstance, CardPayload } from '@ojb/shared';
import { registerScripts } from '@ojb/shared/src/engine/script.ts';
import { isTouch } from './touch.ts';
import { showSheet, type SheetItem } from './sheet.tsx';

export { getCard };

// ------------------------------------------------------------- cards outside the built-in cube

/** Register card data the server sent with a room view (database cards + their rules scripts). */
export function receiveCards(p: CardPayload) {
  registerScripts(p.scripts ?? {}, p.tokens);
  registerCards(p.cards ?? {});
}

// Unknown ids (e.g. an imported cube list in the lobby) are fetched in batches from /api/cards.
const queued = new Set<string>();
const requested = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
setCardResolver((id) => {
  if (requested.has(id) || !id) return undefined;
  queued.add(id);
  requested.add(id);
  timer ??= setTimeout(flushFetch, 30);
  return undefined;
});
async function flushFetch() {
  timer = null;
  const ids = [...queued];
  queued.clear();
  for (let i = 0; i < ids.length; i += 200) {
    try {
      const res = await fetch(`/api/cards?ids=${encodeURIComponent(ids.slice(i, i + 200).join(','))}`);
      if (res.ok) registerCards(await res.json() as Record<string, CardData>);
    } catch { /* offline: cards stay as id placeholders */ }
  }
}

/** Re-render when new card data arrives. */
export function useCardRegistry(): number {
  return useSyncExternalStore(onCardsRegistered, cardRegistryVersion);
}

// ------------------------------------------------------------- hover preview store

export interface PreviewItem { face: Face; extra?: string; backFace?: Face }
let preview: PreviewItem | null = null;
const listeners = new Set<() => void>();
export function setPreview(p: PreviewItem | null) {
  preview = p;
  listeners.forEach((l) => l());
}
export function usePreview() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => preview);
}

// ------------------------------------------------------------- image source preference

const PREF_KEY = 'ojb:imageSource';
export type ImageSource = 'scryfall' | 'local';
let imageSource: ImageSource = (() => {
  // With Scryfall-built data the image URLs point straight at Scryfall's CDN; otherwise
  // the PDF crops are faster and avoid Scryfall's API rate limit for grids of cards.
  const dflt: ImageSource = CUBE.source === 'scryfall' ? 'scryfall' : 'local';
  try { return (localStorage.getItem(PREF_KEY) as ImageSource) || dflt; } catch { return dflt; }
})();
const imgListeners = new Set<() => void>();
export function setImageSource(s: ImageSource) {
  imageSource = s;
  try { localStorage.setItem(PREF_KEY, s); } catch { /* ignore */ }
  imgListeners.forEach((l) => l());
}
export function useImageSource() {
  return useSyncExternalStore((l) => { imgListeners.add(l); return () => imgListeners.delete(l); }, () => imageSource);
}

/** Remember remote failures so we stop retrying blocked/missing images. */
const failed = new Set<string>();

export function cardFace(card: CardData): Face {
  return faceOf({ iid: '', cardId: card.id, owner: '', controller: '', zone: 'library', tapped: false, faceDown: false, transformed: false, counters: {}, damage: 0, tempPT: [0, 0], permPT: [0, 0], summoningSick: false, noUntap: false, revealedTo: [] }, getCard);
}

export function backFaceOf(card: CardData): Face | undefined {
  if (!card.faces?.[1]) return undefined;
  return faceOf({ iid: '', cardId: card.id, owner: '', controller: '', zone: 'library', tapped: false, faceDown: false, transformed: true, counters: {}, damage: 0, tempPT: [0, 0], permPT: [0, 0], summoningSick: false, noUntap: false, revealedTo: [], castAs: card.layout === 'adventure' || card.layout === 'split' ? card.faces[1].name : undefined }, getCard);
}

function sources(face: Face, large: boolean): string[] {
  const remote = face.image ? (large ? face.image.replace('version=normal', 'version=large') : face.image) : undefined;
  const local = face.localImage ? `/${face.localImage}` : undefined;
  // The big preview always tries the high-res remote image first.
  const order = imageSource === 'local' && !large ? [local, remote] : [remote, local];
  return order.filter((s): s is string => !!s && !failed.has(s));
}

/** A card picture with graceful fallbacks: remote → PDF crop → text frame. */
export function CardImage({ face, large, className, style }: { face: Face; large?: boolean; className?: string; style?: CSSProperties }) {
  useImageSource();
  const [, bump] = useState(0);
  const list = sources(face, !!large);
  const src = list[0];
  if (!src) return <TextCard face={face} className={className} style={style} />;
  return (
    <img
      className={`card-img ${className ?? ''}`}
      style={style}
      src={src}
      alt={face.name}
      draggable={false}
      loading="lazy"
      onError={() => { failed.add(src); bump((x) => x + 1); }}
    />
  );
}

const COLOR_BG: Record<string, string> = {
  W: '#e9e2c8', U: '#9cc3e6', B: '#a59a9a', R: '#e59a7c', G: '#9cc79a',
};

export function TextCard({ face, className, style }: { face: Face; className?: string; style?: CSSProperties }) {
  const colors = (face.manaCost.match(/[WUBRG]/g) ?? []) as string[];
  const tokenColors = face.typeLine.toLowerCase();
  const basic = { plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G' }[face.name.toLowerCase()];
  const c = colors[0] ?? basic ?? (['white', 'blue', 'black', 'red', 'green'].map((x, i) => (tokenColors.includes(x) ? 'WUBRG'[i] : '')).find(Boolean));
  if (basic) {
    return (
      <div className={`card-img text-card basic ${className ?? ''}`} style={{ background: COLOR_BG[basic], ...style }}>
        <div className="tc-name">{face.name}</div>
        <div className="basic-sym"><span className={`pip pip-${basic}`}>{basic}</span></div>
        <div className="tc-type">Basic Land — {face.name}</div>
      </div>
    );
  }
  return (
    <div className={`card-img text-card ${className ?? ''}`} style={{ background: c ? COLOR_BG[c] : '#c9c9c9', ...style }}>
      <div className="tc-name">{face.name}<span className="tc-cost">{face.manaCost.replace(/[{}]/g, '')}</span></div>
      <div className="tc-type">{face.typeLine}</div>
      <div className="tc-text">{face.oracle}</div>
      {face.power != null && <div className="tc-pt">{face.power}/{face.toughness}</div>}
      {face.loyalty != null && <div className="tc-pt">◆{face.loyalty}</div>}
    </div>
  );
}

export function CardBack({ className, style, label }: { className?: string; style?: CSSProperties; label?: ReactNode }) {
  return <div className={`card-img card-back ${className ?? ''}`} style={style}><span>{label ?? '🍊'}</span></div>;
}

/**
 * Simple clickable cube card (draft, deckbuilder). On touch devices a tap opens the zoom sheet (large image) instead:
 * `tapLabel` names the sheet's button (running `tapAction`, default: the card's onClick); without it the sheet is zoom-only.
 */
export function CubeCard({ id, onClick, className, children, title, tapLabel, tapAction, tapItems }: {
  id: string; onClick?: (e: React.MouseEvent) => void; className?: string; children?: ReactNode; title?: string;
  tapLabel?: string; tapAction?: () => void; tapItems?: SheetItem[];
}) {
  const card = getCard(id);
  if (!card) return <div className="cube-card missing">{id}</div>;
  const face = cardFace(card);
  const click = (e: React.MouseEvent) => {
    if (isTouch()) {
      const items: SheetItem[] = tapItems ?? (onClick ? [{ label: tapLabel ?? 'Select', primary: true, onClick: () => (tapAction ? tapAction() : onClick(e)) }] : []);
      showSheet({ face, backFace: backFaceOf(card), items });
      return;
    }
    onClick?.(e);
  };
  return (
    <div
      className={`cube-card ${className ?? ''}`}
      onClick={onClick || isTouch() ? click : undefined}
      title={title}
      onMouseEnter={() => setPreview({ face, backFace: backFaceOf(card) })}
    >
      <CardImage face={face} />
      {children}
    </div>
  );
}

export function tokenToFace(t: TokenData): Face {
  return tokenFace(t);
}

export function instFace(inst: CardInstance): Face {
  return faceOf(inst, getCard);
}

/** Mana cost rendered as little pips. */
export function ManaCost({ cost }: { cost: string }) {
  const parts = cost.match(/\{[^}]+\}|\/\//g) ?? [];
  return (
    <span className="mana-cost">
      {parts.map((p, i) => p === '//' ? <span key={i}> // </span> : <span key={i} className={`pip pip-${p.slice(1, -1).replace('/', '')}`}>{p.slice(1, -1)}</span>)}
    </span>
  );
}

/** Side panel with the hovered card. */
export function PreviewPanel() {
  const p = usePreview();
  if (!p) return <div className="preview-panel empty">Hover a card to see it here.</div>;
  return (
    <div className="preview-panel">
      <CardImage face={p.face} large className="preview-img" />
      {p.backFace && <CardImage face={p.backFace} className="preview-back" />}
      <div className="preview-text">
        <div className="pt-name">{p.face.name} <ManaCost cost={p.face.manaCost} /></div>
        <div className="pt-type">{p.face.typeLine}</div>
        <div className="pt-oracle">{p.face.oracle.split('\n').map((l, i) => <p key={i}>{l}</p>)}</div>
        {p.face.power != null && <div className="pt-pt">{p.face.power}/{p.face.toughness}</div>}
        {p.face.loyalty != null && <div className="pt-pt">Loyalty {p.face.loyalty}</div>}
        {p.backFace && (
          <div className="pt-back">
            <div className="pt-name">{p.backFace.name} <ManaCost cost={p.backFace.manaCost} /></div>
            <div className="pt-type">{p.backFace.typeLine}</div>
            <div className="pt-oracle">{p.backFace.oracle.split('\n').map((l, i) => <p key={i}>{l}</p>)}</div>
          </div>
        )}
        {p.extra && <div className="pt-extra">{p.extra}</div>}
      </div>
    </div>
  );
}


const PV_TARGETS = '.tcard, .hcard, .stack-item, .zcard, .rv, .pend-card, .zone, .ae-item, .revealed-top, .cube-card';

/** Arena-style large card preview floating next to the cursor (hover any card on the table). */
export function HoverPreview() {
  const p = usePreview();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (isTouch()) return; // phones have no hover: cards open a bottom sheet instead
    const move = (e: MouseEvent) => {
      const over = (e.target as Element | null)?.closest?.(PV_TARGETS);
      setPos(over ? { x: e.clientX, y: e.clientY } : null);
    };
    const hide = () => setPos(null);
    window.addEventListener('mousemove', move);
    window.addEventListener('dragstart', hide);
    window.addEventListener('mousedown', hide);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('dragstart', hide); window.removeEventListener('mousedown', hide); };
  }, []);
  if (!p || !pos) return null;
  const w = Math.min(300, Math.max(220, innerHeight * 0.36));
  const h = w * 88 / 63;
  const right = pos.x < innerWidth / 2;
  const left = right ? Math.min(pos.x + 28, innerWidth - w - 8) : Math.max(8, pos.x - 28 - w);
  const top = Math.max(8, Math.min(pos.y - h / 2, innerHeight - h - 8 - (p.extra ? 60 : 0)));
  return (
    <div className="hover-preview" style={{ left, top, width: w }}>
      <CardImage face={p.face} large className="hp-img" />
      {p.backFace && <CardImage face={p.backFace} className="hp-back" />}
      {p.extra && <div className="hp-extra">{p.extra}</div>}
    </div>
  );
}
