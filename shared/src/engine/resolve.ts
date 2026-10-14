/**
 * Runs automated stack items: target legality, the effect chain, player decisions (Pending / peek
 * continuations) and state-based actions.
 */
import { cardName, effectivePT, faceOf, hasKeyword, isCreature, payFromPool } from '../game/rules.ts';
import { type Ctx, drawCards, log, moveCard, newInstance, player, randomId, shuffleLibrary } from '../game/state.ts';
import type { CardInstance, GamePlayer, GameState, StackItem, Zone } from '../game/types.ts';
import { abilityAt, flatten, SCRIPTS, specIndexByStep, supportedVar, targetSpecs, unsupportedReason } from './script.ts';
import { isValidTarget, matchCard, matchPlayer, type MatchEnv, type Tri } from './targets.ts';
import type { AutoCont, AutoInfo, Lki, ParsedAbility, Pending, TargetRef, TargetSpec } from './types.ts';

// ------------------------------------------------------------------ run context

interface Run extends AutoCont {
  steps: ParsedAbility[];
  specOf: (number | undefined)[];
  svars: Record<string, string>;
  controller: string;
  sourceIid?: string;
  sourceName: string;
  /** Creatures dealt damage by a deathtouch source during this run. */
  deathtouched: string[];
}

export function abilityFor(auto: AutoInfo): ParsedAbility | undefined {
  return abilityAt(auto.cardId, auto.face, auto.index);
}

function makeRun(state: GameState, ctx: Ctx, cont: AutoCont): Run | undefined {
  const auto = cont.item.auto!;
  const ab = abilityFor(auto);
  if (!ab) return undefined;
  const steps = flatten(ab, auto.modes);
  const sourceIid = cont.item.iid ?? cont.item.sourceIid;
  const src = sourceIid ? state.cards[sourceIid] : undefined;
  const face = SCRIPTS.cards[auto.cardId]?.[auto.face];
  return {
    ...cont, steps, specOf: specIndexByStep(steps), svars: face?.svars ?? {}, controller: cont.item.controller, sourceIid,
    sourceName: src ? cardName(src, ctx.lookup) : face?.name ?? 'It', deathtouched: [],
  };
}

function contAt(r: Run, next: number): AutoCont {
  return JSON.parse(JSON.stringify({ item: r.item, next, targets: r.targets, lki: r.lki, remembered: r.remembered })) as AutoCont;
}

function lkiOf(c: CardInstance, ctx: Ctx): Lki {
  const [power, toughness] = effectivePT(c, ctx.lookup);
  const data = c.cardId ? ctx.lookup(c.cardId) : undefined;
  return { power, toughness, mv: c.token && !c.cardId ? 0 : data?.cmc ?? 0, controller: c.controller, owner: c.owner, name: cardName(c, ctx.lookup) };
}

const ZONE: Record<string, Zone> = { battlefield: 'battlefield', hand: 'hand', graveyard: 'graveyard', exile: 'exile', library: 'library', stack: 'stack', command: 'command' };
const zoneOf = (forge: string | undefined): Zone | undefined => (forge ? ZONE[forge.trim().toLowerCase()] : undefined);

function names(state: GameState, ctx: Ctx, iids: string[]): string {
  return iids.map((i) => (state.cards[i] ? cardName(state.cards[i], ctx.lookup) : 'a card')).join(', ') || 'nothing';
}

function pname(state: GameState, pid: string): string {
  return state.players.find((p) => p.pid === pid)?.name ?? 'someone';
}

function manual(state: GameState, ctx: Ctx, r: Run, step: ParsedAbility) {
  const what = step.description === step.api ? `${r.sourceName} (${step.api})` : step.description;
  log(state, ctx, r.controller, `Not automated: ${what} — resolve it by hand.`);
}

// ------------------------------------------------------------------ targets & defined objects

function ownTargets(r: Run, i: number): TargetRef[] | undefined {
  const s = r.specOf[i];
  return s == null ? undefined : r.targets[s] ?? [];
}

/** Targets of the nearest step at or before `i` that has targets. */
function parentTargets(r: Run, i: number): TargetRef[] {
  for (let j = i; j >= 0; j--) { const t = ownTargets(r, j); if (t) return t; }
  return [];
}

function split(state: GameState, refs: TargetRef[]): { cards: string[]; players: string[] } {
  const cards: string[] = [], players: string[] = [];
  for (const ref of refs) {
    if (ref.kind === 'card') cards.push(ref.iid);
    else if (ref.kind === 'player') players.push(ref.pid);
    else { const it = state.stack.find((s) => s.id === ref.id); if (it?.iid) cards.push(it.iid); }
  }
  return { cards, players };
}

interface Objs { cards: string[]; players: string[] }

function defined(state: GameState, r: Run, i: number, value: string | undefined): Objs | undefined {
  const live = state.players.filter((p) => !p.conceded).map((p) => p.pid);
  const tgt = () => split(state, parentTargets(r, i));
  const ctrlOf = (iid: string) => r.lki[iid]?.controller ?? state.cards[iid]?.controller;
  const ownerOf = (iid: string) => r.lki[iid]?.owner ?? state.cards[iid]?.owner;
  const src = r.sourceIid ? state.cards[r.sourceIid] : undefined;
  switch (value) {
    case 'You': return { cards: [], players: [r.controller] };
    case 'Self': case 'Parent': return { cards: r.sourceIid && src ? [r.sourceIid] : [], players: [] };
    case 'Targeted': case 'TargetedCard': return tgt();
    case 'ParentTarget': return split(state, i > 0 ? parentTargets(r, i - 1) : []);
    case 'TargetedPlayer': return { cards: [], players: tgt().players };
    case 'TargetedAndYou': return { cards: [], players: [...new Set([...tgt().players, r.controller])] };
    case 'TargetedController': {
      const t = parentTargets(r, i);
      const ps = t.map((ref) => (ref.kind === 'card' ? ctrlOf(ref.iid) : ref.kind === 'player' ? ref.pid : r.lki[ref.id]?.controller ?? state.stack.find((s) => s.id === ref.id)?.controller));
      return { cards: [], players: [...new Set(ps.filter((x): x is string => !!x))] };
    }
    case 'TargetedOwner': {
      const ps = tgt().cards.map(ownerOf);
      return { cards: [], players: [...new Set(ps.filter((x): x is string => !!x))] };
    }
    case 'Player': return { cards: [], players: live };
    case 'Opponent': case 'Player.Opponent': return { cards: [], players: live.filter((p) => p !== r.controller) };
    case 'Remembered': case 'RememberedLKI': return { cards: [...r.remembered], players: [] };
    case 'Enchanted': case 'Equipped': return { cards: src?.attachedTo ? [src.attachedTo] : [], players: [] };
  }
  return undefined;
}

