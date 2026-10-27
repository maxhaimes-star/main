import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
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

// ------------------------------------------------------------- auto-zoom on hover (user setting, default on)

const ZOOM_KEY = 'ojb:hoverZoom';
let hoverZoom = (() => { try { return localStorage.getItem(ZOOM_KEY) !== '0'; } catch { return true; } })();
const zoomListeners = new Set<() => void>();
export function setHoverZoom(on: boolean) {
  hoverZoom = on;
  try { localStorage.setItem(ZOOM_KEY, on ? '1' : '0'); } catch { /* storage blocked: setting lasts for this page */ }
  zoomListeners.forEach((l) => l());
}
export function useHoverZoom(): boolean {
  return useSyncExternalStore((l) => { zoomListeners.add(l); return () => zoomListeners.delete(l); }, () => hoverZoom);
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

/**
 * Image URLs to try, best first. The large previews (hover zoom, bottom sheet, preview panel) use exactly the same list
 * as the card on the table, so a zoom always shows the same printing / crop the player is looking at.
 */
function sources(face: Face): string[] {
  const remote = face.image || undefined;
  const local = face.localImage ? `/${face.localImage}` : undefined;
  const order = imageSource === 'local' ? [local, remote] : [remote, local];
  return order.filter((s): s is string => !!s && !failed.has(s));
}

// ------------------------------------------------------------- token art (Scryfall token search, cached)

type TokenArt = string | null; // URL, or null = no matching token / lookup failed
const TOKEN_KEY = 'ojb:tokenArt:';
const tokenArt = new Map<string, TokenArt>();
const tokenListeners = new Set<() => void>();
const tokenQueue: { key: string; face: Face }[] = [];
let tokenBusy = false;

const tokenKey = (f: Face) => `${f.name}|${f.power ?? ''}/${f.toughness ?? ''}|${(f.colors ?? []).slice().sort().join('')}`;

interface ScryCard { name: string; type_line?: string; power?: string; toughness?: string; colors?: string[]; image_uris?: { normal?: string }; card_faces?: { name?: string; image_uris?: { normal?: string } }[] }

/** Best Scryfall token for this face: same name, then same P/T and colors score higher. */
function pickToken(face: Face, list: ScryCard[]): string | null {
  const want = (face.colors ?? []).slice().sort().join('');
  let best: { url: string; score: number } | null = null;
  for (const c of list) {
    const url = c.image_uris?.normal ?? c.card_faces?.find((x) => x.name?.toLowerCase() === face.name.toLowerCase())?.image_uris?.normal ?? c.card_faces?.[0]?.image_uris?.normal;
    if (!url) continue;
    let score = 0;
    if (c.name.toLowerCase() === face.name.toLowerCase()) score += 4;
    if ((c.power ?? '') === (face.power ?? '') && (c.toughness ?? '') === (face.toughness ?? '')) score += 3;
    if ((c.colors ?? []).slice().sort().join('') === want) score += 2;
    const sub = face.typeLine.split(/\s+[—-]\s+/)[1];
    if (sub && c.type_line?.includes(sub)) score += 1;
    if (!best || score > best.score) best = { url, score };
  }
  return best?.url ?? null;
}

async function pumpTokens() {
  if (tokenBusy) return;
  tokenBusy = true;
  while (tokenQueue.length) {
    const { key, face } = tokenQueue.shift()!;
    let url: TokenArt = null;
    try {
      const q = `!"${face.name.replace(/"/g, '')}" t:token`;
      const res = await fetch(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=art&include_extras=true&order=released&dir=desc`);
      if (res.ok) url = pickToken(face, ((await res.json()) as { data?: ScryCard[] }).data ?? []);
    } catch { url = null; }
    tokenArt.set(key, url);
    try { localStorage.setItem(TOKEN_KEY + key, url ?? ''); } catch { /* storage blocked */ }
    tokenListeners.forEach((l) => l());
    await new Promise((r) => setTimeout(r, 120)); // Scryfall asks for <10 requests per second
  }
  tokenBusy = false;
}

/** Token art URL for a token face without its own image: undefined while unknown, null when there is none. */
function useTokenArt(face: Face): TokenArt | undefined {
  const need = face.isToken && !face.image && !face.localImage;
  const key = need ? tokenKey(face) : '';
  useSyncExternalStore((l) => { tokenListeners.add(l); return () => tokenListeners.delete(l); }, () => (key ? tokenArt.get(key) : undefined));
  if (!need) return undefined;
  if (!tokenArt.has(key)) {
    let stored: string | null = null;
    try { stored = localStorage.getItem(TOKEN_KEY + key); } catch { stored = null; }
    if (stored != null) tokenArt.set(key, stored || null);
    else if (!tokenQueue.some((t) => t.key === key)) { tokenQueue.push({ key, face }); void pumpTokens(); }
  }
  return tokenArt.get(key);
}

/** A card picture with graceful fallbacks: remote → PDF crop → text frame. Tokens use Scryfall token art when found. */
export function CardImage({ face, large, className, style }: { face: Face; large?: boolean; className?: string; style?: CSSProperties }) {
  useImageSource();
  const [, bump] = useState(0);
  const art = useTokenArt(face);
  const list = art ? [art].filter((u) => !failed.has(u)) : sources(face);
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
  if (face.isToken) return <TokenFrame face={face} className={className} style={style} />;
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

/** Styled frame for a token without art: name, type line, rules text and P/T, tinted by its colors. */
function TokenFrame({ face, className, style }: { face: Face; className?: string; style?: CSSProperties }) {
  const cols = (face.colors ?? []).filter((c) => COLOR_BG[c]);
  const bg = cols.length === 0 ? 'linear-gradient(160deg, #d8d8d8, #9a9a9a)'
    : cols.length === 1 ? `linear-gradient(160deg, ${COLOR_BG[cols[0]]}, #00000033), ${COLOR_BG[cols[0]]}`
      : `linear-gradient(135deg, ${cols.map((c) => COLOR_BG[c]).join(', ')})`;
  return (
    <div className={`card-img text-card token-frame ${className ?? ''}`} style={{ background: bg, ...style }}>
      <div className="tf-tag">Token</div>
      <div className="tc-name">{face.name}</div>
      <div className="tf-art">{face.types.includes('Creature') ? '◆' : '✦'}</div>
      <div className="tc-type">{face.typeLine.replace(/^Token\s+/, '')}</div>
      {face.oracle && <div className="tc-text">{face.oracle}</div>}
      {face.power != null && <div className="tc-pt">{face.power}/{face.toughness}</div>}
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
  const zoom = useHoverZoom();
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
  if (!p || !pos || !zoom) return null;
  return <HoverBox p={p} pos={pos} />;
}

/** The floating preview, measured after render and kept fully inside the viewport (beside the cursor, never under it). */
function HoverBox({ p, pos }: { p: PreviewItem; pos: { x: number; y: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(0);
  // Size the card so the whole box (image + back face + note) fits the viewport height.
  const extraH = (p.backFace ? 0.55 * 88 / 63 : 0);
  const w = Math.max(140, Math.min(300, Math.max(220, innerHeight * 0.36), (innerHeight - 16 - (p.extra ? 70 : 0)) / (88 / 63 + extraH + 0.02), innerWidth / 2 - 40));
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && Math.abs(el.offsetHeight - h) > 0.5) setH(el.offsetHeight);
  });
  const right = pos.x < innerWidth / 2;
  const left = Math.max(8, Math.min(right ? pos.x + 28 : pos.x - 28 - w, innerWidth - w - 8));
  const hh = h || w * 88 / 63;
  const top = Math.max(8, Math.min(pos.y - hh / 2, innerHeight - hh - 8));
  return (
    <div ref={ref} className="hover-preview" style={{ left, top, width: w, maxHeight: innerHeight - 16 }}>
      <CardImage face={p.face} large className="hp-img" />
      {p.backFace && <CardImage face={p.backFace} className="hp-back" />}
      {p.extra && <div className="hp-extra">{p.extra}</div>}
    </div>
  );
}
