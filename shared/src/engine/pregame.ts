/**
 * "Before you shuffle your deck to start the game" (K:MayEffectFromOpeningDeck, Arcane Savant).
 *
 * The keyword names a DB$ chain the owner may run before the opening hands are drawn. The engine supports the shape
 * Forge's scripts use: Reveal (RevealDefined$ Self) -> ChangeZone (Origin$ Sideboard, Destination$ Exile, ChangeType$ ...)
 * -> Pump (NoteCards$ Remembered, NoteCardsFor$ <name>) -> Cleanup. Run by createGame (game/reducer.ts):
 *   - every such card in a player's deck asks its owner (a Pending, kind 'pregame') which matching sideboard card to
 *     exile with it, or not to reveal it; no question when the sideboard has no matching card;
 *   - the chosen card is exiled and noted for <name> (GamePlayer.notes, read by the NotedFor<name> card property:
 *     Arcane Savant's "copy a card you exiled with cards named Arcane Savant", engine/more.ts Play CopyCard$ True);
 *   - the revealed card is shown to everyone (the "Revealed" zone) and stays in the library;
 *   - once every question is answered the libraries are shuffled and the opening hands drawn (mulligans follow).
 */
import type { Lookup } from '../game/rules.ts';
import { cardName } from '../game/rules.ts';
import { type Ctx, drawCards, log, moveCard, player, randomId, shuffleLibrary } from '../game/state.ts';
import type { CardInstance, GameState } from '../game/types.ts';
import { getScript, parseAbility } from './script.ts';
import { matchCard } from './targets.ts';
import type { ParsedAbility } from './types.ts';

export const PREGAME_KEYWORD = 'MayEffectFromOpeningDeck';

export interface PregameSpec {
  /** Card name (for prompts). */
  name: string;
  /** ChangeZone ChangeType$ of the sideboard card to exile ("Instant.YouOwn,Sorcery.YouOwn"). */
  changeType: string;
  /** NoteCardsFor$ name ("ArcaneSavant"). */
  noteFor: string;
  /** The reveal step's description (the card's pre-game text). */
  text: string;
}

/** Parse a K:MayEffectFromOpeningDeck:<SVar> chain; undefined when it isn't a shape the engine runs. */
export function pregameChain(keyword: string, svars: Record<string, string>, name: string): PregameSpec | undefined {
  const [head, svar] = keyword.split(':').map((s) => s.trim());
  if (head !== PREGAME_KEYWORD || !svar || !svars[svar]) return undefined;
  const ab = parseAbility(svars[svar], svars, name);
  if (!ab) return undefined;
  const steps: ParsedAbility[] = [];
  for (let s: ParsedAbility | undefined = ab; s; s = s.sub) steps.push(s);
  const [reveal, exile, note, ...rest] = steps;
  if (reveal?.api !== 'Reveal' || (reveal.params.RevealDefined ?? reveal.params.Defined) !== 'Self') return undefined;
  if (exile?.api !== 'ChangeZone' || exile.params.Origin !== 'Sideboard' || exile.params.Destination !== 'Exile' || !exile.params.ChangeType) return undefined;
  if (note?.api !== 'Pump' || note.params.NoteCards !== 'Remembered' || !note.params.NoteCardsFor) return undefined;
  if (rest.some((s) => s.api !== 'Cleanup')) return undefined;
  return { name, changeType: exile.params.ChangeType, noteFor: note.params.NoteCardsFor, text: reveal.description };
}

/** Whether the engine runs this K: line (coverage tools, engine/mechanics.ts keywordGap). */
export function pregameKeywordSupported(keyword: string, svars: Record<string, string> | undefined, name = ''): boolean {
  return !!svars && !!pregameChain(keyword, svars, name);
}

/** The pre-game effect of a card, if it has one the engine runs. */
export function pregameSpec(cardId: string | undefined): PregameSpec | undefined {
  if (!cardId) return undefined;
  const f = getScript(cardId)?.[0];
  if (!f) return undefined;
  for (const k of f.keywords) {
    if (!k.startsWith(PREGAME_KEYWORD)) continue;
    const s = pregameChain(k, f.svars, f.name);
    if (s) return s;
  }
  return undefined;
}

/** Sideboard cards of `pid` that `spec` may exile (one per card name), not already exiled. */
export function pregameChoices(state: GameState, pid: string, spec: PregameSpec, lookup: Lookup): CardInstance[] {
  const p = player(state, pid);
  const seen = new Set<string>();
  const out: CardInstance[] = [];
  for (const iid of p.zones.sideboard) {
    const c = state.cards[iid];
    if (!c?.cardId || seen.has(c.cardId)) continue;
    if (spec.changeType.split(',').some((alt) => matchCard(c, alt.trim(), { controller: pid, lookup }) === true)) { seen.add(c.cardId); out.push(c); }
  }
  return out;
}