/** Objects a step acts on: its own targets, else Defined$, else the default. */
function objects(state: GameState, r: Run, i: number, dflt: 'You' | 'Self'): Objs | undefined {
  const step = r.steps[i];
  const own = ownTargets(r, i);
  if (own) return split(state, own);
  return defined(state, r, i, step.params.Defined ?? dflt);
}

// ------------------------------------------------------------------ amounts & conditions

function firstCardTarget(r: Run): string | undefined {
  for (const list of r.targets) for (const ref of list) if (ref.kind === 'card') return ref.iid;
  for (const list of r.targets) for (const ref of list) if (ref.kind === 'stack' && r.lki[ref.id]) return ref.id;
  return undefined;
}

function evalVar(state: GameState, ctx: Ctx, r: Run, v: string): number | undefined {
  if (!supportedVar(v)) return undefined;
  if (v === 'Count$xPaid') return r.item.auto?.x ?? r.item.x ?? 0;
  let m = /^Number\$(-?\d+)$/.exec(v);
  if (m) return parseInt(m[1], 10);
  m = /^(Targeted|TargetedLKI|Remembered|RememberedLKI)\$Card(Power|Toughness|ManaCost)$/.exec(v);
  if (m) {
    const iid = m[1].startsWith('Remembered') ? r.remembered[0] ?? firstCardTarget(r) : firstCardTarget(r);
    if (!iid) return 0;
    const l = r.lki[iid] ?? (state.cards[iid] ? lkiOf(state.cards[iid], ctx) : undefined);
    if (!l) return 0;
    return m[2] === 'Power' ? l.power : m[2] === 'Toughness' ? l.toughness : l.mv;
  }
  const src = r.sourceIid ? state.cards[r.sourceIid] : undefined;
  switch (v) {
    case 'Count$CardPower': return src ? effectivePT(src, ctx.lookup)[0] : undefined;
    case 'Count$CardToughness': return src ? effectivePT(src, ctx.lookup)[1] : undefined;
    case 'Count$CardManaCost': return src ? lkiOf(src, ctx).mv : undefined;
    case 'Count$YourLifeTotal': return player(state, r.controller).life;
    case 'Count$CardsInYourHand': return player(state, r.controller).zones.hand.length;
  }
  return undefined;
}

function amount(state: GameState, ctx: Ctx, r: Run, raw: string | undefined, dflt: number): number | undefined {
  if (raw == null) return dflt;
  let s = raw.trim();
  let sign = 1;
  if (s.startsWith('+')) s = s.slice(1);
  else if (s.startsWith('-')) { sign = -1; s = s.slice(1); }
  if (/^\d+$/.test(s)) return sign * parseInt(s, 10);
  const sv = r.svars[s];
  const n = sv ? evalVar(state, ctx, r, sv) : undefined;
  return n == null ? undefined : sign * n;
}

function env(state: GameState, ctx: Ctx, r: Run): MatchEnv {
  return { controller: r.controller, sourceIid: r.sourceIid, lookup: ctx.lookup, num: (name) => amount(state, ctx, r, name, 0) };
}

function compare(state: GameState, ctx: Ctx, r: Run, left: number, expr: string): Tri {
  const m = /^(LT|LE|EQ|NE|GE|GT)(.+)$/.exec(expr);
  if (!m) return 'unknown';
  const right = amount(state, ctx, r, m[2], 0);
  if (right == null) return 'unknown';
  switch (m[1]) {
    case 'LT': return left < right;
    case 'LE': return left <= right;
    case 'EQ': return left === right;
    case 'NE': return left !== right;
    case 'GE': return left >= right;
    default: return left > right;
  }
}

function condition(state: GameState, ctx: Ctx, r: Run, i: number): Tri {
  const p = r.steps[i].params;
  let result: Tri = true;
  if (p.ConditionDefined || p.ConditionPresent) {
    let cards: string[];
    if (p.ConditionDefined) {
      const d = defined(state, r, i, p.ConditionDefined);
      if (!d) return 'unknown';
      cards = d.cards.filter((c) => state.cards[c]);
    } else cards = [...state.battlefield];
    let count = 0;
    let unknown = false;
    for (const iid of cards) {
      const m = matchCard(state.cards[iid], p.ConditionPresent ?? 'Card', env(state, ctx, r));
      if (m === true) count++;
      else if (m === 'unknown') unknown = true;
    }
    const c = compare(state, ctx, r, count, p.ConditionCompare ?? 'GE1');
    result = unknown && c === false ? 'unknown' : unknown && c === true ? 'unknown' : c;
  }
  if (p.ConditionCheckSVar) {
    const v = amount(state, ctx, r, p.ConditionCheckSVar, 0);
    const c: Tri = v == null ? 'unknown' : compare(state, ctx, r, v, p.ConditionSVarCompare ?? 'GE1');
    if (c === false) return false;
    if (c === 'unknown' && result === true) result = 'unknown';
  }
  return result;
}

// ------------------------------------------------------------------ effects helpers

function counterKind(forge: string): string {
  const t = forge.trim().toUpperCase();
  if (t === 'P1P1') return '+1/+1';
  if (t === 'M1M1') return '-1/-1';
  if (t === 'LOYALTY') return 'loyalty';
  return t.toLowerCase();
}

function onBattlefield(state: GameState, iid: string): CardInstance | undefined {
  const c = state.cards[iid];
  return c && c.zone === 'battlefield' ? c : undefined;
}

function damageCard(state: GameState, ctx: Ctx, r: Run, c: CardInstance, n: number, deathtouch: boolean) {
  const f = faceOf(c, ctx.lookup);
  if (isCreature(c, ctx.lookup)) {
    c.damage += n;
    if (deathtouch && n > 0) r.deathtouched.push(c.iid);
  } else if (f.types.includes('Planeswalker')) {
    c.counters.loyalty = Math.max(0, (c.counters.loyalty ?? 0) - n);
  } else if (f.types.includes('Battle')) {
    c.counters.defense = Math.max(0, (c.counters.defense ?? 0) - n);
  }
}

function libraryIndex(state: GameState, ctx: Ctx, r: Run, raw: string | undefined): 'top' | 'bottom' | number {
  if (raw == null) return 'top';
  const n = amount(state, ctx, r, raw, 0) ?? 0;
  if (n === 0) return 'top';
  if (n < 0) return 'bottom';
  return n;
}

function moveTo(state: GameState, ctx: Ctx, r: Run, iid: string, dest: Zone, p: Record<string, string>) {
  const c = state.cards[iid];
  if (!c) return;
  if (dest === 'library') moveCard(state, ctx, iid, 'library', { position: libraryIndex(state, ctx, r, p.LibraryPosition) });
  else if (dest === 'battlefield') moveCard(state, ctx, iid, 'battlefield', { tapped: p.Tapped === 'True', controller: p.GainControl === 'True' ? r.controller : c.zone === 'battlefield' ? c.controller : c.owner });
  else moveCard(state, ctx, iid, dest);
}

