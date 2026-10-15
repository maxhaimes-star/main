import type { TokenData } from '../cards.ts';
import type { Animation, AutoCont, AutoInfo, CastInfo, Chosen, CopyExtra, DelayedTrigger, Pending, QueuedTrigger, TargetRef, TimedEffect, TurnInfo } from '../engine/types.ts';

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
  /**
   * Copy of another card (Clone effects): the copied card's cube id. faceOf() shows the copied face and the engine
   * uses the copied card's script (engine/script.ts scriptRef). Cleared when it leaves the battlefield.
   */
  copyOf?: string;
  /** Copy of a token that has no card: the copied token's data. */
  copyToken?: TokenData;
  /** Face of the copied card (1 = it copied a transformed permanent). */
  copyFace?: number;
  /** Exceptions of the copy effect ("except it's an artifact", "except it has haste") — copiable values. */
  copyExtra?: CopyExtra;
  /** Animate effects ("becomes a 2/2 creature until end of turn"), engine/animate.ts. faceOf() applies them. */
  animations?: Animation[];
  /** Choices made as it entered the battlefield (ChooseType / ChooseColor / NameCard / ChoosePlayer). */
  chosen?: Chosen;
  /** Keywords granted until end of turn (Pump KW$ etc.). Cleared at cleanup. */
  tempKeywords?: string[];
  /** How it was cast (kicked, evoked, flashback...). Kept while on the stack and when it resolves onto the battlefield. */
  castInfo?: CastInfo;
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
  /** Spells: how it was cast (alternative / additional costs). */
  castInfo?: CastInfo;
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
  /** Stage 2: put this player's triggered abilities on the stack automatically (undefined = true). */
  autoTriggers?: boolean;
  /** Strict mode: tried to draw from an empty library since the last state-based action check. */
  drewFromEmpty?: boolean;
  /** Strict mode: why this player lost the game (state-based action), if they did. */
  lost?: string;
}

export interface LogEntry { at: number; pid: string | null; text: string }

export interface CombatProposal {
  lifeChange: Record<string, number>;
  /** Damage to each creature/planeswalker by iid. */
  damage: Record<string, number>;
  /** Stage 2: each damage assignment (source iid -> player id or permanent iid), for damage triggers. */
  hits?: { source: string; target: string; amount: number }[];
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
  /** Per-turn bookkeeping (Revolt, loyalty / activation limits). */
  turnInfo?: TurnInfo;
  /** Effects with a duration that the engine reverts (until your next turn, until end of turn, until X leaves). */
  effects?: TimedEffect[];
  /** Stage 2, engine-internal (not sent to clients): events of the current action, for trigger detection. */
  events?: GameEvent[];
  /** Stage 2, engine-internal: triggered abilities waiting for a decision before going on the stack. */
  triggerQueue?: QueuedTrigger[];
  /** Stage 2, engine-internal: delayed triggers ("at the beginning of the next end step ..."). */
  delayedTriggers?: DelayedTrigger[];
  /** Stage 2, engine-internal: objects a permanent's abilities remembered (source iid -> iids). */
  remembered?: Record<string, string[]>;
  /** Stage 2, engine-internal: per-turn counters (spells cast / cards drawn per player). */
  turnStats?: { cast: Record<string, number>; drawn: Record<string, number>; fired?: Record<string, number> };
  /** Extra turns (engine/turns.ts): player ids, the LAST one is taken next ("after this one" stacks LIFO). */
  extraTurns?: string[];
  /** Whose regular turn is due once the extra turns are over (set when an extra turn interrupts the rotation). */
  nextNormalTurn?: string | null;
  /**
   * Mindslaver (engine/turns.ts): `by` controls `pid` during pid's next turn. `active` once that turn started
   * (the controller then acts for that player and sees their hand); cleared when the turn ends.
   * `since` = turn number when it was set up (the controlled turn is a later one); `turn` = the controlled turn.
   */
  controlledBy?: { pid: string; by: string; active: boolean; since: number; turn?: number } | null;
  /**
   * Strict rules enforcement (engine/strict.ts), true for new games: illegal actions are rejected (land drops,
   * timing, priority, mana payment with auto-pay, combat legality), state-based actions are performed and the
   * manual table tools are only available in fix mode.
   */
  strict?: boolean;
  /** "Fix board" escape hatch: manual tools (and `force`) are allowed while on. Turned on when the opponent accepts. */
  fixMode?: { on: boolean; requestedBy: string | null };
}

