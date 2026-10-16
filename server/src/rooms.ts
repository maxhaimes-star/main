import crypto from 'node:crypto';
import {
  type ClientMsg, type DraftView, type Match, type MatchView, type Player, type RoomState, type RoomView,
  applyAction, auctionTick, createGame, cubeList, DEFAULT_SETTINGS, draftPick, draftTick, leaveSeat, reclaimSeat, setDraftMain, emptyDeck,
  finishPoolsWithBots, multisetDiff, nominate, passDirection, passLot, placeBid, skipCard, seatedPlayers, startAuction, startDraft,
  startSealed, viewFor, type Color, type RoomSettings, type Deck, startDraftWithPacks, startSealedWithPools,
  CONSTRUCTED_FORMATS, type CardPayload,
} from '@ojb/shared';
import { CUBE, getCard, isCubeCard } from '@ojb/shared/src/cube.ts';
import { carddbAvailable, formatLegality, getCardById, resolveDeck } from './carddb.ts';
import { cardPayload, checkBoosterSet, ensureCards, installCardDb, setBooster } from './roomcards.ts';

// Make card-database cards resolvable everywhere (getCard / engine scripts) when the DB is built.
installCardDb();

export const rng = () => crypto.randomBytes(4).readUInt32BE() / 2 ** 32;
const id = (n = 8) => crypto.randomBytes(n).toString('base64url').slice(0, n);

export interface RoomRecord {
  state: RoomState;
  /** token -> player id (players and spectators). */
  tokens: Record<string, string>;
  /** Spectator names by id. */
  spectators: Record<string, string>;
}

const BOT_NAMES = ['Bot Urza', 'Bot Mishra', 'Bot Teferi', 'Bot Jhoira', 'Bot Karn', 'Bot Liliana', 'Bot Chandra', 'Bot Nissa'];

export class Rooms {
  rooms = new Map<string, RoomRecord>();
  dirty = new Set<string>();