function manaString(cost: string, x: number): string | undefined {
  const parts = cost.trim().split(/\s+/);
  let out = '';
  for (const s of parts) {
    if (/^\d+$/.test(s) || /^[WUBRGC]$/.test(s)) out += `{${s}}`;
    else if (s === 'X') out += `{${x}}`;
    else return undefined;
  }
  return out;
}

function openPeek(state: GameState, ctx: Ctx, r: Run, i: number, p: GamePlayer, mode: 'scry' | 'surveil' | 'look' | 'search', n: number) {
  const lib = p.zones.library;
  p.peek = { mode, iids: mode === 'search' ? lib.slice() : lib.slice(0, Math.max(0, n)), label: `${r.sourceName}: ${r.steps[i].description}`, then: contAt(r, i + 1) };
}

// ------------------------------------------------------------------ picks (Pending)

interface PickData {
  kind: 'pick';
  action: 'move' | 'discard' | 'sacrifice';
  chooser: string;
  candidates: string[];
  left: number;
  optional: boolean;
  dest?: Zone;
  params?: Record<string, string>;
  label: string;
  queue: Omit<PickData, 'queue' | 'cont'>[];
  cont?: AutoCont;
}

interface UnlessData {
  kind: 'unless';
  stackId: string;
  cost: string;
  dest?: string;
  params: Record<string, string>;
  cont?: AutoCont;
}

function pickPending(state: GameState, ctx: Ctx, d: PickData): boolean {
  const cands = d.candidates.filter((iid) => state.cards[iid]);
  if (!cands.length || d.left <= 0) return false;
  const options = cands.map((iid) => ({ value: iid, label: cardName(state.cards[iid], ctx.lookup) }));
  if (d.optional) options.push({ value: 'none', label: 'Done' });
  const pending: Pending = {
    id: randomId(ctx.rng), pid: d.chooser, prompt: `${d.label}${d.left > 1 ? ` (${d.left} left)` : ''}`, options,
    data: { ...d, candidates: cands } as unknown as Record<string, unknown>,
  };
  state.pending.push(pending);
  return true;
}

/** Start a pick (with queued follow-ups). Returns true when a Pending was created. */
function startPicks(state: GameState, ctx: Ctx, picks: Omit<PickData, 'queue' | 'cont'>[], cont: AutoCont | undefined): boolean {
  for (let k = 0; k < picks.length; k++) {
    if (pickPending(state, ctx, { ...picks[k], queue: picks.slice(k + 1), cont })) return true;
  }
  return false;
}

// ------------------------------------------------------------------ steps

type StepResult = 'ok' | 'wait';

