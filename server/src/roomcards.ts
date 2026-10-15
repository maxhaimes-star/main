/**
 * Glue between the card database (carddb.ts) and rooms: makes every database card usable by the
 * shared code (getCard / engine scripts), generates set boosters, and builds the per-client card
 * payloads that go out with room views.
 */
import type { CardData, CardPayload, ForgeFace, RoomView, TokenData } from '@ojb/shared';
import { isCubeCard, isKnownCard, registerCards, setCardResolver } from '@ojb/shared/src/cube.ts';
import { getCard } from '@ojb/shared/src/cube.ts';
import { registerScripts } from '@ojb/shared/src/engine/script.ts';
import { heuristicRank } from '@ojb/shared/src/power.ts';
import { printingImage, type Rarity } from '@ojb/shared/src/carddb-types.ts';
import { boosterFor, carddbAvailable, getCardById, getScript, getSet, printingsOf, tokenTable } from './carddb.ts';

let installed = false;

/** Hook the card DB into the shared lookups (idempotent; no-op without the DB). */
export function installCardDb(): boolean {
  if (installed) return true;
  if (!carddbAvailable()) return false;
  installed = true;
  setCardResolver((id) => dbCard(id));
  registerScripts({}, tokenTable());
  return true;
}

/** The rarity a card is usually printed at (bots' power baseline). */
function typicalRarity(id: string): Rarity {
  const counts: Partial<Record<Rarity, number>> = {};
  for (const p of printingsOf(id)) if (p.rarity !== 'S') counts[p.rarity] = (counts[p.rarity] ?? 0) + 1;
  const order: Rarity[] = ['M', 'R', 'U', 'C', 'L'];
  let best: Rarity = 'C';
  let n = 0;
  for (const r of order) if ((counts[r] ?? 0) > n) { n = counts[r]!; best = r; }
  return best;
}

/** A database card ready for the shared code: bot rank set, rules script registered. */
export function dbCard(id: string, rarity?: Rarity): CardData | undefined {
  const c = getCardById(id);
  if (!c) return undefined;
  const faces = getScript(id);
  if (faces) registerScripts({ [id]: faces });
  return { ...c, rank: heuristicRank(c, rarity ?? typicalRarity(id)) };
}

/** Make sure these ids resolve (registers DB cards; cube cards are untouched). */
export function ensureCards(ids: Iterable<string>) {
  const add: CardData[] = [];
  for (const id of new Set(ids)) {
    if (isKnownCard(id)) continue;
    const c = dbCard(id);
    if (c) add.push(c);
  }
  if (add.length) registerCards(add);
}

// ------------------------------------------------------------ set boosters

export interface SetPack { ids: string[]; prints: Record<string, string> }

/** One booster as card ids; registers its cards (rank from the booster's rarity) and their printings. */
export function setBooster(code: string, rng: () => number): SetPack {
  const cards = boosterFor(code, rng);
  const prints: Record<string, string> = {};
  const add: CardData[] = [];
  for (const b of cards) {
    if (b.num && !prints[b.id]) prints[b.id] = `${b.set}:${b.num}`;
    if (!isCubeCard(b.id) && !isKnownCard(b.id)) {
      const c = dbCard(b.id, b.rarity);
      if (c) add.push(c);
    }
  }
  if (add.length) registerCards(add);
  return { ids: cards.map((b) => b.id), prints };
}

/** Error for an unusable set code, or null. */
export function checkBoosterSet(code: string): string | null {
  const s = getSet(code);
  if (!s) return `Unknown set ${code}`;
  if (!s.booster) return `${s.name} has no boosters`;
  return null;
}

// ------------------------------------------------------------ payloads

/** Card ids a view shows, split into "needs card data" and "needs rules scripts too" (games). */
export function idsInView(view: RoomView): { cards: Set<string>; scripts: Set<string> } {
  const cards = new Set<string>();
  const scripts = new Set<string>();
  const add = (ids?: (string | undefined)[] | null) => { for (const id of ids ?? []) if (id) cards.add(id); };
  add(view.pool);
  if (view.deck) { add(view.deck.main); add(view.deck.side); }
  if (view.draft) { add(view.draft.pack); add(view.draft.picks); }
  const a = view.auction;
  if (a) {
    add(a.open);
    if (a.lot) cards.add(a.lot.cardId);
    for (const p of Object.values(a.pools)) add(p);
    add(a.results.slice(0, 30).map((r) => r.cardId));
  }
  for (const m of view.matches) {
    for (const d of Object.values(m.decks ?? {})) { add(d.main); add(d.side); for (const id of [...d.main, ...d.side]) scripts.add(id); }
    for (const c of Object.values(m.game?.cards ?? {})) {
      const inst = c as { cardId?: string; copyOf?: string };
      for (const id of [inst.cardId, inst.copyOf]) if (id) { cards.add(id); scripts.add(id); }
    }
  }
  return { cards, scripts };
}

/** Card with the room's printing art (set events / deck lists with set codes). */
function withPrinting(c: CardData, print: string | undefined): CardData {
  if (!print) return c;
  const [code, num] = print.split(':');
  const set = getSet(code);
  if (!set || !num) return c;
  return {
    ...c,
    image: printingImage(set.scryfall, num),
    ...(c.backImage ? { backImage: printingImage(set.scryfall, num, true) } : {}),
  };
}

/**
 * Card data (and scripts, for game cards) the client hasn't been sent yet. `sent` is per socket and
 * is updated. Cube cards are only sent when the room shows a specific printing of them.
 */
export function cardPayload(view: RoomView, prints: Record<string, string> | undefined, sent: Set<string>): CardPayload | null {
  const { cards, scripts } = idsInView(view);
  const out: CardPayload = { cards: {}, scripts: {} };
  let any = false;
  for (const id of cards) {
    const needScript = scripts.has(id) && !isCubeCard(id);
    const key = needScript ? `${id}+s` : id;
    if (sent.has(key) || id.startsWith('basic_')) continue;
    if (isCubeCard(id) && !prints?.[id]) { sent.add(key); continue; }
    if (!sent.has(id)) {
      const c = getCard(id);
      if (c) { out.cards[id] = withPrinting(c, prints?.[id]); any = true; }
    }
    if (needScript) {
      const f: ForgeFace[] | undefined = getScript(id);
      if (f) {
        out.scripts[id] = f;
        any = true;
        for (const m of JSON.stringify(f).matchAll(/TokenScript\$\s*([^|"]+)/g)) {
          for (const t of m[1].split(',').map((x) => x.trim())) {
            const tok = tokenTable()[t];
            if (tok) (out.tokens ??= {})[t] = tok;
          }
        }
      }
    }
    sent.add(id);
    sent.add(key);
  }
  return any ? out : null;
}
