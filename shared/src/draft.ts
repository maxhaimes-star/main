import { type CardData, type Color, COLORS } from './cards.ts';
import type { AuctionState, Deck, DraftState, Player, RoomState } from './room.ts';

export type Rng = () => number;

export function shuffle<T>(arr: T[], rng: Rng): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export type CardLookup = (id: string) => CardData | undefined;

/**
 * Deal `count` packs of `size` from `list`. With colorBalance each pack first gets
 * one mono-colored card of each color (when available), then is filled at random.
 */
export function makePacks(list: string[], count: number, size: number, rng: Rng, lookup: CardLookup, colorBalance: boolean): string[][] {
  if (count * size > list.length) throw new Error(`Not enough cards: need ${count * size}, cube has ${list.length}`);
  let pool = shuffle(list, rng);
  const packs: string[][] = [];
  for (let p = 0; p < count; p++) {
    const pack: string[] = [];
    if (colorBalance && size >= 8) {
      for (const color of COLORS) {
        const idx = pool.findIndex((id) => {
          const c = lookup(id);
          return c && c.colors.length === 1 && c.colors[0] === color;
        });
        if (idx >= 0) pack.push(pool.splice(idx, 1)[0]);
      }
    }
    while (pack.length < size) pack.push(pool.shift()!);
    packs.push(shuffle(pack, rng));
  }
  return packs;
}

export function seatedPlayers(room: RoomState): Player[] {
  return room.players.slice().sort((a, b) => a.seat - b.seat);
}

export function cubeList(room: RoomState, defaultList: string[]): string[] {
  return room.settings.customList?.length ? room.settings.customList : defaultList;
}

export function multisetDiff(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const x of b) counts.set(x, (counts.get(x) ?? 0) + 1);
  return a.filter((x) => {
    const c = counts.get(x) ?? 0;
    if (c > 0) { counts.set(x, c - 1); return false; }
    return true;
  });
}

export const emptyDeck = (): Deck => ({ main: [], side: [], basics: { W: 0, U: 0, B: 0, R: 0, G: 0 }, ready: false });

// ===================================================================== booster draft

export function pickTime(room: RoomState, packLen: number): number {
  const t = room.settings.pickTimer;
  if (!t) return 0;
  return Math.max(8, Math.round((t * packLen) / room.settings.packSize)) * 1000;
}

export function startDraft(room: RoomState, list: string[], rng: Rng, lookup: CardLookup, now: number) {
  const n = room.players.length;
  const { packs, packSize, colorBalance } = room.settings;
  const all = makePacks(list, n * packs, packSize, rng, lookup, colorBalance);
  const unopened: string[][][] = [];
  for (let r = 0; r < packs; r++) unopened.push(all.slice(r * n, (r + 1) * n));
  const draft: DraftState = {
    round: 0,
    queues: Array.from({ length: n }, () => []),
    deadlines: Array(n).fill(null),
    picks: Array.from({ length: n }, () => []),
    unopened,
    pickNumber: Array(n).fill(0),
    done: false,
  };
  room.draft = draft;
  room.phase = 'drafting';
  openRound(room, now);
}

function openRound(room: RoomState, now: number) {
  const d = room.draft!;
  const packs = d.unopened[d.round];
  packs.forEach((pack, seat) => {
    d.queues[seat].push(pack);
  });
  d.unopened[d.round] = [];
  d.queues.forEach((_, seat) => armDeadline(room, seat, now));
}

function armDeadline(room: RoomState, seat: number, now: number) {
  const d = room.draft!;
  const front = d.queues[seat][0];
  if (front && d.deadlines[seat] == null) {
    const t = pickTime(room, front.length);
    d.deadlines[seat] = t ? now + t : null;
  }
  if (!front) d.deadlines[seat] = null;
}

export function passDirection(round: number): 1 | -1 {
  return round % 2 === 0 ? 1 : -1;
}