function execStep(state: GameState, ctx: Ctx, r: Run, i: number): StepResult {
  const step = r.steps[i];
  const p = step.params;
  const me = player(state, r.controller);
  const reason = unsupportedReason(step);
  const supportedAnyway = step.api === 'DealDamage' && reason === 'DealDamage (divided)';
  if (step.api === 'Effect' && !reason) return 'ok'; // e.g. "can't be regenerated": nothing to do
  if (reason && !supportedAnyway) {
    if (step.api !== 'Cleanup') manual(state, ctx, r, step);
    return 'ok';
  }
  const cond = condition(state, ctx, r, i);
  if (cond === false) {
    log(state, ctx, r.controller, `${r.sourceName}: condition not met — skipped (${step.description}).`);
    return 'ok';
  }
  if (cond === 'unknown') log(state, ctx, r.controller, `Check by hand: ${p.ConditionDescription ?? step.description} (condition not verified).`);
  const remember = (iids: string[]) => {
    if (Object.keys(p).some((k) => k.startsWith('Remember'))) {
      for (const iid of iids) if (state.cards[iid] && !r.lki[iid]) r.lki[iid] = lkiOf(state.cards[iid], ctx);
      r.remembered = [...iids];
    }
  };
  const bad = () => { manual(state, ctx, r, step); return 'ok' as const; };
  const E = env(state, ctx, r);

  switch (step.api) {
    case 'Cleanup': {
      if (p.ClearRemembered) r.remembered = [];
      return 'ok';
    }
    case 'DealDamage': {
      const n = amount(state, ctx, r, p.NumDmg, 0);
      const o = objects(state, r, i, 'You');
      if (n == null || !o || (!ownTargets(r, i) && !p.Defined)) return bad();
      if (p.DividedAsYouChoose && o.cards.length + o.players.length > 1) return bad();
      const srcObj = p.DamageSource ? defined(state, r, i, p.DamageSource)?.cards[0] : r.sourceIid;
      const src = srcObj ? state.cards[srcObj] : undefined;
      const srcName = src ? cardName(src, ctx.lookup) : r.sourceName;
      const deathtouch = !!src && hasKeyword(src, ctx.lookup, 'Deathtouch');
      const hit: string[] = [];
      for (const iid of o.cards) { const c = onBattlefield(state, iid); if (c) { damageCard(state, ctx, r, c, n, deathtouch); hit.push(cardName(c, ctx.lookup)); } }
      for (const pid of o.players) { player(state, pid).life -= n; hit.push(pname(state, pid)); }
      log(state, ctx, r.controller, `${srcName} deals ${n} damage to ${hit.join(', ') || 'nothing'}.`);
      if (src && hasKeyword(src, ctx.lookup, 'Lifelink') && hit.length) {
        const gain = n * hit.length;
        player(state, src.controller).life += gain;
        log(state, ctx, src.controller, `${pname(state, src.controller)} gains ${gain} life (lifelink).`);
      }
      return 'ok';
    }
    case 'DamageAll': {
      const n = amount(state, ctx, r, p.NumDmg, 0);
      if (n == null) return bad();
      const hit: string[] = [];
      if (p.ValidCards) {
        const cs = state.battlefield.map((x) => state.cards[x]);
        const ms = cs.map((c) => matchCard(c, p.ValidCards, E));
        if (ms.includes('unknown')) return bad();
        cs.forEach((c, k) => { if (ms[k]) { damageCard(state, ctx, r, c, n, false); hit.push(cardName(c, ctx.lookup)); } });
      }
      if (p.ValidPlayers) for (const pl of state.players) if (!pl.conceded && matchPlayer(pl.pid, p.ValidPlayers, E) !== false) { pl.life -= n; hit.push(pl.name); }
      log(state, ctx, r.controller, `${r.sourceName} deals ${n} damage to ${hit.join(', ') || 'nothing'}.`);
      return 'ok';
    }
    case 'Draw': {
      const n = amount(state, ctx, r, p.NumCards, 1);
      const o = objects(state, r, i, 'You');
      if (n == null || !o) return bad();
      for (const pid of o.players) {
        const got = drawCards(state, player(state, pid), n);
        log(state, ctx, pid, `${pname(state, pid)} draws ${got} card${got === 1 ? '' : 's'}.`);
      }
      return 'ok';
    }
    case 'Destroy': {
      const o = objects(state, r, i, 'Self');
      if (!o) return bad();
      const done: string[] = [];
      for (const iid of o.cards) {
        const c = onBattlefield(state, iid);
        if (!c) continue;
        if (hasKeyword(c, ctx.lookup, 'Indestructible')) { log(state, ctx, null, `${cardName(c, ctx.lookup)} is indestructible.`); continue; }
        r.lki[iid] ??= lkiOf(c, ctx);
        const nm = cardName(c, ctx.lookup);
        moveCard(state, ctx, iid, 'graveyard');
        done.push(nm);
        remember([iid]);
      }
      log(state, ctx, r.controller, `${r.sourceName} destroys ${done.join(', ') || 'nothing'}.`);
      return 'ok';
    }
    case 'DestroyAll': case 'SacrificeAll': {
      const valid = p.ValidCards ?? (step.api === 'SacrificeAll' && p.Defined ? undefined : 'Card');
      let list: string[];
      if (!valid) {
        const d = defined(state, r, i, p.Defined);
        if (!d) return bad();
        list = d.cards.filter((x) => onBattlefield(state, x));
      } else {
        const ms = state.battlefield.map((x) => [x, matchCard(state.cards[x], valid, E)] as const);
        if (ms.some(([, m]) => m === 'unknown')) return bad();
        list = ms.filter(([, m]) => m).map(([x]) => x);
      }
      const done: string[] = [];
      for (const iid of list) {
        const c = state.cards[iid];
        if (step.api === 'DestroyAll' && hasKeyword(c, ctx.lookup, 'Indestructible')) continue;
        done.push(cardName(c, ctx.lookup));
        moveCard(state, ctx, iid, 'graveyard');
      }
      log(state, ctx, r.controller, `${r.sourceName}: ${step.api === 'DestroyAll' ? 'destroyed' : 'sacrificed'} ${done.length ? done.join(', ') : 'nothing'}.`);
      return 'ok';
    }
    case 'ChangeZone': {
      const dest = zoneOf(p.Destination);
      if (!dest) return bad();
      const origins = (p.Origin ?? '').split(',').map((z) => zoneOf(z)).filter((z): z is Zone => !!z);
      let cards: string[] | undefined;
      const own = ownTargets(r, i);
      if (own) cards = split(state, own).cards;
      else if (p.Defined) {
        const d = defined(state, r, i, p.Defined);
        if (!d) return bad();
        cards = d.cards;
      }
      if (!cards) {
        // Hidden choice: search the library, or pick from hand / graveyard / battlefield.
        const chooserPid = p.DefinedPlayer ? defined(state, r, i, p.DefinedPlayer)?.players[0] : r.controller;
        if (!chooserPid) return bad();
        const chooser = player(state, chooserPid);
        if (origins.includes('library')) {
          openPeek(state, ctx, r, i, chooser, 'search', 0);
          log(state, ctx, chooserPid, `${chooser.name} searches their library (${r.sourceName}: ${step.description}) — choose the card.`);
          return 'wait';
        }
        const origin = origins[0];
        if (!origin || origins.length > 1) return bad();
        const changeType = p.ChangeType ?? 'Card';
        const pool = origin === 'battlefield' ? state.battlefield : origin === 'stack' ? [] : chooser.zones[origin as 'hand'];
        const cands = pool.filter((x) => {
          const c = state.cards[x];
          if (origin === 'battlefield' && !/YouCtrl|OppCtrl|YouOwn/.test(changeType) && c.controller !== chooserPid) return false;
          return matchCard(c, changeType, E) !== false;
        });
        const n = p.ChangeNum === 'All' ? cands.length : amount(state, ctx, r, p.ChangeNum, 1);
        if (n == null) return bad();
        if (!cands.length) { log(state, ctx, chooserPid, `${r.sourceName}: no card to choose.`); return 'ok'; }
        const where = dest === 'library' ? (p.LibraryPosition === '-1' ? 'on the bottom of your library' : 'on top of your library') : `to ${dest === 'battlefield' ? 'the battlefield' : `your ${dest}`}`;
        const created = startPicks(state, ctx, [{
          kind: 'pick', action: 'move', chooser: chooserPid, candidates: cands, left: Math.min(n, cands.length), optional: p.Mandatory !== 'True' && origin !== 'hand',
          dest, params: p, label: `${r.sourceName}: choose a card to put ${where}${dest === 'library' && n > 1 ? ' (the last one you choose ends up on top)' : ''}`,
        }], contAt(r, i + 1));
        return created ? 'wait' : 'ok';
      }
      const moved: string[] = [];
      for (const iid of cards) {
        const c = state.cards[iid];
        if (!c) continue;
        const self = iid === r.sourceIid && (p.Defined === 'Self' || p.Defined === 'Parent');
        if (!self && origins.length && !origins.includes(c.zone) && !p.Origin?.includes('Any')) continue;
        r.lki[iid] ??= lkiOf(c, ctx);
        const nm = cardName(c, ctx.lookup);
        moveTo(state, ctx, r, iid, dest, p);
        moved.push(nm);
      }
      remember(cards.filter((x) => state.cards[x]));
      if (p.Shuffle === 'True') for (const pid of new Set(cards.map((x) => state.cards[x]?.owner).filter(Boolean) as string[])) shuffleLibrary(state, player(state, pid), ctx.rng);
      const destLabel = dest === 'library' ? 'its owner\'s library' : dest === 'battlefield' ? 'the battlefield' : `${dest}`;
      log(state, ctx, r.controller, moved.length ? `${r.sourceName}: ${moved.join(', ')} → ${destLabel}.` : `${r.sourceName}: nothing to move.`);
      return 'ok';
    }
    case 'ChangeZoneAll': {
      const dest = zoneOf(p.Destination);
      const origins = (p.Origin ?? '').split(',').map((z) => zoneOf(z));
      if (!dest || !origins.length || origins.some((z) => !z || z === 'stack')) return bad();
      const valid = p.ChangeType ?? p.ValidCards ?? 'Card';
      const pool: string[] = [];
      for (const origin of origins as Zone[]) {
        if (origin === 'battlefield') { pool.push(...state.battlefield); continue; }
        const own = ownTargets(r, i);
        const ps = own ? split(state, own).players : p.Defined ? defined(state, r, i, p.Defined)?.players : state.players.filter((x) => !x.conceded).map((x) => x.pid);
        if (!ps) return bad();
        pool.push(...ps.flatMap((pid) => [...player(state, pid).zones[origin as 'hand']]));
      }
      const ms = pool.map((x) => [x, matchCard(state.cards[x], valid, E)] as const);
      if (ms.some(([, m]) => m === 'unknown')) return bad();
      const list = ms.filter(([, m]) => m).map(([x]) => x);
      const owners = new Set(list.map((x) => state.cards[x].owner));
      for (const iid of list) moveTo(state, ctx, r, iid, dest, p);
      remember(list.filter((x) => state.cards[x]));
      if (p.Shuffle === 'True') for (const pid of owners) shuffleLibrary(state, player(state, pid), ctx.rng);
      log(state, ctx, r.controller, `${r.sourceName}: ${list.length} card${list.length === 1 ? '' : 's'} → ${dest}${p.Shuffle === 'True' ? ' (shuffled)' : ''}.`);
      return 'ok';
    }
    case 'Token': {
      const n = amount(state, ctx, r, p.TokenAmount, 1);
      const owners = p.TokenOwner ? defined(state, r, i, p.TokenOwner)?.players : [r.controller];
      if (n == null || !owners) return bad();
      const made: string[] = [];
      for (const script of (p.TokenScript ?? '').split(',').map((s) => s.trim())) {
        const token = SCRIPTS.tokens[script];
        if (!token) continue;
        for (const owner of owners) {
          for (let k = 0; k < n; k++) {
            const inst = newInstance(state, ctx.rng, owner, 'battlefield', undefined, token);
            inst.tapped = p.TokenTapped === 'True';
            inst.summoningSick = true;
            state.battlefield.push(inst.iid);
            made.push(inst.iid);
          }
          log(state, ctx, owner, `${pname(state, owner)} creates ${n} ${token.name}${token.power != null ? ` ${token.power}/${token.toughness}` : ''} token${n === 1 ? '' : 's'}.`);
        }
      }
      remember(made);
      if (p.TokenAttacking) log(state, ctx, r.controller, 'Reminder: the token enters attacking — declare it by hand.');
      return 'ok';
    }
    case 'PutCounter': case 'PutCounterAll': {
      const n = amount(state, ctx, r, p.Adapt ?? p.CounterNum, 1);
      if (n == null || !(p.CounterType || p.Adapt)) return bad();
      const kind = counterKind(p.CounterType ?? 'P1P1');
      if (p.Adapt) {
        const self = r.sourceIid ? onBattlefield(state, r.sourceIid) : undefined;
        if (self && (self.counters['+1/+1'] ?? 0) > 0) { log(state, ctx, r.controller, `${r.sourceName} already has +1/+1 counters — adapt does nothing.`); return 'ok'; }
      }
      let o: Objs | undefined;
      if (step.api === 'PutCounterAll') {
        const ms = state.battlefield.map((x) => [x, matchCard(state.cards[x], p.ValidCards ?? 'Card', E)] as const);
        if (ms.some(([, m]) => m === 'unknown')) return bad();
        o = { cards: ms.filter(([, m]) => m).map(([x]) => x), players: [] };
      } else o = objects(state, r, i, 'Self');
      if (!o) return bad();
      for (const iid of o.cards) {
        const c = state.cards[iid];
        if (!c) continue;
        c.counters[kind] = (c.counters[kind] ?? 0) + n;
        log(state, ctx, r.controller, `${cardName(c, ctx.lookup)} gets ${n} ${kind} counter${n === 1 ? '' : 's'} (now ${c.counters[kind]}).`);
      }
      for (const pid of o.players) {
        const pl = player(state, pid);
        pl.counters[kind] = (pl.counters[kind] ?? 0) + n;
        log(state, ctx, pid, `${pl.name} gets ${n} ${kind} counter${n === 1 ? '' : 's'} (now ${pl.counters[kind]}).`);
      }
      return 'ok';
    }
    case 'GainLife': case 'LoseLife': case 'SetLife': {
      const n = amount(state, ctx, r, p.LifeAmount, 0);
      const o = objects(state, r, i, 'You');
      if (n == null || !o) return bad();
      for (const pid of o.players) {
        const pl = player(state, pid);
        if (step.api === 'GainLife') pl.life += n;
        else if (step.api === 'LoseLife') pl.life -= n;
        else pl.life = n;
        const verb = step.api === 'GainLife' ? `gains ${n} life` : step.api === 'LoseLife' ? `loses ${n} life` : `has their life total set to ${n}`;
        log(state, ctx, pid, `${pl.name} ${verb} (${pl.life}).`);
      }
      return 'ok';
    }
    case 'Counter': {
      const refs = ownTargets(r, i) ?? (p.Defined ? (defined(state, r, i, p.Defined)?.cards ?? []).map((iid) => ({ kind: 'card', iid }) as TargetRef) : []);
      for (const ref of refs) {
        const item = ref.kind === 'stack' ? state.stack.find((s) => s.id === ref.id) : ref.kind === 'card' ? state.stack.find((s) => s.iid === ref.iid) : undefined;
        if (!item) continue;
        if (p.UnlessCost) {
          const x = amount(state, ctx, r, 'X', 0) ?? 0;
          const cost = manaString(p.UnlessCost, x);
          if (!cost) return bad();
          const data: UnlessData = { kind: 'unless', stackId: item.id, cost, dest: p.Destination, params: p, cont: contAt(r, i + 1) };
          state.pending.push({
            id: randomId(ctx.rng), pid: item.controller,
            prompt: `${r.sourceName}: pay ${cost} or ${item.text} is countered.`,
            options: [{ value: 'pay', label: `Pay ${cost}` }, { value: 'decline', label: "Don't pay" }],
            data: data as unknown as Record<string, unknown>,
          });
          log(state, ctx, r.controller, `${r.sourceName}: ${pname(state, item.controller)} may pay ${cost} to keep ${item.text} on the stack.`);
          return 'wait';
        }
        counterItem(state, ctx, item, p, r.sourceName, r);
      }
      return 'ok';
    }
    case 'Pump': case 'PumpAll': {
      const a = amount(state, ctx, r, p.NumAtt, 0);
      const d = amount(state, ctx, r, p.NumDef, 0);
      if (a == null || d == null) return bad();
      const kws = p.KW ? p.KW.split('&').map((k) => k.trim()).filter(Boolean) : [];
      let cards: string[];
      if (step.api === 'PumpAll') {
        const ms = state.battlefield.map((x) => [x, matchCard(state.cards[x], p.ValidCards ?? 'Creature', E)] as const);
        if (ms.some(([, m]) => m === 'unknown')) return bad();
        cards = ms.filter(([, m]) => m).map(([x]) => x);
      } else {
        const o = objects(state, r, i, 'Self');
        if (!o) return bad();
        cards = o.cards;
      }
      const hit: string[] = [];
      for (const iid of cards) {
        const c = onBattlefield(state, iid);
        if (!c) continue;
        c.tempPT = [c.tempPT[0] + a, c.tempPT[1] + d];
        if (kws.length) c.tempKeywords = [...new Set([...(c.tempKeywords ?? []), ...kws])];
        hit.push(cardName(c, ctx.lookup));
      }
      const bits = [(a || d) ? `get${hit.length === 1 ? 's' : ''} ${a >= 0 ? '+' : ''}${a}/${d >= 0 ? '+' : ''}${d}` : '', kws.length ? `gain${hit.length === 1 ? 's' : ''} ${kws.join(', ')}` : ''].filter(Boolean).join(' and ');
      if (hit.length) log(state, ctx, r.controller, `${hit.join(', ')} ${bits || 'is pumped'} until end of turn.`);
      else log(state, ctx, r.controller, `${r.sourceName}: nothing to pump.`);
      if (p.Duration && p.Duration !== 'UntilEndOfTurn') log(state, ctx, r.controller, `Reminder: this lasts ${p.Duration.replace(/([A-Z])/g, ' $1').trim().toLowerCase()} — the engine removes it at end of turn; re-apply by hand.`);
      return 'ok';
    }
    case 'Tap': case 'Untap': case 'TapAll': case 'UntapAll': {
      let cards: string[];
      if (step.api.endsWith('All')) {
        const ms = state.battlefield.map((x) => [x, matchCard(state.cards[x], p.ValidCards ?? 'Permanent', E)] as const);
        if (ms.some(([, m]) => m === 'unknown')) return bad();
        cards = ms.filter(([, m]) => m).map(([x]) => x);
      } else {
        const o = objects(state, r, i, 'Self');
        if (!o) return bad();
        cards = o.cards;
      }
      const tap = step.api.startsWith('Tap');
      const hit: string[] = [];
      for (const iid of cards) { const c = onBattlefield(state, iid); if (c) { c.tapped = tap; hit.push(cardName(c, ctx.lookup)); } }
      log(state, ctx, r.controller, `${r.sourceName}: ${tap ? 'taps' : 'untaps'} ${hit.join(', ') || 'nothing'}.`);
      return 'ok';
    }
    case 'Discard': {
      const o = objects(state, r, i, 'You');
      const n = p.Mode === 'Hand' ? 0 : amount(state, ctx, r, p.NumCards, 1);
      if (!o || n == null) return bad();
      const picks: Omit<PickData, 'queue' | 'cont'>[] = [];
      for (const pid of o.players) {
        const pl = player(state, pid);
        if (p.Mode === 'Hand' || p.Mode === 'Random') {
          let ids = [...pl.zones.hand];
          if (p.Mode === 'Random') {
            const chosen: string[] = [];
            while (chosen.length < n && ids.length) { const k = Math.floor(ctx.rng() * ids.length); chosen.push(ids[k]); ids.splice(k, 1); }
            ids = chosen;
          }
          const nm = names(state, ctx, ids);
          for (const iid of ids) moveCard(state, ctx, iid, 'graveyard');
          remember(ids);
          log(state, ctx, pid, `${pl.name} discards ${ids.length ? nm : 'nothing'}${p.Mode === 'Random' ? ' at random' : ''}.`);
          continue;
        }
        const valid = p.DiscardValid ?? 'Card';
        const cands = pl.zones.hand.filter((x) => matchCard(state.cards[x], valid, E) !== false);
        if (p.Mode === 'RevealYouChoose') {
          if (pid !== r.controller) me.viewingHandOf = pid;
          log(state, ctx, r.controller, `${pl.name} reveals their hand: ${names(state, ctx, pl.zones.hand)}. ${me.name} chooses a card to discard.`);
          if (!cands.length) { log(state, ctx, r.controller, 'No valid card to choose.'); continue; }
          picks.push({ kind: 'pick', action: 'discard', chooser: r.controller, candidates: cands, left: Math.min(n, cands.length), optional: false, label: `${r.sourceName}: choose a card for ${pl.name} to discard` });
        } else {
          if (!cands.length) { log(state, ctx, pid, `${pl.name} has nothing to discard.`); continue; }
          log(state, ctx, pid, `${pl.name} chooses ${n} card${n === 1 ? '' : 's'} to discard.`);
          picks.push({ kind: 'pick', action: 'discard', chooser: pid, candidates: cands, left: Math.min(n, cands.length), optional: false, label: `${r.sourceName}: choose a card to discard` });
        }
      }
      return startPicks(state, ctx, picks, contAt(r, i + 1)) ? 'wait' : 'ok';
    }
    case 'Mill': {
      const n = amount(state, ctx, r, p.NumCards, 1);
      const o = objects(state, r, i, 'You');
      if (n == null || !o) return bad();
      const all: string[] = [];
      for (const pid of o.players) {
        const pl = player(state, pid);
        const ids = pl.zones.library.slice(0, n);
        for (const iid of ids) moveCard(state, ctx, iid, 'graveyard');
        all.push(...ids);
        log(state, ctx, pid, `${pl.name} mills ${names(state, ctx, ids)}.`);
      }
      remember(all);
      return 'ok';
    }
    case 'Scry': case 'Surveil': case 'Dig': case 'RearrangeTopOfLibrary': {
      const raw = step.api === 'Scry' ? p.ScryNum : step.api === 'Surveil' ? p.Amount : step.api === 'Dig' ? p.DigNum : p.NumCards;
      const n = amount(state, ctx, r, raw, 1);
      const o = objects(state, r, i, 'You');
      if (n == null || !o || o.players.length !== 1 || o.players[0] !== r.controller) return bad();
      const mode = step.api === 'Scry' ? 'scry' : step.api === 'Surveil' ? 'surveil' : 'look';
      openPeek(state, ctx, r, i, me, mode, n);
      const verb = mode === 'scry' ? `scries ${n}` : mode === 'surveil' ? `surveils ${n}` : `looks at the top ${n}`;
      log(state, ctx, r.controller, `${me.name} ${verb} (${r.sourceName}${mode === 'look' ? `: ${step.description}` : ''}).`);
      return 'wait';
    }
    case 'GainControl': {
      const o = objects(state, r, i, 'Self');
      const to = p.NewController ? defined(state, r, i, p.NewController)?.players[0] : r.controller;
      if (!o || !to) return bad();
      const kws = p.AddKWs ? p.AddKWs.split('&').map((k) => k.trim()) : [];
      for (const iid of o.cards) {
        const c = onBattlefield(state, iid);
        if (!c) continue;
        c.controller = to;
        c.summoningSick = true;
        c.attacking = undefined;
        c.blocking = undefined;
        if (p.Untap === 'True') c.tapped = false;
        if (kws.length) c.tempKeywords = [...new Set([...(c.tempKeywords ?? []), ...kws])];
        log(state, ctx, to, `${pname(state, to)} gains control of ${cardName(c, ctx.lookup)}${p.LoseControl ? ' (give it back at end of turn by hand)' : ''}.`);
      }
      return 'ok';
    }
    case 'Sacrifice': {
      const sacValid = p.SacValid ?? 'Card';
      if (p.Defined === 'Self' || sacValid === 'Self' || sacValid === 'Card.Self') {
        const c = r.sourceIid ? onBattlefield(state, r.sourceIid) : undefined;
        if (c) { const nm = cardName(c, ctx.lookup); moveCard(state, ctx, c.iid, 'graveyard'); log(state, ctx, r.controller, `${pname(state, c.controller)} sacrifices ${nm}.`); remember([c.iid]); }
        return 'ok';
      }
      const own = ownTargets(r, i);
      const ps = own ? split(state, own).players : defined(state, r, i, p.Defined ?? 'You')?.players;
      const n = amount(state, ctx, r, p.Amount, 1);
      if (!ps || n == null) return bad();
      const picks: Omit<PickData, 'queue' | 'cont'>[] = [];
      for (const pid of ps) {
        const cands = state.battlefield.filter((x) => state.cards[x].controller === pid && matchCard(state.cards[x], sacValid, { ...E, controller: pid }) !== false);
        if (!cands.length) { log(state, ctx, pid, `${pname(state, pid)} has nothing to sacrifice.`); continue; }
        picks.push({ kind: 'pick', action: 'sacrifice', chooser: pid, candidates: cands, left: Math.min(n, cands.length), optional: false, label: `${r.sourceName}: choose a permanent to sacrifice` });
      }
      return startPicks(state, ctx, picks, contAt(r, i + 1)) ? 'wait' : 'ok';
    }
    case 'Attach': {
      const objIid = p.Object ? defined(state, r, i, p.Object)?.cards[0] : r.sourceIid;
      const own = ownTargets(r, i);
      const to = own ? split(state, own).cards[0] : p.Defined ? defined(state, r, i, p.Defined)?.cards[0] : undefined;
      const obj = objIid ? onBattlefield(state, objIid) : undefined;
      const host = to ? onBattlefield(state, to) : undefined;
      if (!obj || !host || obj === host) { if (!own) return bad(); return 'ok'; }
      obj.attachedTo = host.iid;
      log(state, ctx, r.controller, `${cardName(obj, ctx.lookup)} is attached to ${cardName(host, ctx.lookup)}.`);
      return 'ok';
    }
    case 'Mana': {
      const n = amount(state, ctx, r, p.Amount, 1);
      if (n == null) return bad();
      if (n <= 0) return 'ok';
      const syms = (p.Produced ?? '').split(' ');
      for (let k = 0; k < n; k++) for (const s of syms) me.manaPool[s] = (me.manaPool[s] ?? 0) + 1;
      log(state, ctx, r.controller, `${me.name} adds ${Array(n).fill(syms.map((s) => `{${s}}`).join('')).join('')}.`);
      return 'ok';
    }
    case 'Charm': {
      log(state, ctx, r.controller, `Not automated: ${r.sourceName} — no modes were chosen; resolve the chosen modes by hand.`);
      return 'ok';
    }
    case 'Shuffle': {
      const o = objects(state, r, i, 'You');
      if (!o) return bad();
      for (const pid of o.players) { shuffleLibrary(state, player(state, pid), ctx.rng); log(state, ctx, pid, `${pname(state, pid)} shuffles their library.`); }
      return 'ok';
    }
    case 'BecomeMonarch': case 'TakeInitiative': {
      const name = step.api === 'BecomeMonarch' ? 'Monarch' : 'Initiative';
      for (const pl of state.players) pl.designations = pl.designations.filter((d) => d !== name);
      me.designations.push(name);
      log(state, ctx, r.controller, `${me.name} ${step.api === 'BecomeMonarch' ? 'becomes the monarch' : 'takes the initiative'}.`);
      return 'ok';
    }
    case 'RevealHand': {
      const o = objects(state, r, i, 'You');
      if (!o) return bad();
      for (const pid of o.players) {
        if (pid !== r.controller) me.viewingHandOf = pid;
        log(state, ctx, r.controller, `${pname(state, pid)} reveals their hand: ${names(state, ctx, player(state, pid).zones.hand)}.`);
      }
      return 'ok';
    }
  }
  return bad();
}

