import type { Color } from './cards.ts';
import type { GameState } from './game/types.ts';

export type Mode = 'draft' | 'auction' | 'sealed';
export type RoomPhase = 'lobby' | 'drafting' | 'auction' | 'deckbuilding';

export interface RoomSettings {
  mode: Mode;
  /** Total seats at the table (humans + bots). */
  seats: number;
  fillWithBots: boolean;
  // Booster draft
  packs: number;
  packSize: number;
  /** Seconds for a full pack; 0 = no timer. Shrinks as the pack gets smaller. */
  pickTimer: number;
  // Sealed
  sealedPacks: number;
  sealedPackSize: number;
  // Auction
  auctionBudget: number;
  /** Seconds a lot stays open after the latest bid. */
  auctionTimer: number;
  /** Seconds the nominator has to choose which card goes up next. */
  nominateTimer: number;
  auctionPackSize: number;
  /** Cards each player should end with; also the hard cap per pool. */
  auctionPoolSize: number;
  // Shared
  colorBalance: boolean;
  /** Optional custom card list (card ids); defaults to the full cube list. */
  customList?: string[];
}

export const DEFAULT_SETTINGS: RoomSettings = {
  mode: 'draft',
  seats: 4,
  fillWithBots: true,
  packs: 3,
  packSize: 15,
  pickTimer: 75,
  sealedPacks: 6,
  sealedPackSize: 15,
  auctionBudget: 100,
  auctionTimer: 10,
  nominateTimer: 20,
  auctionPackSize: 15,
  auctionPoolSize: 45,
  colorBalance: true,
};

export interface Player {
  id: string;
  name: string;
  seat: number;
  isBot: boolean;
  connected: boolean;
}

export interface Deck {
  /** Card ids (cube cards). */
  main: string[];
  side: string[];
  basics: Record<Color, number>;
  ready: boolean;
}

// ----------------------------------------------------------- booster draft

export interface DraftState {
  round: number; // 0-based
  /** Per seat: queue of packs waiting to be picked from (front = current). */
  queues: string[][][];
  /** Deadline (ms epoch) for each seat's current pick, or null. */
  deadlines: (number | null)[];
  /** Picks per seat in order. */
  picks: string[][];
  /** Packs not yet opened, per round per seat. */
  unopened: string[][][];
  pickNumber: number[];
  done: boolean;
}

// ----------------------------------------------------------- auction

export interface Bid { pid: string; amount: number; at: number }

export interface AuctionState {
  /** Unopened packs. */
  packs: string[][];
  packNumber: number;
  totalPacks: number;
  /** Cards remaining in the currently open pack. */
  open: string[];
  /** Seat index of the player choosing the next card. */
  nominatorSeat: number;
  nominateDeadline: number | null;
  lot: null | {
    cardId: string;
    bids: Bid[];
    deadline: number;
    nominatedBy: string;
  };
  budgets: Record<string, number>;
  pools: Record<string, string[]>;
  /** Recent results for the feed. */
  results: { cardId: string; pid: string | null; amount: number }[];
  done: boolean;
}

// ----------------------------------------------------------- matches

export interface Match {
  id: string;
  players: [string, string];
  /** Game wins per player id. */
  wins: Record<string, number>;
  bestOf: number;
  game: GameState | null;
  gameNumber: number;
  /** Between games: players adjusting sideboards. */
  sideboarding: boolean;
  readyForNext: string[];
  /** Per-match deck copies (sideboarding edits these). */
  decks: Record<string, { main: string[]; side: string[] }>;
  winner: string | null;
}

export interface ChatMessage { pid: string; name: string; text: string; at: number }

export interface RoomState {
  id: string;
  name: string;
  hostId: string;
  settings: RoomSettings;
  players: Player[];
  phase: RoomPhase;
  draft: DraftState | null;
  auction: AuctionState | null;
  pools: Record<string, string[]>;
  decks: Record<string, Deck>;
  matches: Match[];
  chat: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}