export function draftPick(room: RoomState, seat: number, cardId: string, now: number): string | null {
  const d = room.draft;
  if (!d || d.done) return 'No draft in progress';
  const pack = d.queues[seat][0];
  if (!pack) return 'No pack to pick from';
  const idx = pack.indexOf(cardId);
  if (idx < 0) return 'Card not in pack';
  pack.splice(idx, 1);
  d.picks[seat].push(cardId);
  d.pickNumber[seat]++;
  d.queues[seat].shift();
  d.deadlines[seat] = null;
  const n = d.queues.length;
  if (pack.length > 0) {
    const next = (seat + passDirection(d.round) + n) % n;
    d.queues[next].push(pack);
    armDeadline(room, next, now);
  }
  armDeadline(room, seat, now);
  // Round over?
  if (d.queues.every((q) => q.length === 0)) {
    if (d.round + 1 < d.unopened.length) {
      d.round++;
      openRound(room, now);
    } else {
      d.done = true;
      finishPools(room, (seatIdx) => d.picks[seatIdx]);
    }
  }
  return null;
}

/** Called periodically: auto-picks for bots and timed-out humans. Returns true if anything changed. */
export function draftTick(room: RoomState, now: number, lookup: CardLookup, rng: Rng): boolean {
  const d = room.draft;
  if (!d || d.done) return false;
  let changed = false;
  const players = seatedPlayers(room);
  for (let seat = 0; seat < d.queues.length; seat++) {
    if (d.done) break;
    const pack = d.queues[seat][0];
    if (!pack) continue;
    const p = players[seat];
    const timedOut = d.deadlines[seat] != null && now >= d.deadlines[seat]!;
    if (p.isBot || timedOut) {
      const pick = botPick(pack, d.picks[seat], lookup, rng);
      draftPick(room, seat, pick, now);
      changed = true;
    }
  }
  return changed;
}

// ===================================================================== bots

/** Colors a bot leans toward given its picks so far. */
export function colorWeights(picks: string[], lookup: CardLookup): Record<Color, number> {
  const w: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const id of picks) {
    const c = lookup(id);
    if (!c || c.types.includes('Land')) continue;
    const power = 1 + Math.max(0, 1 - c.rank / 600);
    for (const col of c.colors) w[col] += power / c.colors.length;
  }
  return w;
}

export function cardScore(card: CardData, picks: string[], lookup: CardLookup): number {
  // Earlier in the list ≈ the cube owner's sort order; use a gentle prior plus color fit.
  let score = 1 - Math.min(card.rank, 600) / 600;
  score += 0.5; // baseline so nothing scores negative
  if (picks.length >= 4) {
    const w = colorWeights(picks, lookup);
    const top = (Object.entries(w) as [Color, number][]).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
    if (card.colors.length === 0) score += 0.25;
    else if (card.colors.every((c) => top.includes(c))) score += 0.6;
    else if (card.colors.some((c) => top.includes(c))) score += 0.1;
    else score -= 0.4 * Math.min(1, picks.length / 15);
  }
  if (card.types.includes('Land') && card.colorIdentity.length >= 2) score -= 0.15;
  return score;
}

export function botPick(pack: string[], picks: string[], lookup: CardLookup, rng: Rng): string {
  let best = pack[0];
  let bestScore = -Infinity;
  for (const id of pack) {
    const c = lookup(id);
    const s = (c ? cardScore(c, picks, lookup) : 0) + rng() * 0.15;
    if (s > bestScore) { bestScore = s; best = id; }
  }
  return best;
}

/** Bot deckbuilding: two best colors, 23 spells, 17 lands. */
export function botDeck(pool: string[], lookup: CardLookup): Deck {
  const w = colorWeights(pool, lookup);
  const top = (Object.entries(w) as [Color, number][]).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
  const fits = (c: CardData) => c.colors.every((x) => top.includes(x));
  const cards = pool.map((id) => lookup(id)).filter(Boolean) as CardData[];
  const spells = cards.filter((c) => !c.types.includes('Land') && fits(c)).sort((a, b) => a.rank - b.rank).slice(0, 23);
  const lands = cards.filter((c) => c.types.includes('Land') && c.producedMana.some((m) => top.includes(m as Color)) && c.producedMana.every((m) => top.includes(m as Color) || m === 'C')).slice(0, 7);
  const main = [...spells, ...lands].map((c) => c.id);
  const deck = emptyDeck();
  deck.main = main;
  deck.side = multisetDiff(pool, main);
  const basicsNeeded = Math.max(0, 40 - main.length);
  deck.basics[top[0]] = Math.ceil(basicsNeeded / 2);
  deck.basics[top[1] ?? top[0]] += Math.floor(basicsNeeded / 2);
  deck.ready = true;
  return deck;
}