function counterItem(state: GameState, ctx: Ctx, item: StackItem, p: Record<string, string>, by: string, r?: Run) {
  if (item.iid && state.cards[item.iid]) {
    const nm = cardName(state.cards[item.iid], ctx.lookup);
    if (r) r.lki[item.id] = lkiOf(state.cards[item.iid], ctx);
    const dest = zoneOf(p.Destination) ?? 'graveyard';
    if (dest === 'library') moveCard(state, ctx, item.iid, 'library', { position: p.LibraryPosition === '-1' ? 'bottom' : 'top' });
    else moveCard(state, ctx, item.iid, dest === 'battlefield' || dest === 'stack' ? 'graveyard' : dest);
    state.stack = state.stack.filter((s) => s !== item);
    log(state, ctx, item.controller, `${nm} is countered by ${by}${dest !== 'graveyard' ? ` (→ ${dest})` : ''}.`);
  } else {
    state.stack = state.stack.filter((s) => s !== item);
    log(state, ctx, item.controller, `${item.text} is countered by ${by}.`);
  }
}

// ------------------------------------------------------------------ driving

function runFrom(state: GameState, ctx: Ctx, cont: AutoCont): void {
  const r = makeRun(state, ctx, cont);
  if (!r) return;
  for (let i = cont.next; i < r.steps.length; i++) {
    if (execStep(state, ctx, r, i) === 'wait') break;
  }
  stateBasedActions(state, ctx, r.deathtouched);
}

