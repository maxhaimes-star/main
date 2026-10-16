import type { Color } from './cards.ts';
import type { GameState } from './game/types.ts';

export type Mode = 'draft' | 'auction' | 'sealed' | 'constructed';
/** Where draft/sealed packs come from: the cube list (OJ cube or an imported list) or real set boosters. */
export type PackSource = 'cube' | 'set';
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
  /** Smallest allowed bid (also the smallest opening bid). */
  auctionMinBid: number;
  /** Packs per player; total packs = players x this. */
  auctionPacksPerPlayer: number;
  /** Seconds a lot stays open after the latest bid (backstop; 0 = no timer). */
  auctionTimer: number;
  /** Seconds the nominator has to choose which card goes up next. */
  nominateTimer: number;
  auctionPackSize: number;
  /** Hard cap on cards per pool; 0 = no cap. */
  auctionPoolSize: number;
  // Shared
  colorBalance: boolean;
  /** Optional custom card list (card ids); defaults to the full cube list. */
  customList?: string[];
  /** Name of the imported cube list (display only). */
  customListName?: string;
  // Card database sources
  /** Draft/sealed packs from the cube list or from set boosters. */
  source: PackSource;
  /** Set codes for set boosters: draft = one per round (pack 1, 2, 3…); sealed = cycled over the packs. */
  setCodes: string[];
  /** Constructed format name (Standard, Pioneer, Modern, Legacy, Vintage, Pauper, Freeform). */
  format: string;
  /** Default match length. */
  bestOf: number;
}

export const CONSTRUCTED_FORMATS = ['Standard', 'Pioneer', 'Modern', 'Legacy', 'Vintage', 'Pauper', 'Freeform'] as const;

export const DEFAULT_SETTINGS: RoomSettings = {
  mode: 'draft',
  seats: 4,
  fillWithBots: true,
  packs: 3,
  packSize: 15,
  pickTimer: 75,
  sealedPacks: 6,
  sealedPackSize: 15,
  auctionBudget: 200,
  auctionMinBid: 2,
  auctionPacksPerPlayer: 2,
  auctionTimer: 20,
  nominateTimer: 30,
  auctionPackSize: 30,
  auctionPoolSize: 0,
  colorBalance: true,
  source: 'cube',
  setCodes: [],
  format: 'Standard',
  bestOf: 3,
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
  /** Per seat: the picks the player has moved into their main deck (the rest are sideboard). Carried into deckbuilding. */
  main?: string[][];
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
    /** Backstop deadline, or null when the bid timer is off. */
    deadline: number | null;
    nominatedBy: string;
    /** Players who passed since the last bid. */
    passes: string[];
  };
  budgets: Record<string, number>;
  pools: Record<string, string[]>;
  /** Recent results for the feed. */
  /** pid null = unsold (skipped and discarded). */
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
  /** Printing per card id for set events ("DMU:94"), so images show the right art. */
  prints?: Record<string, string>;
  chat: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}
