import { type CardData, COLORS } from './cards.ts';
import { botDeck, botPick, cardScore } from './bots.ts';
import { emptyDeck, multisetDiff } from './deckutil.ts';
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

export { multisetDiff, emptyDeck };

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
  startDraftWithPacks(room, unopened, now);
}

/** Start a draft from ready-made packs: unopened[round][seat] (e.g. set boosters). */
export function startDraftWithPacks(room: RoomState, unopened: string[][][], now: number) {
  const n = room.players.length;
  const draft: DraftState = {
    round: 0,
    queues: Array.from({ length: n }, () => []),
    deadlines: Array(n).fill(null),
    picks: Array.from({ length: n }, () => []),
    main: Array.from({ length: n }, () => []),
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
      finishPools(room, (seatIdx) => d.picks[seatIdx], (seatIdx) => d.main?.[seatIdx] ?? []);
    }
  }
  return null;
}

/**
 * A human leaves mid-draft (or mid-auction): a bot takes over their seat so the event carries on.
 * The seat keeps the player's id, picks and pool, so they can take it back later with `reclaimSeat`.
 */
export function leaveSeat(room: RoomState, pid: string): string | null {
  if (room.phase !== 'drafting' && room.phase !== 'auction') return 'You can only leave while drafting or in an auction';
  const p = room.players.find((x) => x.id === pid);
  if (!p) return 'You are not seated';
  if (p.isBot) return 'A bot is already playing your seat';
  p.isBot = true;
  p.away = true;
  p.connected = false;
  return null;
}

/** An away player takes their seat back from the bot that was playing it. */
export function reclaimSeat(room: RoomState, pid: string, now: number): string | null {
  const p = room.players.find((x) => x.id === pid);
  if (!p?.away) return 'That seat is not waiting for you';
  p.isBot = false;
  delete p.away;
  p.connected = true;
  const d = room.draft;
  if (room.phase === 'drafting' && d && !d.done) {
    // The bot may have left a pack in front of the seat; give the human a fresh timer for it.
    d.deadlines[p.seat] = null;
    armDeadline(room, p.seat, now);
  }
  return null;
}

