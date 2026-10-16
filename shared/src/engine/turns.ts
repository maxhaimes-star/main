/**
 * Turn-level and permanent-level mechanics of the cube's unique cards:
 *
 * - Extra turns: state.extraTurns (LIFO), consumed by the reducer when the next turn starts (nextTurnPlayer).
 * - Mindslaver: state.controlledBy. During the controlled turn the controller's actions are routed to the
 *   controlled player (routeAction: explicit `action.as`, else the Pending's player / the card's controller /
 *   the player with priority); the controlled player can only chat / concede; view.ts reveals their hand and
 *   questions to the controller (controls()).
 * - Sagas (K:Chapter:N:svars): a lore counter as it enters and at its controller's precombat main phase,
 *   chapter abilities trigger for each chapter reached, sacrificed after the last chapter left the stack.
 *   Chapter-granted abilities (Urza's Saga) are available once the Saga has that many lore counters
 *   (keywords.ts synthesizes the activated ones, mana.ts the mana one).
 * - State triggers (T: Mode$ Always, Dark Depths), Hideaway (Shelldock Isle) and trigger rewrites for cards whose
 *   Forge scripts use optional costs / player-chosen targets the engine can't express (Oath of Druids, Sylvan
 *   Library, Dark Depths' "Mandatory Sac<1/CARDNAME>").
 * - Activated-ability costs beyond the basics: tapXType<N/Type> (Opposition), Sac<N/Type> (Recurring Nightmare),
 *   Return<1/CARDNAME>, Discard<N/Type> (Survival of the Fittest), Exile...; and activation restrictions
 *   IsPresent$ with PresentZone$ Hand (Library of Alexandria).
 */
import { cardName } from '../game/rules.ts';
import { type Ctx, log, moveCard, player, randomId } from '../game/state.ts';
import type { CardInstance, GameAction, GameState, StackItem } from '../game/types.ts';
import { startCostPicks, type CostData } from './costs.ts';
import { getScript, parseAbility, parseParams, triggersOf, scriptRef } from './script.ts';
import { matchCard } from './targets.ts';
import { conditionHolds } from './triggers.ts';
import { oathApplies } from './unique.ts';
import type { AutoInfo, ForgeFace, ParsedAbility, Pending, QueuedTrigger } from './types.ts';

const pname = (state: GameState, pid: string) => state.players.find((p) => p.pid === pid)?.name ?? 'someone';

// ------------------------------------------------------------------ extra turns & Mindslaver

/**
 * Who takes the next turn: the most recently added extra turn, else `normal` — or, right after extra turns,
 * the player whose regular turn they interrupted.
 */
export function nextTurnPlayer(state: GameState, ctx: Ctx, normal: string): string {
  const q = state.extraTurns ?? [];
  const alive = (pid: string) => state.players.some((p) => p.pid === pid && !p.conceded);
  while (q.length) {
    const pid = q.pop()!;
    if (!alive(pid)) continue;
    state.nextNormalTurn ??= normal;
    log(state, ctx, pid, `${pname(state, pid)} takes an extra turn.`);
    return pid;
  }
  const resume = state.nextNormalTurn;
  state.nextNormalTurn = null;
  return resume && alive(resume) ? resume : normal;
}

/** Called as a turn starts (after state.turn / activePlayer are set): starts / ends Mindslaver control. */
export function turnStarted(state: GameState, ctx: Ctx, pid: string) {
  const cb = state.controlledBy;
  if (!cb) return;
  if (cb.active && cb.turn !== state.turn) {
    log(state, ctx, cb.pid, `${pname(state, cb.pid)} is no longer controlled by ${pname(state, cb.by)}.`);
    state.controlledBy = null;
    return;
  }
  if (!cb.active && cb.pid === pid && state.turn > cb.since) {
    cb.active = true;
    cb.turn = state.turn;
    log(state, ctx, cb.by, `${pname(state, cb.by)} controls ${pname(state, pid)} during this turn — they make all of ${pname(state, pid)}'s decisions and see their hand.`);
  }
}

/** Does `viewer` currently control player `pid` (Mindslaver)? */
export function controls(state: Pick<GameState, 'controlledBy'>, viewer: string | null, pid: string): boolean {
  const cb = state.controlledBy;
  return !!viewer && !!cb?.active && cb.by === viewer && cb.pid === pid;
}

const NEVER_ROUTED = new Set<GameAction['t']>(['chat', 'concede', 'requestUndo', 'answerUndo', 'lookAtHand', 'setStops', 'mulligan', 'keep', 'bottom']);

