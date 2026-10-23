/**
 * Computer opponent ("bot player"): picks the next game action for one seat of a rules-enforced (strict) game.
 *
 * It only ever looks at what its seat may see — a GameView from viewFor(state, pid) — and answers with an ordinary
 * GameAction that the reducer validates like a human's. One call = one action, so a driver (server/src/botdriver.ts,
 * scripts/playtest.ts --ai) applies it, and asks again; failed actions are reported back (botActionFailed) so the
 * next call tries something else and the bot never hangs on an action the engine refuses.
 *
 * Heuristics (cheap, no search):
 *   - before the game: Arcane Savant's pre-game exile takes the best instant / sorcery of the sideboard
 *   - mulligans: keep 2–5 landers (1–5 after a mulligan), at most two mulligans; bottom extra lands / expensive cards
 *   - main phase: play the land that fixes the hand's colors, then cast the most valuable castable spell (auto-pay)
 *   - targets: harmful effects at the opponent's biggest threat (burn at what it kills, at the face when lethal),
 *     beneficial ones at the bot's own best creature / graveyard card
 *   - attacks: creatures nothing can block profitably, everything when the swing is lethal, never into a lethal
 *     crack-back
 *   - blocks: free kills, safe blocks and even trades, then chump blocks only when the damage would be lethal
 *   - questions (choose / targets / divide / number / yes-no / order), scry / surveil, cleanup discards, legend rule,
 *     undo / fix-mode / free-mulligan requests from the opponent
 *   - guards: a cap on actions per step, refused actions are never retried at the same game state
 */
import { getCard } from '../cube.ts';
import { cmcOf, parseManaSymbols, type CardData } from '../cards.ts';
import type { Lookup } from '../game/rules.ts';
import { effectivePT, faceOf, hasKeyword, isCreature } from '../game/rules.ts';
import { type CardInstance, type GameAction, type GameState, type GameView, isHidden, type ViewCard, type ViewPlayer } from '../game/types.ts';
import type { ParsedAbility, Pending, TargetRef, TargetSpec } from '../engine/types.ts';
import { abilitiesOfInstance } from '../engine/animate.ts';
import { castableFaces, castOptions } from '../engine/costs.ts';
import { castSpellAbility, flatten, isRoomCard, targetSpecs, type ActivatedEntry } from '../engine/script.ts';
import { isValidTarget } from '../engine/targets.ts';
import { attackRestriction, blockRestriction } from '../engine/statics.ts';
import { abilityUsability, attackError, autoPayPreview, blockError, castability, isLandCard, landPlaysLeft, manaSources } from '../engine/strict.ts';
import { cardPower } from '../power.ts';

export type BotLevel = 'easy' | 'normal';
export const BOT_LEVELS: BotLevel[] = ['easy', 'normal'];

/** Per-seat memory between calls (plain data: survives JSON round trips). */
export interface BotMemory {
  /** Actions refused by the engine at game state `failedSeq` (keys from actionKey). */
  failedSeq: number;
  failed: string[];
  /** Actions taken in the current step (`stepKey`), for the per-window cap. */
  stepKey: string;
  stepActions: number;
  /** Abilities already activated this turn (iid:index), so mana sinks aren't spammed. */
  abilityTurn: number;
  usedAbilities: string[];
  /** Undo requests accepted this turn. */
  undoTurn: number;
  undos: number;
  /** Combat plans, computed once per declare step. */
  attackPlan: { key: string; attacks: { iid: string; target: string }[] } | null;
  blockPlan: { key: string; blocks: { iid: string; attacker: string }[] } | null;
  rng: number;
}

export function newBotMemory(seed = 1): BotMemory {
  return { failedSeq: -1, failed: [], stepKey: '', stepActions: 0, abilityTurn: -1, usedAbilities: [], undoTurn: -1, undos: 0, attackPlan: null, blockPlan: null, rng: (seed >>> 0) || 1 };
}

export interface BotOptions {
  level?: BotLevel;
  lookup?: Lookup;
  /** Max non-pass actions (casts, activations, land plays) per step before the bot just passes. */
  maxActionsPerStep?: number;
}

/** Cap on non-pass actions per step (a loop guard: an engine bug can't make the bot spin). */
export const MAX_ACTIONS_PER_STEP = 16;

// ------------------------------------------------------------------ small helpers

type View = GameView;
const asState = (v: View) => v as unknown as GameState;

function rand(mem: BotMemory): number {
  let s = (mem.rng = (mem.rng + 0x6d2b79f5) >>> 0);
  s = Math.imul(s ^ (s >>> 15), s | 1);
  s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
  return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
}

function safe<T>(f: () => T, dflt: T): T {
  try { return f(); } catch { return dflt; }
}

/** A key identifying an action for the "refused, don't retry" list. */
export function actionKey(a: GameAction): string {
  switch (a.t) {
    case 'cast': return `cast:${a.iid}:${a.face ?? ''}:${a.costOption ?? ''}`;
    case 'activate': return `act:${a.iid}:${a.ability}`;
    case 'playLand': return `land:${a.iid}`;
    case 'choose': return `choose:${a.id}:${a.value}`;
    case 'chooseTargets': return `ct:${a.id}:${JSON.stringify(a.targets)}`;
    case 'declareAttacker': return `atk:${a.iid}:${a.target}`;
    case 'declareBlocker': return `blk:${a.iid}:${a.attacker}`;
    default: return a.t;
  }
}

/** Tell the bot the engine refused `a` (state seq `seq`): it won't try it again until the state changes. */
export function botActionFailed(mem: BotMemory, a: GameAction, seq: number) {
  if (mem.failedSeq !== seq) { mem.failedSeq = seq; mem.failed = []; }
  mem.failed.push(actionKey(a));
  if (a.t === 'chooseTargets') mem.failed.push(`ctany:${a.id}`);
}

/** Tell the bot `a` was applied (counts toward the per-step cap). */
export function botActionDone(mem: BotMemory, v: { turn: number; step: string }, a: GameAction) {
  const key = `${v.turn}|${v.step}`;
  if (mem.stepKey !== key) { mem.stepKey = key; mem.stepActions = 0; }
  if (['cast', 'activate', 'playLand'].includes(a.t)) mem.stepActions++;
  if (a.t === 'activate') {
    if (mem.abilityTurn !== v.turn) { mem.abilityTurn = v.turn; mem.usedAbilities = []; }
    mem.usedAbilities.push(`${a.iid}:${a.ability}`);
  }
}

function failed(mem: BotMemory, v: View, key: string): boolean {
  return mem.failedSeq === v.seq && mem.failed.includes(key);
}

function visible(v: View, iid: string | undefined): CardInstance | undefined {
  const c = iid ? v.cards[iid] : undefined;
  return c && !isHidden(c) ? (c as CardInstance) : undefined;
}

function me(v: View, pid: string): ViewPlayer {
  return v.players.find((p) => p.pid === pid)!;
}

function opponents(v: View, pid: string): ViewPlayer[] {
  return v.players.filter((p) => p.pid !== pid && !p.conceded);
}

// ------------------------------------------------------------------ evaluation

interface Stats { p: number; t: number; dmg: number; creature: boolean; kw: (k: string) => boolean; value: number }

const KW_VALUE: Record<string, number> = {
  Flying: 1.5, Deathtouch: 1.5, Lifelink: 1, 'First Strike': 1, 'Double Strike': 2, Trample: 0.5, Vigilance: 0.5,
  Hexproof: 1, Indestructible: 2.5, Menace: 0.7, Haste: 0.3, Unblockable: 1.5,
};