/** Continue an automated resolution that was waiting on a peek (scry / search ...). */
export function resumeAuto(state: GameState, ctx: Ctx, cont: AutoCont) {
  runFrom(state, ctx, cont);
}

function stillLegal(state: GameState, ctx: Ctx, item: StackItem, spec: TargetSpec | undefined, ref: TargetRef): boolean {
  if (ref.kind === 'player') { const p = state.players.find((x) => x.pid === ref.pid); return !!p && !p.conceded; }
  if (ref.kind === 'stack') return state.stack.some((s) => s.id === ref.id);
  const c = state.cards[ref.iid];
  if (!c) return false;
  const zone = item.auto?.targetZones?.[ref.iid];
  if (zone && c.zone !== zone) return false;
  if (!spec) return true;
  return isValidTarget(state, spec, ref, item.controller, item.iid ?? item.sourceIid, ctx.lookup);
}

/**
 * Resolve an automated stack item. `finish` puts a spell card where it goes after resolving
 * (battlefield / graveyard / exile) without logging.
 */
export function resolveAuto(state: GameState, ctx: Ctx, item: StackItem, isPermanentSpell: boolean, finish: () => void) {
  const auto = item.auto!;
  state.stack = state.stack.filter((s) => s !== item);
  const ab = abilityFor(auto);
  const src = item.iid ? state.cards[item.iid] : item.sourceIid ? state.cards[item.sourceIid] : undefined;
  const name = item.kind === 'spell' && src ? cardName(src, ctx.lookup) : item.text;
  if (!ab) {
    log(state, ctx, item.controller, `${name} resolves (not automated — resolve it by hand).`);
    if (item.iid && state.cards[item.iid]?.zone === 'stack') finish();
    return;
  }
  const specs = targetSpecs(ab, auto.modes);
  const legal = auto.targets.map((list, k) => list.filter((ref) => stillLegal(state, ctx, item, specs[k], ref)));
  const total = auto.targets.reduce((n, l) => n + l.length, 0);
  const left = legal.reduce((n, l) => n + l.length, 0);
  if (total > 0 && left === 0) {
    if (item.iid && state.cards[item.iid]?.zone === 'stack') moveCard(state, ctx, item.iid, 'graveyard');
    log(state, ctx, item.controller, `${name} fizzles — its target${total === 1 ? ' is' : 's are'} no longer legal.`);
    return;
  }
  if (left < total) log(state, ctx, item.controller, `${name}: ${total - left} target${total - left === 1 ? ' is' : 's are'} no longer legal.`);
  const lki: Record<string, Lki> = {};
  for (const ref of legal.flat()) {
    if (ref.kind === 'card' && state.cards[ref.iid]) lki[ref.iid] = lkiOf(state.cards[ref.iid], ctx);
    if (ref.kind === 'stack') {
      const it = state.stack.find((s) => s.id === ref.id);
      if (it?.iid && state.cards[it.iid]) lki[ref.id] = lkiOf(state.cards[it.iid], ctx);
      else if (it) lki[ref.id] = { power: 0, toughness: 0, mv: 0, controller: it.controller, owner: it.controller, name: it.text };
    }
  }
  log(state, ctx, item.controller, item.kind === 'spell' ? `${name} resolves.` : `Resolved: ${item.text}`);
  const isSpellCard = item.kind === 'spell' && !!item.iid;
  if (isSpellCard && isPermanentSpell) finish();
  const cont: AutoCont = { item, next: 0, targets: legal, lki, remembered: [] };
  const r = makeRun(state, ctx, cont)!;
  for (let i = 0; i < r.steps.length; i++) {
    if (execStep(state, ctx, r, i) === 'wait') break;
  }
  if (isSpellCard && !isPermanentSpell && state.cards[item.iid!]?.zone === 'stack') finish();
  stateBasedActions(state, ctx, r.deathtouched);
}