/**
 * Which player an action is performed as. Returns the acting player id, or an error.
 * Without Mindslaver control this is `pid` (an `as` naming someone else is refused).
 */
export function routeAction(state: GameState, pid: string, action: GameAction): { pid: string } | { error: string } {
  const cb = state.controlledBy;
  const as = action.as;
  if (!cb?.active) return !as || as === pid ? { pid } : { error: "You don't control that player" };
  if (NEVER_ROUTED.has(action.t)) return { pid };
  if (pid === cb.pid) return { error: `${pname(state, cb.by)} controls you this turn` };
  if (pid !== cb.by) return !as || as === pid ? { pid } : { error: "You don't control that player" };
  if (as) return as === cb.pid || as === pid ? { pid: as } : { error: "You don't control that player" };
  const slaved = cb.pid;
  // Questions: whoever they were asked of.
  if (action.t === 'choose' || action.t === 'chooseTargets') {
    const q = state.pending.find((p) => p.id === action.id);
    return { pid: q?.pid === slaved ? slaved : pid };
  }
  if (action.t === 'resolvePeek') return { pid: player(state, slaved).peek && !player(state, pid).peek ? slaved : pid };
  // Card actions: the card's controller (on the battlefield / stack) or owner (elsewhere).
  const iid = (action as { iid?: string }).iid;
  if (iid && state.cards[iid]) {
    const c = state.cards[iid];
    const who = c.zone === 'battlefield' || c.zone === 'stack' ? c.controller : c.owner;
    return { pid: who === slaved ? slaved : pid };
  }
  if (action.t === 'declareBlocker' || action.t === 'confirmBlockers') return { pid };
  if (action.t === 'confirmAttackers' || action.t === 'gotoStep' || action.t === 'nextTurn') return { pid: state.activePlayer === slaved ? slaved : pid };
  return { pid: state.priority === slaved ? slaved : pid };
}

// ------------------------------------------------------------------ sagas

export interface SagaInfo { chapters: string[] }

/** K:Chapter:<N>:<svar1>,<svar2>,... of a face. */
export function sagaOf(f: ForgeFace | undefined): SagaInfo | undefined {
  const k = f?.keywords.find((x) => /^Chapter:\d+:/.test(x));
  if (!k) return undefined;
  const [, n, list] = k.split(':');
  const chapters = (list ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, parseInt(n, 10) || 0);
  return chapters.length ? { chapters } : undefined;
}

