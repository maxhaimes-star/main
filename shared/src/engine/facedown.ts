/**
 * Face-down permanents (rules 701.40 manifest, 701.58 cloak, 701.62 manifest dread, 702.37 morph, 702.168 disguise):
 *
 *  - A face-down permanent is a nameless, colorless 2/2 creature with no text (game/rules.ts faceOf / effectivePT);
 *    its identity is hidden from the other players (game/view.ts). CardInstance.faceDownAs says how it got there.
 *  - Disguise and cloak: while face down it has ward {2} (hasKeyword / keyword-play.ts wardForgeCost).
 *  - Casting face down (morph / megamorph / disguise): a {3} cast option ('faceDown', costs.ts / reducer).
 *  - Turning it face up is a special action (GameAction turnFaceUp, any time its controller has priority): pay its
 *    morph / disguise cost, or — manifested / cloaked creature cards — its mana cost. Megamorph adds a +1/+1 counter.
 *    "When this is turned face up" triggers (Mode$ TurnFaceUp) see a 'faceUp' event.
 *  - Effect APIs Manifest, Cloak (top card(s) of a library or defined cards onto the battlefield face down) and
 *    ManifestDread (look at the top two, manifest one, the other into the graveyard), run from more.ts.
 */
import { cardName, type Lookup } from '../game/rules.ts';
import { type Ctx, emit, log, moveCard, player, randomId, shuffleLibrary } from '../game/state.ts';
import type { CardInstance, FaceDownKind, GameState } from '../game/types.ts';
import { costText } from './keywords.ts';
import { TOP_OF_LIBRARY_RE } from './more-support.ts';
import { canPayMana, payMana } from './paycost.ts';
import { getScript } from './script.ts';
import type { AutoCont, ParsedAbility, Pending } from './types.ts';
import type { MoreRun } from './more.ts';
import { resumeAuto } from './resolve.ts';

/** Effect APIs this module runs. */
export const FACEDOWN_APIS = new Set(['Manifest', 'Cloak', 'ManifestDread']);

// ------------------------------------------------------------------ keyword costs

/** A mana-only Forge cost as mana symbols ("4 G" -> "{4}{G}"), or undefined (life, reveal ... costs). */
function manaCostText(forge: string): string | undefined {
  const t = costText((forge.trim() || '0').split(/\s+/).map((x) => (/^[WUBRG]{2}$/.test(x) ? `${x[0]}/${x[1]}` : x)).join(' '));
  return /^(\{[^}]+\})+$/.test(t) ? t : undefined;
}

/** The morph / megamorph / disguise keyword of a card: what casting it face down makes it, and the turn-up cost. */
export function faceDownKeyword(cardId: string | undefined): { kind: 'morph' | 'disguise'; megamorph: boolean; cost?: string } | undefined {
  const kws = cardId ? getScript(cardId)?.[0]?.keywords ?? [] : [];
  for (const k of kws) {
    const i = k.indexOf(':');
    const head = (i < 0 ? k : k.slice(0, i)).trim();
    if (head !== 'Morph' && head !== 'Megamorph' && head !== 'Disguise') continue;
    return { kind: head === 'Disguise' ? 'disguise' : 'morph', megamorph: head === 'Megamorph', cost: manaCostText(i < 0 ? '0' : k.slice(i + 1)) };
  }
  return undefined;
}

/** Does a face-down permanent have ward {2} (disguise, cloak)? */
export function faceDownWard(c: Pick<CardInstance, 'faceDown' | 'faceDownAs'>): boolean {
  return c.faceDown && (c.faceDownAs === 'disguise' || c.faceDownAs === 'cloak');
}

/** Costs that turn a face-down permanent face up: its morph / disguise cost, and — manifested / cloaked — its mana cost if it's a creature card. */
export function faceUpCosts(c: CardInstance, lookup: Lookup): string[] {
  if (!c.faceDown || !c.cardId) return [];
  const out: string[] = [];
  const kw = faceDownKeyword(c.cardId);
  if (kw?.cost != null) out.push(kw.cost);
  if (c.faceDownAs === 'manifest' || c.faceDownAs === 'cloak') {
    const data = lookup(c.cardId);
    const front = data?.faces?.[0] ?? data;
    if (data && front && (data.faces?.[0]?.typeLine ?? data.typeLine).includes('Creature')) out.push(front.manaCost || data.manaCost || '');
  }
  return [...new Set(out)];
}