/** Answer a Pending question. Returns an error string or null. */
export function answerPending(state: GameState, ctx: Ctx, pid: string, id: string, value: string): string | null {
  const pend = state.pending.find((p) => p.id === id);
  if (!pend) return 'That question is no longer open';
  if (pend.pid !== pid) return 'That question is for another player';
  if (!pend.options.some((o) => o.value === value)) return 'Not one of the options';
  state.pending = state.pending.filter((p) => p !== pend);
  const data = pend.data as unknown as PickData | UnlessData;
  const who = player(state, pid);
  if (data.kind === 'unless') {
    const item = state.stack.find((s) => s.id === data.stackId);
    if (item) {
      if (value === 'pay') {
        const res = payFromPool(data.cost, who.manaPool);
        if (res) { who.manaPool = res.pool; if (res.lifePaid) who.life -= res.lifePaid; log(state, ctx, pid, `${who.name} pays ${data.cost}.`); }
        else log(state, ctx, pid, `${who.name} pays ${data.cost} (mana not deducted — pool did not cover it).`);
      } else {
        log(state, ctx, pid, `${who.name} doesn't pay ${data.cost}.`);
        counterItem(state, ctx, item, data.params, 'it');
      }
    }
    if (data.cont) runFrom(state, ctx, data.cont);
    return null;
  }
  // pick
  let left = data.left;
  let candidates = data.candidates;
  if (value !== 'none') {
    const c = state.cards[value];
    if (c) {
      const nm = cardName(c, ctx.lookup);
      if (data.action === 'discard') {
        moveCard(state, ctx, value, 'graveyard');
        log(state, ctx, pid, `${pname(state, c.owner)} discards ${nm}.`);
      } else if (data.action === 'sacrifice') {
        moveCard(state, ctx, value, 'graveyard');
        log(state, ctx, pid, `${who.name} sacrifices ${nm}.`);
      } else {
        const p = data.params ?? {};
        const from = c.zone;
        if (data.dest === 'library') moveCard(state, ctx, value, 'library', { position: p.LibraryPosition === '-1' ? 'bottom' : 'top' });
        else if (data.dest === 'battlefield') moveCard(state, ctx, value, 'battlefield', { tapped: p.Tapped === 'True', controller: pid });
        else moveCard(state, ctx, value, data.dest ?? 'hand');
        const hidden = (z: Zone) => z === 'hand' || z === 'library';
        log(state, ctx, pid, `${who.name} puts ${hidden(from) && hidden(data.dest ?? 'hand') ? 'a card' : nm} ${data.dest === 'library' ? (p.LibraryPosition === '-1' ? 'on the bottom of their library' : 'on top of their library') : `into ${data.dest === 'battlefield' ? 'play' : `their ${data.dest}`}`}.`);
      }
    }
    left--;
    candidates = candidates.filter((x) => x !== value);
  } else left = 0;
  if (left > 0 && pickPending(state, ctx, { ...data, left, candidates })) return null;
  if (startPicks(state, ctx, data.queue, data.cont)) return null;
  if (data.cont) runFrom(state, ctx, data.cont);
  else stateBasedActions(state, ctx, []);
  return null;
}