/** Combat stats and a rough value of a permanent (hidden face-down = a vanilla 2/2). */
function stats(v: View, iid: string, L: Lookup): Stats {
  const raw = v.cards[iid];
  if (!raw || isHidden(raw)) {
    return { p: 2, t: 2, dmg: 0, creature: !!raw && raw.zone === 'battlefield', kw: () => false, value: 3 };
  }
  const c = raw as CardInstance;
  const S = asState(v) as never;
  const creature = safe(() => isCreature(c, L, S), false);
  const [p, t] = creature ? safe(() => effectivePT(c, L, S), [0, 0] as [number, number]) : [0, 0];
  const kwCache = new Map<string, boolean>();
  const kw = (k: string) => {
    let r = kwCache.get(k);
    if (r == null) { r = safe(() => hasKeyword(c, L, k, S), false); kwCache.set(k, r); }
    return r;
  };
  const f = safe(() => faceOf(c, L), undefined);
  const cmc = f ? manaValue(f.manaCost) : 0;
  let value: number;
  if (creature) {
    value = Math.max(0, p) * 1.5 + Math.max(0, t) + 0.4 * cmc;
    for (const [k, w] of Object.entries(KW_VALUE)) if (kw(k)) value += w * (k === 'Haste' ? 1 : Math.max(1, p) / 2 + 0.5);
  } else if (f?.types.includes('Planeswalker')) value = 6 + (c.counters.loyalty ?? 0);
  else if (f?.types.includes('Land')) value = 1;
  else value = 1 + cmc;
  if (c.token) value *= 0.8;
  return { p, t, dmg: c.damage ?? 0, creature, kw, value };
}

function manaValue(cost: string | undefined): number {
  if (!cost) return 0;
  let n = 0;
  for (const s of parseManaSymbols(cost)) {
    if (/^\d+$/.test(s)) n += parseInt(s, 10);
    else if (s !== 'X') n += 1;
  }
  return n;
}

/** Value of a card in hand / graveyard (what it would be worth to have / cast). */
function cardValue(v: View, pid: string, iid: string, L: Lookup): number {
  const c = visible(v, iid);
  if (!c?.cardId) return c?.token ? 1 : 2;
  const d = L(c.cardId);
  if (!d) return 2;
  if (d.types.includes('Land')) {
    const lands = landsOnBattlefield(v, pid, L);
    return lands < 6 ? 3.5 : 0.8;
  }
  return 1 + d.cmc * 0.6 + safe(() => cardPower(d), 0.3) * 4;
}

function landsOnBattlefield(v: View, pid: string, L: Lookup): number {
  let n = 0;
  for (const iid of v.battlefield) {
    const c = visible(v, iid);
    if (c && c.controller === pid && safe(() => faceOf(c, L).types.includes('Land'), false)) n++;
  }
  return n;
}

/** Does `a` deal lethal damage to `b` in a fight / combat (first strike aside)? */
function kills(a: Stats, b: Stats): boolean {
  if (a.p <= 0) return false;
  if (b.kw('Indestructible')) return false;
  return a.kw('Deathtouch') || a.p * (a.kw('Double Strike') ? 2 : 1) >= b.t - b.dmg;
}

/** Does `x` survive a fight with `y` (x strikes first if it has first strike and y doesn't)? */
function survives(x: Stats, y: Stats): boolean {
  if (!kills(y, x)) return true;
  const xFirst = (x.kw('First Strike') || x.kw('Double Strike')) && !(y.kw('First Strike') || y.kw('Double Strike'));
  return xFirst && kills(x, y);
}

const firstStrikes = (s: Stats) => s.kw('First Strike') || s.kw('Double Strike');

/** Does `x` get to deal its combat damage to `y`, i.e. `y` doesn't kill it first with first strike? */
function strikesBack(x: Stats, y: Stats): boolean {
  return !(firstStrikes(y) && !firstStrikes(x) && kills(y, x));
}

/** `x` kills `y` in a fight between them, first strike included (a 2/1 never kills a first striker that kills it first). */
function killsInCombat(x: Stats, y: Stats): boolean {
  return kills(x, y) && strikesBack(x, y);
}

/** Can `b` block `a` (evasion keywords; a cheap version of blockError that works in any step)? */
function canBlockKw(a: Stats, b: Stats): boolean {
  if (!b.creature) return false;
  if (a.kw('Unblockable')) return false;
  if (a.kw('Flying') && !b.kw('Flying') && !b.kw('Reach')) return false;
  if (a.kw('Shadow') && !b.kw('Shadow')) return false;
  if (a.kw('Horsemanship') && !b.kw('Horsemanship')) return false;
  return true;
}

// ------------------------------------------------------------------ who acts

/**
 * Does `pid` have something to do right now (answer a question, decide a mulligan, resolve a scry, hold priority,
 * answer the opponent's undo / fix-mode / free-mulligan request)? Works on the state or the seat's view.
 */
export function botNeedsToAct(g: GameState | GameView, pid: string): boolean {
  if (g.phase === 'over') return false;
  const p = g.players.find((x) => x.pid === pid);
  if (!p || p.conceded) return false;
  if (g.undoRequest && g.undoRequest !== pid) return true;
  if (g.fixMode && !g.fixMode.on && g.fixMode.requestedBy && g.fixMode.requestedBy !== pid) return true;
  if (g.freeMulligan && !g.freeMulligan.on && g.freeMulligan.requestedBy && g.freeMulligan.requestedBy !== pid && g.phase === 'mulligan') return true;
  // Before the opening hands (Arcane Savant, engine/pregame.ts): only the questions; mulligans wait for them.
  if (g.phase === 'mulligan' && (g.pregame || g.pending.length)) return g.pending.some((q) => q.pid === pid);
  if (g.phase === 'mulligan') return !p.kept || p.needsBottom > 0;
  const cb = g.controlledBy?.active ? g.controlledBy : null;
  if (cb && cb.pid === pid) return false; // the opponent plays this turn for us (Mindslaver)
  const actsFor = (x: string) => x === pid || (cb?.by === pid && cb.pid === x);
  if (g.pending.length) return g.pending.some((q) => actsFor(q.pid));
  if (p.peek) return true;
  if (cb?.by === pid && g.players.find((x) => x.pid === cb.pid)?.peek) return true;
  return actsFor(g.priority);
}

// ------------------------------------------------------------------ main entry

/**
 * The bot's next action for seat `pid`, from that seat's view (viewFor(state, pid)). null = nothing to do.
 * Never returns an action already refused at this state (see botActionFailed); falls back to passing priority.
 */
export function decideBotAction(v: View, pid: string, mem: BotMemory, opts: BotOptions = {}): GameAction | null {
  const L = opts.lookup ?? getCard;
  const level = opts.level ?? 'normal';
  const ctx: Ctx = { v, pid, mem, L, level, cap: opts.maxActionsPerStep ?? MAX_ACTIONS_PER_STEP };
  const ok = (a: GameAction | null | undefined): GameAction | null => (a && !failed(mem, v, actionKey(a)) ? a : null);
  if (v.phase === 'over') return null;
  const self = me(v, pid);
  if (!self || self.conceded) return null;

  // Requests from the opponent.
  if (v.undoRequest && v.undoRequest !== pid) {
    if (mem.undoTurn !== v.turn) { mem.undoTurn = v.turn; mem.undos = 0; }
    const accept = mem.undos < 3;
    if (accept) {
      mem.undos++;
      // The game goes back: forget plans and refusals made for states that may come again.
      mem.failedSeq = -1; mem.failed = []; mem.attackPlan = null; mem.blockPlan = null;
    }
    return ok({ t: 'answerUndo', accept }) ?? ok({ t: 'answerUndo', accept: !accept });
  }
  if (v.fixMode && !v.fixMode.on && v.fixMode.requestedBy && v.fixMode.requestedBy !== pid) return ok({ t: 'answerFixMode', accept: true }) ?? ok({ t: 'answerFixMode', accept: false });
  if (v.phase === 'mulligan') {
    if (v.freeMulligan && !v.freeMulligan.on && v.freeMulligan.requestedBy && v.freeMulligan.requestedBy !== pid) return ok({ t: 'answerFreeMulligan', accept: true }) ?? ok({ t: 'answerFreeMulligan', accept: false });
    // Pre-game questions (Arcane Savant: which sideboard card to exile) come before the mulligan decision.
    const pre = v.pending.find((x) => x.pid === pid);
    if (pre) return answerPending(ctx, pre);
    if (v.pregame || v.pending.length) return null;
    return mulliganAction(ctx, self);
  }
  if (v.phase !== 'playing') return null;

  const cb = v.controlledBy?.active ? v.controlledBy : null;
  if (cb && cb.pid === pid) return null;
  if (cb && cb.by === pid) {
    // We control the opponent's turn (Mindslaver): keep it simple — answer its questions with the first option, pass.
    const q = v.pending.find((x) => x.pid === cb.pid);
    if (q) return firstOk(ctx, q.options.map((o) => ({ t: 'choose', id: q.id, value: o.value, as: cb.pid }) as GameAction));
    const slave = v.players.find((x) => x.pid === cb.pid);
    if (slave?.peek) return ok({ t: 'resolvePeek', top: slave.peek.iids.slice(), bottom: [], graveyard: [], hand: [], battlefield: [], exile: [], shuffle: false, as: cb.pid });
    if (v.priority === cb.pid && !v.pending.length) return ok({ t: 'pass', as: cb.pid });
  }

  const q = v.pending.find((x) => x.pid === pid);
  if (q) return answerPending(ctx, q);
  if (v.pending.length) return null;
  if (self.peek) return resolvePeek(ctx, self);
  if (v.priority !== pid) return null;
  return priorityAction(ctx);
}