/** The cost `pid` would pay now to turn `c` face up (the first payable one), or why they can't. */
export function faceUpCost(state: GameState, pid: string, c: CardInstance, lookup: Lookup): { cost: string } | { error: string } {
  if (!c || c.zone !== 'battlefield' || !c.faceDown) return { error: "That isn't a face-down permanent" };
  if (c.controller !== pid) return { error: "You don't control that permanent" };
  const costs = faceUpCosts(c, lookup);
  if (!costs.length) return { error: `${cardName({ ...c, faceDown: false }, lookup)} can't be turned face up (it has no morph or disguise cost${c.faceDownAs === 'manifest' || c.faceDownAs === 'cloak' ? " and isn't a creature card" : ''})` };
  const ok = costs.find((m) => canPayMana(state, pid, m, 0, lookup));
  return ok != null ? { cost: ok } : { error: `Not enough mana to turn it face up (${costs.join(' or ')})` };
}

/** Turn a face-down permanent face up (special action: no stack). Returns an error or null. */
export function turnFaceUp(state: GameState, ctx: Ctx, pid: string, iid: string): string | null {
  const c = state.cards[iid];
  const r = faceUpCost(state, pid, c, ctx.lookup);
  if ('error' in r) return r.error;
  if (r.cost && !payMana(state, ctx, pid, r.cost)) return `Not enough mana to turn it face up (${r.cost})`;
  revealFaceUp(state, ctx, pid, c);
  const kw = faceDownKeyword(c.cardId);
  if (kw?.megamorph && kw.cost === r.cost) c.counters['+1/+1'] = (c.counters['+1/+1'] ?? 0) + 1;
  log(state, ctx, pid, `${player(state, pid).name} pays ${r.cost || '{0}'} and turns ${cardName(c, ctx.lookup)} face up${kw?.megamorph && kw.cost === r.cost ? ' (megamorph: +1/+1 counter)' : ''}.`);
  return null;
}

/** The permanent is turned face up (by its controller, or by an effect): "when turned face up" triggers. */
export function revealFaceUp(state: GameState, _ctx: Ctx, pid: string, c: CardInstance) {
  c.faceDown = false;
  c.faceDownAs = undefined;
  emit(state, { t: 'faceUp', iid: c.iid, pid });
}

// ------------------------------------------------------------------ manifest / cloak / manifest dread

/** Put a card onto the battlefield face down under `controller` (a 2/2; ward {2} if cloaked). True if it got there. */
export function putFaceDown(state: GameState, ctx: Ctx, iid: string, controller: string, kind: FaceDownKind, tapped = false): boolean {
  if (!state.cards[iid]) return false;
  moveCard(state, ctx, iid, 'battlefield', { faceDown: true, faceDownAs: kind, controller, tapped });
  const c = state.cards[iid];
  return !!c && c.zone === 'battlefield';
}

type FData = { kind: 'facedown'; m: 'dread'; cont: AutoCont; pid: string; left: number; done: string[]; remember: boolean; source: string };

function players(r: MoreRun): string[] {
  const p = r.step.params;
  if (!p.DefinedPlayer || p.DefinedPlayer === 'You') return [r.controller];
  return r.defined(p.DefinedPlayer)?.players ?? [];
}