// ===================================================================== sealed

export function startSealed(room: RoomState, list: string[], rng: Rng, lookup: CardLookup) {
  const n = room.players.length;
  const { sealedPacks, sealedPackSize, colorBalance } = room.settings;
  const packs = makePacks(list, n * sealedPacks, sealedPackSize, rng, lookup, colorBalance);
  finishPools(room, (seat) => packs.slice(seat * sealedPacks, (seat + 1) * sealedPacks).flat());
}

function finishPools(room: RoomState, poolForSeat: (seat: number) => string[]) {
  const players = seatedPlayers(room);
  room.pools = {};
  room.decks = {};
  players.forEach((p, seat) => {
    room.pools[p.id] = poolForSeat(seat).slice();
    room.decks[p.id] = { ...emptyDeck(), side: room.pools[p.id].slice() };
  });
  room.phase = 'deckbuilding';
}

export function finishPoolsWithBots(room: RoomState, lookup: CardLookup) {
  for (const p of room.players) if (p.isBot) room.decks[p.id] = botDeck(room.pools[p.id], lookup);
}

// ===================================================================== auction

export function startAuction(room: RoomState, list: string[], rng: Rng, lookup: CardLookup, now: number) {
  const n = room.players.length;
  const { auctionPackSize, auctionPoolSize, auctionBudget, colorBalance } = room.settings;
  const needed = Math.ceil((n * auctionPoolSize) / auctionPackSize);
  const totalPacks = Math.min(needed, Math.floor(list.length / auctionPackSize));
  const packs = makePacks(list, totalPacks, auctionPackSize, rng, lookup, colorBalance);
  const a: AuctionState = {
    packs,
    packNumber: 0,
    totalPacks,
    open: [],
    nominatorSeat: 0,
    nominateDeadline: null,
    lot: null,
    budgets: Object.fromEntries(room.players.map((p) => [p.id, auctionBudget])),
    pools: Object.fromEntries(room.players.map((p) => [p.id, []])),
    results: [],
    done: false,
  };
  room.auction = a;
  room.phase = 'auction';
  openNextPack(room, now);
}

function isCapped(room: RoomState, pid: string): boolean {
  return room.auction!.pools[pid].length >= room.settings.auctionPoolSize;
}

function openNextPack(room: RoomState, now: number) {
  const a = room.auction!;
  const next = a.packs.shift();
  if (!next) return endAuction(room);
  a.open = next;
  a.packNumber++;
  armNominator(room, now, false);
}

/** Moves the nominator to the next uncapped seat (or keeps current if advance=false and eligible). */
function armNominator(room: RoomState, now: number, advance: boolean) {
  const a = room.auction!;
  const players = seatedPlayers(room);
  const eligible = players.filter((p) => !isCapped(room, p.id));
  if (eligible.length === 0) return endAuction(room);
  if (eligible.length === 1) {
    // Only one player can still take cards: they get the rest of the open pack for free.
    const pid = eligible[0].id;
    while (a.open.length && !isCapped(room, pid)) {
      const card = a.open.shift()!;
      a.pools[pid].push(card);
      a.results.unshift({ cardId: card, pid, amount: 0 });
    }
    if (isCapped(room, pid)) return endAuction(room);
    return openNextPack(room, now);
  }
  let seat = advance ? (a.nominatorSeat + 1) % players.length : a.nominatorSeat;
  for (let i = 0; i < players.length && isCapped(room, players[seat].id); i++) seat = (seat + 1) % players.length;
  a.nominatorSeat = seat;
  a.nominateDeadline = room.settings.nominateTimer ? now + room.settings.nominateTimer * 1000 : null;
}

function endAuction(room: RoomState) {
  const a = room.auction!;
  a.done = true;
  a.lot = null;
  a.nominateDeadline = null;
  finishPools(room, (seat) => a.pools[seatedPlayers(room)[seat].id]);
}