interface Ctx { v: View; pid: string; mem: BotMemory; L: Lookup; level: BotLevel; cap: number }

function firstOk(ctx: Ctx, list: GameAction[]): GameAction | null {
  for (const a of list) if (!failed(ctx.mem, ctx.v, actionKey(a))) return a;
  return null;
}

// ------------------------------------------------------------------ mulligans

function mulliganAction(ctx: Ctx, self: ViewPlayer): GameAction | null {
  const { v, L } = ctx;
  const hand = self.zones.hand;
  if (!self.kept) {
    const lands = hand.filter((iid) => { const c = visible(v, iid); return !!c && safe(() => isLandCard(c, L), false); }).length;
    const size = hand.length;
    const good = self.mulligans >= 2 || (size >= 7 ? lands >= 2 && lands <= 5 : lands >= 1 && lands <= Math.min(5, size - 1));
    return firstOk(ctx, good ? [{ t: 'keep' }, { t: 'mulligan' }] : [{ t: 'mulligan' }, { t: 'keep' }]);
  }
  if (self.needsBottom > 0) {
    // Keep ~3 lands (of 6) and the cheapest spells.
    const scored = hand.map((iid) => {
      const c = visible(v, iid);
      const d = c?.cardId ? L(c.cardId) : undefined;
      const land = !!c && safe(() => isLandCard(c, L), false);
      return { iid, land, cmc: d?.cmc ?? 0, power: d ? safe(() => cardPower(d), 0.3) : 0 };
    });
    const lands = scored.filter((s) => s.land);
    const spells = scored.filter((s) => !s.land);
    const keepN = hand.length - self.needsBottom;
    const wantLands = Math.min(lands.length, Math.max(2, Math.round(keepN * 0.45)));
    const keep = new Set<string>([...lands.slice(0, wantLands).map((s) => s.iid)]);
    spells.sort((a, b) => (a.cmc - b.cmc) || (b.power - a.power));
    for (const s of [...spells, ...lands.slice(wantLands)]) if (keep.size < keepN) keep.add(s.iid);
    return firstOk(ctx, [{ t: 'bottom', iids: hand.filter((iid) => !keep.has(iid)) }]);
  }
  return null;
}

// ------------------------------------------------------------------ scry / surveil / looks

function resolvePeek(ctx: Ctx, self: ViewPlayer): GameAction | null {
  const { v, pid, L } = ctx;
  const peek = self.peek!;
  const r = { top: [] as string[], bottom: [] as string[], graveyard: [] as string[], hand: [] as string[], battlefield: [] as string[], exile: [] as string[], shuffle: false };
  const lands = landsOnBattlefield(v, pid, L) + self.zones.hand.filter((iid) => { const c = visible(v, iid); return !!c && safe(() => isLandCard(c, L), false); }).length;
  for (const iid of peek.iids) {
    if (peek.mode !== 'scry' && peek.mode !== 'surveil') { if (peek.mode !== 'search') r.top.push(iid); continue; }
    const c = visible(v, iid);
    const d = c?.cardId ? L(c.cardId) : undefined;
    const land = !!c && safe(() => isLandCard(c, L), false);
    const keep = land ? lands < 5 : !!d && d.cmc <= lands + 2;
    (keep ? r.top : peek.mode === 'scry' ? r.bottom : r.graveyard).push(iid);
  }
  const a: GameAction = { t: 'resolvePeek', ...r };
  if (!failed(ctx.mem, v, actionKey(a))) return a;
  return { t: 'resolvePeek', top: peek.mode === 'search' ? [] : peek.iids.slice(), bottom: [], graveyard: [], hand: [], battlefield: [], exile: [], shuffle: false };
}

// ------------------------------------------------------------------ questions

const HARMFUL_PROMPT = /discard|sacrifice|exile|destroy|bottom|lose|mill|return .* to (its owner's|your) hand|counter|tap|damage|put .* into (your|its owner's) graveyard/i;
const BENEFIT_PROMPT = /search|to your hand|onto the battlefield|keep|return .* from your graveyard|draw|create|put .*counter/i;

function answerPending(ctx: Ctx, q: Pending): GameAction | null {
  const { v, pid, mem, L } = ctx;
  const opts = q.options;
  // Choose targets.
  if (q.targets && !failed(mem, v, `ctany:${q.id}`)) {
    const picked = pickTargets(ctx, q.targets.specs, q.targets.controller, q.targets.sourceIid, q.prompt + ' ' + q.targets.label, undefined);
    if (picked) {
      const a: GameAction = { t: 'chooseTargets', id: q.id, targets: picked.targets };
      if (!failed(mem, v, actionKey(a))) return a;
    }
  }
  // The best guess was refused or would only hurt us: the question's own options (a "no target" choice ...), else
  // random legal targets — a mandatory trigger must be answered even when every target is ours.
  const randomTargets = (): GameAction | null => {
    if (!q.targets) return null;
    for (let k = 0; k < 4; k++) {
      const random = pickTargets(ctx, q.targets.specs, q.targets.controller, q.targets.sourceIid, q.prompt, undefined, true);
      if (!random) return null;
      const a: GameAction = { t: 'chooseTargets', id: q.id, targets: random.targets };
      if (!failed(mem, v, actionKey(a))) return a;
    }
    return null;
  };
  if (q.targets && !opts.length) return randomTargets();
  // Divide damage / counters: the suggested split, else an even split of our own.
  if (q.divide) {
    const list: GameAction[] = opts.map((o) => ({ t: 'choose', id: q.id, value: o.value }));
    const d = q.divide;
    if (d.targets.length) {
      const split: Record<string, number> = {};
      let left = d.total;
      d.targets.forEach((t, i) => { const n = i === d.targets.length - 1 ? left : Math.max(d.min, Math.floor(d.total / d.targets.length)); split[t.key] = n; left -= n; });
      list.push({ t: 'choose', id: q.id, value: JSON.stringify(split) });
    }
    return firstOk(ctx, list);
  }
  // Choose a number.
  if (q.number) {
    const { min, max } = q.number;
    const low = /pay|life|discard|sacrifice|lose/i.test(q.prompt);
    const nums = low ? [min, max] : [max, min];
    return firstOk(ctx, [...nums.map((n) => ({ t: 'choose', id: q.id, value: String(n) }) as GameAction), ...opts.map((o) => ({ t: 'choose', id: q.id, value: o.value }) as GameAction)]);
  }
  if (!opts.length) return null;
  const ranked = rankOptions(ctx, q).map((value) => ({ t: 'choose', id: q.id, value }) as GameAction);
  return firstOk(ctx, ranked) ?? randomTargets();
  void pid; void L;
}

