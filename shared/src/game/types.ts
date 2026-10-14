import type { TokenData } from '../cards.ts';
import type { AutoCont, AutoInfo, Pending, TargetRef } from '../engine/types.ts';

export const STEPS = [
  'untap', 'upkeep', 'draw', 'main1',
  'beginCombat', 'attackers', 'blockers', 'damage', 'endCombat',
  'main2', 'end', 'cleanup',
] as const;
export type Step = (typeof STEPS)[number];

export const STEP_LABELS: Record<Step, string> = {
  untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw', main1: 'Main 1',
  beginCombat: 'Begin Combat', attackers: 'Attackers', blockers: 'Blockers', damage: 'Damage', endCombat: 'End Combat',
  main2: 'Main 2', end: 'End', cleanup: 'Cleanup',
};

export type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'stack' | 'command' | 'sideboard';
export const PLAYER_ZONES = ['library', 'hand', 'graveyard', 'exile', 'command', 'sideboard'] as const;
export type PlayerZone = (typeof PLAYER_ZONES)[number];

export interface CardInstance {
  /** Instance id; library cards are re-keyed on every shuffle so they can't be tracked. */
  iid: string;
  /** Cube card id, or undefined for tokens. */
  cardId?: string;
  token?: TokenData;
  owner: string;
  controller: string;
  zone: Zone;
  tapped: boolean;
  faceDown: boolean;
  /** Showing back face (transformed / MDFC back / flipped). */
  transformed: boolean;
  counters: Record<string, number>;
  /** Damage marked this turn. */
  damage: number;
  /** "Until end of turn" P/T change. */
  tempPT: [number, number];
  /** Permanent manual P/T change (anthems etc.). */
  permPT: [number, number];
  summoningSick: boolean;
  /** Doesn't untap during untap step. */
  noUntap: boolean;
  attachedTo?: string;
  note?: string;
  /** Players allowed to see this card while it's in a hidden zone. */
  revealedTo: string[];
  /** Card was cast as its adventure / second half. */
  castAs?: string;
  /** Combat. */
  attacking?: string; // defending player id or planeswalker iid
  blocking?: string; // attacker iid
  /** Copy of another card (Clone effects). */
  copyOf?: string;
  /** Keywords granted until end of turn (Pump KW$ etc.). Cleared at cleanup. */
  tempKeywords?: string[];
}

export interface StackItem {
  id: string;
  kind: 'spell' | 'ability' | 'trigger';
  /** Card on the stack (for spells). */
  iid?: string;
  /** Source permanent (for abilities). */
  sourceIid?: string;
  controller: string;
  text: string;
  /** Mana value of X etc. */
  x?: number;
  /** Present when the engine resolves this automatically. */
  auto?: AutoInfo;
}

export interface GamePlayer {
  pid: string;
  name: string;
  life: number;
  counters: Record<string, number>; // poison, energy, ...
  zones: Record<PlayerZone, string[]>;
  manaPool: Record<string, number>;
  mulligans: number;
  /** Mulligan phase: kept hand; waiting for bottom choice if mulligans > 0. */
  kept: boolean;
  needsBottom: number;
  landsPlayed: number;
  /** Steps on which this player wants priority (MTGO-style stops). */
  stops: { own: Step[]; opp: Step[] };
  /** Skip all stops until end of turn (F6). */
  passUntilEOT: boolean;
  /** Private window: top N of library or full library search. */
  peek: null | { mode: 'scry' | 'surveil' | 'look' | 'search'; iids: string[]; label?: string; then?: AutoCont };
  /** Temporary view of an opponent's hand. */
  viewingHandOf: string | null;
  conceded: boolean;
  /** City's blessing, monarch, initiative... */
  designations: string[];
}

export interface LogEntry { at: number; pid: string | null; text: string }

export interface CombatProposal {
  lifeChange: Record<string, number>;
  /** Damage to each creature/planeswalker by iid. */
  damage: Record<string, number>;
  /** Creatures / planeswalkers expected to die. */
  dies: string[];
  lines: string[];
  confirmed: string[];
}

export interface GameState {
  id: string;
  players: GamePlayer[];
  cards: Record<string, CardInstance>;
  battlefield: string[];
  stack: StackItem[];
  turn: number;
  activePlayer: string;
  startingPlayer: string;
  step: Step;
  priority: string;
  /** Players who passed priority in succession with the current stack. */
  passed: string[];
  phase: 'mulligan' | 'playing' | 'over';
  winner: string | null;
  combat: { proposal: CombatProposal | null; attackersDeclared: boolean; blockersDeclared: boolean };
  log: LogEntry[];
  /** Undo history (previous states, without logs). */
  history: string[];
  undoRequest: string | null;
  /** Questions the engine is waiting on (answered with the 'choose' action). */
  pending: Pending[];
  seq: number;
}