/** Stage 2: something that happened during an action (engine-internal; used to detect triggers). */
export type GameEvent =
  /** from 'none' = a token was created. */
  | { t: 'zone'; iid: string; from: Zone | 'none'; to: Zone; snap: CardInstance; cause?: 'discard' | 'sacrifice' }
  | { t: 'phase'; step: Step; active: string; turn: number }
  | { t: 'attacks'; iid: string; defender: string }
  | { t: 'attackersDeclared'; pid: string }
  | { t: 'blocks'; iid: string; attacker: string }
  | { t: 'cast'; iid: string; pid: string; nth: number }
  | { t: 'drawn'; iid: string; pid: string; nth: number; firstInDrawStep?: boolean }
  | { t: 'damage'; source: string; target: string; amount: number; combat: boolean; sourceSnap?: CardInstance; targetSnap?: CardInstance }
  | { t: 'landPlayed'; iid: string; pid: string };

/**
 * Actions a player can send. All are validated in the reducer.
 * Any action may carry `as: <player id>` — "act on behalf of" that player, accepted only from the player who
 * controls them this turn (Mindslaver, see state.controlledBy); without it the reducer routes obvious cases.
 */
export type GameAction = GameActionBody & { as?: string };
type GameActionBody =
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
  /**
   * targets: one list per TargetSpec of the spell. manual: skip the engine (resolve by hand).
   * costOption: id from castOptions() (default normal). kicked: pay kicker. division: DividedAsYouChoose$ damage, target key (iid / pid) -> amount.
   * force: ignore timing and static restrictions (e.g. "can't be cast", sorcery speed).
   */
  | { t: 'cast'; iid: string; face?: number; x?: number; faceDown?: boolean; targets?: TargetRef[][]; manual?: boolean; modes?: string[]; costOption?: string; kicked?: boolean; force?: boolean; division?: Record<string, number> }
  /** Manual: text (+ loyalty). Automatic: ability = index of the A: line on the card's current face, plus targets. force: ignore timing / limits. */
  | { t: 'activate'; iid: string; text: string; loyalty?: number; ability?: number; targets?: TargetRef[][]; x?: number; force?: boolean; division?: Record<string, number> }
  /** Activate a mana ability: option = id from manaOptionsFor(). */
  | { t: 'activateMana'; iid: string; option: string }
  | { t: 'choose'; id: string; value: string }
  /** Answer a Pending that has `targets`: one list per spec. */
  | { t: 'chooseTargets'; id: string; targets: TargetRef[][] }
  | { t: 'trigger'; text: string; sourceIid?: string }
  /** Stage 2: turn automatic triggered abilities on/off for yourself. */
  | { t: 'setAutoTriggers'; on: boolean }
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
  /** force: ignore static restrictions (defender, Ensnaring Bridge, "can't block" ...). */
  | { t: 'declareAttacker'; iid: string; target: string | null; force?: boolean }
  | { t: 'declareBlocker'; iid: string; attacker: string | null; force?: boolean }
  | { t: 'confirmAttackers' }
  | { t: 'confirmBlockers' }
  | { t: 'proposeDamage' }
  | { t: 'confirmDamage' }
  | { t: 'clearCombat' }
  | { t: 'requestUndo' }
  | { t: 'answerUndo'; accept: boolean }
  | { t: 'concede' }
  /** Strict mode: ask the opponent to allow manual fixes ("Fix board"); answerFixMode accepts / declines; endFixMode ends it. */
  | { t: 'requestFixMode' }
  | { t: 'answerFixMode'; accept: boolean }
  | { t: 'endFixMode' }
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