/** Run Manifest / Cloak / ManifestDread. undefined = not ours. */
export function execFaceDownStep(state: GameState, ctx: Ctx, r: MoreRun): 'ok' | 'wait' | undefined {
  const step = r.step;
  if (!FACEDOWN_APIS.has(step.api)) return undefined;
  const p = step.params;
  const n = r.amount(p.Amount, 1) ?? 1;
  const remember = p.RememberManifested === 'True' || p.RememberCloaked === 'True';
  if (step.api === 'ManifestDread') {
    const pid = players(r)[0];
    if (!pid) return 'ok';
    const d: FData = { kind: 'facedown', m: 'dread', cont: r.contAt(r.index + 1), pid, left: n, done: [], remember, source: r.sourceName };
    if (dread(state, ctx, d)) return 'wait';
    if (remember) r.remember(d.done);
    return 'ok';
  }
  const kind: FaceDownKind = step.api === 'Cloak' ? 'cloak' : 'manifest';
  const done: string[] = [];
  const shuffle = new Set<string>();
  if (p.Defined === 'Remembered') {
    for (const iid of r.remembered) {
      const c = state.cards[iid];
      if (!c || c.zone === 'battlefield') continue;
      const ctl = p.DefinedPlayer ? players(r)[0] ?? r.controller : r.controller;
      if (c.zone === 'library') shuffle.add(c.owner);
      if (putFaceDown(state, ctx, iid, ctl, kind, p.Tapped === 'True')) done.push(iid);
    }
  } else if (p.Defined && TOP_OF_LIBRARY_RE.test(p.Defined)) {
    // "the top card of that player's library", put onto the battlefield under the effect controller's control.
    const m = TOP_OF_LIBRARY_RE.exec(p.Defined)!;
    const owners = m[1] ? r.defined(m[1])?.players ?? [] : [state.activePlayer];
    for (const pid of owners) {
      for (let i = 0; i < n; i++) {
        const top = player(state, pid).zones.library[0];
        if (!top) break;
        if (putFaceDown(state, ctx, top, r.controller, kind, p.Tapped === 'True')) done.push(top);
      }
    }
  } else {
    for (const pid of players(r)) {
      for (let i = 0; i < n; i++) {
        const top = player(state, pid).zones.library[0];
        if (!top) break;
        if (putFaceDown(state, ctx, top, pid, kind, p.Tapped === 'True')) done.push(top);
      }
    }
  }
  if (p.Shuffle === 'True') for (const pid of shuffle) shuffleLibrary(state, player(state, pid), ctx.rng);
  const verb = kind === 'cloak' ? 'cloaks' : 'manifests';
  log(state, ctx, r.controller, `${r.sourceName} ${verb} ${done.length || 'no'} card${done.length === 1 ? '' : 's'} (face down 2/2${kind === 'cloak' ? ' with ward {2}' : ''}).`);
  if (remember) r.remember(done);
  return 'ok';
}

/** One manifest dread: ask which of the top two to manifest. True when a question was asked. */
function dread(state: GameState, ctx: Ctx, d: FData): boolean {
  while (d.left > 0) {
    const lib = player(state, d.pid).zones.library;
    const top = lib.slice(0, 2);
    if (!top.length) break;
    if (top.length === 1) {
      d.left--;
      if (putFaceDown(state, ctx, top[0], d.pid, 'manifest')) d.done.push(top[0]);
      log(state, ctx, d.pid, `${player(state, d.pid).name} manifests dread (${d.source}).`);
      continue;
    }
    const opts: Pending['options'] = top.map((iid) => ({ value: iid, label: cardName(state.cards[iid], ctx.lookup) }));
    state.pending.push({ id: randomId(ctx.rng), pid: d.pid, prompt: `${d.source}: manifest dread — choose the card to put onto the battlefield face down (the other goes into your graveyard)`, options: opts, data: d as unknown as Record<string, unknown> });
    return true;
  }
  if (d.remember) d.cont = { ...d.cont, remembered: [...d.done] };
  return false;
}

/** Answer a manifest dread question. undefined = not ours. */
export function answerFaceDownPending(state: GameState, ctx: Ctx, pend: Pending, value: string): string | null | undefined {
  const d = pend.data as unknown as FData;
  if (d.kind !== 'facedown') return undefined;
  const lib = player(state, d.pid).zones.library;
  const top = lib.slice(0, 2);
  if (!top.includes(value)) return 'That card is no longer on top of your library';
  const other = top.find((x) => x !== value);
  d.left--;
  if (putFaceDown(state, ctx, value, d.pid, 'manifest')) d.done.push(value);
  if (other) moveCard(state, ctx, other, 'graveyard');
  log(state, ctx, d.pid, `${player(state, d.pid).name} manifests dread (${d.source}) and puts ${other ? cardName(state.cards[other], ctx.lookup) : 'nothing'} into their graveyard.`);
  if (dread(state, ctx, d)) return null;
  resumeAuto(state, ctx, d.cont);
  return null;
}

/** Face-down spells: is this card castable face down (morph / disguise), and as what? */
export function faceDownCastKind(c: CardInstance): FaceDownKind | undefined {
  return faceDownKeyword(c.cardId)?.kind;
}