  create(roomName: string, hostName: string): { roomId: string; token: string; pid: string } {
    let roomId = id(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
    while (this.rooms.has(roomId)) roomId = id(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
    const pid = id(10);
    const token = id(24);
    const now = Date.now();
    const state: RoomState = {
      id: roomId, name: roomName.slice(0, 60) || 'Cube night', hostId: pid,
      settings: { ...DEFAULT_SETTINGS },
      players: [{ id: pid, name: cleanName(hostName), seat: 0, isBot: false, connected: false }],
      phase: 'lobby', draft: null, auction: null, pools: {}, decks: {}, matches: [], chat: [],
      createdAt: now, updatedAt: now,
    };
    this.rooms.set(roomId, { state, tokens: { [token]: pid }, spectators: {} });
    this.dirty.add(roomId);
    return { roomId, token, pid };
  }

  join(roomId: string, name: string): { token: string; pid: string; spectator: boolean } | null {
    const rec = this.rooms.get(roomId);
    if (!rec) return null;
    const pid = id(10);
    const token = id(24);
    rec.tokens[token] = pid;
    const s = rec.state;
    const humans = s.players.filter((p) => !p.isBot);
    if (s.phase === 'lobby' && humans.length < 8) {
      s.players = s.players.filter((p) => !p.isBot);
      s.players.push({ id: pid, name: cleanName(name), seat: s.players.length, isBot: false, connected: false });
      if (s.settings.seats < s.players.length) s.settings.seats = s.players.length;
      this.touch(s);
      return { token, pid, spectator: false };
    }
    rec.spectators[pid] = cleanName(name);
    this.dirty.add(roomId);
    return { token, pid, spectator: true };
  }

  auth(roomId: string, token: string): { rec: RoomRecord; pid: string } | null {
    const rec = this.rooms.get(roomId);
    const pid = rec?.tokens[token];
    return rec && pid ? { rec, pid } : null;
  }

  touch(s: RoomState) {
    s.updatedAt = Date.now();
    this.dirty.add(s.id);
  }

  /** Handle a client message. Returns an error string or null. */
  handle(rec: RoomRecord, pid: string, msg: ClientMsg): string | null {
    const s = rec.state;
    const now = Date.now();
    const me = s.players.find((p) => p.id === pid);
    const isHost = s.hostId === pid;
    this.touch(s);
    switch (msg.t) {
      case 'chat': {
        const text = String(msg.text ?? '').trim().slice(0, 400);
        if (!text) return null;
        s.chat.push({ pid, name: me?.name ?? rec.spectators[pid] ?? '?', text, at: now });
        if (s.chat.length > 200) s.chat.shift();
        return null;
      }
      case 'rename': {
        if (me) me.name = cleanName(msg.name);
        else if (rec.spectators[pid]) rec.spectators[pid] = cleanName(msg.name);
        return null;
      }
      case 'updateSettings': {
        if (!isHost) return 'Only the host can change settings';
        if (s.phase !== 'lobby') return 'The event already started';
        const listChanged = Array.isArray(msg.settings?.customList);
        s.settings = sanitizeSettings({ ...s.settings, ...msg.settings }, s.players.filter((p) => !p.isBot).length, listChanged ? undefined : s.settings.customList);
        return null;
      }
      case 'kick': {
        if (!isHost || s.phase !== 'lobby') return 'Only the host can remove players in the lobby';
        if (msg.pid === pid) return "You can't remove yourself";
        s.players = s.players.filter((p) => p.id !== msg.pid).map((p, i) => ({ ...p, seat: i }));
        for (const [tok, p] of Object.entries(rec.tokens)) if (p === msg.pid) delete rec.tokens[tok];
        return null;
      }
      case 'start': {
        if (!isHost) return 'Only the host can start';
        if (s.phase !== 'lobby') return 'Already started';
        return this.start(s, now);
      }
      case 'backToLobby': {
        if (!isHost) return 'Only the host can do that';
        // Humans who left mid-event come back as themselves; only real bots are dropped.
        s.players = s.players.filter((p) => !p.isBot || p.away).map((p, i) => ({ ...p, isBot: false, away: undefined, seat: i }));
        s.phase = 'lobby';
        s.draft = null;
        s.auction = null;
        s.pools = {};
        s.decks = {};
        s.matches = [];
        delete s.prints;
        return null;
      }
      case 'pick': {
        if (!me || s.phase !== 'drafting') return 'Not drafting';
        if (me.away) return 'A bot is playing your seat — take it back first';
        const err = draftPick(s, me.seat, msg.cardId, now);
        if (!err) this.afterPools(s);
        return err;
      }
      case 'leaveSeat': {
        if (!me) return 'You are not seated';
        return leaveSeat(s, pid);
      }
      case 'takeSeat': {
        if (me) return reclaimSeat(s, pid, now);
        const target = s.players.find((p) => p.id === msg.pid);
        if (!rec.spectators[pid] || !target?.away) return 'That seat is not available';
        // The spectator's connection now speaks for the away player.
        for (const [tok, owner] of Object.entries(rec.tokens)) if (owner === pid) rec.tokens[tok] = target.id;
        delete rec.spectators[pid];
        return reclaimSeat(s, target.id, now);
      }
      case 'draftMain': {
        if (!me || s.phase !== 'drafting') return 'Not drafting';
        return setDraftMain(s, me.seat, msg.main);
      }
      case 'nominate': {
        if (!me || s.phase !== 'auction') return 'No auction';
        if (me.away) return 'A bot is playing your seat — take it back first';
        return nominate(s, pid, msg.cardId, now, msg.amount == null ? undefined : Math.floor(Number(msg.amount)));
      }
      case 'skipLot': {
        if (!me || s.phase !== 'auction') return 'No auction';
        if (me.away) return 'A bot is playing your seat — take it back first';
        return skipCard(s, pid, msg.cardId, now);
      }
      case 'passLot': {
        if (!me || s.phase !== 'auction') return 'No auction';
        if (me.away) return 'A bot is playing your seat — take it back first';
        return passLot(s, pid, now);
      }
      case 'bid': {
        if (!me || s.phase !== 'auction') return 'No auction';
        if (me.away) return 'A bot is playing your seat — take it back first';
        return placeBid(s, pid, Math.floor(Number(msg.amount)), now);
      }
      case 'saveDeck': {
        if (!me || !s.pools[pid]) return 'You have no pool';
        const pool = s.pools[pid];
        const main = (msg.deck.main ?? []).filter((x) => typeof x === 'string');
        // main must be a sub-multiset of the pool
        const leftover = multisetDiff(pool, main);
        if (leftover.length !== pool.length - main.length) return 'Deck contains cards not in your pool';
        const basics = { ...emptyDeck().basics };
        for (const c of Object.keys(basics) as Color[]) basics[c] = Math.max(0, Math.min(60, Math.floor(Number(msg.deck.basics?.[c] ?? 0))));
        s.decks[pid] = { main, side: leftover, basics, ready: !!msg.ready };
        return null;
      }
      case 'submitDeck': {
        if (!me) return 'Only players can submit decks';
        if (s.settings.mode !== 'constructed' || s.phase !== 'deckbuilding') return 'Deck lists are for constructed events';
        const r = this.importDeck(s, String(msg.text ?? ''));
        if ('error' in r) return r.error;
        s.pools[pid] = [...r.deck.main, ...r.deck.side];
        s.decks[pid] = r.deck;
        s.prints = { ...(s.prints ?? {}), ...r.prints };
        return null;
      }
      case 'createMatch': {
        const [a, b] = msg.players;
        if (a === b) return 'Pick two different players';
        if (pid !== a && pid !== b && !isHost) return 'You can only start your own matches';
        for (const p of [a, b]) {
          const pl = s.players.find((x) => x.id === p);
          if (!pl) return 'Unknown player';
          if (pl.isBot) return 'Bots can draft but not play — pick a human opponent';
          if (!s.decks[p] || deckSize(s.decks[p]) < 1) return `${pl.name} hasn't built a deck yet`;
        }
        if (s.matches.some((m) => !m.winner && (m.players.includes(a) || m.players.includes(b)))) return 'One of those players is already in a match';
        if (s.settings.mode === 'constructed') {
          for (const p of [a, b]) {
            const errs = this.constructedErrors(s, s.decks[p]);
            if (errs.length) return `${s.players.find((x) => x.id === p)?.name}'s deck is not legal: ${errs.slice(0, 3).join(' ')}`;
          }
        }
        const match: Match = {
          id: id(8), players: [a, b], wins: { [a]: 0, [b]: 0 }, bestOf: [1, 3, 5].includes(msg.bestOf) ? msg.bestOf : 3,
          game: null, gameNumber: 0, sideboarding: false, readyForNext: [], winner: null,
          decks: { [a]: deckCards(s.decks[a]), [b]: deckCards(s.decks[b]) },
        };
        s.matches.push(match);
        this.startGame(s, match, rng() < 0.5 ? a : b, now);
        return null;
      }
      case 'game': {
        const match = s.matches.find((m) => m.id === msg.matchId);
        if (!match?.game) return 'No game';
        if (!match.players.includes(pid)) return 'You are watching this match';
        const err = applyAction(match.game, pid, msg.action, { rng, lookup: getCard, now });
        if (err) return err;
        if (match.game.phase === 'over' && !match.sideboarding && !match.winner) this.gameOver(match);
        return null;
      }
      case 'sideboard': {
        const match = s.matches.find((m) => m.id === msg.matchId);
        if (!match || !match.players.includes(pid) || !match.sideboarding) return 'Not sideboarding';
        const cur = match.decks[pid];
        const all = [...cur.main, ...cur.side];
        const side = multisetDiff(all, msg.main);
        if (side.length !== all.length - msg.main.length) return 'Invalid deck';
        match.decks[pid] = { main: msg.main.slice(), side };
        return null;
      }
      case 'readyNext': {
        const match = s.matches.find((m) => m.id === msg.matchId);
        if (!match || !match.players.includes(pid) || !match.sideboarding) return 'Not between games';
        if (!match.readyForNext.includes(pid)) match.readyForNext.push(pid);
        if (match.players.every((p) => match.readyForNext.includes(p))) {
          const lastWinner = match.game?.winner;
          const loser = match.players.find((p) => p !== lastWinner) ?? match.players[0];
          this.startGame(s, match, loser, now);
        }
        return null;
      }
    }
    return 'Unknown message';
  }

  private start(s: RoomState, now: number): string | null {
    const humans = s.players.filter((p) => !p.isBot);
    const seats = Math.max(s.settings.seats, humans.length);
    const players: Player[] = humans.map((p) => ({ ...p }));
    if (s.settings.fillWithBots) {
      let b = 0;
      while (players.length < seats) players.push({ id: `bot_${id(6)}`, name: BOT_NAMES[b++ % BOT_NAMES.length], seat: 0, isBot: true, connected: true });
    }
    if (s.settings.mode === 'constructed') {
      if (!carddbAvailable()) return 'Constructed needs the card database, which this server does not have';
      s.players = humans.map((p, i) => ({ ...p, seat: i }));
      s.pools = {};
      s.decks = {};
      s.phase = 'deckbuilding';
      return null;
    }
    if (players.length < 2 && s.settings.mode !== 'sealed') return 'Need at least 2 seats (turn on bots or invite friends)';
    if (s.settings.source === 'set' && s.settings.mode !== 'auction') {
      const err = this.checkSets(s.settings.setCodes);
      if (err) return err;
    }
    // Random seating, like a real draft table.
    const order = players.map((p) => ({ p, r: rng() })).sort((x, y) => x.r - y.r).map((x, i) => ({ ...x.p, seat: i }));
    s.players = order;
    const list = cubeList(s, CUBE.list);
    const n = order.length;
    try {
      if (s.settings.source === 'set' && s.settings.mode === 'draft') {
        const prints: Record<string, string> = {};
        const rounds = s.settings.setCodes.map((code) => order.map(() => {
          const b = setBooster(code, rng);
          for (const [k, v] of Object.entries(b.prints)) prints[k] ??= v;
          return b.ids;
        }));
        s.prints = prints;
        s.settings = { ...s.settings, packs: rounds.length, packSize: Math.max(...rounds[0].map((p) => p.length)) };
        startDraftWithPacks(s, rounds, now);
      } else if (s.settings.source === 'set' && s.settings.mode === 'sealed') {
        const prints: Record<string, string> = {};
        const codes = s.settings.setCodes;
        const pools = order.map(() => Array.from({ length: s.settings.sealedPacks }, (_, i) => {
          const b = setBooster(codes[i % codes.length], rng);
          for (const [k, v] of Object.entries(b.prints)) prints[k] ??= v;
          return b.ids;
        }).flat());
        s.prints = prints;
        startSealedWithPools(s, pools);
      } else if (s.settings.mode === 'draft') {
        if (n * s.settings.packs * s.settings.packSize > list.length) return `Not enough cards: ${n} × ${s.settings.packs} × ${s.settings.packSize} > ${list.length}`;
        startDraft(s, list, rng, getCard, now);
      } else if (s.settings.mode === 'sealed') {
        if (n * s.settings.sealedPacks * s.settings.sealedPackSize > list.length) return 'Not enough cards in the cube for that many sealed pools';
        startSealed(s, list, rng, getCard);
      } else {
        startAuction(s, list, rng, getCard, now);
      }
    } catch (e) {
      return (e as Error).message;
    }
    this.afterPools(s);
    return null;
  }

  /** When drafting ends, bots build decks. */
  afterPools(s: RoomState) {
    if (s.phase === 'deckbuilding' && s.players.some((p) => p.isBot && !s.decks[p.id]?.ready)) finishPoolsWithBots(s, getCard);
  }

  private checkSets(codes: string[]): string | null {
    if (!carddbAvailable()) return 'Set events need the card database, which this server does not have';
    if (!codes.length) return 'Choose a set';
    for (const c of codes) { const e = checkBoosterSet(c); if (e) return e; }
    return null;
  }

  /** Resolve + validate a pasted deck list for the room's constructed format. */
  importDeck(s: RoomState, text: string): { error: string } | { deck: Deck; prints: Record<string, string> } {
    if (!carddbAvailable()) return { error: 'Card database not available' };
    const r = resolveDeck(text);
    if (r.errors.length) return { error: r.errors.slice(0, 5).join('\n') };
    if (!r.entries.length) return { error: 'The deck list is empty' };
    const deck: Deck = { ...emptyDeck(), ready: true };
    const prints: Record<string, string> = {};
    const basicColor: Record<string, Color> = { plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G' };
    for (const e of r.entries) {
      if (e.set && e.num && !isCubeCard(e.id)) prints[e.id] ??= `${e.set}:${e.num}`;
      const basic = basicColor[e.id];
      if (basic && e.section !== 'side') { deck.basics[basic] += e.count; continue; }
      const target = e.section === 'side' ? deck.side : deck.main;
      for (let i = 0; i < e.count; i++) target.push(e.id);
    }
    ensureCards([...deck.main, ...deck.side]);
    const errs = this.constructedErrors(s, deck);
    if (errs.length) return { error: errs.slice(0, 6).join('\n') };
    return { deck, prints };
  }

  constructedErrors(s: RoomState, deck: Deck | undefined): string[] {
    if (!deck) return ['No deck'];
    const format = s.settings.format;
    const total = deckSize(deck);
    if (format === 'Freeform') return total < 1 ? ['The deck is empty'] : [];
    const names: Record<Color, string> = { W: 'plains', U: 'island', B: 'swamp', R: 'mountain', G: 'forest' };
    const entries = [
      ...countIds(deck.main).map(([id, count]) => ({ id: id.replace(/^basic_/, ''), count, section: 'main' as const })),
      ...countIds(deck.side).map(([id, count]) => ({ id, count, section: 'side' as const })),
      ...(Object.entries(deck.basics) as [Color, number][]).filter(([, n]) => n > 0).map(([c, count]) => ({ id: names[c], count, section: 'main' as const })),
    ];
    return formatLegality(entries, format);
  }

  /** Card data the socket hasn't been sent yet for this view (see roomcards.ts). */
  cardsFor(rec: RoomRecord, view: RoomView, sent: Set<string>): CardPayload | null {
    if (!carddbAvailable()) return null;
    return cardPayload(view, rec.state.prints, sent);
  }

  private startGame(s: RoomState, match: Match, starting: string, now: number) {
    ensureCards([...match.decks[match.players[0]].main, ...match.decks[match.players[0]].side, ...match.decks[match.players[1]].main, ...match.decks[match.players[1]].side]);
    match.gameNumber++;
    match.sideboarding = false;
    match.readyForNext = [];
    const seat = (pid: string) => ({
      pid, name: s.players.find((p) => p.id === pid)?.name ?? '?', deck: match.decks[pid].main, side: match.decks[pid].side,
    });
    match.game = createGame(`${match.id}-${match.gameNumber}`, [seat(match.players[0]), seat(match.players[1])], starting, { rng, lookup: getCard, now }, { strict: true }); // rules-enforced (Arena-style)
  }

  private gameOver(match: Match) {
    const g = match.game!;
    if (g.winner) match.wins[g.winner] = (match.wins[g.winner] ?? 0) + 1;
    const need = Math.ceil(match.bestOf / 2);
    const champ = match.players.find((p) => match.wins[p] >= need);
    if (champ) match.winner = champ;
    else match.sideboarding = true;
  }

  /** Timers & bots. Returns ids of rooms that changed. */
  tick(now: number): string[] {
    const changed: string[] = [];
    for (const [rid, rec] of this.rooms) {
      const s = rec.state;
      let did = false;
      if (s.phase === 'drafting') did = draftTick(s, now, getCard, rng);
      else if (s.phase === 'auction') did = auctionTick(s, now, getCard, rng);
      if (did) {
        this.afterPools(s);
        this.touch(s);
        changed.push(rid);
      }
    }
    return changed;
  }

  view(rec: RoomRecord, pid: string): RoomView {
    const s = rec.state;
    const me = s.players.find((p) => p.id === pid);
    let draft: DraftView | null = null;
    if (s.draft && me) {
      const d = s.draft;
      draft = {
        round: d.round, rounds: s.settings.packs, pack: d.queues[me.seat][0] ?? null, queued: Math.max(0, d.queues[me.seat].length - 1),
        picks: d.picks[me.seat], main: d.main?.[me.seat] ?? [], pickNumber: d.pickNumber[me.seat], deadline: d.deadlines[me.seat],
        waiting: d.queues.map((q) => q.length), direction: passDirection(d.round),
      };
    }
    const matches: MatchView[] = s.matches.map((m) => {
      const playing = m.players.includes(pid);
      return {
        ...m,
        game: m.game ? viewFor(m.game, playing ? pid : null) : null,
        decks: playing ? { [pid]: m.decks[pid] } : null,
      };
    });
    const spectators = Object.entries(rec.spectators).map(([sid, name]) => ({ id: sid, name }));
    return {
      id: s.id, name: s.name, hostId: s.hostId, me: pid, settings: s.settings,
      players: seatedPlayers(s),
      phase: s.phase, draft, auction: s.auction,
      pool: s.pools[pid] ?? [], deck: s.decks[pid] ?? null,
      decksReady: Object.fromEntries(Object.entries(s.decks).map(([k, d]) => [k, d.ready])),
      matches, chat: s.chat, serverNow: Date.now(), cubeSize: cubeList(s, CUBE.list).length, carddb: carddbAvailable(),
      ...(spectators.length ? { spectators } : {}),
    } as RoomView;
  }
}

function cleanName(n: unknown): string {
  return String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Player';
}

function countIds(ids: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const id of ids) m.set(id, (m.get(id) ?? 0) + 1);
  return [...m];
}

function deckSize(d: Deck) {
  return d.main.length + Object.values(d.basics).reduce((a, b) => a + b, 0);
}

function deckCards(d: Deck): { main: string[]; side: string[] } {
  const basics: string[] = [];
  const names: Record<Color, string> = { W: 'plains', U: 'island', B: 'swamp', R: 'mountain', G: 'forest' };
  for (const [c, n] of Object.entries(d.basics) as [Color, number][]) for (let i = 0; i < n; i++) basics.push(`basic_${names[c]}`);
  // Basics are also available to side in, like a real land station.
  const station = (Object.values(names)).flatMap((n) => Array(5).fill(`basic_${n}`));
  return { main: [...d.main, ...basics], side: [...d.side, ...station] };
}

function clamp(v: unknown, lo: number, hi: number, dflt: number) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

/** Valid ids of an imported list: cube cards, plus any database card when the DB is built. */
function cleanList(list: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const db = carddbAvailable();
  return list.filter((c): c is string => typeof c === 'string' && (isCubeCard(c) || (db && !!getCardById(c)))).slice(0, 2000);
}

/** `keepList`: an already-validated custom list to keep as is (skips re-checking every id). */
export function sanitizeSettings(x: RoomSettings, humans: number, keepList?: string[]): RoomSettings {
  const d = DEFAULT_SETTINGS;
  const codes = Array.isArray(x.setCodes) ? x.setCodes.filter((c) => typeof c === 'string' && /^[A-Za-z0-9]{2,6}$/.test(c)).map((c) => c.toUpperCase()).slice(0, 12) : [];
  const customList = keepList ?? cleanList(x.customList);
  return {
    mode: (['draft', 'auction', 'sealed', 'constructed'] as const).includes(x.mode) ? x.mode : d.mode,
    source: x.source === 'set' ? 'set' : 'cube',
    setCodes: codes,
    format: (CONSTRUCTED_FORMATS as readonly string[]).includes(x.format) ? x.format : d.format,
    bestOf: [1, 3, 5].includes(Number(x.bestOf)) ? Number(x.bestOf) : d.bestOf,
    seats: clamp(x.seats, Math.max(1, humans), 8, d.seats),
    fillWithBots: !!x.fillWithBots,
    packs: clamp(x.packs, 1, 5, d.packs),
    packSize: clamp(x.packSize, 5, 20, d.packSize),
    pickTimer: clamp(x.pickTimer, 0, 600, d.pickTimer),
    sealedPacks: clamp(x.sealedPacks, 1, 12, d.sealedPacks),
    sealedPackSize: clamp(x.sealedPackSize, 5, 20, d.sealedPackSize),
    auctionBudget: clamp(x.auctionBudget, 10, 10000, d.auctionBudget),
    auctionMinBid: clamp(x.auctionMinBid, 1, 100, d.auctionMinBid),
    auctionPacksPerPlayer: clamp(x.auctionPacksPerPlayer, 1, 8, d.auctionPacksPerPlayer),
    auctionTimer: clamp(x.auctionTimer, 0, 120, d.auctionTimer),
    nominateTimer: clamp(x.nominateTimer, 0, 300, d.nominateTimer),
    auctionPackSize: clamp(x.auctionPackSize, 3, 30, d.auctionPackSize),
    auctionPoolSize: clamp(x.auctionPoolSize, 0, 90, d.auctionPoolSize),
    colorBalance: !!x.colorBalance,
    customList,
    ...(customList?.length && x.customListName ? { customListName: String(x.customListName).slice(0, 80) } : {}),
  };
}
