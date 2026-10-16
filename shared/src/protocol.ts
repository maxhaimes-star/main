import type { Deck, Match, Player, RoomSettings, RoomState } from './room.ts';
import type { GameAction, GameView } from './game/types.ts';
import type { AuctionState, DraftState } from './room.ts';
import type { CardData, TokenData } from './cards.ts';
import type { ForgeFace } from './engine/types.ts';

/**
 * Server -> client 'cards' event, sent before a 'room' view that references cards the client hasn't
 * got (anything outside the built-in cube). The client registers them (registerCards/registerScripts).
 */
export interface CardPayload {
  cards: Record<string, CardData>;
  scripts: Record<string, ForgeFace[]>;
  tokens?: Record<string, TokenData>;
}

/** What a client sends. */
export type ClientMsg =
  | { t: 'updateSettings'; settings: Partial<RoomSettings> }
  | { t: 'rename'; name: string }
  | { t: 'start' }
  | { t: 'pick'; cardId: string }
  /** During the draft: which of my picks are in the main deck (a sub-multiset of my picks; the rest is sideboard). */
  | { t: 'draftMain'; main: string[] }
  | { t: 'nominate'; cardId: string; amount?: number }
  | { t: 'skipLot'; cardId: string }
  | { t: 'passLot' }
  | { t: 'bid'; amount: number }
  | { t: 'saveDeck'; deck: Omit<Deck, 'ready'>; ready: boolean }
  /** Constructed: submit a pasted deck list (validated against the room's format). */
  | { t: 'submitDeck'; text: string }
  | { t: 'createMatch'; players: [string, string]; bestOf: number }
  | { t: 'game'; matchId: string; action: GameAction }
  | { t: 'sideboard'; matchId: string; main: string[]; side: string[] }
  | { t: 'readyNext'; matchId: string }
  /** Leave mid-draft/auction: a bot takes over the seat until the player takes it back. */
  | { t: 'leaveSeat' }
  /** Take a seat back from the bot that is playing it. A spectator names the away player's seat (`pid`). */
  | { t: 'takeSeat'; pid?: string }
  | { t: 'kick'; pid: string }
  | { t: 'chat'; text: string }
  | { t: 'backToLobby' };

/** Draft state as a single seat sees it. */
export interface DraftView {
  round: number;
  rounds: number;
  pack: string[] | null;
  queued: number;
  picks: string[];
  /** The picks currently in the main deck (a sub-multiset of `picks`). */
  main: string[];
  pickNumber: number;
  deadline: number | null;
  /** Number of packs waiting per seat (for the "waiting on" display). */
  waiting: number[];
  direction: 1 | -1;
}

export interface MatchView extends Omit<Match, 'game' | 'decks'> {
  game: GameView | null;
  decks: Match['decks'] | null;
}

export interface RoomView {
  id: string;
  name: string;
  hostId: string;
  me: string;
  settings: RoomSettings;
  players: Player[];
  phase: RoomState['phase'];
  draft: DraftView | null;
  auction: AuctionState | null;
  pool: string[];
  deck: Deck | null;
  decksReady: Record<string, boolean>;
  matches: MatchView[];
  chat: RoomState['chat'];
  serverNow: number;
  cubeSize: number;
  /** The server has the full card database (set events, imported cubes, constructed). */
  carddb?: boolean;
}

export type { DraftState };