export function nominate(room: RoomState, pid: string, cardId: string, now: number): string | null {
  const a = room.auction;
  if (!a || a.done) return 'No auction in progress';
  if (a.lot) return 'A card is already up for auction';
  const nominator = seatedPlayers(room)[a.nominatorSeat];
  if (nominator.id !== pid) return `Waiting for ${nominator.name} to choose`;
  const idx = a.open.indexOf(cardId);
  if (idx < 0) return 'Card is not in the open pack';
  a.open.splice(idx, 1);
  a.lot = {
    cardId,
    bids: [{ pid, amount: 0, at: now }],
    deadline: now + room.settings.auctionTimer * 1000,
    nominatedBy: pid,
  };
  a.nominateDeadline = null;
  return null;
}

export function highBid(a: AuctionState) {
  return a.lot?.bids[a.lot.bids.length - 1];
}

export function placeBid(room: RoomState, pid: string, amount: number, now: number): string | null {
  const a = room.auction;
  if (!a || !a.lot) return 'Nothing to bid on';
  if (!Number.isInteger(amount) || amount < 0) return 'Invalid bid';
  if (isCapped(room, pid)) return 'Your pool is full';
  const high = highBid(a)!;
  if (high.pid === pid) return 'You are already the high bidder';
  if (amount <= high.amount) return `Bid must be more than ${high.amount}`;
  if (amount > a.budgets[pid]) return `You only have ${a.budgets[pid]}`;
  a.lot.bids.push({ pid, amount, at: now });
  a.lot.deadline = Math.max(a.lot.deadline, now + room.settings.auctionTimer * 1000);
  return null;
}

function awardLot(room: RoomState, now: number) {
  const a = room.auction!;
  const lot = a.lot!;
  const high = highBid(a)!;
  a.budgets[high.pid] -= high.amount;
  a.pools[high.pid].push(lot.cardId);
  a.results.unshift({ cardId: lot.cardId, pid: high.pid, amount: high.amount });
  a.lot = null;
  if (a.open.length === 0) openNextPack(room, now);
  else armNominator(room, now, true);
}

export function botValuation(room: RoomState, pid: string, cardId: string, lookup: CardLookup): number {
  const card = lookup(cardId);
  const a = room.auction!;
  if (!card) return 0;
  const perCard = room.settings.auctionBudget / room.settings.auctionPoolSize;
  const s = cardScore(card, a.pools[pid], lookup); // ~0.1 .. 2.1
  // Spend more freely when the bot has budget left relative to the cards it still needs.
  const need = Math.max(1, room.settings.auctionPoolSize - a.pools[pid].length);
  const pace = Math.min(2, a.budgets[pid] / (need * perCard || 1));
  return Math.floor(perCard * s * s * 1.6 * pace);
}

export function auctionTick(room: RoomState, now: number, lookup: CardLookup, rng: Rng): boolean {
  const a = room.auction;
  if (!a || a.done) return false;
  const players = seatedPlayers(room);
  if (a.lot) {
    if (now >= a.lot.deadline) {
      awardLot(room, now);
      return true;
    }
    const high = highBid(a)!;
    // Bots consider bidding at most once a second, after a short think.
    if (now - high.at < 900) return false;
    const bidders = players.filter((p) => p.isBot && p.id !== high.pid && !isCapped(room, p.id));
    for (const bot of shuffle(bidders, rng)) {
      const value = Math.min(botValuation(room, bot.id, a.lot.cardId, lookup), a.budgets[bot.id]);
      if (high.amount + 1 > value || rng() > 0.75) continue;
      // Jump-bid toward the valuation so bot bidding wars don't crawl up one point at a time.
      const gap = value - high.amount;
      const next = high.amount + (gap > 3 ? Math.ceil(gap / 2) : 1);
      placeBid(room, bot.id, next, now);
      return true;
    }
    return false;
  }
  const nominator = players[a.nominatorSeat];
  const timedOut = a.nominateDeadline != null && now >= a.nominateDeadline;
  if (a.open.length && (nominator.isBot || timedOut)) {
    const pick = nominator.isBot ? botPick(a.open, a.pools[nominator.id], lookup, rng) : bestRanked(a.open, lookup);
    nominate(room, nominator.id, pick, now);
    return true;
  }
  return false;
}

function bestRanked(ids: string[], lookup: CardLookup): string {
  return ids.slice().sort((x, y) => (lookup(x)?.rank ?? 9999) - (lookup(y)?.rank ?? 9999))[0];
}
