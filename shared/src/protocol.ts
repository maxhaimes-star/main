import type { Deck, Match, Player, RoomSettings, RoomState } from './room.ts';
import type { GameAction, GameView } from './game/types.ts';
import type { AuctionState, DraftState } from './room.ts';

/** What a client sends. */
export type ClientMsg =
  | { t: 'updateSettings'; settings: Partial<RoomSettings> }
  | { t: 'rename'; name: string }
  | { t: 'start' }
  | { t: 'pick'; cardId: string }
  | { t: 'nominate'; cardId: string; amount?: number }
  | { t: 'skipLot'; cardId: string }
  | { t: 'passLot' }
  | { t: 'bid'; amount: number }
  | { t: 'saveDeck'; deck: Omit<Deck, 'ready'>; ready: boolean }
  | { t: 'createMatch'; players: [string, string]; bestOf: number }
  | { t: 'game'; matchId: string; action: GameAction }
  | { t: 'sideboard'; matchId: string; main: string[]; side: string[] }
  | { t: 'readyNext'; matchId: string }
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
}

export type { DraftState };
