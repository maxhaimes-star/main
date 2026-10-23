/**
 * More effect APIs, all automatic, every decision a Pending question for the right player:
 *
 *   Branch / RepeatEach / Repeat / GenericChoice / RollDice   run sub-chains chosen while resolving (resolve.ts "splices")
 *   FlipCoin                                                  one random flip, logged (Win/Lose, Heads/Tails sub-abilities)
 *   Charm without chosen modes (activated / triggered)         asks the modes on resolution
 *   ChooseCard / ChooseNumber                                  Defined$ ChosenCard, Count$ChosenNumber
 *   TapOrUntap, Amass, Proliferate, Connive, Recruit, Empower, Discover, Fight, Explore, MultiplyCounter, ExchangeControl, SetState (transform),
 *   Protection (color choice), PeekAndReveal / Reveal (private looks), DigUntil, CopySpellAbility, Earthbend,
 *   Airbend, Play (cast a card during the resolution: modes + targets asked, cost / free), DamageResolve (no-op).
 *
 * resolve.ts calls execMoreStep() with a MoreRun (its helpers bound to the running chain); answers come back
 * through answerMorePending() (data.kind 'more') and resume the chain with resumeAuto().
 */
import type { CardData, TokenData } from '../cards.ts';
import { getCard, registerCards } from '../cube.ts';
import { cardName, effectivePT, faceOf, isCreature } from '../game/rules.ts';
import { type Ctx, detach, drawCards, emit, log, moveCard, player, randomId, shuffleLibrary, turnStats } from '../game/state.ts';
import type { CardInstance, GameState, StackItem, Zone } from '../game/types.ts';
import { addEffect } from './durations.ts';
import { addExtraCombat } from './combat-rules.ts';
import { canPayCost, parseCostTokens, payCostNow } from './paycost.ts';
import { checkTargets } from './play.ts';
import { tokenMultiplier } from './replacements.ts';
import { addSplice, createTokenInstance, exiledWithSource, lkiOf, resumeAuto } from './resolve.ts';
import { flatten, getScript, INCUBATOR_TOKEN, parseAbility, registerScripts, SCRIPTS, spellAbility, targetSpecs } from './script.ts';
import { isValidTarget, matchCard, type MatchEnv } from './targets.ts';
import type { AutoCont, AutoInfo, ParsedAbility, Pending, TargetRef, TargetSpec } from './types.ts';
import type { UniqueRun } from './unique.ts';
export { MORE_APIS } from './more-support.ts';

interface Objs { cards: string[]; players: string[] }

/** The running chain, as resolve.ts exposes it to this module. */
export interface MoreRun extends UniqueRun {
  index: number;
  env: MatchEnv;
  /** Results of choices made during this resolution (persisted with the continuation). */
  chosen: NonNullable<AutoCont['chosen']>;
  /** Insert an SVar's chain (or a synthesized line) after this step; consecutive calls append in order. Returns the steps added. */
  splice(svar: string, opts?: { remember?: string[]; modes?: string[]; line?: string }): number;
  /** Continuation resuming at step `next` (this step = index). */
  contAt(next: number): AutoCont;
  /** Deal damage from a source to a card iid or player id (prevention, lifelink, triggers). Returns the damage dealt. */
  damage(source: string | undefined, key: string, n: number): number;
  /** Late targets of this step (chosen while resolving), if any. */
  lateTargets(): TargetRef[] | undefined;
}

type Result = 'ok' | 'wait';

const pname = (state: GameState, pid: string) => state.players.find((p) => p.pid === pid)?.name ?? 'someone';
const nm = (state: GameState, ctx: Ctx, iid: string) => (state.cards[iid] ? cardName(state.cards[iid], ctx.lookup) : 'a card');
const names = (state: GameState, ctx: Ctx, iids: string[]) => iids.map((i) => nm(state, ctx, i)).join(', ') || 'nothing';
const isPlayer = (state: GameState, id: string) => state.players.some((p) => p.pid === id);
const COLORS: Record<string, string> = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G' };

function counterKind(forge: string): string {
  const t = forge.trim().toUpperCase();
  if (t === 'P1P1') return '+1/+1';
  if (t === 'M1M1') return '-1/-1';
  if (t === 'LOYALTY') return 'loyalty';
  return t.toLowerCase();
}

function cmp(a: number, expr: string | undefined, right: (s: string) => number | undefined): boolean | undefined {
  const m = /^(LT|LE|EQ|NE|GE|GT)(.+)$/.exec((expr ?? 'GE1').trim());
  if (!m) return undefined;
  const b = /^-?\d+$/.test(m[2]) ? parseInt(m[2], 10) : right(m[2]);
  if (b == null) return undefined;
  switch (m[1]) {
    case 'LT': return a < b;
    case 'LE': return a <= b;
    case 'EQ': return a === b;
    case 'NE': return a !== b;
    case 'GE': return a >= b;
    default: return a > b;
  }
}

/** The ResultSubAbilities$ SVar for a die result: "1:A,2-5:B,Else:C" / "Even:A,Odd:B". */
export function rollResult(spec: string | undefined, n: number): string | undefined {
  let other: string | undefined;
  for (const part of (spec ?? '').split(',')) {
    const k = part.indexOf(':');
    if (k < 0) continue;
    const range = part.slice(0, k).trim();
    const svar = part.slice(k + 1).trim();
    if (/^Else$/i.test(range)) { other = svar; continue; }
    if (/^Even$/i.test(range)) { if (n % 2 === 0) return svar; continue; }
    if (/^Odd$/i.test(range)) { if (n % 2 === 1) return svar; continue; }
    const m = /^(\d+)(?:-(\d+))?(\+)?$/.exec(range);
    if (!m) continue;
    const lo = parseInt(m[1], 10);
    const hi = m[3] ? Infinity : m[2] != null ? parseInt(m[2], 10) : lo;
    if (n >= lo && n <= hi) return svar;
  }
  return other;
}

// ------------------------------------------------------------------ pendings

type MData = { kind: 'more'; m: string; cont: AutoCont; pid: string } & Record<string, unknown>;

function ask(state: GameState, ctx: Ctx, pid: string, prompt: string, options: Pending['options'], data: MData, extra: Partial<Pending> = {}) {
  state.pending.push({ id: randomId(ctx.rng), pid, prompt, options, data: data as unknown as Record<string, unknown>, ...extra });
}

// ------------------------------------------------------------------ Valid$ with run-level properties

/** A card filter for Choices$ / RepeatCards$ etc., with properties that need the run (ExiledWithSource, ControlledBy Remembered ...). */
export function cardFilter(state: GameState, r: MoreRun, valid: string): (c: CardInstance) => boolean {
  const exiledWith = new Set<string>(exiledWithSource(state, r.sourceIid));
  const remembered = new Set(r.remembered);
  const rememberedPlayers = new Set(r.remembered.filter((x) => isPlayer(state, x)));
  const env: MatchEnv = { ...r.env, remembered: r.remembered, chosen: { ...(r.chosen.type ? { type: r.chosen.type } : {}), ...(r.chosen.color ? { color: r.chosen.color } : {}) } };
  const alts = valid.split(',').map((alt) => {
    const checks: ((c: CardInstance) => boolean)[] = [];
    let rest = alt.trim();
    rest = rest.replace(/\+?ControlledBy Remembered/g, () => { checks.push((c) => rememberedPlayers.has(c.controller)); return ''; });
    rest = rest.replace(/\+?(ExiledWithSource|ExiledWithSourceLKI|ExiledWithEffectSource)/g, () => { checks.push((c) => exiledWith.has(c.iid)); return ''; });
    rest = rest.replace(/\+?ActivePlayerCtrl/g, () => { checks.push((c) => c.controller === state.activePlayer); return ''; });
    rest = rest.replace(/\+?IsImprinted/g, () => { checks.push((c) => (r.chosen.imprinted ?? []).includes(c.iid)); return ''; });
    rest = rest.replace(/\+?ChosenCard/g, () => { checks.push((c) => (r.chosen.cards ?? []).includes(c.iid)); return ''; });
    rest = rest.replace(/\+?IsRemembered/g, () => { checks.push((c) => remembered.has(c.iid)); return ''; });
    // Cards noted for a name (NoteCards$ ... NoteCardsFor$: Arcane Savant's pre-game exile, engine/pregame.ts).
    rest = rest.replace(/\+?NotedFor(\w+)/g, (_m, nm: string) => { checks.push((c) => notedFor(state, r.controller, nm).includes(c.iid)); return ''; });
    rest = rest.replace(/\+?DrawnThisTurn/g, () => ''); // not tracked: any card in hand
    rest = rest.replace(/\.$/, '').replace(/\.\+/, '.');
    return { valid: rest || 'Card', checks };
  });
  return (c) => alts.some((a) => matchCard(c, a.valid, env) !== false && a.checks.every((f) => f(c)));
}

function zoneCards(state: GameState, zone: string): string[] {
  const z = zone.trim().toLowerCase();
  if (z === 'battlefield') return [...state.battlefield];
  return state.players.flatMap((p) => [...((p.zones as Record<string, string[]>)[z] ?? [])]);
}

// ------------------------------------------------------------------ steps