/** Order a question's options, best first. */
function rankOptions(ctx: Ctx, q: Pending): string[] {
  const { v, pid, L, level, mem } = ctx;
  const self = me(v, pid);
  const harmful = HARMFUL_PROMPT.test(q.prompt) && !BENEFIT_PROMPT.test(q.prompt);
  const scored = q.options.map((o, i) => {
    const val = o.value;
    const lbl = o.label;
    let s = -i * 0.01; // stable: earlier options first
    const card = v.cards[val];
    if (card) {
      const mine = (card.zone === 'battlefield' ? card.controller : card.owner) === pid;
      const cv = card.zone === 'battlefield' ? stats(v, val, L).value : cardValue(v, pid, val, L);
      const cleanup = /cleanup|hand size/i.test(q.prompt);
      // A card from our sideboard (Arcane Savant's pre-game exile): the most powerful one, to cast for free later.
      if (card.zone === 'sideboard' && mine) s += 5 + cv;
      else if (/legend rule/i.test(q.prompt)) s += (/tapped/.test(lbl) ? 0 : 1) + cv * 0.01;
      else if (cleanup || harmful) s += mine ? 10 - cv : cv; // lose our worst / the opponent's best
      else s += mine ? cv : -cv + 5;
    } else if (/^(yes|pay|ok|keep|reveal|untap)$/i.test(val)) {
      s += 5;
      if (val === 'pay' && /life/i.test(lbl)) s += self.life > 10 ? 0 : -10;
    } else if (/^(no|decline|none|done|cancel|skip)$/i.test(val)) {
      s += harmful ? 6 : 1;
    } else if (val === 'top') s += 2;
    if (level === 'easy') s += rand(mem) * 2;
    return { val, s };
  });
  return scored.sort((a, b) => b.s - a.s).map((x) => x.val);
}

// ------------------------------------------------------------------ targets

type Polarity = 'harm' | 'help';

/** Is this targeting step bad for what it targets (removal, burn, discard) or good (pump, aura, regrowth)? */
function polarity(step: ParsedAbility | undefined, spec: TargetSpec, text: string): Polarity {
  const p = step?.params ?? {};
  const api = step?.api ?? '';
  if (/OppCtrl|Opponent/.test(spec.valid)) return 'harm';
  if (p.IsCurse === 'True') return 'harm';
  if (/YouCtrl|\bYou\b|YouOwn/.test(spec.valid)) return 'help';
  switch (api) {
    case 'DealDamage': case 'Destroy': case 'Counter': case 'Tap': case 'Debuff': case 'Sacrifice': case 'Discard': case 'LoseLife':
    case 'Mill': case 'GainControl': case 'Fight': case 'SetLife': case 'TapOrUntap': case 'Bounce': case 'MustBlock':
      return 'harm';
    case 'Pump': case 'PumpAll': {
      const a = p.NumAtt ?? '';
      return /^-/.test(a) || /^-/.test(p.NumDef ?? '') ? 'harm' : 'help';
    }
    case 'PutCounter': return /M1M1|STUN/i.test(p.CounterType ?? '') ? 'harm' : 'help';
    case 'ChangeZone': {
      const origin = p.Origin ?? '';
      const dest = p.Destination ?? '';
      if (/Graveyard/.test(origin) && /Hand|Battlefield/.test(dest)) return 'help';
      return 'harm';
    }
    case 'Untap': case 'Regenerate': case 'Protection': case 'ProtectionAll': case 'GainLife': case 'Draw': case 'Animate': case 'CopyPermanent':
      return 'help';
    case 'Attach': return /can't (attack|block)|doesn't untap|gets -|loses all abilities/i.test(text) ? 'harm' : 'help';
  }
  return /destroy|exile|damage|-\d|can't|counter target|discard|sacrifice/i.test(text) ? 'harm' : 'help';
}

function damageOf(step: ParsedAbility | undefined, x: number): number {
  const n = step?.params.NumDmg;
  if (!n) return 0;
  if (/^\d+$/.test(n)) return parseInt(n, 10);
  if (n === 'X' || /xPaid/i.test(step?.svars?.[n] ?? '')) return x;
  return 0;
}

function candidates(v: View, spec: TargetSpec, controller: string, src: string | undefined, L: Lookup): TargetRef[] {
  const refs: TargetRef[] = [];
  if (spec.players) for (const p of v.players) if (!p.conceded) refs.push({ kind: 'player', pid: p.pid });
  if (spec.zone === 'stack') for (const s of v.stack) refs.push({ kind: 'stack', id: s.id });
  else if (spec.cards) for (const iid of Object.keys(v.cards)) refs.push({ kind: 'card', iid });
  return refs.filter((r) => safe(() => isValidTarget(asState(v), spec, r, controller, src, L), false));
}

interface TargetPick { targets: TargetRef[][]; value: number }

/**
 * Targets for each spec, best first: harmful effects at the opponent's most valuable things (burn at what it kills,
 * or the face when that's lethal), helpful ones at our own. null when a required target is missing or a harmful
 * effect would have to hit our own stuff.
 */
function pickTargets(ctx: Ctx, specs: TargetSpec[], controller: string, src: string | undefined, text: string, ability: ParsedAbility | undefined, random = false, x = 0, modes?: string[]): TargetPick | null {
  const { v, pid, L, level, mem } = ctx;
  const steps = ability ? safe(() => flatten(ability, modes), [] as ParsedAbility[]) : [];
  const out: TargetRef[][] = [];
  let total = 0;
  const used = new Set<string>();
  const opp = opponents(v, pid)[0];
  for (const spec of specs) {
    const step = steps[spec.step];
    const pol = polarity(step, spec, `${step?.description ?? ''} ${text}`);
    const dmg = damageOf(step, x);
    const cands = candidates(v, spec, controller, src, L).filter((r) => !used.has(refKey(r)));
    const scored = cands.map((r) => ({ r, s: scoreTarget(v, pid, r, pol, dmg, L) }));
    if (random || level === 'easy') for (const c of scored) c.s += (random ? 20 : 3) * rand(mem);
    scored.sort((a, b) => b.s - a.s);
    const good = scored.filter((c) => c.s > 0);
    const want = Math.max(spec.min, Math.min(spec.max, good.length || (spec.min > 0 ? spec.min : 0)));
    if (cands.length < spec.min) return null;
    const chosen = (good.length >= want ? good : scored).slice(0, Math.max(spec.min, Math.min(want, spec.max)));
    if (chosen.length < spec.min) return null;
    // A required harmful target that only hits our own side: don't do it.
    if (!random && chosen.some((c) => c.s <= -50) && spec.min > 0) return null;
    for (const c of chosen) { used.add(refKey(c.r)); total += c.s; }
    out.push(chosen.map((c) => c.r));
    void opp;
  }
  return { targets: out, value: total };
}

function refKey(r: TargetRef): string {
  return r.kind === 'player' ? `p:${r.pid}` : r.kind === 'card' ? `c:${r.iid}` : `s:${r.id}`;
}

/** How good a target is for an effect of this polarity (> 0 good, <= -50 hurts us). */
function scoreTarget(v: View, pid: string, r: TargetRef, pol: Polarity, dmg: number, L: Lookup): number {
  if (r.kind === 'player') {
    const p = v.players.find((x) => x.pid === r.pid)!;
    const mine = r.pid === pid;
    if (pol === 'harm') {
      if (mine) return -60;
      if (dmg && dmg >= p.life) return 100; // lethal burn
      return dmg ? 0.5 + dmg * 0.3 : 2;
    }
    return mine ? 3 : -60;
  }
  if (r.kind === 'stack') {
    const it = v.stack.find((s) => s.id === r.id);
    if (!it) return 0;
    const mine = it.controller === pid;
    const val = it.iid ? (v.cards[it.iid] && !isHidden(v.cards[it.iid]) ? cardValue(v, pid, it.iid, L) + 1 : 3) : 2;
    return pol === 'harm' ? (mine ? -60 : val) : (mine ? val : -60);
  }
  const c = v.cards[r.iid];
  if (!c) return 0;
  const owner = c.zone === 'battlefield' || c.zone === 'stack' ? c.controller : c.owner;
  const mine = owner === pid;
  if (c.zone !== 'battlefield') {
    const val = isHidden(c) ? 2 : cardValue(v, pid, r.iid, L);
    // Graveyard / exile cards: return ours, exile theirs.
    if (pol === 'help') return mine ? val : -1;
    return mine ? -2 : val * 0.5;
  }
  const st = stats(v, r.iid, L);
  if (pol === 'harm') {
    if (mine) return -60 - st.value;
    if (dmg) {
      if (!st.creature) return safe(() => faceOf(c as CardInstance, L).types.includes('Planeswalker'), false) ? (dmg >= ((c as CardInstance).counters.loyalty ?? 0) ? st.value : 1) : -5;
      return kills({ ...st, p: dmg, kw: () => false } as Stats, st) ? st.value + 2 : 0.2;
    }
    return st.value;
  }
  if (!mine) return -60;
  return st.creature ? st.value : 0.5;
}