/** Actions a player can send. All are validated in the reducer. */
export type GameAction =
  | { t: 'mulligan' }
  | { t: 'keep' }
  | { t: 'bottom'; iids: string[] }
  | { t: 'pass' }
  | { t: 'passUntilEOT' }
  | { t: 'setStops'; own: Step[]; opp: Step[] }
  | { t: 'gotoStep'; step: Step }
  | { t: 'nextTurn' }
  | { t: 'draw'; n: number }
  | { t: 'shuffle' }
  | { t: 'mill'; n: number }
  | { t: 'peek'; mode: 'scry' | 'surveil' | 'look' | 'search'; n?: number }
  | { t: 'resolvePeek'; top: string[]; bottom: string[]; graveyard: string[]; hand: string[]; battlefield: string[]; exile: string[]; shuffle: boolean }
  | { t: 'revealTop'; n: number }
  | { t: 'move'; iid: string; to: Zone; toOwner?: boolean; position?: 'top' | 'bottom' | number; faceDown?: boolean; tapped?: boolean }
  | { t: 'playLand'; iid: string }
  /** targets: one list per TargetSpec of the spell. manual: skip the engine (resolve by hand). */
  | { t: 'cast'; iid: string; face?: number; x?: number; faceDown?: boolean; targets?: TargetRef[][]; manual?: boolean; modes?: string[] }
  /** Manual: text (+ loyalty). Automatic: ability = index of the A: line on the card's current face, plus targets. */
  | { t: 'activate'; iid: string; text: string; loyalty?: number; ability?: number; targets?: TargetRef[][]; x?: number }
  | { t: 'choose'; id: string; value: string }
  | { t: 'trigger'; text: string; sourceIid?: string }
  | { t: 'resolve' }
  | { t: 'counterTop' }
  | { t: 'removeStackItem'; id: string }
  | { t: 'tap'; iid: string; tapped?: boolean }
  | { t: 'tapForMana'; iid: string; mana: string }
  | { t: 'addMana'; mana: string; n: number }
  | { t: 'clearMana' }
  | { t: 'untapAll' }
  | { t: 'counter'; iid: string; kind: string; delta: number }
  | { t: 'playerCounter'; pid: string; kind: string; delta: number }
  | { t: 'life'; pid: string; delta: number }
  | { t: 'pt'; iid: string; dp: number; dt: number; permanent?: boolean }
  | { t: 'damage'; iid: string; delta: number }
  | { t: 'transform'; iid: string }
  | { t: 'faceDown'; iid: string; faceDown: boolean }
  | { t: 'attach'; iid: string; to: string | null }
  | { t: 'control'; iid: string; pid: string }
  | { t: 'createToken'; token: import('../cards.ts').TokenData; n: number; tapped?: boolean; pid?: string }
  | { t: 'copyCard'; iid: string }
  | { t: 'note'; iid: string; note: string }
  | { t: 'noUntap'; iid: string; value: boolean }
  | { t: 'reveal'; iid: string }
  | { t: 'revealHand' }
  | { t: 'lookAtHand'; pid: string | null }
  | { t: 'designation'; name: string; on: boolean }
  | { t: 'declareAttacker'; iid: string; target: string | null }
  | { t: 'declareBlocker'; iid: string; attacker: string | null }
  | { t: 'confirmAttackers' }
  | { t: 'confirmBlockers' }
  | { t: 'proposeDamage' }
  | { t: 'confirmDamage' }
  | { t: 'clearCombat' }
  | { t: 'requestUndo' }
  | { t: 'answerUndo'; accept: boolean }
  | { t: 'concede' }
  | { t: 'chat'; text: string };

// ------------------------------------------------------------ client view

export interface HiddenCard { iid: string; hidden: true; owner: string; controller: string; zone: Zone; tapped: boolean; counters: Record<string, number>; faceDown: boolean; attachedTo?: string; attacking?: string; blocking?: string }
export type ViewCard = CardInstance | HiddenCard;

export interface ViewPlayer extends Omit<GamePlayer, 'zones' | 'peek'> {
  zones: Record<PlayerZone, string[]>;
  libraryCount: number;
  handCount: number;
  peek: GamePlayer['peek'];
}

export interface GameView extends Omit<GameState, 'players' | 'cards' | 'history'> {
  players: ViewPlayer[];
  cards: Record<string, ViewCard>;
  canUndo: boolean;
  /** Viewer's player id, or null for spectators. */
  me: string | null;
}

export function isHidden(c: ViewCard | undefined): c is HiddenCard {
  return !!c && (c as HiddenCard).hidden === true;
}