/** Run a more.ts step. undefined = not ours. */
export function execMoreStep(state: GameState, ctx: Ctx, r: MoreRun): Result | undefined {
  const step = r.step;
  const p = step.params;
  switch (step.api) {
    case '_Remember': {
      const objs = (p.Objects ?? '').split(',').filter(Boolean);
      for (const iid of objs) if (state.cards[iid] && !r.lki[iid]) r.lki[iid] = lkiOf(state.cards[iid], ctx, state);
      // Mode$ Add / Remove: RepeatEach's per-pass object (Forge adds it before the sub-ability and removes it after).
      if (p.Mode === 'Add') { for (const o of objs) if (!r.remembered.includes(o)) r.remembered.push(o); }
      else if (p.Mode === 'Remove') { const keep = r.remembered.filter((o) => !objs.includes(o)); r.remembered.splice(0, r.remembered.length, ...keep); }
      else r.remembered.splice(0, r.remembered.length, ...objs);
      return 'ok';
    }
    case 'Charm': return askModes(state, ctx, r);
    case 'AddPhase': {
      if (p.ExtraPhase !== 'Combat') { r.manual(); return 'ok'; }
      addExtraCombat(state);
      log(state, ctx, r.controller, `${r.sourceName}: there will be an additional combat phase after this one.`);
      return 'ok';
    }
    case '_Fading': case '_CumUpkeep': case '_Cascade': case '_Storm': case '_LivingWeapon': case '_Ravenous': case '_Backup': case '_PutBottom':
    case '_Madness': case '_ToGraveyard': case '_Replicate': case '_FlashSac':
      return keywordStep(state, ctx, r);
    case '_SetChosenType': r.chosen.type = p.Type; return 'ok';
    case '_Throne': {
      // Undercity's Throne of the Dead Three: reveal the top ten, a creature card among them enters with three +1/+1 counters.
      const me = player(state, r.controller);
      const top = me.zones.library.slice(0, 10);
      log(state, ctx, r.controller, `${me.name} reveals ${names(state, ctx, top)} (Throne of the Dead Three).`);
      const creatures = top.filter((x) => faceOf(state.cards[x], ctx.lookup).types.includes('Creature'));
      if (!creatures.length) { shuffleLibrary(state, me, ctx.rng); return 'ok'; }
      ask(state, ctx, r.controller, 'Throne of the Dead Three: put a creature card onto the battlefield with three +1/+1 counters', creatures.map((x) => ({ value: x, label: nm(state, ctx, x) })),
        { kind: 'more', m: 'throne', cont: r.contAt(r.index + 1), pid: r.controller });
      return 'wait';
    }
    case 'Branch': {
      const raw = p.BranchConditionSVar ?? p.BranchCondition;
      const v = r.amount(raw, 0);
      const res = v == null ? undefined : cmp(v, p.BranchConditionSVarCompare, (s) => r.amount(s, 0));
      if (res == null) { r.manual(); return 'ok'; }
      const sub = res ? p.TrueSubAbility : p.FalseSubAbility;
      if (sub) r.splice(sub);
      return 'ok';
    }
    case 'RepeatEach': return repeatEach(state, ctx, r);
    case 'Repeat': {
      r.splice(p.RepeatSubAbility);
      r.splice('', { line: `DB$ _RepeatCheck | RepeatSubAbility$ ${p.RepeatSubAbility} | RepeatCheckSVar$ ${p.RepeatCheckSVar ?? ''} | RepeatSVarCompare$ ${p.RepeatSVarCompare ?? 'GE1'} | Times$ 1` });
      return 'ok';
    }
    case '_RepeatCheck': {
      const times = parseInt(p.Times ?? '1', 10) || 1;
      const v = r.amount(p.RepeatCheckSVar, 0);
      const again = v != null && cmp(v, p.RepeatSVarCompare, (s) => r.amount(s, 0)) === true;
      if (again && times < 30) {
        r.splice(p.RepeatSubAbility);
        r.splice('', { line: `DB$ _RepeatCheck | RepeatSubAbility$ ${p.RepeatSubAbility} | RepeatCheckSVar$ ${p.RepeatCheckSVar} | RepeatSVarCompare$ ${p.RepeatSVarCompare} | Times$ ${times + 1}` });
      }
      return 'ok';
    }
    case 'GenericChoice': {
      const chooser = r.ownTargets()?.find((t) => t.kind === 'player');
      const pid = chooser?.kind === 'player' ? chooser.pid : r.defined(p.Defined ?? 'You')?.players[0] ?? r.controller;
      const choices = p.Choices.split(',').map((s) => s.trim()).filter((s) => r.svars[s]);
      if (!choices.length) return 'ok';
      const label = (svar: string) => parseAbility(r.svars[svar], r.svars, r.sourceName)?.description ?? svar;
      ask(state, ctx, pid, `${r.sourceName}: choose one`, choices.map((c) => ({ value: c, label: label(c) })), { kind: 'more', m: 'generic', cont: r.contAt(r.index), pid, at: r.index });
      return 'wait';
    }
    case 'RollDice': {
      // Roll Amount$ dice with Sides$ sides (+ Modifier$). The total picks a ResultSubAbilities$ entry ("1-9:SVar",
      // "20:SVar", "Else:SVar"; EvenOddResults$ "Even:SVar,Odd:SVar") and is stored in ResultSVar$ for later steps.
      const sides = r.amount(p.Sides ?? '6', 6) || 6;
      const count = Math.max(1, r.amount(p.Amount ?? '1', 1) ?? 1);
      const rolls = Array.from({ length: count }, () => 1 + Math.floor(ctx.rng() * sides));
      const mod = p.Modifier ? r.amount(p.Modifier, 0) ?? 0 : 0;
      const n = (p.UseHighestRoll ? Math.max(...rolls) : rolls.reduce((a, b) => a + b, 0)) + mod;
      log(state, ctx, r.controller, `${pname(state, r.controller)} rolls ${count > 1 ? rolls.join(' + ') : `a ${rolls[0]}`}${mod ? ` ${mod > 0 ? '+' : '-'} ${Math.abs(mod)} = ${n}` : count > 1 ? ` = ${n}` : ''} (${count > 1 ? count : ''}d${sides}, ${r.sourceName}).`);
      if (p.ResultSVar) (r.chosen.vars ??= {})[p.ResultSVar.trim()] = n;
      const sub = rollResult(p.ResultSubAbilities, n);
      if (sub && r.svars[sub]) r.splice(sub);
      return 'ok';
    }
    case 'FlipCoin': {
      // One flip (Mana Crypt, Krark's Thumb-free): the flipper calls it, so winning is a fair 50/50, as are heads / tails.
      const flipper = r.defined(p.Flipper ?? p.Defined ?? 'You')?.players[0] ?? r.controller;
      const heads = ctx.rng() < 0.5;
      const won = p.NoCall === 'True' ? undefined : ctx.rng() < 0.5;
      log(state, ctx, flipper, `${pname(state, flipper)} flips a coin (${r.sourceName}): ${heads ? 'heads' : 'tails'}${won == null ? '' : ` — ${pname(state, flipper)} ${won ? 'wins' : 'loses'} the flip`}.`);
      const sub = won === true ? p.WinSubAbility : won === false ? p.LoseSubAbility : undefined;
      const side = heads ? p.HeadsSubAbility : p.TailsSubAbility;
      for (const svar of [sub, side]) if (svar && r.svars[svar]) r.splice(svar);
      return 'ok';
    }
    case 'Incubate': {
      // Incubate N (Times$ T): create an Incubator token with N +1/+1 counters ("{2}: Transform this artifact." into a 0/0 Phyrexian).
      const n = r.amount(p.Amount ?? '1', 1);
      const times = r.amount(p.Times ?? '1', 1);
      if (n == null || times == null) { r.manual(); return 'ok'; }
      const players = p.Defined ? r.defined(p.Defined)?.players ?? [] : [r.controller];
      const made: string[] = [];
      for (const owner of players) {
        const count = times * tokenMultiplier(state, ctx, owner);
        for (let k = 0; k < count; k++) {
          const inst = createTokenInstance(state, ctx, owner, INCUBATOR_TOKEN, false);
          if (n > 0) inst.counters['+1/+1'] = (inst.counters['+1/+1'] ?? 0) + n;
          made.push(inst.iid);
        }
        log(state, ctx, owner, `${pname(state, owner)} incubates ${n}${count > 1 ? ` ${count} times` : ''} (Incubator token${count === 1 ? '' : 's'} with ${n} +1/+1 counter${n === 1 ? '' : 's'}).`);
      }
      if (Object.keys(p).some((k) => k.startsWith('Remember'))) r.remember(made);
      return 'ok';
    }
    case 'ChooseCard': return chooseCard(state, ctx, r);
    case 'ChooseNumber': {
      const min = r.amount(p.Min ?? '0', 0) ?? 0;
      const max = Math.max(min, Math.min(99, r.amount(p.Max ?? '10', 10) ?? 10));
      const pid = r.defined(p.Defined ?? 'You')?.players[0] ?? r.controller;
      if (min === max) { r.chosen.number = min; return 'ok'; }
      ask(state, ctx, pid, `${r.sourceName}: choose a number${p.ListTitle ? ` (${p.ListTitle})` : ''} from ${min} to ${max}`,
        Array.from({ length: Math.min(max - min + 1, 31) }, (_v, k) => ({ value: String(min + k), label: String(min + k) })),
        { kind: 'more', m: 'number', cont: r.contAt(r.index + 1), pid, min, max }, { number: { min, max } });
      return 'wait';
    }
    case 'TapOrUntap': {
      const o = r.objects('Self');
      const cards = (o?.cards ?? []).filter((x) => state.cards[x]?.zone === 'battlefield');
      if (!cards.length) return 'ok';
      askTapOrUntap(state, ctx, { kind: 'more', m: 'tapOrUntap', cont: r.contAt(r.index + 1), pid: r.controller, queue: cards, source: r.sourceName });
      return 'wait';
    }
    case 'Amass': return amass(state, ctx, r);
    case 'Empower': return empower(state, ctx, r);
    case 'Fight': {
      // Two creatures fight: each deals damage equal to its power to the other (rule 701.14). The first fighter is
      // Defined$ (ParentTarget, Enchanted, Self ...), else the first of two targets, else the source; the other is a target.
      const own = (r.ownTargets() ?? []).filter((t): t is { kind: 'card'; iid: string } => t.kind === 'card').map((t) => t.iid);
      let a: string | undefined;
      let b: string | undefined;
      if (p.Defined) {
        const d = r.defined(p.Defined)?.cards ?? [];
        a = d[0];
        b = own[0] ?? d[1]; // "Defined$ Targeted": the parent's two targets fight each other
      }
      else if (own.length >= 2) [a, b] = own;
      else { a = r.sourceIid; b = own[0]; }
      const fighter = (x: string | undefined) => !!x && state.cards[x]?.zone === 'battlefield' && isCreature(state.cards[x], ctx.lookup, state);
      if (!fighter(a) || !fighter(b) || a === b) { log(state, ctx, r.controller, `${r.sourceName}: no fight (a creature is missing).`); return 'ok'; }
      const pa = Math.max(0, effectivePT(state.cards[a!], ctx.lookup, state)[0]);
      const pb = Math.max(0, effectivePT(state.cards[b!], ctx.lookup, state)[0]);
      log(state, ctx, r.controller, `${nm(state, ctx, a!)} fights ${nm(state, ctx, b!)} (${pa} and ${pb} damage).`);
      r.damage(a, b!, pa);
      r.damage(b, a!, pb);
      return 'ok';
    }
    case 'Discover': {
      // Exile from the top until a nonland card with mana value N or less; cast it free or put it into your hand;
      // the rest go to the bottom in a random order.
      const n = r.amount(p.Num, 0) ?? 0;
      const me = player(state, r.controller);
      const exiled: string[] = [];
      let hit: string | undefined;
      while (me.zones.library.length) {
        const top = me.zones.library[0];
        moveCard(state, ctx, top, 'exile');
        if (state.cards[top]?.zone !== 'exile') break;
        exiled.push(top);
        const card = state.cards[top];
        const cmc = card.cardId ? ctx.lookup(card.cardId)?.cmc ?? 0 : 0;
        if (!faceOf(card, ctx.lookup).types.includes('Land') && cmc <= n) { hit = top; break; }
      }
      log(state, ctx, r.controller, `Discover ${n}: ${pname(state, r.controller)} exiles ${names(state, ctx, exiled) || 'nothing'}.`);
      if (hit) {
        r.remember([hit]);
        r.splice('_kw', { line: 'DB$ Play | Defined$ Remembered | WithoutManaCost$ True | Optional$ True | ValidSA$ Spell | SpellDescription$ You may cast it without paying its mana cost.' });
        r.splice('_kw', { line: `DB$ _DiscoverHand | Cards$ ${hit} | SpellDescription$ If you don't cast it, put it into your hand.` });
      }
      const rest = exiled.filter((x) => x !== hit);
      if (rest.length) r.splice('_kw', { line: `DB$ _PutBottom | Cards$ ${rest.join(',')} | SpellDescription$ Put the exiled cards on the bottom in a random order.` });
      return 'ok';
    }
    case '_DiscoverHand': {
      for (const iid of (p.Cards ?? '').split(',')) {
        const c = state.cards[iid];
        if (c?.zone !== 'exile') continue;
        moveCard(state, ctx, iid, 'hand');
        log(state, ctx, c.owner, `${pname(state, c.owner)} puts ${cardName(c, ctx.lookup)} into their hand (discover).`);
      }
      return 'ok';
    }
    case 'Recruit': {
      // Draw a card, then discard a card. If you discarded a nonland card, create a 1/1 white Human Soldier token.
      const me = player(state, r.controller);
      const got = drawCards(state, me, 1);
      log(state, ctx, r.controller, `${me.name} recruits (draws ${got}).`);
      askConnive(state, ctx, { kind: 'more', m: 'connive', cont: r.contAt(r.index + 1), pid: r.controller, conniver: '', recruit: true, left: Math.min(1, me.zones.hand.length), nonland: 0, source: r.sourceName });
      return 'wait';
    }
    case 'Proliferate': {
      const cands = [
        ...state.battlefield.filter((x) => Object.values(state.cards[x].counters).some((n) => n > 0)),
        ...state.players.filter((pl) => !pl.conceded && Object.values(pl.counters).some((n) => n > 0)).map((pl) => pl.pid),
      ];
      if (!cands.length) { log(state, ctx, r.controller, `${r.sourceName}: nothing to proliferate.`); return 'ok'; }
      askProliferate(state, ctx, { kind: 'more', m: 'prolif', cont: r.contAt(r.index + 1), pid: r.controller, cands, picked: [], source: r.sourceName });
      return 'wait';
    }
    case 'Connive': {
      const o = r.objects('Self');
      const conniver = o?.cards[0] ?? r.sourceIid;
      const n = r.amount(p.ConniveNum ?? p.Num, 1) ?? 1;
      const me = player(state, r.controller);
      const got = drawCards(state, me, n);
      log(state, ctx, r.controller, `${conniver ? nm(state, ctx, conniver) : r.sourceName} connives (${me.name} draws ${got}).`);
      askConnive(state, ctx, { kind: 'more', m: 'connive', cont: r.contAt(r.index + 1), pid: r.controller, conniver: conniver ?? '', left: Math.min(n, me.zones.hand.length), nonland: 0, source: r.sourceName });
      return 'wait';
    }
    case 'Explore': {
      const o = r.objects('Self');
      const queue = (o?.cards ?? []).filter((x) => state.cards[x]?.zone === 'battlefield');
      return explore(state, ctx, { kind: 'more', m: 'explore', cont: r.contAt(r.index + 1), pid: r.controller, queue, source: r.sourceName }) ? 'wait' : 'ok';
    }
    case 'MultiplyCounter': {
      const o = p.Defined?.startsWith('Valid ') ? { cards: state.battlefield.filter((x) => matchCard(state.cards[x], p.Defined.slice(6), r.env) === true), players: [] } : r.objects('Self');
      const kind = p.CounterType ? counterKind(p.CounterType) : undefined;
      const mult = r.amount(p.Multiplier, 2) ?? 2;
      for (const iid of o?.cards ?? []) {
        const c = state.cards[iid];
        if (!c || c.zone !== 'battlefield') continue;
        for (const k of kind ? [kind] : Object.keys(c.counters)) {
          const have = c.counters[k] ?? 0;
          if (have <= 0) continue;
          c.counters[k] = have * mult;
          log(state, ctx, r.controller, `${cardName(c, ctx.lookup)}: ${k} counters ${have} → ${c.counters[k]}.`);
        }
      }
      return 'ok';
    }
    case 'ExchangeControl': {
      const first = p.Defined ? r.defined(p.Defined)?.cards ?? [] : [];
      const own = (r.ownTargets() ?? []).filter((t) => t.kind === 'card').map((t) => (t as { iid: string }).iid);
      const pair = [...first, ...own].filter((x) => state.cards[x]?.zone === 'battlefield').slice(0, 2);
      if (pair.length < 2) { log(state, ctx, r.controller, `${r.sourceName}: the exchange doesn't happen (a target is gone).`); return 'ok'; }
      const [a, b] = pair.map((x) => state.cards[x]);
      if (a.controller === b.controller) { log(state, ctx, r.controller, `${r.sourceName}: same controller — nothing to exchange.`); return 'ok'; }
      [a.controller, b.controller] = [b.controller, a.controller];
      for (const c of [a, b]) { c.summoningSick = true; c.attacking = undefined; c.blocking = undefined; }
      log(state, ctx, r.controller, `${r.sourceName}: ${pname(state, a.controller)} gains control of ${cardName(a, ctx.lookup)} and ${pname(state, b.controller)} of ${cardName(b, ctx.lookup)}.`);
      return 'ok';
    }
    case 'SetState': {
      const o = r.objects('Self');
      for (const iid of o?.cards ?? []) {
        const c = state.cards[iid];
        if (!c || c.zone !== 'battlefield') continue;
        if (p.Mode === 'TurnFaceUp' || p.Mode === 'TurnFace') { c.faceDown = false; log(state, ctx, r.controller, `${cardName(c, ctx.lookup)} is turned face up.`); continue; }
        const data = c.cardId ? ctx.lookup(c.cardId) : undefined;
        if (!(c.token?.back && !c.cardId) && (!data?.faces || data.faces.length < 2)) continue;
        const before = cardName(c, ctx.lookup);
        c.transformed = !c.transformed;
        const f = faceOf(c, ctx.lookup);
        if (f.loyalty && c.counters.loyalty == null) c.counters.loyalty = parseInt(f.loyalty, 10) || 0;
        log(state, ctx, r.controller, `${before} transforms into ${f.name}.`);
        noteTransformed(state, iid);
      }
      return 'ok';
    }
    case 'Protection': {
      const o = r.objects('Self');
      const cards = (o?.cards ?? []).filter((x) => state.cards[x]?.zone === 'battlefield');
      if (!cards.length) return 'ok';
      const gains = p.Gains ?? 'Choice';
      if (gains !== 'Choice') {
        const list = gains.split(',').map((g) => g.trim().toLowerCase());
        giveProtection(state, ctx, cards, list, r.sourceName);
        return 'ok';
      }
      const choices = (p.Choices ?? 'AnyColor').split(',').flatMap((x) => (x.trim() === 'AnyColor' ? ['white', 'blue', 'black', 'red', 'green'] : [x.trim().toLowerCase()]));
      ask(state, ctx, r.controller, `${r.sourceName}: choose a quality for protection (${names(state, ctx, cards)})`, choices.map((c) => ({ value: c, label: `Protection from ${c}` })),
        { kind: 'more', m: 'protection', cont: r.contAt(r.index + 1), pid: r.controller, cards, source: r.sourceName });
      return 'wait';
    }
    case 'PeekAndReveal': {
      const o = r.objects('You');
      const pid = o?.players[0] ?? r.controller;
      const n = r.amount(p.PeekAmount, 1) ?? 1;
      const top = player(state, pid).zones.library.slice(0, n);
      if (!top.length) { log(state, ctx, r.controller, `${pname(state, pid)}'s library is empty.`); return 'ok'; }
      if (p.RememberRevealed || p.RememberPeeked) r.remember(top);
      if (p.ImprintRevealed) r.chosen.imprinted = [...top];
      if (p.NoReveal === 'True') {
        for (const iid of top) if (!state.cards[iid].revealedTo.includes(r.controller)) state.cards[iid].revealedTo.push(r.controller);
        log(state, ctx, r.controller, `${pname(state, r.controller)} looks at the top ${top.length === 1 ? 'card' : `${top.length} cards`} of ${pid === r.controller ? 'their' : `${pname(state, pid)}'s`} library (${r.sourceName}).`);
        ask(state, ctx, r.controller, `${r.sourceName}: you look at the top of ${pid === r.controller ? 'your' : `${pname(state, pid)}'s`} library`, [{ value: 'ok', label: `${names(state, ctx, top)} — OK` }],
          { kind: 'more', m: 'info', cont: r.contAt(r.index + 1), pid: r.controller });
        return 'wait';
      }
      for (const iid of top) state.cards[iid].revealedTo = state.players.map((x) => x.pid);
      log(state, ctx, pid, `${pname(state, pid)} reveals ${names(state, ctx, top)} (${r.sourceName}).`);
      return 'ok';
    }
    case 'Reveal': {
      const o = r.objects('You');
      const pid = o?.players[0] ?? r.controller;
      const hand = player(state, pid).zones.hand;
      if (!hand.length) { log(state, ctx, r.controller, `${pname(state, pid)}'s hand is empty (${r.sourceName}).`); return 'ok'; }
      const picks = p.Random === 'True' ? [hand[Math.floor(ctx.rng() * hand.length)]] : [...hand];
      if (p.RememberRevealed) r.remember(picks);
      if (pid === r.controller || p.Random !== 'True') {
        for (const iid of picks) state.cards[iid].revealedTo = state.players.map((x) => x.pid);
        log(state, ctx, pid, `${pname(state, pid)} reveals ${names(state, ctx, picks)} (${r.sourceName}).`);
        return 'ok';
      }
      for (const iid of picks) if (!state.cards[iid].revealedTo.includes(r.controller)) state.cards[iid].revealedTo.push(r.controller);
      log(state, ctx, r.controller, `${pname(state, r.controller)} looks at a card at random in ${pname(state, pid)}'s hand (${r.sourceName}).`);
      ask(state, ctx, r.controller, `${r.sourceName}: a card at random from ${pname(state, pid)}'s hand`, [{ value: 'ok', label: `${names(state, ctx, picks)} — OK` }],
        { kind: 'more', m: 'info', cont: r.contAt(r.index + 1), pid: r.controller });
      return 'wait';
    }
    case 'DamageResolve': return 'ok';
    case 'DigUntil': return digUntil(state, ctx, r);
    case 'CopySpellAbility': return copySpell(state, ctx, r);
    case 'AlterAttribute': {
      const o = r.objects('Self');
      const attrs = (p.Attributes ?? '').split(',').map((s) => s.trim());
      for (const iid of o?.cards ?? []) {
        const c = state.cards[iid];
        if (!c) continue;
        for (const a of attrs) {
          if (a === 'Prepared') { c.counters.prepared = 1; log(state, ctx, r.controller, `${cardName(c, ctx.lookup)} becomes prepared.`); }
          else if (a === 'Unprepared' || a === '!Prepared') { delete c.counters.prepared; log(state, ctx, r.controller, `${cardName(c, ctx.lookup)} is no longer prepared.`); }
          else if (a === 'Suspected') c.tempKeywords = [...new Set([...(c.tempKeywords ?? []), 'Menace'])];
        }
      }
      return 'ok';
    }
    case 'Earthbend': {
      const n = r.amount(p.Num, 1) ?? 1;
      const lands = state.battlefield.filter((x) => state.cards[x].controller === r.controller && faceOf(state.cards[x], ctx.lookup).types.includes('Land'));
      if (!lands.length) { log(state, ctx, r.controller, `${r.sourceName}: no land to earthbend.`); return 'ok'; }
      ask(state, ctx, r.controller, `${r.sourceName}: earthbend ${n} — choose a land you control`, lands.map((x) => ({ value: x, label: nm(state, ctx, x) })),
        { kind: 'more', m: 'earthbend', cont: r.contAt(r.index + 1), pid: r.controller, n, source: r.sourceName });
      return 'wait';
    }
    case 'Airbend': {
      const o = r.objects('Self');
      const done: string[] = [];
      for (const iid of o?.cards ?? []) {
        const c = state.cards[iid];
        if (!c || c.zone !== 'battlefield') continue;
        const owner = c.owner;
        const name = cardName(c, ctx.lookup);
        moveCard(state, ctx, iid, 'exile');
        if (state.cards[iid]?.zone === 'exile') addEffect(state, ctx, { kind: 'grant', controller: owner, until: 'permanent', iid, zone: 'exile', keyword: 'Airbend', source: r.sourceName });
        done.push(name);
      }
      log(state, ctx, r.controller, `${r.sourceName} airbends ${done.join(', ') || 'nothing'} (each may be cast from exile for {2}).`);
      return 'ok';
    }
    case 'Play': return play(state, ctx, r);
  }
  return undefined;
}

/** Transformed this action (Mode$ Transformed triggers, triggers.ts). */
export function noteTransformed(state: GameState, iid: string) {
  emit(state, { t: 'transformed', iid } as never);
}

// ------------------------------------------------------------------ modes chosen on resolution

function askModes(state: GameState, ctx: Ctx, r: MoreRun): Result {
  const step = r.step;
  const choices = step.choices ?? [];
  if (!choices.length) return 'ok';
  const min = step.charmMin ?? 1, max = Math.min(step.charmMax ?? 1, choices.length);
  const d: MData = { kind: 'more', m: 'modes', cont: r.contAt(r.index + 1), pid: r.controller, at: r.index, picked: [], min, max, names: choices.map((c) => c.name), labels: choices.map((c) => c.ability.description), source: r.sourceName };
  askMode(state, ctx, d);
  return 'wait';
}

function askMode(state: GameState, ctx: Ctx, d: MData) {
  const picked = d.picked as string[];
  const all = d.names as string[];
  const labels = d.labels as string[];
  const options = all.map((n, k) => ({ value: n, label: labels[k] })).filter((o) => !picked.includes(o.value));
  if (picked.length >= (d.min as number)) options.push({ value: 'done', label: 'Done' });
  const n = d.max as number;
  ask(state, ctx, d.pid, `${d.source}: choose ${n === 1 ? 'one' : `up to ${n}`}${picked.length ? ` (chosen: ${picked.map((p) => labels[all.indexOf(p)]).join('; ')})` : ''}`, options, d);
}

// ------------------------------------------------------------------ RepeatEach

function repeatEach(state: GameState, ctx: Ctx, r: MoreRun): Result {
  const p = r.step.params;
  let objs: string[] = [];
  if (p.RepeatPlayers) objs = r.defined(p.RepeatPlayers === 'Opponent' ? 'Player.Opponent' : p.RepeatPlayers)?.players ?? [];
  else if (p.DefinedCards) objs = r.defined(p.DefinedCards)?.cards ?? [];
  else if (p.RepeatCards) {
    const f = cardFilter(state, r, p.RepeatCards);
    objs = zoneCards(state, p.Zone ?? 'Battlefield').filter((x) => state.cards[x] && f(state.cards[x]));
  } else if (p.RepeatTypesFrom) {
    // Atraxa: one repetition per card type among the imprinted / revealed cards.
    const pool = r.chosen.imprinted ?? r.remembered;
    const types = new Set<string>();
    for (const iid of pool) for (const t of state.cards[iid] ? faceOf(state.cards[iid], ctx.lookup).types : []) types.add(t);
    const prev = [...r.remembered];
    const acc = subRemembers(r.svars, p.RepeatSubAbility);
    if (acc) r.chosen.accumulate = true;
    for (const t of types) { r.splice('', { line: `DB$ _SetChosenType | Type$ ${t}` }); r.splice(p.RepeatSubAbility); }
    if (!acc) r.splice('', { remember: prev });
    return 'ok';
  }
  if (subRemembers(r.svars, p.RepeatSubAbility)) {
    // The sub-ability remembers what it chooses (Chaos Defiler): keep the chosen objects across passes, Forge style.
    r.chosen.accumulate = true;
    for (const o of objs) {
      r.splice('', { line: `DB$ _Remember | Mode$ Add | Objects$ ${o}` });
      r.splice(p.RepeatSubAbility);
      r.splice('', { line: `DB$ _Remember | Mode$ Remove | Objects$ ${o}` });
    }
    return 'ok';
  }
  const prev = [...r.remembered];
  for (const o of objs) r.splice(p.RepeatSubAbility, { remember: [o] });
  r.splice('', { remember: prev });
  return 'ok';
}

/** Does the RepeatEach sub-ability chain remember what it chooses (RememberChosen ...)? */
function subRemembers(svars: Record<string, string>, svar: string | undefined): boolean {
  const seen = new Set<string>();
  for (let k = svar; k && !seen.has(k) && svars[k]; k = /\|\s*SubAbility\$\s*([^|]+)/.exec(svars[k])?.[1]?.trim()) {
    seen.add(k);
    if (/\|\s*RememberChosen\$\s*True/.test(svars[k])) return true;
  }
  return false;
}

// ------------------------------------------------------------------ ChooseCard

interface ChoiceSpec { chooser: string; cands: string[]; n: number; min: number; label: string; reveal?: string }

function chooseCard(state: GameState, ctx: Ctx, r: MoreRun): Result {
  const p = r.step.params;
  const zone = p.ChoiceZone ?? 'Battlefield';
  const f = cardFilter(state, r, p.Choices ?? 'Card');
  const all = zoneCards(state, zone).filter((x) => state.cards[x] && f(state.cards[x]));
  const choosers = r.defined(p.Defined ?? 'You')?.players ?? [r.controller];
  const n = r.amount(p.Amount, 1) ?? 1;
  const accumulate = !!(r.chosen.accumulate && p.RememberChosen);
  // Atraxa: "for each card type, you MAY put a card of that type ..." (a per-type choice without Mandatory$).
  const optional = p.MinAmount ? (r.amount(p.MinAmount, 0) ?? 0) : p.Mandatory === 'True' ? n : /\bmay\b/i.test(p.ChoiceTitle ?? '') || (accumulate && r.chosen.type) ? 0 : n;
  const title = p.ChoiceTitle ?? `choose ${n === 1 ? 'a card' : `${n} cards`}`;
  const specs: ChoiceSpec[] = [];
  for (const chooser of choosers) {
    let cands = all;
    if (p.ControlledByPlayer === 'Chooser') cands = cands.filter((x) => state.cards[x].controller === chooser);
    // Accumulating RepeatEach (Chaos Defiler, Atraxa): a card already chosen in an earlier pass can't be chosen again.
    if (accumulate) cands = cands.filter((x) => !r.remembered.includes(x));
    if (p.EachBasicType === 'True') {
      for (const t of ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']) {
        const c = cands.filter((x) => faceOf(state.cards[x], ctx.lookup).typeLine.includes(t));
        if (c.length) specs.push({ chooser, cands: c, n: 1, min: 1, label: `choose a ${t}` });
      }
    } else if (p.ChooseEach) {
      for (const t of p.ChooseEach.split('&').map((s) => s.trim())) {
        const c = cands.filter((x) => matchCard(state.cards[x], t, r.env) === true);
        if (c.length) specs.push({ chooser, cands: c, n: 1, min: 1, label: `choose ${/^[AEIOU]/.test(t) ? 'an' : 'a'} ${t.toLowerCase()} to keep` });
      }
    } else {
      const owners = new Set(cands.map((x) => state.cards[x].owner));
      const reveal = zone === 'Hand' && owners.size === 1 && !owners.has(chooser) ? [...owners][0] : undefined;
      specs.push({ chooser, cands, n: Math.min(n, cands.length), min: Math.min(optional, cands.length), label: title, ...(reveal ? { reveal } : {}) });
    }
  }
  r.chosen.cards = [];
  const live = specs.filter((s) => s.cands.length && s.n > 0);
  if (!live.length) { if (!all.length) log(state, ctx, r.controller, `${r.sourceName}: nothing to choose.`); return 'ok'; }
  if (p.AtRandom === 'True') {
    for (const s of live) {
      const pool = [...s.cands];
      for (let k = 0; k < s.n && pool.length; k++) r.chosen.cards.push(pool.splice(Math.floor(ctx.rng() * pool.length), 1)[0]);
    }
    log(state, ctx, r.controller, `${r.sourceName}: ${names(state, ctx, r.chosen.cards)} chosen at random.`);
    if (p.RememberChosen) r.remember(accumulate ? [...r.remembered, ...r.chosen.cards] : [...r.chosen.cards]);
    return 'ok';
  }
  const d: MData = { kind: 'more', m: 'chooseCard', cont: r.contAt(r.index + 1), pid: live[0].chooser, specs: live, idx: 0, picked: [], left: live[0].n, remember: !!p.RememberChosen, accumulate, reveal: p.Reveal === 'True', source: r.sourceName };
  askChooseCard(state, ctx, d);
  return 'wait';
}

function askChooseCard(state: GameState, ctx: Ctx, d: MData) {
  const specs = d.specs as ChoiceSpec[];
  const s = specs[d.idx as number];
  const picked = d.picked as string[];
  const got = (d.got as number | undefined) ?? 0;
  const cands = s.cands.filter((x) => state.cards[x] && !picked.includes(x));
  const options = cands.map((x) => ({ value: x, label: nm(state, ctx, x) }));
  if (got >= s.min || !cands.length) options.push({ value: 'done', label: got ? 'Done' : 'Choose nothing' });
  const extra: Partial<Pending> = {};
  if (s.reveal) {
    const hand = player(state, s.reveal).zones.hand;
    for (const iid of hand) if (!state.cards[iid].revealedTo.includes(s.chooser)) state.cards[iid].revealedTo.push(s.chooser);
    extra.revealed = hand.map((iid) => ({ iid, label: nm(state, ctx, iid), legal: cands.includes(iid) }));
  }
  ask(state, ctx, s.chooser, `${d.source}: ${s.label}${s.n - got > 1 ? ` (${s.n - got} left)` : ''}`, options, { ...d, pid: s.chooser }, extra);
}

// ------------------------------------------------------------------ small interactive effects

function askTapOrUntap(state: GameState, ctx: Ctx, d: MData) {
  const queue = (d.queue as string[]).filter((x) => state.cards[x]?.zone === 'battlefield');
  if (!queue.length) { resumeAuto(state, ctx, d.cont); return; }
  const iid = queue[0];
  ask(state, ctx, d.pid, `${d.source}: tap or untap ${nm(state, ctx, iid)}?`, [{ value: 'tap', label: `Tap ${nm(state, ctx, iid)}` }, { value: 'untap', label: `Untap ${nm(state, ctx, iid)}` }], { ...d, queue });
}

function askProliferate(state: GameState, ctx: Ctx, d: MData) {
  const picked = d.picked as string[];
  const cands = (d.cands as string[]).filter((x) => !picked.includes(x) && (isPlayer(state, x) || state.cards[x]?.zone === 'battlefield'));
  const label = (x: string) => {
    if (isPlayer(state, x)) { const pl = player(state, x); return `${pl.name} (${Object.entries(pl.counters).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ')})`; }
    const c = state.cards[x];
    return `${cardName(c, ctx.lookup)} (${Object.entries(c.counters).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ')})`;
  };
  if (!cands.length) { finishProliferate(state, ctx, d); return; }
  ask(state, ctx, d.pid, `${d.source}: proliferate — choose permanents and players to get another counter of each kind${picked.length ? ` (chosen: ${picked.length})` : ''}`,
    [...cands.map((x) => ({ value: x, label: label(x) })), { value: 'done', label: 'Done' }], d);
}

function finishProliferate(state: GameState, ctx: Ctx, d: MData) {
  const out: string[] = [];
  for (const x of d.picked as string[]) {
    const counters = isPlayer(state, x) ? player(state, x).counters : state.cards[x]?.counters;
    if (!counters) continue;
    for (const k of Object.keys(counters)) if (counters[k] > 0) counters[k]++;
    out.push(isPlayer(state, x) ? pname(state, x) : nm(state, ctx, x));
  }
  log(state, ctx, d.pid, `${pname(state, d.pid)} proliferates: ${out.join(', ') || 'nothing'}.`);
  resumeAuto(state, ctx, d.cont);
}

function askConnive(state: GameState, ctx: Ctx, d: MData) {
  const me = player(state, d.pid);
  if ((d.left as number) <= 0 || !me.zones.hand.length) {
    const c = state.cards[d.conniver as string];
    const k = d.nonland as number;
    if (d.recruit) {
      if (k > 0) {
        const soldier: TokenData = SCRIPTS.tokens.w_1_1_human_soldier ?? { name: 'Human Soldier', typeLine: 'Token Creature — Human Soldier', colors: ['W'], power: '1', toughness: '1', oracle: '', keywords: [] };
        createTokenInstance(state, ctx, d.pid, soldier, false);
        log(state, ctx, d.pid, `${me.name} creates a 1/1 white Human Soldier creature token (recruit).`);
      }
      resumeAuto(state, ctx, d.cont);
      return;
    }
    if (c?.zone === 'battlefield' && k > 0) {
      c.counters['+1/+1'] = (c.counters['+1/+1'] ?? 0) + k;
      log(state, ctx, d.pid, `${cardName(c, ctx.lookup)} gets ${k} +1/+1 counter${k === 1 ? '' : 's'} (connive).`);
    }
    resumeAuto(state, ctx, d.cont);
    return;
  }
  ask(state, ctx, d.pid, `${d.source}: ${d.recruit ? 'recruit' : 'connive'} — discard a card${(d.left as number) > 1 ? ` (${d.left} left)` : ''}`, me.zones.hand.map((x) => ({ value: x, label: nm(state, ctx, x) })), d);
}

/** Explore the next creature in the queue. Returns true when a question was asked. */
function explore(state: GameState, ctx: Ctx, d: MData): boolean {
  const queue = d.queue as string[];
  while (queue.length) {
    const iid = queue.shift()!;
    const c = state.cards[iid];
    if (!c) continue;
    const me = player(state, c.controller);
    const top = me.zones.library[0];
    if (!top) { log(state, ctx, c.controller, `${cardName(c, ctx.lookup)} explores — the library is empty.`); continue; }
    const card = state.cards[top];
    const name = cardName(card, ctx.lookup);
    if (faceOf(card, ctx.lookup).types.includes('Land')) {
      moveCard(state, ctx, top, 'hand');
      log(state, ctx, c.controller, `${cardName(c, ctx.lookup)} explores: reveals ${name} (a land) — put into ${me.name}'s hand.`);
      continue;
    }
    if (c.zone === 'battlefield') c.counters['+1/+1'] = (c.counters['+1/+1'] ?? 0) + 1;
    card.revealedTo = state.players.map((p) => p.pid);
    log(state, ctx, c.controller, `${cardName(c, ctx.lookup)} explores: reveals ${name} and gets a +1/+1 counter.`);
    ask(state, ctx, c.controller, `${d.source}: ${name} — keep it on top of your library or put it into your graveyard?`, [{ value: 'top', label: `Keep ${name} on top` }, { value: 'graveyard', label: `Put ${name} into your graveyard` }],
      { ...d, pid: c.controller, card: top, queue });
    return true;
  }
  resumeAuto(state, ctx, d.cont);
  return true;
}

function giveProtection(state: GameState, ctx: Ctx, cards: string[], qualities: string[], source: string) {
  for (const iid of cards) {
    const c = state.cards[iid];
    if (!c || c.zone !== 'battlefield') continue;
    const kws = qualities.map((q) => `Protection from ${q}`);
    c.tempKeywords = [...new Set([...(c.tempKeywords ?? []), ...kws])];
    log(state, ctx, c.controller, `${cardName(c, ctx.lookup)} gains ${kws.join(', ').toLowerCase()} until end of turn (${source}).`);
  }
}

// ------------------------------------------------------------------ Amass

function amass(state: GameState, ctx: Ctx, r: MoreRun): Result {
  const p = r.step.params;
  const n = r.amount(p.Num, 1) ?? 1;
  const type = p.Type ?? 'Zombie';
  let armies = state.battlefield.filter((x) => state.cards[x].controller === r.controller && faceOf(state.cards[x], ctx.lookup).typeLine.includes('Army') && isCreature(state.cards[x], ctx.lookup, state));
  if (!armies.length) {
    const token: TokenData = { name: `${type} Army`, typeLine: `Token Creature — ${type} Army`, colors: ['B'], power: '0', toughness: '0', oracle: '', keywords: [] };
    const inst = createTokenInstance(state, ctx, r.controller, token, false);
    log(state, ctx, r.controller, `${pname(state, r.controller)} creates a 0/0 black ${type} Army creature token.`);
    armies = [inst.iid];
  }
  const put = (iid: string) => {
    const c = state.cards[iid];
    c.counters['+1/+1'] = (c.counters['+1/+1'] ?? 0) + n;
    emit(state, { t: 'counterAdded', iid, kind: '+1/+1', n });
    log(state, ctx, r.controller, `Amass ${type}s ${n}: ${cardName(c, ctx.lookup)} gets ${n} +1/+1 counter${n === 1 ? '' : 's'} (now ${c.counters['+1/+1']}).`);
    if (p.RememberAmass) r.remember([iid]);
  };
  if (armies.length === 1) { put(armies[0]); return 'ok'; }
  ask(state, ctx, r.controller, `${r.sourceName}: amass — choose an Army`, armies.map((x) => ({ value: x, label: nm(state, ctx, x) })), { kind: 'more', m: 'amass', cont: r.contAt(r.index + 1), pid: r.controller, n });
  return 'wait';
}

// ------------------------------------------------------------------ Empower

/**
 * The Jace token Empower creates: a token with a card id (so its loyalty abilities come from a script like any
 * planeswalker's). Registered on first use; the server sends its data and script to clients like a database card's.
 */
export const EMPOWER_JACE = 'token_empower_jace';
function ensureEmpowerJace() {
  if (getCard(EMPOWER_JACE)) return;
  const card: CardData = {
    id: EMPOWER_JACE, name: 'Jace', manaCost: '', cmc: 0, colors: ['U'], colorIdentity: ['U'], typeLine: 'Token Planeswalker — Jace',
    supertypes: [], types: ['Planeswalker'], subtypes: ['Jace'], oracle: '[−1]: Surveil 1.\n[−3]: Draw a card.', keywords: [], producedMana: [],
    layout: 'normal', tokens: [], image: '', rank: 99999,
  } as CardData;
  registerCards([card]);
  registerScripts({
    [EMPOWER_JACE]: [{
      name: 'Jace', triggers: [], statics: [], replacements: [], keywords: [], svars: {},
      abilities: [
        'AB$ Surveil | Cost$ SubCounter<1/LOYALTY> | Amount$ 1 | Planeswalker$ True | SpellDescription$ Surveil 1.',
        'AB$ Draw | Cost$ SubCounter<3/LOYALTY> | NumCards$ 1 | Planeswalker$ True | SpellDescription$ Draw a card.',
      ],
    }],
  });
}

/** Empower <Type> N: put N loyalty counters on a <Type> token you control, first creating a Jace token if you control none. */
function empower(state: GameState, ctx: Ctx, r: MoreRun): Result {
  const p = r.step.params;
  const n = r.amount(p.Num, 1) ?? 1;
  const type = p.Type ?? 'Jace';
  let mine = state.battlefield.filter((x) => {
    const c = state.cards[x];
    return c.controller === r.controller && !!c.token && faceOf(c, ctx.lookup).typeLine.split(/[\s—-]+/).includes(type);
  });
  if (!mine.length) {
    ensureEmpowerJace();
    const token: TokenData = { name: 'Jace', typeLine: 'Token Planeswalker — Jace', colors: ['U'], oracle: '[−1]: Surveil 1.\n[−3]: Draw a card.', keywords: [] };
    const inst = createTokenInstance(state, ctx, r.controller, token, false, EMPOWER_JACE);
    log(state, ctx, r.controller, `${pname(state, r.controller)} creates a blue Jace planeswalker token.`);
    mine = [inst.iid];
  }
  if (mine.length === 1) { empowerPut(state, ctx, r.controller, mine[0], n); return 'ok'; }
  ask(state, ctx, r.controller, `${r.sourceName}: empower ${type} ${n} — choose a ${type} token`, mine.map((x) => ({ value: x, label: nm(state, ctx, x) })), { kind: 'more', m: 'empower', cont: r.contAt(r.index + 1), pid: r.controller, n });
  return 'wait';
}

function empowerPut(state: GameState, ctx: Ctx, pid: string, iid: string, n: number) {
  const c = state.cards[iid];
  if (!c) return;
  c.counters.loyalty = (c.counters.loyalty ?? 0) + n;
  emit(state, { t: 'counterAdded', iid, kind: 'loyalty', n });
  log(state, ctx, pid, `Empower: ${cardName(c, ctx.lookup)} gets ${n} loyalty counter${n === 1 ? '' : 's'} (now ${c.counters.loyalty}).`);
}

// ------------------------------------------------------------------ DigUntil

function digUntil(state: GameState, ctx: Ctx, r: MoreRun): Result {
  const p = r.step.params;
  const pid = r.defined(p.Defined ?? 'You')?.players[0] ?? r.controller;
  const me = player(state, pid);
  const want = r.amount(p.Amount, 1) ?? 1;
  const f = cardFilter(state, r, p.Valid ?? 'Card');
  const found: string[] = [];
  const revealed: string[] = [];
  for (const iid of [...me.zones.library]) {
    if (found.length >= want) break;
    if (f(state.cards[iid])) found.push(iid); else revealed.push(iid);
  }
  const zone = (z: string | undefined, d: Zone): Zone => (({ Exile: 'exile', Graveyard: 'graveyard', Hand: 'hand', Battlefield: 'battlefield', Library: 'library' } as Record<string, Zone>)[z ?? ''] ?? d);
  const fd = zone(p.FoundDestination, 'hand');
  const rd = zone(p.RevealedDestination, 'graveyard');
  log(state, ctx, pid, `${me.name} reveals ${names(state, ctx, [...revealed, ...found])} (${r.sourceName}).`);
  for (const iid of found) moveCard(state, ctx, iid, fd, fd === 'battlefield' ? { controller: r.controller } : {});
  if (rd === 'library') for (const iid of revealed) moveCard(state, ctx, iid, 'library', { position: 'bottom' });
  else for (const iid of revealed) moveCard(state, ctx, iid, rd);
  if (p.RevealedDestination === 'Library' && p.RevealedLibraryPosition !== '-1' && p.Shuffle === 'True') shuffleLibrary(state, me, ctx.rng);
  if (p.RememberFound) r.remember(found.filter((x) => state.cards[x]));
  if (p.RememberRevealed) r.remember(revealed.filter((x) => state.cards[x]));
  return 'ok';
}

// ------------------------------------------------------------------ CopySpellAbility

function copySpell(state: GameState, ctx: Ctx, r: MoreRun): Result {
  const p = r.step.params;
  let originals: StackItem[] = [];
  if (p.Defined === 'Parent' || p.Defined === 'Self' || !p.Defined) originals = r.item.auto ? [r.item] : [];
  else if (p.Defined === 'TriggeredSpellAbility') {
    const iid = r.trig?.card;
    const it = iid ? state.stack.find((s) => s.iid === iid) : undefined;
    if (it) originals = [it];
  } else {
    for (const t of r.ownTargets() ?? []) {
      const it = t.kind === 'stack' ? state.stack.find((s) => s.id === t.id) : t.kind === 'card' ? state.stack.find((s) => s.iid === t.iid) : undefined;
      if (it) originals.push(it);
    }
  }
  if (!originals.length) { log(state, ctx, r.controller, `${r.sourceName}: nothing to copy.`); return 'ok'; }
  let controller = r.controller;
  if (p.Controller === 'TargetedOrController') {
    const t = (r.item.auto?.targets ?? []).flat()[0];
    controller = t?.kind === 'player' ? t.pid : t?.kind === 'card' ? state.cards[t.iid]?.controller ?? r.controller : r.controller;
  }
  const n = r.amount(p.Amount, 1) ?? 1;
  const queue: StackItem[] = [];
  for (const orig of originals) {
    if (!orig.auto) continue;
    for (let k = 0; k < n; k++) {
      const auto: AutoInfo = JSON.parse(JSON.stringify(orig.auto)) as AutoInfo;
      queue.push({ id: randomId(ctx.rng), kind: orig.kind === 'spell' ? 'spell' : 'ability', controller, text: `Copy of ${orig.text}`, auto, ...(orig.x != null ? { x: orig.x } : {}), ...(orig.sourceIid ? { sourceIid: orig.sourceIid } : {}) });
    }
  }
  return pushCopies(state, ctx, { kind: 'more', m: 'copies', cont: r.contAt(r.index + 1), pid: controller, queue, mayChoose: p.MayChooseTarget === 'True' }) ? 'wait' : 'ok';
}

/** Push copies, asking for new targets first when allowed. Returns true when a question was asked. */
function pushCopies(state: GameState, ctx: Ctx, d: MData): boolean {
  const queue = d.queue as StackItem[];
  while (queue.length) {
    const item = queue[0];
    const ab = item.auto ? flatten(getAbility(item.auto)!, item.auto.modes) : [];
    const specs = item.auto && getAbility(item.auto) ? targetSpecs(getAbility(item.auto)!, item.auto.modes) : [];
    if (d.mayChoose && specs.length) {
      ask(state, ctx, item.controller, `${item.text}: choose new targets (or keep them)`, [{ value: 'keep', label: 'Keep the same targets' }],
        { ...d, pid: item.controller }, { targets: { specs, sourceIid: item.sourceIid, controller: item.controller, label: item.text } });
      return true;
    }
    void ab;
    queue.shift();
    state.stack.push(item);
    log(state, ctx, item.controller, `${pname(state, item.controller)} puts ${item.text} on the stack.`);
  }
  resumeAuto(state, ctx, d.cont);
  return true;
}

function getAbility(auto: AutoInfo): ParsedAbility | undefined {
  if (auto.source === 'spell') return spellAbility(auto.cardId, auto.face)?.ability;
  const f = getScript(auto.cardId)?.[auto.face];
  if (!f) return undefined;
  if (auto.source === 'trigger') { const line = auto.line ?? (auto.svar ? f.svars[auto.svar] : undefined); return line ? parseAbility(line, f.svars, f.name) : undefined; }
  const line = f.abilities[auto.index];
  return line ? parseAbility(line, f.svars, f.name) : undefined;
}

// ------------------------------------------------------------------ triggered keywords (engine/kwtriggers.ts)

function keywordStep(state: GameState, ctx: Ctx, r: MoreRun): Result {
  const p = r.step.params;
  const self = r.sourceIid ? state.cards[r.sourceIid] : undefined;
  const onBf = self && self.zone === 'battlefield' ? self : undefined;
  const sacrifice = (c: CardInstance) => {
    const name = cardName(c, ctx.lookup);
    moveCard(state, ctx, c.iid, 'graveyard', { cause: 'sacrifice' });
    log(state, ctx, c.controller, `${pname(state, c.controller)} sacrifices ${name}.`);
  };
  switch (r.step.api) {
    case '_Fading': {
      if (!onBf) return 'ok';
      const kind = counterKind(p.CounterType ?? 'FADE');
      const have = onBf.counters[kind] ?? 0;
      if (have > 0) {
        onBf.counters[kind] = have - 1;
        log(state, ctx, r.controller, `${r.sourceName}: a ${kind} counter is removed (${have - 1} left).`);
        if (p.Vanishing === 'True' && have - 1 === 0) sacrifice(onBf);
      } else sacrifice(onBf);
      return 'ok';
    }
    case '_CumUpkeep': {
      if (!onBf) return 'ok';
      onBf.counters.age = (onBf.counters.age ?? 0) + 1;
      const age = onBf.counters.age;
      const raw = (p.UpkeepCost ?? '').trim();
      const life = /^PayLife<(\d+)>$/.exec(raw);
      const cost = life ? `PayLife<${parseInt(life[1], 10) * age}>` : Array(age).fill(raw).join(' ');
      log(state, ctx, r.controller, `${r.sourceName} gets an age counter (${age}).`);
      r.splice('_kw', { line: `DB$ Sacrifice | Defined$ Self | UnlessCost$ ${cost} | UnlessPayer$ You | SpellDescription$ Sacrifice it unless you pay the upkeep cost.` });
      return 'ok';
    }
    case '_LivingWeapon': {
      if (!onBf) return 'ok';
      const germ: TokenData = { name: 'Phyrexian Germ', typeLine: 'Token Creature — Phyrexian Germ', colors: ['B'], power: '0', toughness: '0', oracle: '', keywords: [] };
      const inst = createTokenInstance(state, ctx, r.controller, germ, false);
      onBf.attachedTo = inst.iid;
      log(state, ctx, r.controller, `${pname(state, r.controller)} creates a 0/0 black Phyrexian Germ token and attaches ${r.sourceName} to it.`);
      return 'ok';
    }
    case '_Ravenous': {
      const x = onBf ? onBf.castInfo?.x ?? onBf.counters['+1/+1'] ?? 0 : 0;
      if (x >= 5) {
        const got = drawCards(state, player(state, r.controller), 1);
        log(state, ctx, r.controller, `${pname(state, r.controller)} draws ${got} card (ravenous).`);
      }
      return 'ok';
    }
    case '_Backup': {
      const n = r.amount(p.Num, 1) ?? 1;
      const t = (r.ownTargets() ?? []).find((x) => x.kind === 'card');
      const c = t && t.kind === 'card' ? state.cards[t.iid] : undefined;
      if (!c || c.zone !== 'battlefield') return 'ok';
      c.counters['+1/+1'] = (c.counters['+1/+1'] ?? 0) + n;
      emit(state, { t: 'counterAdded', iid: c.iid, kind: '+1/+1', n });
      log(state, ctx, r.controller, `${cardName(c, ctx.lookup)} gets ${n} +1/+1 counter${n === 1 ? '' : 's'} (backup).`);
      const svar = p.Abilities;
      if (c.iid !== r.sourceIid && svar && r.svars[svar]) r.splice('_kw', { line: `${r.svars[svar]} | Defined$ Targeted` });
      return 'ok';
    }
    case '_Cascade': {
      const src = r.trig?.card ?? r.sourceIid;
      const c = src ? state.cards[src] : undefined;
      const mv = c?.cardId ? ctx.lookup(c.cardId)?.cmc ?? 0 : 0;
      const me = player(state, r.controller);
      const exiled: string[] = [];
      let hit: string | undefined;
      while (me.zones.library.length) {
        const top = me.zones.library[0];
        moveCard(state, ctx, top, 'exile');
        if (state.cards[top]?.zone !== 'exile') break;
        exiled.push(top);
        const card = state.cards[top];
        const cmc = card.cardId ? ctx.lookup(card.cardId)?.cmc ?? 0 : 0;
        if (!faceOf(card, ctx.lookup).types.includes('Land') && cmc < mv) { hit = top; break; }
      }
      log(state, ctx, r.controller, `Cascade: ${pname(state, r.controller)} exiles ${names(state, ctx, exiled)}.`);
      if (hit) {
        r.remember([hit]);
        r.splice('_kw', { line: 'DB$ Play | Defined$ Remembered | WithoutManaCost$ True | Optional$ True | ValidSA$ Spell | SpellDescription$ You may cast it without paying its mana cost.' });
      }
      if (exiled.length) r.splice('_kw', { line: `DB$ _PutBottom | Cards$ ${exiled.join(',')} | SpellDescription$ Put the exiled cards on the bottom in a random order.` });
      return 'ok';
    }
    case '_Madness': {
      const iid = r.trig?.card;
      if (!iid || state.cards[iid]?.zone !== 'exile') return 'ok';
      const cost = p.Cost ?? '';
      r.splice('_kw', { line: `DB$ Play | Defined$ TriggeredCard | PlayCost$ ${cost} | Optional$ True | SpellDescription$ Cast it for its madness cost.` });
      r.splice('_kw', { line: `DB$ _ToGraveyard | Cards$ ${iid} | SpellDescription$ Otherwise it goes to the graveyard.` });
      return 'ok';
    }
    case '_ToGraveyard': {
      for (const iid of (p.Cards ?? '').split(',')) {
        const c = state.cards[iid];
        if (c?.zone !== 'exile') continue;
        moveCard(state, ctx, iid, 'graveyard');
        log(state, ctx, c.owner, `${cardName(c, ctx.lookup)} is put into its owner's graveyard.`);
      }
      return 'ok';
    }
    case '_Replicate': {
      const iid = r.trig?.card;
      const item = iid ? state.stack.find((s) => s.iid === iid) : undefined;
      const n = item?.castInfo?.replicated ?? 0;
      if (n > 0) r.splice('_kw', { line: `DB$ CopySpellAbility | Defined$ TriggeredSpellAbility | Amount$ ${n} | MayChooseTarget$ True | SpellDescription$ Replicate: copy it.` });
      return 'ok';
    }
    case '_FlashSac': {
      if (!onBf?.castInfo?.flashSac || !onBf.cardId) return 'ok';
      (state.delayedTriggers ??= []).push({
        id: randomId(ctx.rng), controller: r.controller, sourceIid: onBf.iid, sourceName: r.sourceName, text: `${r.sourceName}: sacrifice it (cast with flash)`,
        step: 'cleanup', turn: state.turn, createdStep: state.step,
        auto: { cardId: onBf.cardId, face: 0, source: 'trigger', index: -1, targets: [], line: 'DB$ Sacrifice | Defined$ Self | SpellDescription$ Sacrifice it.', trigger: { mode: 'Delayed', remembered: [onBf.iid], lki: {} } },
      });
      log(state, ctx, r.controller, `${r.sourceName} will be sacrificed at the beginning of the next cleanup step.`);
      return 'ok';
    }
    case '_PutBottom': {
      const cards = (p.Cards ?? '').split(',').filter((x) => state.cards[x]?.zone === 'exile');
      for (let k = cards.length - 1; k > 0; k--) { const j = Math.floor(ctx.rng() * (k + 1)); [cards[k], cards[j]] = [cards[j], cards[k]]; }
      for (const iid of cards) moveCard(state, ctx, iid, 'library', { position: 'bottom' });
      if (cards.length) log(state, ctx, r.controller, `${cards.length} card${cards.length === 1 ? ' is' : 's are'} put on the bottom of the library in a random order.`);
      return 'ok';
    }
    case '_Storm': {
      const st = turnStats(state);
      const before = Object.values(st.cast).reduce((a, b) => a + b, 0) - 1;
      if (before <= 0) { log(state, ctx, r.controller, `Storm: no spells were cast before ${r.sourceName} this turn.`); return 'ok'; }
      log(state, ctx, r.controller, `Storm count ${before}.`);
      r.splice('_kw', { line: `DB$ CopySpellAbility | Defined$ TriggeredSpellAbility | Amount$ ${before} | MayChooseTarget$ True | SpellDescription$ Copy it.` });
      return 'ok';
    }
  }
  return 'ok';
}

// ------------------------------------------------------------------ Play: cast a card during the resolution

function play(state: GameState, ctx: Ctx, r: MoreRun): Result {
  const p = r.step.params;
  let cards: string[];
  if (p.Defined === 'ExiledWith') cards = r.sourceIid ? [...(state.remembered?.[r.sourceIid] ?? [])] : [];
  // Valid$ cards in ValidZone$ (Arcane Savant: "a card you exiled with cards named Arcane Savant").
  else if (!p.Defined && p.Valid && p.ValidZone) cards = p.ValidZone.split(',').flatMap((z) => zoneCards(state, z));
  else cards = r.defined(p.Defined ?? 'Remembered')?.cards ?? [];
  cards = cards.filter((iid) => state.cards[iid] && state.cards[iid].zone !== 'battlefield' && state.cards[iid].zone !== 'stack');
  if (p.Valid) { const f = cardFilter(state, r, p.Valid); cards = cards.filter((x) => f(state.cards[x])); }
  if (p.ValidSA === 'Spell') cards = cards.filter((x) => !faceOf(state.cards[x], ctx.lookup).types.includes('Land'));
  if (!cards.length) { log(state, ctx, r.controller, `${r.sourceName}: no card to play.`); return 'ok'; }
  const who = p.Controller ? r.defined(p.Controller)?.players[0] ?? r.controller : p.DefinedPlayer ? r.defined(p.DefinedPlayer)?.players[0] ?? r.controller : r.controller;
  const free = p.WithoutManaCost === 'True' || !p.PlayCost;
  // CopyCard$ True: a copy of the card is cast; the card itself stays where it is.
  const copy = p.CopyCard === 'True';
  const d: MData = { kind: 'more', m: 'play', cont: r.contAt(r.index + 1), pid: who, queue: cards, free, cost: p.PlayCost ?? '', optional: p.Optional === 'True' || p.OptionalDecider != null, source: r.sourceName, ...(copy ? { copy: true } : {}) };
  // Amount$ N with more candidates: the player picks which (and casts it right away).
  const n = /^\d+$/.test(p.Amount ?? '') ? parseInt(p.Amount!, 10) : undefined;
  if (n != null && cards.length > n) {
    const names = new Set<string>();
    const opts = cards.filter((x) => { const k = state.cards[x].cardId ?? x; if (names.has(k)) return false; names.add(k); return true; })
      .map((x) => ({ value: x, label: `${copy ? 'Copy and cast' : 'Cast'} ${nm(state, ctx, x)}` }));
    ask(state, ctx, who, `${r.sourceName}: choose a card to ${copy ? 'copy — you may cast the copy' : 'cast'}${free && !p.PlayCost ? ' without paying its mana cost' : ''}`,
      [...opts, { value: 'no', label: "Don't" }], { ...d, m: 'playPick', left: n });
    return 'wait';
  }
  return askPlay(state, ctx, d) ? 'wait' : 'ok';
}

/** Cards `pid` noted for `name` (GamePlayer.notes: NoteCards$ / NoteCardsFor$, engine/pregame.ts). */
export function notedFor(state: GameState, pid: string, name: string): string[] {
  return state.players.find((x) => x.pid === pid)?.notes?.[name] ?? [];
}

/**
 * A copy of a card to cast (Play CopyCard$ True): a token with the card's characteristics, so it ceases to exist when
 * it leaves the stack. It is created "on the stack" (the cast puts it there; continueAfterCast removes it when it
 * isn't cast).
 */
function castableCopy(state: GameState, ctx: Ctx, pid: string, iid: string): CardInstance {
  const src = state.cards[iid];
  const f = faceOf(src, ctx.lookup);
  const data: TokenData = { name: f.name, typeLine: f.typeLine, colors: (f.colors ?? []) as TokenData['colors'], oracle: f.oracle, keywords: f.keywords, ...(f.power != null ? { power: f.power } : {}), ...(f.toughness != null ? { toughness: f.toughness } : {}) };
  let cid = randomId(ctx.rng);
  while (state.cards[cid]) cid = randomId(ctx.rng);
  const inst: CardInstance = {
    iid: cid, cardId: src.cardId, token: data, owner: pid, controller: pid, zone: 'stack', tapped: false, faceDown: false, transformed: false,
    counters: {}, damage: 0, tempPT: [0, 0], permPT: [0, 0], summoningSick: false, noUntap: false, revealedTo: [],
  };
  state.cards[cid] = inst;
  return inst;
}

/** Cast the card `iid` of a Play question (or a copy of it, CopyCard$ True); `rest` are offered afterwards. */
function playOne(state: GameState, ctx: Ctx, d: MData, iid: string, rest: string[], x?: number) {
  const cost = playCost(state, ctx, d, iid);
  const after = rest.length ? { ...d, m: 'play', queue: rest } : undefined;
  const extra = { cost: cost && d.cost ? (d.cost as string) : '', after, ...(x != null ? { x } : {}) };
  if (d.copy) {
    const from = state.cards[iid].zone;
    const cp = castableCopy(state, ctx, d.pid, iid);
    log(state, ctx, d.pid, `${pname(state, d.pid)} copies ${nm(state, ctx, iid)} (${d.source}).`);
    castDuringResolution(state, ctx, d.pid, cp.iid, `${d.source}, a copy`, d.cont, { ...extra, copyFrom: from });
    return;
  }
  castDuringResolution(state, ctx, d.pid, iid, d.source as string, d.cont, extra);
}

/** Ask about the next card to play. Returns true when a question is open (or the chain was resumed). */
function askPlay(state: GameState, ctx: Ctx, d: MData): boolean {
  const queue = (d.queue as string[]).filter((x) => state.cards[x] && state.cards[x].zone !== 'battlefield' && state.cards[x].zone !== 'stack');
  if (!queue.length) { resumeAuto(state, ctx, d.cont); return true; }
  const iid = queue[0];
  const cost = playCost(state, ctx, d, iid);
  if (cost === null) {
    log(state, ctx, d.pid, `${pname(state, d.pid)} can't pay to cast ${nm(state, ctx, iid)} (${d.source}).`);
    return askPlay(state, ctx, { ...d, queue: queue.slice(1) });
  }
  // An X in the cost (Entreat the Angels' miracle cost {X}{W}{W}): choose X among the payable values.
  const xs = cost && /(^|\s)X(\s|$)/.test(cost) ? payableXs(state, ctx, d.pid, cost) : null;
  if (xs) {
    ask(state, ctx, d.pid, `${d.source}: cast ${nm(state, ctx, iid)} by paying ${cost}? Choose X`,
      [...xs.map((x) => ({ value: `x:${x}`, label: `Cast ${nm(state, ctx, iid)} with X=${x}` })), { value: 'no', label: "Don't" }], { ...d, queue });
    return true;
  }
  const what = d.copy ? `a copy of ${nm(state, ctx, iid)}` : nm(state, ctx, iid);
  ask(state, ctx, d.pid, `${d.source}: cast ${what}${cost ? ` by paying ${cost}` : ' without paying its mana cost'}?`,
    [{ value: 'yes', label: `Cast ${what}` }, { value: 'no', label: "Don't" }], { ...d, queue });
  return true;
}

/** The values of X `pid` can pay a Forge cost with (highest first). */
function payableXs(state: GameState, ctx: Ctx, pid: string, cost: string): number[] {
  const { toks } = parseCostTokens(cost);
  const out: number[] = [];
  for (let x = 0; x <= 30 && canPayCost(state, ctx, pid, undefined, toks, x); x++) out.unshift(x);
  return out;
}

/** '' = free; a Forge cost text; null = can't be paid. */
function playCost(state: GameState, ctx: Ctx, d: MData, iid: string): string | null {
  if (!d.cost) return '';
  const mv = state.cards[iid]?.cardId ? ctx.lookup(state.cards[iid].cardId!)?.cmc ?? 0 : 0;
  const cost = (d.cost as string).replace(/ConvertedManaCost/g, String(mv));
  const { toks, unknown } = parseCostTokens(cost);
  if (unknown.length) return '';
  return canPayCost(state, ctx, d.pid, undefined, toks, 0) ? cost.replace(/PayEnergy<(\d+)>/, '{E}×$1') : null;
}

/**
 * Cast a card during a resolution (Shelldock Isle, Spell Queller, cascade ...): modes and targets are asked first
 * (data.m 'castTargets'), then the spell goes on the stack and the resolution continues with `cont`.
 * Returns true when a question was asked.
 */
export function castDuringResolution(state: GameState, ctx: Ctx, pid: string, iid: string, via: string, cont: AutoCont | undefined, extra: { cost?: string; after?: MData; x?: number; copyFrom?: Zone } = {}): boolean {
  const c = state.cards[iid];
  if (!c) { if (cont) resumeAuto(state, ctx, cont); return !!cont; }
  if (faceOf(c, ctx.lookup).types.includes('Land')) {
    c.faceDown = false;
    moveCard(state, ctx, iid, 'battlefield', { controller: pid });
    log(state, ctx, pid, `${pname(state, pid)} plays ${cardName(c, ctx.lookup)} (${via}).`);
    if (cont) resumeAuto(state, ctx, cont);
    return !!cont;
  }
  const sp = c.cardId ? spellAbility(c.cardId, 0) : undefined;
  const d: MData = { kind: 'more', m: 'castTargets', cont: cont ?? (null as unknown as AutoCont), pid, iid, via, modes: undefined, cost: extra.cost ?? '', ...(extra.after ? { after: extra.after } : {}), ...(extra.x != null ? { x: extra.x } : {}), ...(extra.copyFrom ? { copyFrom: extra.copyFrom } : {}) };
  if (sp?.ability.api === 'Charm' && sp.ability.choices?.length) {
    const ab = sp.ability;
    askCastMode(state, ctx, { ...d, m: 'castModes', picked: [], min: ab.charmMin ?? 1, max: ab.charmMax ?? 1, repeat: ab.params.CanRepeatModes === 'True' });
    return true;
  }
  return castTargetsStep(state, ctx, d);
}

/** Ask for the next mode of a modal spell cast during a resolution (one at a time, up to CharmNum$; Mystic Confluence repeats). */
function askCastMode(state: GameState, ctx: Ctx, d: MData) {
  const c = state.cards[d.iid as string];
  const ab = c?.cardId ? spellAbility(c.cardId, 0)?.ability : undefined;
  const picked = d.picked as string[];
  const max = d.max as number;
  const opts = (ab?.choices ?? []).filter((ch) => d.repeat || !picked.includes(ch.name)).map((ch) => ({ value: ch.name, label: ch.ability.description }));
  if (picked.length >= (d.min as number) && picked.length > 0) opts.push({ value: 'done', label: 'Done choosing modes' });
  const left = max - picked.length;
  ask(state, ctx, d.pid as string, `${d.via}: ${c ? cardName(c, ctx.lookup) : 'the spell'} — choose ${max === 1 ? 'a mode' : `a mode (${left} of ${max} left)`}`, opts, d);
}

function castTargetsStep(state: GameState, ctx: Ctx, d: MData): boolean {
  const c = state.cards[d.iid as string];
  const sp = c?.cardId ? spellAbility(c.cardId, 0) : undefined;
  const modes = d.modes as string[] | undefined;
  const specs = sp ? targetSpecs(sp.ability, modes) : [];
  if (c && specs.length) {
    const cands = specs.map((s) => candidates(state, ctx, s, d.pid, c.iid));
    if (specs.some((s, k) => s.min > 0 && cands[k].length < s.min)) {
      log(state, ctx, d.pid, `${cardName(c, ctx.lookup)} has no legal targets — it can't be cast (${d.via}).`);
      continueAfterCast(state, ctx, d);
      return !!d.cont;
    }
    ask(state, ctx, d.pid, `${d.via}: choose targets for ${cardName(c, ctx.lookup)}`, [{ value: 'cancel', label: "Don't cast it" }], { ...d, m: 'castTargets' },
      { targets: { specs, sourceIid: c.iid, controller: d.pid, label: cardName(c, ctx.lookup) } });
    return true;
  }
  finishCast(state, ctx, d, []);
  return !!d.cont;
}

function candidates(state: GameState, ctx: Ctx, spec: TargetSpec, controller: string, sourceIid: string | undefined): TargetRef[] {
  const refs: TargetRef[] = [];
  if (spec.players) for (const p of state.players) refs.push({ kind: 'player', pid: p.pid });
  if (spec.zone === 'stack') for (const s of state.stack) refs.push({ kind: 'stack', id: s.id });
  else if (spec.cards) for (const iid of Object.keys(state.cards)) refs.push({ kind: 'card', iid });
  return refs.filter((r) => isValidTarget(state, spec, r, controller, sourceIid, ctx.lookup));
}

function finishCast(state: GameState, ctx: Ctx, d: MData, targets: TargetRef[][], targetZones: Record<string, string> = {}) {
  const pid = d.pid;
  const c = state.cards[d.iid as string];
  if (!c) { if (d.cont) resumeAuto(state, ctx, d.cont); return; }
  const cost = d.cost as string;
  if (cost) {
    const mv = c.cardId ? ctx.lookup(c.cardId)?.cmc ?? 0 : 0;
    const { toks } = parseCostTokens(cost.replace(/ConvertedManaCost/g, String(mv)));
    payCostNow(state, ctx, pid, undefined, toks, typeof d.x === 'number' ? d.x : 0);
  }
  const x = typeof d.x === 'number' ? d.x : undefined;
  const from = (d.copyFrom as Zone | undefined) ?? c.zone;
  c.faceDown = false;
  detach(state, c);
  c.zone = 'stack';
  c.controller = pid;
  c.revealedTo = [];
  const splitData = c.cardId ? ctx.lookup(c.cardId) : undefined;
  c.castAs = splitData?.layout === 'split' && splitData.faces?.length ? splitData.faces[0].name : undefined; // split / Room: the left half
  c.transformed = false;
  c.castInfo = { option: 'free', ...(from !== 'hand' ? { from } : {}), ...(x != null ? { x } : {}) };
  const name = cardName(c, ctx.lookup);
  const item: StackItem = { id: randomId(ctx.rng), kind: 'spell', iid: c.iid, controller: pid, text: name, castInfo: { ...c.castInfo }, ...(x != null ? { x } : {}) };
  const sp = c.cardId ? spellAbility(c.cardId, 0) : undefined;
  if (sp) {
    item.auto = { cardId: c.cardId!, face: 0, source: 'spell', index: sp.index, targets, targetZones, costOption: 'free', ...(x != null ? { x } : {}) };
    const modes = d.modes as string[] | undefined;
    if (modes) item.auto.modes = modes;
  }
  state.stack.push(item);
  const st = turnStats(state);
  st.cast[pid] = (st.cast[pid] ?? 0) + 1;
  (st.castCards ??= []).push(JSON.parse(JSON.stringify(c)) as CardInstance); // Count$ThisTurnCast_ (counts.ts)
  const gs = (state.gameStats ??= { cast: {} });
  gs.cast[pid] = (gs.cast[pid] ?? 0) + 1;
  emit(state, { t: 'cast', iid: c.iid, pid, nth: st.cast[pid] });
  const tn = targets.flat().map((t) => (t.kind === 'player' ? pname(state, t.pid) : t.kind === 'card' ? nm(state, ctx, t.iid) : 'a spell'));
  log(state, ctx, pid, `${pname(state, pid)} casts ${name}${x != null ? ` (X=${x})` : ''}${cost ? '' : ' without paying its mana cost'} (${d.via})${tn.length ? ` targeting ${tn.join(', ')}` : ''}.`);
  continueAfterCast(state, ctx, d);
}

function continueAfterCast(state: GameState, ctx: Ctx, d: MData) {
  // A copy that wasn't cast (no legal targets, declined) ceases to exist.
  if (d.copyFrom && state.cards[d.iid as string] && !state.stack.some((s) => s.iid === d.iid)) delete state.cards[d.iid as string];
  if (d.after) { askPlay(state, ctx, d.after as MData); return; }
  if (d.cont) resumeAuto(state, ctx, d.cont);
}

// ------------------------------------------------------------------ answers

/** Answer a more.ts Pending ('choose'). undefined = not ours. */
export function answerMorePending(state: GameState, ctx: Ctx, pend: Pending, value: string): string | null | undefined {
  const d = pend.data as unknown as MData;
  if (d.kind !== 'more') return undefined;
  const who = pname(state, pend.pid);
  switch (d.m) {
    case 'info': resumeAuto(state, ctx, d.cont); return null;
    case 'throne': {
      const c = state.cards[value];
      const me = player(state, pend.pid);
      if (c?.zone === 'library') {
        moveCard(state, ctx, value, 'battlefield', { controller: pend.pid });
        if (state.cards[value]?.zone === 'battlefield') {
          c.counters['+1/+1'] = (c.counters['+1/+1'] ?? 0) + 3;
          addEffect(state, ctx, { kind: 'pump', controller: pend.pid, until: 'yourNextTurn', cards: [value], pt: [0, 0], keywords: ['Hexproof'] });
          c.tempKeywords = [...new Set([...(c.tempKeywords ?? []), 'Hexproof'])];
        }
        log(state, ctx, pend.pid, `${cardName(c, ctx.lookup)} enters the battlefield with three +1/+1 counters and gains hexproof until ${me.name}'s next turn.`);
      }
      shuffleLibrary(state, me, ctx.rng);
      resumeAuto(state, ctx, d.cont);
      return null;
    }
    case 'modes': {
      const picked = d.picked as string[];
      if (value !== 'done') picked.push(value);
      if (value !== 'done' && picked.length < (d.max as number) && picked.length < (d.names as string[]).length) { askMode(state, ctx, d); return null; }
      const labels = d.labels as string[];
      const all = d.names as string[];
      log(state, ctx, pend.pid, `${who} chooses: ${picked.map((p) => labels[all.indexOf(p)]).join('; ') || 'no mode'} (${d.source}).`);
      let at = d.at as number;
      const ordered = all.filter((n) => picked.includes(n));
      for (const name of ordered) at += addSplice(d.cont, at, name, {});
      resumeAuto(state, ctx, d.cont);
      return null;
    }
    case 'generic': {
      addSplice(d.cont, d.at as number, value, {});
      d.cont.next = (d.at as number) + 1;
      log(state, ctx, pend.pid, `${who} chooses: ${pend.options.find((o) => o.value === value)?.label ?? value}.`);
      resumeAuto(state, ctx, d.cont);
      return null;
    }
    case 'number': {
      const n = parseInt(value, 10);
      if (Number.isNaN(n) || n < (d.min as number) || n > (d.max as number)) return `Choose a number from ${d.min} to ${d.max}`;
      d.cont.chosen = { ...(d.cont.chosen ?? {}), number: n };
      log(state, ctx, pend.pid, `${who} chooses ${n}.`);
      resumeAuto(state, ctx, d.cont);
      return null;
    }
    case 'chooseCard': {
      const specs = d.specs as ChoiceSpec[];
      const picked = d.picked as string[];
      let idx = d.idx as number;
      let got = (d.got as number | undefined) ?? 0;
      if (value !== 'done') { picked.push(value); got++; }
      const s = specs[idx];
      if (value === 'done' || got >= s.n) { idx++; got = 0; }
      if (idx < specs.length) { askChooseCard(state, ctx, { ...d, idx, got, picked }); return null; }
      const shown = d.reveal || specs.every((sp) => !sp.reveal);
      log(state, ctx, pend.pid, `${d.source}: ${shown ? names(state, ctx, picked) : `${picked.length} card${picked.length === 1 ? '' : 's'}`} chosen.`);
      d.cont.chosen = { ...(d.cont.chosen ?? {}), cards: [...picked] };
      if (d.remember) {
        d.cont.remembered = d.accumulate ? [...new Set([...d.cont.remembered, ...picked])] : [...picked];
        for (const iid of picked) if (state.cards[iid] && !d.cont.lki[iid]) d.cont.lki[iid] = lkiOf(state.cards[iid], ctx, state);
      }
      resumeAuto(state, ctx, d.cont);
      return null;
    }
    case 'tapOrUntap': {
      const [iid, ...rest] = d.queue as string[];
      const c = state.cards[iid];
      if (c?.zone === 'battlefield') { c.tapped = value === 'tap'; log(state, ctx, pend.pid, `${who} ${value === 'tap' ? 'taps' : 'untaps'} ${cardName(c, ctx.lookup)} (${d.source}).`); }
      askTapOrUntap(state, ctx, { ...d, queue: rest });
      return null;
    }
    case 'prolif': {
      if (value === 'done') { finishProliferate(state, ctx, d); return null; }
      (d.picked as string[]).push(value);
      askProliferate(state, ctx, d);
      return null;
    }
    case 'connive': {
      const c = state.cards[value];
      if (c?.zone === 'hand') {
        const land = faceOf(c, ctx.lookup).types.includes('Land');
        moveCard(state, ctx, value, 'graveyard', { cause: 'discard' });
        log(state, ctx, pend.pid, `${who} discards ${cardName(c, ctx.lookup)}.`);
        d.nonland = (d.nonland as number) + (land ? 0 : 1);
      }
      d.left = (d.left as number) - 1;
      askConnive(state, ctx, d);
      return null;
    }
    case 'explore': {
      const card = state.cards[d.card as string];
      if (value === 'graveyard' && card?.zone === 'library') { moveCard(state, ctx, card.iid, 'graveyard'); log(state, ctx, pend.pid, `${who} puts ${cardName(card, ctx.lookup)} into their graveyard.`); }
      else log(state, ctx, pend.pid, `${who} keeps the card on top.`);
      explore(state, ctx, d);
      return null;
    }
    case 'protection': {
      giveProtection(state, ctx, d.cards as string[], [value], d.source as string);
      resumeAuto(state, ctx, d.cont);
      return null;
    }
    case 'empower': {
      empowerPut(state, ctx, pend.pid, value, d.n as number);
      resumeAuto(state, ctx, d.cont);
      return null;
    }
    case 'amass': {
      const c = state.cards[value];
      if (c) { c.counters['+1/+1'] = (c.counters['+1/+1'] ?? 0) + (d.n as number); log(state, ctx, pend.pid, `${cardName(c, ctx.lookup)} gets ${d.n} +1/+1 counter${d.n === 1 ? '' : 's'} (amass).`); }
      resumeAuto(state, ctx, d.cont);
      return null;
    }
    case 'earthbend': {
      const c = state.cards[value];
      if (c?.zone === 'battlefield') {
        (c.animations ??= []).push({ id: randomId(ctx.rng), controller: pend.pid, until: 'permanent', turn: state.turn, power: 0, toughness: 0, addTypes: ['Creature'], keywords: ['Haste'] });
        c.counters['+1/+1'] = (c.counters['+1/+1'] ?? 0) + (d.n as number);
        addEffect(state, ctx, { kind: 'grant', controller: pend.pid, until: 'permanent', iid: value, zone: 'battlefield', keyword: 'Earthbend', source: d.source as string });
        log(state, ctx, pend.pid, `${cardName(c, ctx.lookup)} becomes a 0/0 creature with haste (earthbend ${d.n}) and gets ${d.n} +1/+1 counter${d.n === 1 ? '' : 's'}.`);
      }
      resumeAuto(state, ctx, d.cont);
      return null;
    }
    case 'copies': {
      const queue = d.queue as StackItem[];
      if (value === 'keep') { const it = queue.shift()!; state.stack.push(it); log(state, ctx, pend.pid, `${who} puts ${it.text} on the stack.`); }
      pushCopies(state, ctx, { ...d, queue, mayChoose: d.mayChoose && value !== 'keep' ? d.mayChoose : d.mayChoose });
      return null;
    }
    case 'play': {
      const [iid, ...rest] = d.queue as string[];
      const xm = /^x:(\d+)$/.exec(value);
      if ((value === 'yes' || xm) && iid) {
        // The remaining cards (if any) are offered after this one is on the stack.
        playOne(state, ctx, d, iid, rest, xm ? parseInt(xm[1], 10) : undefined);
        return null;
      }
      if (iid) log(state, ctx, d.pid, `${who} doesn't cast ${d.copy ? 'a copy of ' : ''}${nm(state, ctx, iid)} (${d.source}).`);
      askPlay(state, ctx, { ...d, queue: rest });
      return null;
    }
    case 'playPick': {
      if (value === 'no' || !state.cards[value]) { log(state, ctx, d.pid, `${who} doesn't cast anything (${d.source}).`); resumeAuto(state, ctx, d.cont); return null; }
      playOne(state, ctx, { ...d, m: 'play' }, value, []);
      return null;
    }
    case 'castModes': {
      const picked = d.picked as string[];
      if (value !== 'done') picked.push(value);
      if (value !== 'done' && picked.length < (d.max as number)) { askCastMode(state, ctx, d); return null; }
      castTargetsStep(state, ctx, { ...d, m: 'castTargets', modes: [...picked] });
      return null;
    }
    case 'castTargets': {
      if (value === 'cancel') { log(state, ctx, d.pid, `${who} doesn't cast it (${d.via}).`); continueAfterCast(state, ctx, d); return null; }
      return null;
    }
  }
  return undefined;
}

/** Answer a more.ts Pending that takes targets ('chooseTargets'). undefined = not ours. */
export function answerMoreTargets(state: GameState, ctx: Ctx, pend: Pending, targets: TargetRef[][]): string | null | undefined {
  const d = pend.data as unknown as MData;
  if (d.kind !== 'more') return undefined;
  if (d.m === 'castTargets') {
    const c = state.cards[d.iid as string];
    const sp = c?.cardId ? spellAbility(c.cardId, 0) : undefined;
    if (!c || !sp) return 'That card is gone';
    const res = checkTargets(state, sp.ability, d.modes as string[] | undefined, targets, d.pid, c.iid, ctx, cardName(c, ctx.lookup));
    if ('error' in res) return res.error;
    state.pending = state.pending.filter((p) => p !== pend);
    finishCast(state, ctx, d, res.targets, res.targetZones);
    return null;
  }
  if (d.m === 'copies') {
    const queue = d.queue as StackItem[];
    const item = queue[0];
    const ab = item?.auto ? getAbility(item.auto) : undefined;
    if (!item || !ab) return 'Nothing to copy';
    const res = checkTargets(state, ab, item.auto!.modes, targets, item.controller, item.sourceIid ?? '', ctx, item.text);
    if ('error' in res) return res.error;
    state.pending = state.pending.filter((p) => p !== pend);
    item.auto!.targets = res.targets;
    item.auto!.targetZones = res.targetZones;
    queue.shift();
    state.stack.push(item);
    log(state, ctx, item.controller, `${pname(state, item.controller)} puts ${item.text} on the stack with new targets.`);
    pushCopies(state, ctx, { ...d, queue });
    return null;
  }
  return undefined;
}

// ------------------------------------------------------------------ Defined$ values / variables

/** Defined$ values this module knows. undefined = unknown. */
export function moreDefinedValue(state: GameState, r: { remembered: string[]; sourceIid?: string; trig?: AutoInfo['trigger']; item: StackItem; chosen?: AutoCont['chosen'] }, value: string | undefined): Objs | undefined {
  switch (value) {
    case 'Imprinted': return { cards: [...(r.chosen?.imprinted ?? [])], players: [] };
    case 'Remembered.ExiledWithSource': {
      const mem = r.remembered.length ? r.remembered : (r.sourceIid ? state.remembered?.[r.sourceIid] ?? [] : []);
      const ex = new Set(exiledWithSource(state, r.sourceIid));
      return { cards: mem.filter((x) => ex.has(x)), players: [] };
    }
    case 'ReplacedCard': return { cards: r.trig?.card ? [r.trig.card] : [], players: [] };
    case 'TriggeredSpellAbility': return { cards: r.trig?.card ? [r.trig.card] : [], players: [] };
    case 'TriggeredCardOpponent': {
      const who = r.trig?.player;
      return { cards: [], players: state.players.filter((p) => !p.conceded && p.pid !== who).map((p) => p.pid) };
    }
    case 'TriggeredDefender': case 'TriggeredDefender.Opponent & Valid Planeswalker.TriggeredDefender': {
      const d = r.trig?.defender;
      if (!d) return { cards: [], players: [] };
      return isPlayer(state, d) ? { cards: [], players: [d] } : { cards: [d], players: [] };
    }
    case 'RememberedController': case 'RememberedOwner': {
      const ps = r.remembered.map((x) => (isPlayer(state, x) ? x : value === 'RememberedOwner' ? state.cards[x]?.owner : state.cards[x]?.controller));
      return { cards: [], players: [...new Set(ps.filter((x): x is string => !!x))] };
    }
    case 'ExiledWith': return { cards: exiledWithSource(state, r.sourceIid), players: [] };
  }
  return undefined;
}

/** Counting variables this module knows (see moreVarSupported). undefined = unknown. */
export function moreVar(state: GameState, r: { controller: string; sourceIid?: string; remembered: string[]; chosen?: AutoCont['chosen']; trig?: AutoInfo['trigger']; item: StackItem }, ctx: Ctx, v: string): number | undefined {
  const me = state.players.find((p) => p.pid === r.controller);
  let m: RegExpExecArray | null;
  switch (v) {
    case 'Count$ChosenNumber': return r.chosen?.number ?? 0;
    case 'Count$RememberedSize': return r.remembered.length;
    case 'Count$YourCountersEnergy': return me?.counters.energy ?? 0;
    case 'Count$Monarch': return me?.designations.includes('Monarch') ? 1 : 0;
    case 'Count$Initiative': return me?.designations.includes('Initiative') ? 1 : 0;
    case 'Count$DungeonsCompleted': return me?.counters.dungeons ?? 0;
    case 'Count$TriggerRememberAmount': return r.trig?.amount ?? 0;
    // "that creature's power" of a reflexive trigger (Minsc & Boo): the trigger's remembered object, last known.
    case 'TriggerRemembered$CardPower': case 'TriggerRemembered$CardToughness': case 'TriggerRemembered$CardManaCost': {
      const iid = r.trig?.remembered?.[0];
      const c = iid ? state.cards[iid] : undefined;
      const l = (iid ? r.trig?.lki?.[iid] : undefined) ?? (c ? lkiOf(c, ctx, state) : undefined);
      if (!l) return 0;
      return v.endsWith('Power') ? l.power : v.endsWith('Toughness') ? l.toughness : l.mv;
    }
    case 'Count$ResolvedThisTurn': {
      const key = `resolved|${r.item.auto?.cardId}|${r.item.auto?.index}|${r.sourceIid}`;
      return state.turnInfo?.turn === state.turn ? state.turnInfo.activations[key] ?? 0 : 0;
    }
    case 'Count$CardsDrawnThisTurn': case 'Count$YouDrewThisTurn': return state.turnStats?.drawn[r.controller] ?? 0;
    case 'Count$YourLifeGainedThisTurn': case 'Count$LifeYouGainedThisTurn': return state.turnInfo?.turn === state.turn ? state.turnInfo.activations[`life+|${r.controller}`] ?? 0 : 0;
    case 'Remembered$CardManaCost': { const c = state.cards[r.remembered[0]]; return c?.cardId ? ctx.lookup(c.cardId)?.cmc ?? 0 : 0; }
    case 'Remembered$CardPower': { const c = state.cards[r.remembered[0]]; return c ? parseInt(faceOf(c, ctx.lookup).power ?? '0', 10) || 0 : 0; }
    case 'Remembered$Amount': return r.remembered.length;
    case 'PlayerCountRegisteredOpponents$HasPropertyLostLifeThisTurn': return state.players.filter((p) => p.pid !== r.controller && (state.turnInfo?.turn === state.turn ? state.turnInfo.activations[`life-|${p.pid}`] ?? 0 : 0) > 0).length;
  }
  if ((m = /^Count\$(Monarch|Initiative|Blessing|AltCost|Surged|Kicked|AttackedThisTurn|YouAttacked)\.(-?\d+)\.(-?\d+)$/.exec(v))) {
    const d = me?.designations ?? [];
    const ci = r.item.castInfo ?? (r.sourceIid ? state.cards[r.sourceIid]?.castInfo : undefined);
    const attacked = (state.turnInfo?.turn === state.turn ? state.turnInfo.activations[`attacks|${r.controller}`] ?? 0 : 0) > 0;
    const on = m[1] === 'Monarch' ? d.includes('Monarch') : m[1] === 'Initiative' ? d.includes('Initiative') : m[1] === 'Blessing' ? d.includes("City's Blessing")
      : m[1] === 'AltCost' ? /^alt/.test(ci?.option ?? '') : m[1] === 'Surged' ? ci?.option === 'surge' : m[1] === 'Kicked' ? !!ci?.kicked : attacked;
    return parseInt(on ? m[2] : m[3], 10);
  }
  if ((m = /^Count\$YourCounters(\w+)$/.exec(v))) return me?.counters[m[1].toLowerCase()] ?? 0;
  if ((m = /^Count\$wasCastFrom(Exile|Graveyard|Hand)\.(-?\d+)\.(-?\d+)$/.exec(v))) {
    const ci = r.item.castInfo ?? (r.sourceIid ? state.cards[r.sourceIid]?.castInfo : undefined);
    const from = ci ? ci.from ?? 'hand' : undefined;
    return parseInt(from === m[1].toLowerCase() ? m[2] : m[3], 10);
  }
  if (v === 'Count$AttackersDeclared' || v === 'Count$YouAttackedThisTurn') return state.turnInfo?.turn === state.turn ? state.turnInfo.activations[`attacks|${r.controller}`] ?? 0 : 0;
  if (v === 'DungeonsCompleted$Amount') return me?.counters.dungeons ?? 0;
  if ((m = /^PlayerCountOpponents\$HighestValid (.+)$/.exec(v))) {
    let best = 0;
    for (const p of state.players) {
      if (p.pid === r.controller || p.conceded) continue;
      const n = state.battlefield.filter((x) => matchCard(state.cards[x], m![1], { controller: p.pid, lookup: ctx.lookup }) === true).length;
      best = Math.max(best, n);
    }
    return best;
  }
  if ((m = /^PlayerCountOpponents\$(HighestCardsInHand|LowestLifeTotal|HighestLifeTotal)$/.exec(v))) {
    const opps = state.players.filter((p) => p.pid !== r.controller && !p.conceded);
    if (!opps.length) return 0;
    if (m[1] === 'HighestCardsInHand') return Math.max(...opps.map((p) => p.zones.hand.length));
    return m[1] === 'LowestLifeTotal' ? Math.min(...opps.map((p) => p.life)) : Math.max(...opps.map((p) => p.life));
  }
  if ((m = /^Count\$(CardsInYourHand|xPaid)\/(HalfDown|HalfUp|Twice)$/.exec(v))) {
    const base = m[1] === 'xPaid' ? r.item.auto?.x ?? r.item.x ?? 0 : me?.zones.hand.length ?? 0;
    return m[2] === 'HalfDown' ? Math.floor(base / 2) : m[2] === 'HalfUp' ? Math.ceil(base / 2) : base * 2;
  }
  if ((m = /^Count\$ValidExile (.+)$/.exec(v))) return state.players.flatMap((p) => p.zones.exile).filter((x) => matchCard(state.cards[x], m![1], { controller: r.controller, sourceIid: r.sourceIid, lookup: ctx.lookup }) === true).length;
  if ((m = /^(Remembered|RememberedLKI|Targeted|TargetedLKI)\$Card(Power|Toughness|ManaCost)\/(HalfUp|HalfDown|Twice)$/.exec(v))) {
    const iid = m[1].startsWith('Remembered') ? r.remembered[0] : (r.item.auto?.targets ?? []).flat().map((t) => (t.kind === 'card' ? t.iid : '')).find(Boolean);
    const l = iid ? (r as { lki?: Record<string, import('./types.ts').Lki> }).lki?.[iid] : undefined;
    const c = iid ? state.cards[iid] : undefined;
    const base = m[2] === 'ManaCost' ? (l?.mv ?? (c?.cardId ? ctx.lookup(c.cardId)?.cmc ?? 0 : 0)) : l ? (m[2] === 'Power' ? l.power : l.toughness) : c ? parseInt((m[2] === 'Power' ? faceOf(c, ctx.lookup).power : faceOf(c, ctx.lookup).toughness) ?? '0', 10) || 0 : 0;
    return m[3] === 'HalfUp' ? Math.ceil(base / 2) : m[3] === 'HalfDown' ? Math.floor(base / 2) : base * 2;
  }
  if ((m = /^RememberedLKI\$Valid (.+)$/.exec(v))) {
    // "RememberedLKI$Valid Card.RememberedPlayerCtrl" (Winds of Abandon): remembered cards controlled by the remembered player.
    const lki = (r as { lki?: Record<string, import('./types.ts').Lki> }).lki ?? {};
    const ps = r.remembered.filter((x) => isPlayer(state, x));
    if (/RememberedPlayerCtrl/.test(m[1])) return Object.keys(lki).filter((x) => !isPlayer(state, x) && ps.includes(lki[x].controller)).length;
    return Object.keys(lki).length;
  }
  // "Remembered$Valid Artifact.sharesControllerWith Imprinted" (Goblin Welder): its controller (owner in a graveyard) matches.
  if ((m = /^(Remembered|Imprinted)\$Valid (\w+)\.sharesControllerWith (Remembered|Imprinted)$/.exec(v))) {
    const set = (k: string) => (k === 'Remembered' ? r.remembered : r.chosen?.imprinted ?? []).filter((x) => state.cards[x]);
    const ctl = (x: string) => (state.cards[x].zone === 'battlefield' ? state.cards[x].controller : state.cards[x].owner);
    const others = new Set(set(m[3]).map(ctl));
    return set(m[1]).filter((x) => others.has(ctl(x)) && matchCard(state.cards[x], m![2], { controller: r.controller, lookup: ctx.lookup }) === true).length;
  }
  if ((m = /^Remembered\$Valid (.+)$/.exec(v))) return r.remembered.filter((x) => state.cards[x] && matchCard(state.cards[x], m![1], { controller: r.controller, sourceIid: r.sourceIid, lookup: ctx.lookup }) === true).length;
  if ((m = /^TriggeredCard\$Card(Power|Toughness|ManaCost)$/.exec(v))) {
    const iid = r.trig?.card;
    const l = iid ? r.trig?.lki?.[iid] : undefined;
    const c = iid ? state.cards[iid] : undefined;
    if (m[1] === 'ManaCost') return l?.mv ?? (c?.cardId ? ctx.lookup(c.cardId)?.cmc ?? 0 : 0);
    if (l) return m[1] === 'Power' ? l.power : l.toughness;
    return c ? parseInt((m[1] === 'Power' ? faceOf(c, ctx.lookup).power : faceOf(c, ctx.lookup).toughness) ?? '0', 10) || 0 : 0;
  }
  if ((m = /^TriggerCount\$(\w+)$/.exec(v))) return r.trig?.amount ?? 0;
  if ((m = /^Count\$Devotion\.([A-Za-z]+)$/.exec(v)) || (m = /^Count\$DevotionDual\.([A-Za-z]+)\.([A-Za-z]+)$/.exec(v))) {
    const cols = [COLORS[m[1]] ?? m[1][0], ...(m[2] ? [COLORS[m[2]] ?? m[2][0]] : [])];
    let n = 0;
    for (const iid of state.battlefield) {
      const c = state.cards[iid];
      if (c.controller !== r.controller || c.faceDown || !c.cardId) continue;
      const cost = faceOf(c, ctx.lookup).manaCost ?? '';
      for (const s of cost.match(/\{[^}]+\}/g) ?? []) if (cols.some((col) => s.includes(col))) n++;
    }
    return n;
  }
  return undefined;
}