// ------------------------------------------------------------------ priority

function stepKey(v: View) { return `${v.turn}|${v.step}`; }

function priorityAction(ctx: Ctx): GameAction {
  const { v, pid, mem } = ctx;
  if (mem.stepKey !== stepKey(v)) { mem.stepKey = stepKey(v); mem.stepActions = 0; }
  if (mem.abilityTurn !== v.turn) { mem.abilityTurn = v.turn; mem.usedAbilities = []; }
  const mine = v.activePlayer === pid;
  const pass: GameAction = { t: 'pass' };

  // Combat declarations.
  if (v.step === 'attackers' && mine && !v.combat.attackersDeclared) {
    const a = attackAction(ctx);
    if (a) return a;
    return pass;
  }
  if (v.step === 'blockers' && !mine && !v.combat.blockersDeclared) {
    if (failed(mem, v, 'pass')) {
      // The block was refused (menace ...): take our blocks back and don't block.
      const back = v.battlefield.find((iid) => { const c = v.cards[iid]; return c.controller === pid && c.blocking; });
      if (back) return { t: 'declareBlocker', iid: back, attacker: null };
      mem.blockPlan = { key: `${v.turn}|none`, blocks: [] };
      return pass;
    }
    // Before blocking: held instant-speed removal (spells or abilities) at an attacker.
    if (ctx.level !== 'easy' && mem.stepActions < ctx.cap && !mem.blockPlan?.key.startsWith(`${v.turn}|`)) {
      const kill = bestSpell(ctx, false) ?? abilityAction(ctx, false);
      if (kill) return kill;
    }
    const b = blockAction(ctx);
    if (b) return b;
    return pass;
  }

  if (mem.stepActions >= ctx.cap) return pass;
  const main = (v.step === 'main1' || v.step === 'main2') && mine && v.stack.length === 0;
  if (main) {
    const land = landAction(ctx);
    if (land) return land;
  }
  if (ctx.level === 'easy' && main && rand(mem) < 0.15) return pass;
  const spell = bestSpell(ctx, main);
  if (spell) return spell;
  const ab = abilityAction(ctx, main);
  if (ab) return ab;
  return pass;
}

// ------------------------------------------------------------------ lands

function landAction(ctx: Ctx): GameAction | null {
  const { v, pid, L } = ctx;
  if (safe(() => landPlaysLeft(v, pid, L), 0) <= 0) return null;
  const self = me(v, pid);
  const lands = self.zones.hand.filter((iid) => {
    const c = visible(v, iid);
    if (!c?.cardId) return false;
    const d = L(c.cardId);
    return !!d && d.types.includes('Land') && d.layout !== 'modal_dfc' && !failed(ctx.mem, v, `land:${iid}`) && safe(() => castability(v, pid, iid, L).ok, false);
  });
  if (!lands.length) return null;
  // Colors the hand's spells need that our lands don't make yet.
  const have = new Set<string>();
  for (const iid of v.battlefield) {
    const c = visible(v, iid);
    if (c?.controller === pid && c.cardId) for (const m of L(c.cardId)?.producedMana ?? []) have.add(m);
  }
  const need = new Map<string, number>();
  for (const iid of self.zones.hand) {
    const c = visible(v, iid);
    const d = c?.cardId ? L(c.cardId) : undefined;
    if (!d || d.types.includes('Land')) continue;
    for (const s of parseManaSymbols(d.manaCost)) for (const col of 'WUBRG') if (s.includes(col) && !have.has(col)) need.set(col, (need.get(col) ?? 0) + 1);
  }
  const score = (iid: string) => {
    const d = L(visible(v, iid)!.cardId!)!;
    let s = 0;
    for (const m of d.producedMana) s += (need.get(m) ?? 0) * 2 + (have.has(m) ? 0.2 : 0.5);
    if (/enters (the battlefield )?tapped/i.test(d.oracle) && !/unless/i.test(d.oracle)) s -= 0.3;
    return s;
  };
  lands.sort((a, b) => score(b) - score(a));
  return { t: 'playLand', iid: lands[0] };
}

// ------------------------------------------------------------------ spells

interface SpellChoice { action: GameAction; value: number }

function faceData(d: CardData, face: number | undefined) {
  const f = face != null && d.faces ? d.faces[face] : undefined;
  return {
    typeLine: f?.typeLine ?? d.typeLine, oracle: f?.oracle ?? d.oracle, power: f?.power ?? d.power, toughness: f?.toughness ?? d.toughness,
    manaCost: f?.manaCost ?? d.manaCost,
  };
}

/** The most valuable spell we can cast now (main phase: anything; otherwise instant-speed only by castability). */
function bestSpell(ctx: Ctx, main: boolean): GameAction | null {
  const { v, pid, L, mem } = ctx;
  const self = me(v, pid);
  const opp = opponents(v, pid)[0];
  const zones = [...self.zones.hand, ...self.zones.graveyard, ...self.zones.exile];
  const choices: SpellChoice[] = [];
  for (const iid of zones) {
    const c = visible(v, iid);
    if (!c?.cardId) continue;
    const d = L(c.cardId);
    if (!d || (d.types.includes('Land') && d.layout !== 'modal_dfc')) continue;
    if (!safe(() => castability(v, pid, iid, L).ok, false)) continue;
    let faces: (number | undefined)[] = d.faces && ['modal_dfc', 'adventure', 'split'].includes(d.layout) ? safe(() => castableFaces(d), [0]) : [undefined];
    // Rooms: cast the cheaper door (the other one is unlocked later, abilityAction); the costlier one only when it's
    // the only door we can pay for.
    const room = safe(() => isRoomCard(c.cardId), false);
    if (room) faces = [...faces].sort((a, b) => cmcOf(d.faces![a ?? 0].manaCost) - cmcOf(d.faces![b ?? 0].manaCost));
    const before = choices.length;
    for (const face of faces) {
      if (room && choices.length > before) break;
      const fd = faceData(d, face);
      if (/\bLand\b/.test(fd.typeLine)) continue;
      const options = safe(() => castOptions(asState(v), iid, face, L, pid), []);
      for (const o of options) {
        if (o.unavailable) continue;
        if (c.zone === 'hand' && o.id !== 'normal' && !/kicker|kicked/i.test(o.id)) continue; // alternative costs: keep it simple
        if (failed(mem, v, `cast:${iid}:${face ?? ''}:${o.id === 'normal' ? '' : o.id}`)) continue;
        const ch = planSpell(ctx, iid, c, d, face, o.id, main, opp);
        if (ch) choices.push(ch);
      }
    }
  }
  if (!choices.length) return null;
  if (ctx.level === 'easy') return choices[Math.floor(rand(mem) * choices.length)].action;
  choices.sort((a, b) => b.value - a.value);
  return choices[0].action;
}