function faceFor(c: CardInstance): ForgeFace | undefined {
  return c.cardId && !c.faceDown ? getScript(c.cardId)?.[c.transformed ? 1 : 0] : undefined;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

function queue(state: GameState, ctx: Ctx, c: CardInstance, text: string, auto: AutoInfo, extra: Partial<QueuedTrigger> = {}) {
  const name = cardName(c, ctx.lookup);
  if (state.players.find((p) => p.pid === c.controller)?.autoTriggers === false) {
    log(state, ctx, c.controller, `Reminder (automatic triggers are off): ${name} — ${text}`);
    return;
  }
  (state.triggerQueue ??= []).push({ id: randomId(ctx.rng), controller: c.controller, sourceIid: c.iid, sourceName: name, text: `${name}: ${text}`, auto, ...extra });
}

/** Add lore counters to a Saga and trigger the chapters reached. */
export function addLore(state: GameState, ctx: Ctx, c: CardInstance, n: number) {
  const f = faceFor(c);
  const saga = sagaOf(f);
  if (!saga || !f || !c.cardId) return;
  const before = c.counters.lore ?? 0;
  c.counters.lore = before + n;
  log(state, ctx, c.controller, `${cardName(c, ctx.lookup)} gets a lore counter (now ${c.counters.lore}).`);
  for (let ch = before + 1; ch <= c.counters.lore && ch <= saga.chapters.length; ch++) {
    const svar = saga.chapters[ch - 1];
    const ab = f.svars[svar] ? parseAbility(f.svars[svar], f.svars, f.name) : undefined;
    queue(state, ctx, c, `Chapter ${ROMAN[ch - 1] ?? ch} — ${ab?.description ?? svar}`, {
      cardId: c.cardId, face: c.transformed ? 1 : 0, source: 'trigger', index: -1, svar, targets: [], trigger: { mode: 'CounterAdded', card: c.iid, player: c.controller },
    });
  }
}

/** After the last chapter: sacrifice Sagas whose chapter abilities have all left the stack. */
function sagaSacrifice(state: GameState, ctx: Ctx) {
  for (const iid of [...state.battlefield]) {
    const c = state.cards[iid];
    const saga = sagaOf(faceFor(c));
    if (!saga || (c.counters.lore ?? 0) < saga.chapters.length) continue;
    const busy = state.stack.some((s) => s.sourceIid === iid && s.kind === 'trigger') || (state.triggerQueue ?? []).some((t) => t.sourceIid === iid);
    if (busy) continue;
    const name = cardName(c, ctx.lookup);
    moveCard(state, ctx, iid, 'graveyard', { cause: 'sacrifice' });
    log(state, ctx, c.controller, `${pname(state, c.controller)} sacrifices ${name} (final chapter).`);
  }
}

// ------------------------------------------------------------------ trigger rewrites

const OATH_LINE = 'DB$ OathOfDruids | Valid$ Creature | SpellDescription$ Reveal cards until a creature card; put it onto the battlefield and the rest into the graveyard.';

/** A synthesized line replacing a T: line's Execute$ chain (undefined = keep the script's). */
export function uniqueTriggerLine(cardId: string, face: number, p: Record<string, string>): string | undefined {
  const f = getScript(cardId)?.[face];
  const sv = p.Execute ? f?.svars[p.Execute] : undefined;
  if (!f || !sv) return undefined;
  const params = parseParams(sv).params;
  const api = parseParams(sv).api;
  // Oath of Druids: "that player chooses target player who controls more creatures" + DigUntil.
  if (api === 'Pump' && params.TargetingPlayer === 'TriggeredPlayer' && params.SubAbility && /DigUntil/.test(f.svars[params.SubAbility] ?? '')) return OATH_LINE;
  // Sylvan Library: ChooseCard with Cost$ Draw<2/You> (an optional cost) + "pay 4 life or put it back".
  let m = /Draw<(\d+)\/You>/.exec(params.Cost ?? '');
  if (api === 'ChooseCard' && m) {
    const life = /PayLife<(\d+)>/.exec(Object.values(f.svars).join(' '))?.[1] ?? '4';
    return `DB$ SylvanLibrary | Num$ ${m[1]} | Life$ ${life} | SpellDescription$ You may draw ${m[1]} additional cards; for two cards drawn this turn, pay ${life} life or put it back.`;
  }
  // Dark Depths: AB$ Token with "Cost$ Mandatory Sac<1/CARDNAME>" — sacrifice it; if you do, create the token.
  m = /^Mandatory Sac<1\/CARDNAME>$/.exec((params.Cost ?? '').trim());
  if (api === 'Token' && m && params.TokenScript) return `DB$ SacSelfToken | TokenScript$ ${params.TokenScript} | SpellDescription$ Sacrifice ${f.name}. If you do, create the token.`;
  return undefined;
}

/** Skip a detected trigger that would have no legal target (Oath of Druids when nobody has more creatures). */
export function uniqueTriggerSkip(state: GameState, ctx: Ctx, cardId: string, face: number, p: Record<string, string>, player: string | undefined): boolean {
  if (uniqueTriggerLine(cardId, face, p) === OATH_LINE) return !oathApplies(state, ctx, player ?? state.activePlayer);
  return false;
}

/** Coverage: triggers this module makes automatic (Mode$ Always, rewritten chains). */
export function uniqueTriggerSupport(cardId: string, face: number, index: number): { detect: boolean; chain: boolean } | undefined {
  const t = triggersOf(cardId, face)[index];
  if (!t) return undefined;
  if (uniqueTriggerLine(cardId, face, t.params)) return { detect: true, chain: true };
  return undefined;
}

// ------------------------------------------------------------------ trigger detection hook

/**
 * Called by processTriggers before the normal detection (reads state.events without consuming them):
 * Saga lore counters / chapters, Hideaway, Mode$ Always state triggers, Saga sacrifice.
 */
export function uniqueTriggers(state: GameState, ctx: Ctx) {
  try {
    for (const ev of state.events ?? []) {
      if (ev.t === 'zone' && ev.to === 'battlefield' && ev.from !== 'battlefield') {
        const c = state.cards[ev.iid];
        if (!c || c.zone !== 'battlefield') continue;
        const f = faceFor(c);
        if (sagaOf(f)) addLore(state, ctx, c, 1);
        const hide = f?.keywords.find((k) => /^Hideaway:\d+$/.test(k));
        if (hide && c.cardId) {
          const n = hide.split(':')[1];
          queue(state, ctx, c, `Hideaway ${n} — look at the top ${n} cards, exile one face down, the rest on the bottom.`, {
            cardId: c.cardId, face: c.transformed ? 1 : 0, source: 'trigger', index: -1, targets: [], line: `DB$ Hideaway | Num$ ${n} | SpellDescription$ Hideaway ${n}.`, trigger: { mode: 'ChangesZone', card: c.iid, player: c.controller },
          });
        }
      } else if (ev.t === 'phase' && ev.step === 'main1') {
        for (const iid of [...state.battlefield]) {
          const c = state.cards[iid];
          if (c.controller === ev.active && sagaOf(faceFor(c))) addLore(state, ctx, c, 1);
        }
      }
    }
    alwaysTriggers(state, ctx);
    sagaSacrifice(state, ctx);
  } catch (e) {
    log(state, ctx, null, `Trigger detection error (unique): ${(e as Error).message}`);
  }
}

/** T: Mode$ Always — "When CARDNAME has no ice counters on it ...": trigger while the condition holds (once at a time). */
function alwaysTriggers(state: GameState, ctx: Ctx) {
  for (const iid of [...state.battlefield]) {
    const c = state.cards[iid];
    if (!c || c.faceDown) continue;
    if (state.players.find((p) => p.pid === c.controller)?.autoTriggers === false) continue; // checked every action: no reminders
    const ref = scriptRef(c); // a copy (Thespian's Stage copying Dark Depths): the copied card's triggers
    if (!ref) continue;
    const { cardId, face } = ref;
    for (const t of triggersOf(cardId, face)) {
      const p = t.params;
      if (p.Mode !== 'Always') continue;
      const pending = state.stack.some((s) => s.sourceIid === iid && s.auto?.index === t.index && s.kind === 'trigger')
        || (state.triggerQueue ?? []).some((q) => q.sourceIid === iid && q.auto.index === t.index);
      if (pending) continue;
      const cond: Record<string, string> = {};
      for (const k of ['IsPresent', 'PresentCompare', 'CheckSVar', 'SVarCompare']) if (p[k]) cond[k] = p[k];
      if (conditionHolds(state, ctx, cond, c.controller, iid, cardId, face) !== true) continue;
      const line = uniqueTriggerLine(cardId, face, p);
      const f = getScript(cardId)?.[face];
      const auto: AutoInfo = { cardId, face, source: 'trigger', index: t.index, targets: [], trigger: { mode: 'Always', card: iid, player: c.controller, condition: cond } };
      if (line) auto.line = line; else if (p.Execute) auto.svar = p.Execute;
      queue(state, ctx, c, (p.TriggerDescription ?? 'State trigger').replace(/CARDNAME/g, f?.name ?? 'it'), auto, { targetsChosen: true });
    }
  }
}

// ------------------------------------------------------------------ activated abilities: costs & restrictions

/** Cost tokens of activated abilities this module pays (play.ts calls it for tokens it doesn't know). */
export function isUniqueCost(tok: string): boolean {
  return /^tapXType<\d+\/[^>]+>$/.test(tok) || /^(Sac|Discard|Return|ExileFromGrave|ExileFromHand)<\d+\/[^>]+>$/.test(tok);
}

interface ParsedCost { kind: 'tap' | 'sac' | 'discard' | 'return' | 'exileGrave' | 'exileHand' | 'returnSelf' | 'discardHand'; n: number; valid: string; text: string }

function parseUniqueCost(tok: string, x: number): ParsedCost | undefined {
  const m = /^(\w+)<(\d+|X)\/([^/>]+)(?:\/([^>]+))?>$/.exec(tok);
  if (!m) return undefined;
  const n = m[2] === 'X' ? x : parseInt(m[2], 10);
  const valid = m[3].replace(/;/g, ','); // "Artifact.Other;Creature.Other": either (Broadside Bombardiers)
  const desc = m[4] ?? valid.split('.')[0].toLowerCase();
  const self = /^(CARDNAME|Self|NICKNAME)$/.test(valid);
  switch (m[1]) {
    case 'tapXType': return { kind: 'tap', n, valid, text: `tap ${n} untapped ${desc}${n === 1 ? '' : 's'} you control` };
    case 'Sac': return self ? undefined : { kind: 'sac', n, valid, text: `sacrifice ${n === 1 ? (/^[aeiou]/i.test(desc) ? 'an' : 'a') : n} ${desc.replace(/^(an?|another) (?=another )/, '')}` };
    case 'Discard': if (valid === 'Hand') return { kind: 'discardHand', n: 0, valid, text: 'discard your hand' }; // Bomat Courier
      return self ? undefined : { kind: 'discard', n, valid, text: `discard ${n === 1 ? 'a' : n} ${desc}` };
    case 'Return': return self ? { kind: 'returnSelf', n: 1, valid, text: 'return it to its owner\'s hand' } : { kind: 'return', n, valid, text: `return ${n === 1 ? 'a' : n} ${desc} you control to its owner's hand` };
    case 'ExileFromGrave': return self ? undefined : { kind: 'exileGrave', n, valid, text: `exile ${n === 1 ? 'a' : n} ${desc} from your graveyard` };
    case 'ExileFromHand': return self ? undefined : { kind: 'exileHand', n, valid, text: `exile ${n === 1 ? 'a' : n} ${desc} from your hand` };
  }
  return undefined;
}

function costCandidates(state: GameState, ctx: Ctx, pid: string, src: CardInstance, pc: ParsedCost): string[] {
  const env = { controller: pid, sourceIid: src.iid, lookup: ctx.lookup };
  const me = player(state, pid);
  const ok = (iid: string) => iid !== src.iid && matchCard(state.cards[iid], pc.valid, env) !== false;
  switch (pc.kind) {
    case 'tap': return state.battlefield.filter((iid) => state.cards[iid].controller === pid && !state.cards[iid].tapped && ok(iid));
    case 'sac': case 'return': return state.battlefield.filter((iid) => state.cards[iid].controller === pid && ok(iid));
    case 'discard': case 'exileHand': return me.zones.hand.filter(ok);
    case 'exileGrave': return me.zones.graveyard.filter(ok);
  }
  return [];
}

/** Can these extra cost tokens be paid? Error or null (checked before anything is paid). */
export function uniqueCostError(state: GameState, ctx: Ctx, pid: string, src: CardInstance, toks: string[], x: number): string | null {
  const name = cardName(src, ctx.lookup);
  for (const tok of toks) {
    const pc = parseUniqueCost(tok, x);
    if (!pc) return `${name}: can't pay ${tok}`;
    if (pc.kind === 'returnSelf') { if (src.zone !== 'battlefield') return `${name} must be on the battlefield`; continue; }
    if (pc.kind === 'discardHand') continue;
    const have = costCandidates(state, ctx, pid, src, pc).length;
    if (have < pc.n) return `${name}: you can't ${pc.text} (${have}/${pc.n})`;
  }
  return null;
}

interface TapCostData { kind: 'tapCost'; pid: string; src: string; valid: string; left: number; name: string }

/** Pay the extra cost tokens after the ability is on the stack (choices become Pending questions). */
export function payUniqueCosts(state: GameState, ctx: Ctx, pid: string, src: CardInstance, item: StackItem, toks: string[], x: number) {
  const name = cardName(src, ctx.lookup);
  const picks: CostData['picks'] = [];
  const taps: ParsedCost[] = [];
  for (const tok of toks) {
    const pc = parseUniqueCost(tok, x);
    if (!pc) continue;
    if (pc.kind === 'returnSelf') {
      if (src.zone === 'battlefield') { moveCard(state, ctx, src.iid, 'hand'); log(state, ctx, pid, `${pname(state, pid)} returns ${name} to its owner's hand (cost).`); }
    } else if (pc.kind === 'discardHand') {
      const hand = [...player(state, pid).zones.hand];
      for (const iid of hand) moveCard(state, ctx, iid, 'graveyard', { cause: 'discard' });
      log(state, ctx, pid, `${pname(state, pid)} discards their hand (${hand.length} card${hand.length === 1 ? '' : 's'}) to pay for ${name}.`);
    } else if (pc.kind === 'tap') taps.push(pc);
    else picks.push({ kind: pc.kind, valid: pc.valid, left: pc.n, optional: false, label: pc.text });
  }
  for (const t of taps) askTapCost(state, ctx, { kind: 'tapCost', pid, src: src.iid, valid: t.valid, left: t.n, name });
  if (picks.length) startCostPicks(state, ctx, { kind: 'cost', pid, spellIid: src.iid, spellName: item.text, picks, delved: 0 });
}

function askTapCost(state: GameState, ctx: Ctx, d: TapCostData) {
  const src = state.cards[d.src];
  if (d.left <= 0) return;
  const env = { controller: d.pid, sourceIid: d.src, lookup: ctx.lookup };
  const cands = state.battlefield.filter((iid) => iid !== d.src && state.cards[iid].controller === d.pid && !state.cards[iid].tapped && matchCard(state.cards[iid], d.valid, env) !== false);
  if (!cands.length) return;
  if (cands.length <= d.left) {
    for (const iid of cands) state.cards[iid].tapped = true;
    log(state, ctx, d.pid, `${pname(state, d.pid)} taps ${cands.map((i) => cardName(state.cards[i], ctx.lookup)).join(', ')} to pay for ${src ? cardName(src, ctx.lookup) : d.name}.`);
    return;
  }
  const pending: Pending = {
    id: randomId(ctx.rng), pid: d.pid, prompt: `${d.name}: tap an untapped ${d.valid.split('.')[0].toLowerCase()} you control (cost)${d.left > 1 ? ` (${d.left} left)` : ''}`,
    options: cands.map((iid) => ({ value: iid, label: cardName(state.cards[iid], ctx.lookup) })), data: d as unknown as Record<string, unknown>,
  };
  state.pending.push(pending);
}

/** Answer a tap-cost question. undefined when the Pending isn't one. */
export function answerTapCost(state: GameState, ctx: Ctx, pend: Pending, value: string): string | null | undefined {
  const d = pend.data as unknown as TapCostData;
  if (d.kind !== 'tapCost') return undefined;
  const c = state.cards[value];
  if (c && c.zone === 'battlefield' && !c.tapped) {
    c.tapped = true;
    log(state, ctx, d.pid, `${pname(state, d.pid)} taps ${cardName(c, ctx.lookup)} to pay for ${d.name}.`);
    askTapCost(state, ctx, { ...d, left: d.left - 1 });
  } else askTapCost(state, ctx, d);
  return null;
}

/** Activation restrictions: IsPresent$ with PresentZone$ (Library of Alexandria), chapter-granted abilities. */
export function uniqueActivationError(state: GameState, ctx: Ctx, c: CardInstance, pid: string, ab: ParsedAbility, name: string): string | null {
  const p = ab.params;
  if (p.ChapterLore && (c.counters.lore ?? 0) < (parseInt(p.ChapterLore, 10) || 0)) return `${name}: this ability is gained at chapter ${ROMAN[parseInt(p.ChapterLore, 10) - 1] ?? p.ChapterLore}`;
  if (p.IsPresent && p.PresentZone) {
    const zone = p.PresentZone.trim().toLowerCase() as 'hand' | 'graveyard' | 'library' | 'exile';
    const me = player(state, pid);
    const pool = zone === 'hand' || zone === 'graveyard' || zone === 'library' || zone === 'exile' ? me.zones[zone] : [];
    const env = { controller: pid, sourceIid: c.iid, lookup: ctx.lookup };
    const n = pool.filter((iid) => matchCard(state.cards[iid], p.IsPresent, env) === true).length;
    const m = /^(LT|LE|EQ|NE|GE|GT)(\d+)$/.exec(p.PresentCompare ?? 'GE1');
    if (m) {
      const k = parseInt(m[2], 10);
      const ok = { LT: n < k, LE: n <= k, EQ: n === k, NE: n !== k, GE: n >= k, GT: n > k }[m[1] as 'LT'];
      if (!ok) return `${name}: can't be activated now (you have ${n} matching card${n === 1 ? '' : 's'} in your ${zone}; needs ${m[1]} ${k}) — use force to override`;
    }
  }
  return null;
}

/** Mana abilities a Saga's chapters granted it so far (Urza's Saga chapter I), as [line, id] pairs. */
export function chapterManaLines(c: CardInstance): [string, string][] {
  const f = faceFor(c);
  const saga = sagaOf(f);
  if (!saga || !f) return [];
  const out: [string, string][] = [];
  saga.chapters.forEach((svar, k) => {
    if ((c.counters.lore ?? 0) < k + 1) return;
    const p = parseParams(f.svars[svar] ?? '').params;
    if (parseParams(f.svars[svar] ?? '').api !== 'Animate' || !p.Abilities) return;
    for (const name of p.Abilities.split(',').map((s) => s.trim())) {
      const line = f.svars[name];
      if (line && /^\s*AB\$\s*Mana\b/.test(line)) out.push([line, `ch${k + 1}:${name}`]);
    }
  });
  return out;
}