/** Creatures with lethal damage / 0 toughness and planeswalkers with 0 loyalty go to the graveyard. */
export function stateBasedActions(state: GameState, ctx: Ctx, deathtouched: string[] = []) {
  for (let guard = 0; guard < 20; guard++) {
    const dead: [string, string][] = [];
    for (const iid of state.battlefield) {
      const c = state.cards[iid];
      const f = faceOf(c, ctx.lookup);
      if (isCreature(c, ctx.lookup)) {
        const [, t] = effectivePT(c, ctx.lookup);
        // Only when a printed positive toughness was reduced (0/0 bodies usually get their size from statics we don't model).
        const base = c.faceDown ? 2 : /^-?\d+$/.test(f.toughness ?? '') ? parseInt(f.toughness!, 10) : 0;
        if (base > 0 && t <= 0) { dead.push([iid, 'has 0 toughness']); continue; }
        if (hasKeyword(c, ctx.lookup, 'Indestructible')) continue;
        if ((t > 0 && c.damage >= t) || (c.damage > 0 && deathtouched.includes(iid))) dead.push([iid, 'dies (lethal damage)']);
      } else if (f.types.includes('Planeswalker') && !c.faceDown && (c.counters.loyalty ?? 0) <= 0) {
        dead.push([iid, 'is put into the graveyard (0 loyalty)']);
      }
    }
    if (!dead.length) return;
    for (const [iid, why] of dead) {
      const nm = cardName(state.cards[iid], ctx.lookup);
      moveCard(state, ctx, iid, 'graveyard');
      log(state, ctx, null, `${nm} ${why}.`);
    }
  }
}