function planSpell(ctx: Ctx, iid: string, c: CardInstance, d: CardData, face: number | undefined, costOption: string, main: boolean, opp: ViewPlayer | undefined): SpellChoice | null {
  const { v, pid, L } = ctx;
  const fd = faceData(d, face);
  const types = fd.typeLine;
  const permanent = /\b(Creature|Artifact|Enchantment|Planeswalker|Battle)\b/.test(types);
  const instant = /\bInstant\b/.test(types) || /\bFlash\b/i.test(fd.oracle);
  // Outside our main phase only instants: at the opponent's end step, or in response to their spell.
  const oppEnd = v.step === 'end' && v.activePlayer !== pid && v.stack.length === 0;
  const responding = v.stack.length > 0 && v.stack[v.stack.length - 1].controller !== pid;
  const combat = oppCombat(v, pid);
  if (!main && !instant) return null;
  if (!main && !oppEnd && !responding && !/\bInstant\b/.test(types)) return null;
  const sp = safe(() => castSpellAbility(c.cardId!, face ?? 0, costOption === 'normal' ? undefined : costOption), undefined);
  // X: as big as we can pay.
  let x: number | undefined;
  if (/\{X\}/.test(fd.manaCost)) {
    // every source at its biggest option (Mana Crypt: 2, Grim Monolith: 3), plus floating mana
    const maxX = safe(() => manaSources(v, pid, L).reduce((n, src) => n + Math.max(0, ...src.options.map((o) => o.produces.length)), 0), 0) + Object.values(me(v, pid).manaPool).reduce((a, b) => a + b, 0);
    for (let k = maxX; k >= 1; k--) {
      if (safe(() => autoPayPreview(v, pid, iid, face, costOption, k, L).ok, false)) { x = k; break; }
    }
    if (!x) return null;
  } else if (!safe(() => autoPayPreview(v, pid, iid, face, costOption, undefined, L).ok, false)) {
    if (!safe(() => autoPayPreview(v, pid, iid, face, costOption, undefined, L, 'life').ok, false) || me(v, pid).life <= 8) return null;
  }
  // Modes (charms): the first `min` modes whose targets exist, best single mode first.
  let modes: string[] | undefined;
  let specs: TargetSpec[] = [];
  let targets: TargetRef[][] = [];
  let targetValue = 0;
  const ab = sp?.ability;
  if (ab?.choices?.length) {
    const min = Math.max(1, ab.charmMin ?? 1);
    const scoredModes = ab.choices.map((ch) => {
      const sp2 = safe(() => targetSpecs(ab, [ch.name]), [] as TargetSpec[]);
      const pick = sp2.length ? pickTargets(ctx, sp2, pid, iid, ch.ability.description, ab, false, x ?? 0, [ch.name]) : { targets: [], value: 1 };
      return { name: ch.name, ok: !!pick, value: pick?.value ?? -1 };
    }).filter((m) => m.ok).sort((a, b) => b.value - a.value);
    if (scoredModes.length < min) return null;
    modes = scoredModes.slice(0, min).map((m) => m.name);
  }
  if (ab) {
    specs = safe(() => targetSpecs(ab, modes), [] as TargetSpec[]);
    if (specs.length) {
      const pick = pickTargets(ctx, specs, pid, iid, fd.oracle, ab, false, x ?? 0, modes);
      if (!pick) return null;
      targets = pick.targets;
      targetValue = pick.value;
    }
  }
  // A permanent whose enters trigger removes a target (Journey to Nowhere, Banisher Priest ...) waits for a target.
  const etb = /\bwhen [^.]*enters[^.]*?(exile|destroy|deals? \d+ damage to|return) (up to one )?(another )?target ([a-z ]*?)(creature|permanent|artifact|enchantment|planeswalker)/i.exec(fd.oracle);
  if (permanent && etb && !etb[2]) {
    const kind = etb[5].toLowerCase();
    const theirs = v.battlefield.some((b) => {
      const oc = v.cards[b];
      if (!oc || oc.controller === pid) return false;
      if (isHidden(oc)) return kind === 'creature' || kind === 'permanent';
      const t = safe(() => faceOf(oc as CardInstance, L).types, [] as string[]);
      return kind === 'permanent' ? !t.includes('Land') : t.some((x) => x.toLowerCase() === kind);
    });
    if (!theirs) return null;
  }
  // Value.
  let value: number;
  const cmc = d.layout === 'split' && face != null ? cmcOf(fd.manaCost) : d.cmc; // a split card / Room: the cast half
  if (/\bCreature\b/.test(types)) {
    const p = parseInt(fd.power ?? '0', 10) || 0, t = parseInt(fd.toughness ?? '0', 10) || 0;
    value = 2 + p * 1.2 + t * 0.8 + cmc + (x ?? 0);
    if (!main) value = oppEnd ? value : 0;
  } else if (/\bPlaneswalker\b/.test(types)) value = 8 + cmc;
  else if (specs.length) {
    // Targeted: worth what it hits. Pump-like temporary effects aren't cast in the main phase.
    const steps = safe(() => flatten(ab!, modes), [] as ParsedAbility[]);
    const pols = specs.map((s) => polarity(steps[s.step], s, fd.oracle));
    const tempPump = !permanent && pols.every((p) => p === 'help') && steps.some((s) => s.api === 'Pump');
    if (tempPump) return null;
    if (targetValue <= 0.3) return null;
    const lethal = targetValue >= 100;
    value = lethal ? 1000 : targetValue + (permanent ? cmc : 0);
    // Burn at the face only when it's lethal or late (the opponent is low).
    const atFace = targets.flat().some((r) => r.kind === 'player' && r.pid !== pid);
    if (atFace && !lethal && pols[0] === 'harm' && (opp?.life ?? 20) > 6 && v.stack.length === 0) return null;
    // Counterspells only in response to something worth countering.
    if (targets.flat().some((r) => r.kind === 'stack') && targetValue < 3) return null;
    // Hold up instant-speed removal: on our turn only for a real threat; otherwise wait for the opponent's combat
    // (kill an attacker) or their end step, not their upkeep or draw step.
    const harmsCreature = pols[0] === 'harm' && targets.flat().some((r) => r.kind === 'card');
    if (ctx.level !== 'easy' && /\bInstant\b/.test(types) && harmsCreature && !lethal) {
      if (main && targetValue < 9) return null;
      if (!main && !responding && !combat && !oppEnd) return null;
    }
  } else {
    if (responding) return null; // nothing to respond with
    value = 1 + cmc + (permanent ? 1 : 0) + safe(() => cardPower(d), 0.3) * 2;
  }
  if (value <= 0) return null;
  // Keep counterspell mana up: in our main phase, don't tap below what our cheapest counterspell needs for a
  // middling sorcery-speed play (big plays still go ahead).
  if (main && ctx.level !== 'easy' && !instant && value < 9 && v.turn >= 4) {
    const reserve = counterReserve(ctx, iid);
    if (reserve > 0) {
      const untapped = untappedLands(v, pid, L);
      if (untapped >= reserve && untapped - cmc < reserve) return null;
    }
  }
  const a: GameAction = {
    t: 'cast', iid, targets, ...(face != null ? { face } : {}), ...(modes ? { modes } : {}), ...(x ? { x } : {}),
    ...(costOption !== 'normal' ? { costOption } : {}),
  };
  if (!safe(() => autoPayPreview(v, pid, iid, face, costOption, x, L).ok, false)) (a as { phyrexian?: 'life' }).phyrexian = 'life';
  return { action: a, value };
}

/** The opponent is attacking us: attackers are declared and the stack is empty (time for instant-speed removal). */
function oppCombat(v: View, pid: string): boolean {
  const attacking = v.battlefield.some((iid) => !!v.cards[iid]?.attacking);
  return v.activePlayer !== pid && v.step === 'blockers' && attacking && v.stack.length === 0;
}

function untappedLands(v: View, pid: string, L: Lookup): number {
  let n = 0;
  for (const iid of v.battlefield) {
    const c = visible(v, iid);
    if (c && c.controller === pid && !c.tapped && safe(() => faceOf(c, L).types.includes('Land'), false)) n++;
  }
  return n;
}

/** Mana value of the cheapest counterspell in hand (other than `except`), or 0. */
function counterReserve(ctx: Ctx, except: string): number {
  const { v, pid, L } = ctx;
  let best = 0;
  for (const iid of me(v, pid).zones.hand) {
    if (iid === except) continue;
    const c = visible(v, iid);
    const d = c?.cardId ? L(c.cardId) : undefined;
    if (!d || !/\bInstant\b/.test(d.typeLine) || !/counter target (spell|noncreature spell|creature spell)/i.test(d.oracle)) continue;
    if (!best || d.cmc < best) best = d.cmc;
  }
  return best;
}