/** Does `pid` get a pre-game question (a card with the keyword in the library and a matching sideboard card)? */
export function playerHasPregame(state: GameState, pid: string, lookup: Lookup): boolean {
  const p = player(state, pid);
  return p.zones.library.some((iid) => {
    const spec = pregameSpec(state.cards[iid]?.cardId);
    return !!spec && pregameChoices(state, pid, spec, lookup).length > 0;
  });
}

/**
 * Set up the pre-game questions (createGame) for the players in `deferred`, whose libraries aren't shuffled and whose
 * hands aren't drawn yet: that happens when their last question is answered (finishPregame).
 */
export function startPregame(state: GameState, ctx: Ctx, deferred: string[]) {
  const queue: { pid: string; iid: string }[] = [];
  for (const pid of deferred) for (const iid of player(state, pid).zones.library) if (pregameSpec(state.cards[iid]?.cardId)) queue.push({ pid, iid });
  state.pregame = { queue, deferred: [...deferred] };
  for (const p of state.players) askNext(state, ctx, p.pid);
  if (!state.pending.some((q) => q.data.kind === 'pregame')) finishPregame(state, ctx);
}

/** Ask `pid` about their next pre-game card that has a choice (one open question per player). */
function askNext(state: GameState, ctx: Ctx, pid: string) {
  const pg = state.pregame;
  if (!pg) return;
  while (true) {
    const k = pg.queue.findIndex((e) => e.pid === pid);
    if (k < 0) return;
    const { iid } = pg.queue[k];
    const c = state.cards[iid];
    const spec = pregameSpec(c?.cardId);
    const choices = spec ? pregameChoices(state, pid, spec, ctx.lookup) : [];
    if (!spec || !choices.length) { pg.queue.splice(k, 1); continue; }
    state.pending.push({
      id: randomId(ctx.rng), pid,
      prompt: `${spec.name} — before the game: reveal it from your deck and exile an instant or sorcery card from your sideboard? When ${spec.name} enters, you may cast a copy of the exiled card without paying its mana cost.`,
      options: [...choices.map((x) => ({ value: x.iid, label: `Exile ${cardName(x, ctx.lookup)}` })), { value: 'no', label: `Don't reveal ${spec.name}` }],
      data: { kind: 'pregame', iid },
    });
    return;
  }
}

/** Answer a pre-game question ('choose'). undefined = not ours. */
export function answerPregame(state: GameState, ctx: Ctx, pid: string, id: string, value: string): string | null | undefined {
  const q = state.pending.find((p) => p.id === id);
  if (!q || q.data.kind !== 'pregame') return undefined;
  if (q.pid !== pid) return 'That question is for another player';
  if (!q.options.some((o) => o.value === value)) return 'Not one of the options';
  state.pending = state.pending.filter((p) => p !== q);
  const pg = state.pregame;
  const iid = q.data.iid as string;
  if (pg) pg.queue = pg.queue.filter((e) => e.iid !== iid);
  const savant = state.cards[iid];
  const spec = pregameSpec(savant?.cardId);
  const me = player(state, pid);
  if (value === 'no' || !spec || !savant) {
    log(state, ctx, pid, `${me.name} doesn't reveal ${spec?.name ?? 'it'}.`);
  } else {
    const chosen = state.cards[value];
    const sname = cardName(savant, ctx.lookup);
    const cname = cardName(chosen, ctx.lookup);
    moveCard(state, ctx, value, 'exile');
    const notes = (me.notes ??= {});
    (notes[spec.noteFor] ??= []).push(value);
    // Revealed to everyone: a reveal record (the "Revealed" zone); the card stays in the library to be shuffled.
    const list = (state.reveals ??= []);
    list.push({ id: (list[list.length - 1]?.id ?? 0) + 1, turn: state.turn, by: pid, source: `${sname} (before the game)`, cards: [{ iid: savant.iid, name: sname, ...(savant.cardId ? { cardId: savant.cardId } : {}) }], to: state.players.map((p) => p.pid) });
    log(state, ctx, pid, `${me.name} reveals ${sname} from their deck and exiles ${cname} from their sideboard with it.`);
  }
  askNext(state, ctx, pid);
  if (!state.pending.some((p) => p.data.kind === 'pregame')) finishPregame(state, ctx);
  return null;
}

/** Every pre-game choice is made: shuffle, draw the opening hands; mulligans follow. */
function finishPregame(state: GameState, ctx: Ctx) {
  const deferred = state.pregame?.deferred ?? [];
  delete state.pregame;
  for (const p of state.players) {
    if (!deferred.includes(p.pid)) continue;
    shuffleLibrary(state, p, ctx.rng);
    drawCards(state, p, 7);
  }
}

/** Pre-game questions are still open (mulligan decisions wait). */
export function inPregame(state: Pick<GameState, 'pregame'>): boolean {
  return !!state.pregame;
}