/** The player in `seat` chooses which of their picks form the main deck; the rest is sideboard. */
export function setDraftMain(room: RoomState, seat: number, main: string[]): string | null {
  const d = room.draft;
  if (!d || d.done) return 'No draft in progress';
  const picks = d.picks[seat];
  if (!picks) return 'No such seat';
  if (!Array.isArray(main) || main.some((x) => typeof x !== 'string')) return 'Invalid deck';
  if (multisetDiff(picks, main).length !== picks.length - main.length) return 'Those cards are not in your picks';
  (d.main ??= d.picks.map(() => []))[seat] = main.slice();
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

// ===================================================================== sealed

export function startSealed(room: RoomState, list: string[], rng: Rng, lookup: CardLookup) {
  const n = room.players.length;
  const { sealedPacks, sealedPackSize, colorBalance } = room.settings;
  const packs = makePacks(list, n * sealedPacks, sealedPackSize, rng, lookup, colorBalance);
  finishPools(room, (seat) => packs.slice(seat * sealedPacks, (seat + 1) * sealedPacks).flat());
}

/** Sealed from ready-made pools, one per seat (e.g. set boosters). */
export function startSealedWithPools(room: RoomState, pools: string[][]) {
  finishPools(room, (seat) => pools[seat] ?? []);
}

function finishPools(room: RoomState, poolForSeat: (seat: number) => string[], mainForSeat?: (seat: number) => string[]) {
  const players = seatedPlayers(room);
  room.pools = {};
  room.decks = {};
  players.forEach((p, seat) => {
    room.pools[p.id] = poolForSeat(seat).slice();
    const pool = room.pools[p.id];
    const main = mainForSeat ? mainForSeat(seat) : [];
    const leftover = multisetDiff(pool, main);
    // Only honour a main-deck split that really is a subset of the pool.
    const ok = leftover.length === pool.length - main.length;
    room.decks[p.id] = { ...emptyDeck(), main: ok ? main.slice() : [], side: ok ? leftover : pool.slice() };
  });
  room.phase = 'deckbuilding';
}

export function finishPoolsWithBots(room: RoomState, lookup: CardLookup) {
  for (const p of room.players) if (p.isBot) room.decks[p.id] = botDeck(room.pools[p.id], lookup);
}

// ===================================================================== auction

export function auctionTargetCards(room: RoomState): number {
  const { auctionPoolSize, auctionPacksPerPlayer, auctionPackSize } = room.settings;
  return auctionPoolSize > 0 ? auctionPoolSize : Math.max(1, Math.round(auctionPacksPerPlayer * auctionPackSize * 0.6));
}

export function startAuction(room: RoomState, list: string[], rng: Rng, lookup: CardLookup, now: number) {
  const n = room.players.length;
  const { auctionPackSize, auctionPacksPerPlayer, auctionBudget, colorBalance } = room.settings;
  const totalPacks = n * auctionPacksPerPlayer;
  if (totalPacks * auctionPackSize > list.length) {
    throw new Error(`Not enough cards: ${n} players × ${auctionPacksPerPlayer} packs × ${auctionPackSize} = ${totalPacks * auctionPackSize}, but the cube has ${list.length}`);
  }
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
  const cap = room.settings.auctionPoolSize;
  return cap > 0 && room.auction!.pools[pid].length >= cap;
}

function canOpen(room: RoomState, pid: string): boolean {
  return !isCapped(room, pid) && room.auction!.budgets[pid] >= room.settings.auctionMinBid;
}

function openNextPack(room: RoomState, now: number) {
  const a = room.auction!;
  const next = a.packs.shift();
  if (!next) return endAuction(room);
  a.open = next;
  a.packNumber++;
  armNominator(room, now, false);
}

/** Moves the nominator to the next player who can afford the minimum bid (ends the auction if nobody can). */
function armNominator(room: RoomState, now: number, advance: boolean) {
  const a = room.auction!;
  const players = seatedPlayers(room);
  if (!players.some((p) => canOpen(room, p.id))) return endAuction(room);
  let seat = advance ? (a.nominatorSeat + 1) % players.length : a.nominatorSeat;
  for (let i = 0; i < players.length && !canOpen(room, players[seat].id); i++) seat = (seat + 1) % players.length;
  a.nominatorSeat = seat;
  a.nominateDeadline = room.settings.nominateTimer ? now + room.settings.nominateTimer * 1000 : null;
}

function endAuction(room: RoomState) {
  const a = room.auction!;
  a.done = true;
  a.lot = null;
  a.open = [];
  a.nominateDeadline = null;
  finishPools(room, (seat) => a.pools[seatedPlayers(room)[seat].id]);
}

function afterLot(room: RoomState, now: number) {
  const a = room.auction!;
  if (a.open.length === 0) openNextPack(room, now);
  else armNominator(room, now, true);
}

function checkNominator(room: RoomState, pid: string, cardId: string): string | null {
  const a = room.auction;
  if (!a || a.done) return 'No auction in progress';
  if (a.lot) return 'A card is already up for auction';
  const nominator = seatedPlayers(room)[a.nominatorSeat];
  if (nominator.id !== pid) return `Waiting for ${nominator.name} to choose`;
  if (!a.open.includes(cardId)) return 'Card is not in the open pack';
  return null;
}

/** The nominator puts a card up with an opening bid (default: the minimum bid). */
export function nominate(room: RoomState, pid: string, cardId: string, now: number, amount?: number): string | null {
  const err = checkNominator(room, pid, cardId);
  if (err) return err;
  const a = room.auction!;
  const min = room.settings.auctionMinBid;
  const open = amount ?? min;
  if (!Number.isInteger(open) || open < min) return `Opening bid must be at least ${min}`;
  if (open > a.budgets[pid]) return `You only have ${a.budgets[pid]}`;
  a.open.splice(a.open.indexOf(cardId), 1);
  a.lot = {
    cardId,
    bids: [{ pid, amount: open, at: now }],
    deadline: room.settings.auctionTimer ? now + room.settings.auctionTimer * 1000 : null,
    nominatedBy: pid,
    passes: [],
  };
  a.nominateDeadline = null;
  closeIfSettled(room, now);
  return null;
}

/** The nominator declines to buy: the card is discarded unsold. */
export function skipCard(room: RoomState, pid: string, cardId: string, now: number): string | null {
  const err = checkNominator(room, pid, cardId);
  if (err) return err;
  const a = room.auction!;
  a.open.splice(a.open.indexOf(cardId), 1);
  a.results.unshift({ cardId, pid: null, amount: 0 });
  afterLot(room, now);
  return null;
}

export function highBid(a: AuctionState) {
  return a.lot?.bids[a.lot.bids.length - 1];
}

/** Players who could still outbid the current high bid. */
export function lotContenders(room: RoomState): string[] {
  const a = room.auction;
  if (!a?.lot) return [];
  const high = highBid(a)!;
  return room.players.filter((p) => p.id !== high.pid && !isCapped(room, p.id) && a.budgets[p.id] >= high.amount + 1).map((p) => p.id);
}

function closeIfSettled(room: RoomState, now: number): boolean {
  const a = room.auction!;
  if (!a.lot) return false;
  if (lotContenders(room).every((id) => a.lot!.passes.includes(id))) {
    awardLot(room, now);
    return true;
  }
  return false;
}

export function placeBid(room: RoomState, pid: string, amount: number, now: number): string | null {
  const a = room.auction;
  if (!a || !a.lot) return 'Nothing to bid on';
  if (!Number.isInteger(amount) || amount < room.settings.auctionMinBid) return `Minimum bid is ${room.settings.auctionMinBid}`;
  if (isCapped(room, pid)) return 'Your pool is full';
  const high = highBid(a)!;
  if (high.pid === pid) return 'You are already the high bidder';
  if (amount <= high.amount) return `Bid must be more than ${high.amount}`;
  if (amount > a.budgets[pid]) return `You only have ${a.budgets[pid]}`;
  a.lot.bids.push({ pid, amount, at: now });
  a.lot.passes = [];
  if (a.lot.deadline != null) a.lot.deadline = Math.max(a.lot.deadline, now + room.settings.auctionTimer * 1000);
  closeIfSettled(room, now);
  return null;
}

export function passLot(room: RoomState, pid: string, now: number): string | null {
  const a = room.auction;
  if (!a || !a.lot) return 'Nothing to pass on';
  if (highBid(a)!.pid === pid) return 'You are the high bidder';
  if (!room.players.some((p) => p.id === pid)) return 'Not in this auction';
  if (!a.lot.passes.includes(pid)) a.lot.passes.push(pid);
  closeIfSettled(room, now);
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
  afterLot(room, now);
}

export function botValuation(room: RoomState, pid: string, cardId: string, lookup: CardLookup): number {
  const card = lookup(cardId);
  const a = room.auction!;
  if (!card) return 0;
  const target = auctionTargetCards(room);
  const perCard = room.settings.auctionBudget / target;
  const s = cardScore(card, a.pools[pid], lookup); // ~0.1 .. 2.1
  // Spend more freely when the bot has budget left relative to the cards it still needs.
  const need = Math.max(1, target - a.pools[pid].length);
  const pace = Math.min(2, a.budgets[pid] / (need * perCard || 1));
  return Math.floor(perCard * s * s * 1.6 * pace);
}

export function auctionTick(room: RoomState, now: number, lookup: CardLookup, rng: Rng): boolean {
  const a = room.auction;
  if (!a || a.done) return false;
  const players = seatedPlayers(room);
  const min = room.settings.auctionMinBid;
  if (a.lot) {
    if (a.lot.deadline != null && now >= a.lot.deadline) {
      awardLot(room, now);
      return true;
    }
    if (closeIfSettled(room, now)) return true;
    const high = highBid(a)!;
    // Bots consider acting at most once a second, after a short think.
    if (now - high.at < 900) return false;
    const bidders = players.filter((p) => p.isBot && p.id !== high.pid && !isCapped(room, p.id));
    for (const bot of shuffle(bidders, rng)) {
      if (a.lot.passes.includes(bot.id)) continue;
      const value = Math.min(botValuation(room, bot.id, a.lot.cardId, lookup), a.budgets[bot.id]);
      if (high.amount + 1 > value) {
        passLot(room, bot.id, now);
        return true;
      }
      if (rng() > 0.75) continue;
      // Jump-bid toward the valuation so bot bidding wars don't crawl up one point at a time.
      const gap = value - high.amount;
      const next = high.amount + (gap > 3 ? Math.ceil(gap / 2) : 1);
      placeBid(room, bot.id, Math.max(min, next), now);
      return true;
    }
    return false;
  }
  const nominator = players[a.nominatorSeat];
  const timedOut = a.nominateDeadline != null && now >= a.nominateDeadline;
  if (a.open.length && (nominator.isBot || timedOut)) {
    if (nominator.isBot) {
      const pick = botPick(a.open, a.pools[nominator.id], lookup, rng);
      const value = Math.min(botValuation(room, nominator.id, pick, lookup), a.budgets[nominator.id]);
      // Bots only open on cards they value at or above the minimum bid; otherwise the card is discarded.
      if (value < min) skipCard(room, nominator.id, pick, now);
      else nominate(room, nominator.id, pick, now, Math.max(min, Math.floor(value / 3)));
    } else {
      nominate(room, nominator.id, bestRanked(a.open, lookup), now);
    }
    return true;
  }
  return false;
}

function bestRanked(ids: string[], lookup: CardLookup): string {
  return ids.slice().sort((x, y) => (lookup(x)?.rank ?? 9999) - (lookup(y)?.rank ?? 9999))[0];
}