// ------------------------------------------------------------------ activated abilities

const SINK_APIS = new Set(['Draw', 'DealDamage', 'PutCounter', 'Token', 'Pump', 'Destroy', 'ChangeZone', 'Tap', 'GainLife', 'Scry', 'Surveil', 'LoseLife', 'Mill', 'Dig']);

function abilityAction(ctx: Ctx, main: boolean): GameAction | null {
  const { v, pid, L, mem } = ctx;
  const oppEnd = v.step === 'end' && v.activePlayer !== pid && v.stack.length === 0;
  // During the opponent's attack: removal-like abilities (ping, destroy, tap) at an attacker.
  const combat = oppCombat(v, pid);
  if (!main && !oppEnd && !combat) return null;
  const best: { a: GameAction; value: number }[] = [];
  for (const iid of v.battlefield) {
    const c = visible(v, iid);
    if (!c || c.controller !== pid || c.faceDown) continue;
    const entries = safe(() => abilitiesOfInstance(c, asState(v) as never, L), [] as ActivatedEntry[]);
    const walker = safe(() => faceOf(c, L).types.includes('Planeswalker'), false);
    for (const e of entries) {
      const key = `${iid}:${e.index}`;
      if (mem.usedAbilities.includes(key) || failed(mem, v, `act:${iid}:${e.index}`)) continue;
      if (e.zone) continue;
      if (/Sac<|PayLife<|Discard<|Exile<|ExileFromGrave|Return</.test(e.cost)) continue; // costs that hurt: skip
      if (!walker && /discard|sacrifice|lose \d+ life|deals? \d+ damage to you/i.test(e.ability.description)) continue;
      const isEquip = e.keyword === 'Equip';
      if (e.keyword && !isEquip) continue; // crew, level up ... not handled
      const unlock = e.ability.api === '_Unlock'; // Rooms: unlock the other door whenever we can (sorcery speed)
      if (unlock && !main) continue;
      if (!walker && !isEquip && !unlock && !SINK_APIS.has(e.ability.api)) continue;
      if (!walker && !isEquip && !main && e.ability.api === 'Pump') continue;
      if (combat && !oppEnd && !['DealDamage', 'Destroy', 'Tap'].includes(e.ability.api)) continue;
      if (!safe(() => abilityUsability(v, pid, iid, e.index, L).ok, false)) continue;
      const specs = safe(() => targetSpecs(e.ability), [] as TargetSpec[]);
      let targets: TargetRef[][] = [];
      let value = 1;
      if (specs.length) {
        const pick = pickTargets(ctx, specs, pid, iid, e.ability.description, e.ability, false, 0);
        if (!pick || pick.value <= 0.3) continue;
        targets = pick.targets;
        value = pick.value;
      }
      if (isEquip) {
        if (c.attachedTo && v.cards[c.attachedTo]?.zone === 'battlefield') continue;
        value += 2;
      }
      if (unlock) value = 3 + cmcOf(L(c.cardId ?? '')?.faces?.[parseInt(e.ability.params.Door ?? '0', 10)]?.manaCost ?? '');
      if (walker) {
        const loyalty = c.counters.loyalty ?? 0;
        const l = e.loyalty ?? 0;
        if (loyalty + l <= 0 && l < 0) continue;
        value = l >= 0 ? 3 + l : (specs.length ? value : 2) + (loyalty + l >= 2 ? 1 : -1);
        if (!main) continue;
      }
      if (/\{X\}|X/.test(e.cost) && /\bX\b/.test(e.cost)) continue; // X costs: skip
      best.push({ a: { t: 'activate', iid, text: e.ability.description, ability: e.index, targets }, value });
    }
  }
  if (!best.length) return null;
  best.sort((a, b) => b.value - a.value);
  return best[0].a;
}

// ------------------------------------------------------------------ combat

function attackAction(ctx: Ctx): GameAction | null {
  const { v, pid, mem } = ctx;
  const key = `${v.turn}|${v.step}`;
  if (!mem.attackPlan || mem.attackPlan.key !== key) mem.attackPlan = { key, attacks: planAttacks(ctx) };
  for (const at of mem.attackPlan.attacks) {
    const c = v.cards[at.iid];
    if (!c || c.attacking || c.tapped) continue;
    const a: GameAction = { t: 'declareAttacker', iid: at.iid, target: at.target };
    if (failed(mem, v, actionKey(a))) continue;
    return a;
  }
  return null;
}

function planAttacks(ctx: Ctx): { iid: string; target: string }[] {
  const { v, pid, L, level } = ctx;
  const opp = opponents(v, pid)[0];
  if (!opp) return [];
  const self = me(v, pid);
  const S = asState(v);
  const mineAll = v.battlefield.filter((iid) => { const c = v.cards[iid]; return c.controller === pid && !isHidden(c); });
  const ready = mineAll.filter((iid) => safe(() => attackError(S, pid, iid, opp.pid, L), 'x') == null && safe(() => attackRestriction(S, iid, L), 'x') == null);
  if (!ready.length) return [];
  const st = new Map(ready.map((iid) => [iid, stats(v, iid, L)]));
  const oppCreatures = v.battlefield.filter((iid) => { const c = v.cards[iid]; return c.controller === opp.pid && stats(v, iid, L).creature; });
  const blockers = oppCreatures.filter((iid) => !v.cards[iid].tapped).map((iid) => ({ iid, s: stats(v, iid, L) }));
  // Evaluate each attacker against the opponent's possible blockers.
  const verdict = ready.map((iid) => {
    const a = st.get(iid)!;
    const able = blockers.filter((b) => canBlockKw(a, b.s));
    const menaceSafe = a.kw('Menace') && able.length < 2;
    const unblockable = able.length === 0 || menaceSafe;
    // Safe: no blocker kills it while surviving; good: every block costs them at least as much.
    // Combat math with first strike and deathtouch: a blocker only trades if it gets to deal its damage.
    const badBlock = able.some((b) => survives(b.s, a) && killsInCombat(b.s, a));
    const trade = able.some((b) => killsInCombat(b.s, a));
    const tradeOk = able.every((b) => !killsInCombat(b.s, a) || (killsInCombat(a, b.s) && b.s.value >= a.value * 0.9));
    return { iid, a, unblockable, safe: !trade, good: !badBlock && tradeOk, bad: badBlock };
  });
  // Lethal alpha strike? Each untapped blocker stops one attacker (the biggest ones).
  const powers = verdict.map((x) => x.a.p * (x.a.kw('Double Strike') ? 2 : 1)).sort((a, b) => b - a);
  const evasive = verdict.filter((x) => x.unblockable).reduce((n, x) => n + x.a.p, 0);
  const throughAll = powers.slice(Math.min(blockers.length, powers.length)).reduce((a, b) => a + b, 0);
  const lethal = Math.max(evasive, throughAll) >= opp.life;
  // Racing: when our clock is faster than theirs, attackers that at worst trade keep the pressure on.
  const ourPower = verdict.reduce((n, x) => n + Math.max(0, x.a.p), 0);
  const theirPower = oppCreatures.reduce((n, iid) => n + Math.max(0, stats(v, iid, L).p), 0);
  const turnsToKill = (life: number, power: number) => (power > 0 ? Math.ceil(life / power) : 99);
  const ahead = level !== 'easy' && turnsToKill(opp.life, ourPower) <= 3 && turnsToKill(opp.life, ourPower) < turnsToKill(self.life, theirPower);
  let attackers = lethal ? verdict : verdict.filter((x) => x.a.p > 0 && (x.unblockable || (level === 'easy' ? x.safe : x.safe || x.good || (ahead && !x.bad))));
  // Don't die on the crack-back: keep enough blockers home.
  if (!lethal) {
    const oppPowers = oppCreatures.map((iid) => stats(v, iid, L).p).filter((p) => p > 0).sort((a, b) => b - a);
    const crack = (home: number) => oppPowers.slice(home).reduce((a, b) => a + b, 0);
    const vigilant = (x: typeof verdict[number]) => x.a.kw('Vigilance');
    const stay = () => mineAll.filter((iid) => stats(v, iid, L).creature && (!attackers.some((x) => x.iid === iid) || vigilant(attackers.find((x) => x.iid === iid)!))).length;
    attackers.sort((a, b) => b.a.value - a.a.value);
    while (attackers.length && crack(stay()) >= self.life) attackers = attackers.slice(0, -1);
  }
  // Target: the player; an evasive attacker finishes a planeswalker it can kill instead when the player isn't dying.
  const walkers = v.battlefield.filter((iid) => { const c = visible(v, iid); return !!c && c.controller === opp.pid && safe(() => faceOf(c, L).types.includes('Planeswalker'), false); });
  return attackers.map((x) => {
    let target = opp.pid;
    if (!lethal && x.unblockable) {
      const w = walkers.find((wi) => (v.cards[wi] as CardInstance).counters?.loyalty <= x.a.p && safe(() => attackError(S, pid, x.iid, wi, L), 'x') == null);
      if (w) target = w;
    }
    return { iid: x.iid, target };
  });
}

function blockAction(ctx: Ctx): GameAction | null {
  const { v, pid, mem } = ctx;
  const key = `${v.turn}|${v.step}`;
  if (!mem.blockPlan || mem.blockPlan.key !== key) mem.blockPlan = { key, blocks: planBlocks(ctx) };
  for (const b of mem.blockPlan.blocks) {
    const c = v.cards[b.iid];
    if (!c || c.blocking === b.attacker || c.tapped) continue;
    const a: GameAction = { t: 'declareBlocker', iid: b.iid, attacker: b.attacker };
    if (failed(mem, v, actionKey(a))) continue;
    return a;
  }
  return null;
}

function planBlocks(ctx: Ctx): { iid: string; attacker: string }[] {
  const { v, pid, L, level } = ctx;
  const S = asState(v);
  const self = me(v, pid);
  const attackers = v.battlefield.filter((iid) => {
    const c = v.cards[iid];
    if (!c.attacking) return false;
    const target = c.attacking;
    return target === pid || v.cards[target]?.controller === pid;
  }).map((iid) => ({ iid, s: stats(v, iid, L), atMe: v.cards[iid].attacking === pid }));
  const mine = v.battlefield.filter((iid) => { const c = v.cards[iid]; return c.controller === pid && !c.tapped && !isHidden(c); })
    .map((iid) => ({ iid, s: stats(v, iid, L) })).filter((b) => b.s.creature);
  const can = (b: string, a: string) => safe(() => blockError(S, b, a, L), 'x') == null && safe(() => blockRestriction(S, b, a, L), 'x') == null;
  const free = new Set(mine.map((b) => b.iid));
  const plan: { iid: string; attacker: string }[] = [];
  const blocked = new Set<string>();
  attackers.sort((a, b) => b.s.value - a.s.value);
  const assign = (pickFn: (a: typeof attackers[number], b: typeof mine[number]) => boolean, sortBlockers: (x: typeof mine[number], y: typeof mine[number]) => number) => {
    for (const a of attackers) {
      if (blocked.has(a.iid) || a.s.kw('Menace')) continue;
      const opts = mine.filter((b) => free.has(b.iid) && can(b.iid, a.iid) && pickFn(a, b)).sort(sortBlockers);
      if (!opts.length) continue;
      plan.push({ iid: opts[0].iid, attacker: a.iid });
      free.delete(opts[0].iid);
      blocked.add(a.iid);
    }
  };
  const cheapFirst = (x: typeof mine[number], y: typeof mine[number]) => x.s.value - y.s.value;
  // 1. Free kills: our blocker kills it and survives.
  assign((a, b) => kills(b.s, a.s) && survives(b.s, a.s), cheapFirst);
  if (level !== 'easy') {
    // 2. Safe blocks: our blocker survives (soaks the damage).
    assign((a, b) => survives(b.s, a.s) && a.s.p > 0 && !a.s.kw('Trample'), cheapFirst);
    // 3. Even trades: only when our blocker really deals its damage (no first striker kills it first).
    assign((a, b) => killsInCombat(b.s, a.s) && a.s.value >= b.s.value * 0.9, cheapFirst);
    // 4. Double blocks on a big attacker: two blockers that kill it together, when it can take at most one of them.
    for (const a of attackers) {
      if (blocked.has(a.iid) || a.s.kw('Trample') || a.s.kw('Deathtouch') || a.s.kw('Indestructible')) continue;
      const opts = mine.filter((b) => free.has(b.iid) && can(b.iid, a.iid) && b.s.p > 0).sort(cheapFirst);
      let done = false;
      for (let i = 0; i < opts.length && !done; i++) {
        for (let j = i + 1; j < opts.length && !done; j++) {
          const pair = [opts[i], opts[j]];
          // Damage that lands: a first-striking attacker may kill one blocker before it strikes.
          const fsVictim = firstStrikes(a.s) ? pair.find((b) => !firstStrikes(b.s) && kills(a.s, b.s)) : undefined;
          const dmg = pair.filter((b) => b !== fsVictim).reduce((n, b) => n + (b.s.kw('Deathtouch') ? 99 : b.s.p), 0);
          const killsIt = dmg >= a.s.t - a.s.dmg;
          const losses = pair.filter((b) => kills(a.s, b.s)).sort((x, y) => y.s.value - x.s.value).slice(0, 1).reduce((n, b) => n + b.s.value, 0);
          if (killsIt && a.s.value > losses * 1.2) {
            for (const b of pair) { plan.push({ iid: b.iid, attacker: a.iid }); free.delete(b.iid); }
            blocked.add(a.iid);
            done = true;
          }
        }
      }
    }
  }
  // 5. Chump blocks only when the unblocked damage would kill us: the hardest hitters first, with our cheapest creatures.
  const incoming = () => attackers.filter((a) => a.atMe && (!blocked.has(a.iid) || a.s.kw('Trample'))).reduce((n, a) => n + a.s.p * (a.s.kw('Double Strike') ? 2 : 1), 0);
  if (incoming() >= self.life) {
    attackers.sort((x, y) => y.s.p * (y.s.kw('Double Strike') ? 2 : 1) - x.s.p * (x.s.kw('Double Strike') ? 2 : 1));
    assign((a) => incoming() >= self.life && !a.s.kw('Trample'), cheapFirst);
  }
  return plan;
}

// ------------------------------------------------------------------ driver helper

export interface BotStepResult {
  /** The action that was applied (null: nothing to do, or nothing worked). */
  action: GameAction | null;
  /** Every candidate was refused: the caller should treat the bot as stuck (e.g. concede). */
  stuck: boolean;
  tries: number;
}

/**
 * Decide and apply one bot action: asks decideBotAction, applies it with `apply` (returns an engine error or null),
 * and on a refusal asks again (the refused action is excluded) up to `maxTries` times. `view` must return the seat's
 * current view (viewFor(state, pid)).
 */
export function botStep(view: () => GameView, pid: string, mem: BotMemory, apply: (a: GameAction) => string | null, opts: BotOptions = {}, maxTries = 12): BotStepResult {
  let tries = 0;
  for (; tries < maxTries; tries++) {
    const v = view();
    const a = decideBotAction(v, pid, mem, opts);
    if (!a) {
      if (botNeedsToAct(v, pid)) break; // we must act but found nothing: last resort below
      return { action: null, stuck: false, tries };
    }
    const err = apply(a);
    if (!err) { botActionDone(mem, v, a); return { action: a, stuck: false, tries: tries + 1 }; }
    botActionFailed(mem, a, v.seq);
  }
  // Last resort: any option of our question, else pass.
  const v = view();
  const q = v.pending.find((x) => x.pid === pid);
  const last: GameAction[] = q ? q.options.map((o) => ({ t: 'choose', id: q.id, value: o.value }) as GameAction) : [{ t: 'pass' }];
  for (const a of last) {
    if (!apply(a)) { botActionDone(mem, v, a); return { action: a, stuck: false, tries: tries + 1 }; }
  }
  return { action: null, stuck: true, tries };
}
