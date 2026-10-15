/**
 * Casting costs: the normal cost, alternative costs (Force of Will, Daze, Snuff Out, Fireblast, evoke,
 * flashback, escape, dash, overload, madness, spectacle, surge, miracle), additional costs (kicker,
 * buyback, a spell's own Cost$ like Tinker's "sacrifice an artifact"), delve, and divided damage.
 *
 * castOptions() lists the ways to cast a card; the reducer's cast action picks one with `costOption`
 * (+ `kicked`). Mana is paid from the pool; life / discarding the hand are paid at once; choices
 * (exile a blue card, return an Island, sacrifice two Mountains, delve) become Pending questions for the
 * caster while the spell waits on the stack.
 */
import { parseManaSymbols } from '../cards.ts';
import { getCard } from '../cube.ts';
import { cardName, faceOf, type Lookup, payFromPool } from '../game/rules.ts';
import { type Ctx, log, moveCard, player, randomId } from '../game/state.ts';
import type { CardInstance, GameAction, GamePlayer, GameState, StackItem } from '../game/types.ts';
import { prepareCast } from './play.ts';
import { divisionError } from './divide.ts';
import { getScript, parseParams, spellAbility, targetSpecs } from './script.ts';
import { isValidTarget, matchCard } from './targets.ts';
import { adjustCost, castRestriction } from './statics.ts';
import { castTimingError } from './timing.ts';
import { autoTapFor } from './strict.ts';
import type { AutoInfo, CastInfo, CastOption, TargetRef } from './types.ts';

type CastAction = Extract<GameAction, { t: 'cast' }>;

// ------------------------------------------------------------------ Forge cost strings

export interface CostPart {
  kind: 'life' | 'exileHand' | 'exileGrave' | 'return' | 'sac' | 'sacSelf' | 'discard' | 'discardHand' | 'other';
  /** Count: a number or "X". */
  n: string;
  valid: string;
  text: string;
}

const MANA_TOK = /^(\d+|[WUBRGCX]|[WUBRG2]\/[WUBRGP])$/;
const COUNT_WORDS = ['no', 'a', 'two', 'three', 'four', 'five', 'six', 'seven'];

function describeValid(v: string): string {
  const [type, ...rest] = v.split('.');
  const props = rest.join('.').split('+').filter(Boolean);
  const colors = props.filter((p) => /^(White|Blue|Black|Red|Green)$/.test(p)).map((p) => p.toLowerCase());
  const t = type === 'Card' ? 'card' : /^(Creature|Artifact|Land|Enchantment|Permanent|Planeswalker|Instant|Sorcery)$/.test(type) ? type.toLowerCase() : type;
  return [...colors, t].join(' ');
}

function plural(n: string, what: string): string {
  const k = parseInt(n, 10);
  if (n === 'X') return `X ${what}s`;
  if (k === 1) return `${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what}`;
  return `${COUNT_WORDS[k] ?? k} ${/s$/.test(what) ? what : `${what}s`}`;
}

/** "PayLife<1> ExileFromHand<1/Card.Blue+Other>" -> mana "{…}" + non-mana parts. */
export function parseCost(cost: string, selfName = 'it'): { mana: string; parts: CostPart[] } {
  let mana = '';
  const parts: CostPart[] = [];
  for (const tok of cost.trim().match(/\S+<[^>]*>|\S+/g) ?? []) {
    if (MANA_TOK.test(tok)) { mana += `{${tok}}`; continue; }
    if (/^XMin\d+$/.test(tok)) continue; // "X can't be 0": not checked
    if (tok === 'T' || tok === 'Q') continue; // tap / untap symbols: handled by the caller
    const m = /^(\w+)<([^/>]+)(?:\/([^/>]+))?(?:\/([^>]+))?>$/.exec(tok);
    if (!m) { parts.push({ kind: 'other', n: '1', valid: '', text: `${tok} (by hand)` }); continue; }
    const [, kind, n, valid = 'Card', desc] = m;
    const what = desc ?? describeValid(valid);
    switch (kind) {
      case 'PayLife': parts.push({ kind: 'life', n, valid: '', text: `Pay ${n} life` }); break;
      case 'ExileFromHand': parts.push({ kind: 'exileHand', n, valid, text: `Exile ${plural(n, what)} from your hand` }); break;
      case 'ExileFromGrave': parts.push({ kind: 'exileGrave', n, valid, text: `Exile ${plural(n, desc ? `${desc} card` : what)} from your graveyard` }); break;
      case 'Return': parts.push({ kind: 'return', n, valid, text: `Return ${plural(n, what)} you control to its owner's hand` }); break;
      case 'Sac':
        if (/^(CARDNAME|Self|NICKNAME)$/.test(valid)) parts.push({ kind: 'sacSelf', n: '1', valid, text: `Sacrifice ${selfName}` });
        else parts.push({ kind: 'sac', n, valid, text: `Sacrifice ${plural(n, what)}` });
        break;
      case 'Discard':
        if (valid === 'Hand') parts.push({ kind: 'discardHand', n, valid, text: 'Discard your hand' });
        else parts.push({ kind: 'discard', n, valid, text: `Discard ${plural(n, what)}` });
        break;
      default: parts.push({ kind: 'other', n, valid, text: `${tok} (by hand)` });
    }
  }
  return { mana, parts };
}

/** "1 B" (Forge) -> "{1}{B}". Non-mana tokens are ignored. */
export function forgeMana(cost: string): string {
  return parseCost(cost).mana;
}

function count(n: string, x: number): number {
  return n === 'X' ? x : parseInt(n, 10) || 0;
}

/** Cards that could pay a part (excluding the spell itself). */
function candidates(state: GameState, pid: string, spellIid: string, part: Pick<CostPart, 'kind' | 'valid'>, lookup: Lookup): string[] {
  const me = state.players.find((p) => p.pid === pid);
  if (!me) return [];
  const env = { controller: pid, sourceIid: spellIid, lookup };
  const ok = (iid: string) => iid !== spellIid && !!state.cards[iid] && matchCard(state.cards[iid], part.valid, env) !== false;
  switch (part.kind) {
    case 'exileHand': case 'discard': return me.zones.hand.filter(ok);
    case 'exileGrave': return me.zones.graveyard.filter(ok);
    case 'return': case 'sac': return state.battlefield.filter((iid) => state.cards[iid].controller === pid && ok(iid));
  }
  return [];
}

// ------------------------------------------------------------------ cast options

interface OptionDef {
  id: string;
  label: string;
  mana: string;
  parts: CostPart[];
  flags: Partial<CastInfo>;
  /** Condition / zone problem (force overrides). */
  unavailable?: string;
  /** Can't be paid (not enough cards): force doesn't help. */
  unpayable?: string;
  delve: boolean;
  /** Kicker cost (only on the 'kicked' option). */
  kicker?: { mana: string; parts: CostPart[] };
}

function printedCost(c: CardInstance, face: number | undefined, lookup: Lookup): string {
  const data = c.cardId ? lookup(c.cardId) : undefined;
  if (!data) return faceOf(c, lookup).manaCost;
  if (data.faces && face != null && face > 0 && data.faces[face]) return data.faces[face].manaCost;
  if (data.layout === 'split' && data.faces && face != null) return data.faces[face].manaCost;
  return data.manaCost;
}

function genericOf(mana: string, x: number): number {
  return parseManaSymbols(mana).reduce((n, s) => n + (/^\d+$/.test(s) ? parseInt(s, 10) : s === 'X' ? x : 0), 0);
}

/** Remove up to `n` generic mana from a cost (X counts as generic = x). */
function reduceGeneric(mana: string, n: number, x: number): string {
  let left = n;
  const out: string[] = [];
  for (const s of parseManaSymbols(mana)) {
    if (/^\d+$/.test(s) || s === 'X') {
      const v = s === 'X' ? x : parseInt(s, 10);
      const take = Math.min(v, left);
      left -= take;
      if (v - take > 0) out.push(String(v - take));
    } else out.push(s);
  }
  return out.map((s) => `{${s}}`).join('');
}

function manaText(mana: string): string {
  return mana || '{0}';
}

const KEYWORD_OPTIONS: Record<string, { id: string; label: string; zone?: string; flags: Partial<CastInfo>; note?: string; additional?: boolean }> = {
  Evoke: { id: 'evoke', label: 'Evoke', zone: 'hand', flags: { evoked: true }, note: 'Sacrificed when it enters' },
  Flashback: { id: 'flashback', label: 'Flashback', zone: 'graveyard', flags: { exileOnLeave: true }, note: 'Exiled afterwards' },
  Escape: { id: 'escape', label: 'Escape', zone: 'graveyard', flags: { escaped: true } },
  Dash: { id: 'dash', label: 'Dash', zone: 'hand', flags: { dashed: true }, note: 'Gains haste; returns to hand at end of turn' },
  Buyback: { id: 'buyback', label: 'Buyback', flags: { buyback: true }, note: 'Returns to your hand as it resolves', additional: true },
  Overload: { id: 'overload', label: 'Overload', zone: 'hand', flags: { overloaded: true }, note: '"Target" becomes "each"' },
  Madness: { id: 'madness', label: 'Madness', zone: 'exile', flags: {}, note: 'Only right after discarding it (exile it first)' },
  Spectacle: { id: 'spectacle', label: 'Spectacle', zone: 'hand', flags: {}, note: 'Only if an opponent lost life this turn' },
  Surge: { id: 'surge', label: 'Surge', zone: 'hand', flags: {}, note: 'Only if you or a teammate cast another spell this turn' },
  Miracle: { id: 'miracle', label: 'Miracle', zone: 'hand', flags: {}, note: 'Only as the first card you drew this turn is revealed' },
};

function optionDefs(state: GameState, c: CardInstance, pid: string, face: number | undefined, lookup: Lookup, x: number): OptionDef[] {
  const name = cardName(c, lookup);
  const base = printedCost(c, face, lookup);
  const script = c.cardId ? getScript(c.cardId)?.[face ?? 0] : undefined;
  const sp = c.cardId ? spellAbility(c.cardId, face ?? 0) : undefined;
  const additional = sp?.ability.params.Cost ? parseCost(sp.ability.params.Cost, name).parts : [];
  const delve = !!script?.keywords.includes('Delve');
  const defs: OptionDef[] = [{ id: 'normal', label: 'Cast', mana: base, parts: additional, flags: {}, delve }];
  for (const kw of script?.keywords ?? []) {
    const i = kw.indexOf(':');
    const key = i < 0 ? kw : kw.slice(0, i);
    const rest = i < 0 ? '' : kw.slice(i + 1);
    if (key === 'Kicker') {
      const k = parseCost(rest.split(':')[0], name);
      defs.push({ id: 'kicked', label: `Cast with kicker ${[k.mana, ...k.parts.map((p) => p.text)].filter(Boolean).join(', ')}`, mana: base + k.mana, parts: [...additional, ...k.parts], flags: { kicked: true }, delve, kicker: k });
      continue;
    }
    const spec = KEYWORD_OPTIONS[key];
    if (!spec) continue;
    const k = parseCost(rest.split(':')[0], name);
    const def: OptionDef = {
      id: spec.id, label: spec.label,
      mana: spec.additional ? base + k.mana : k.mana,
      parts: [...additional, ...k.parts], flags: { ...spec.flags }, delve,
    };
    if (spec.note) def.parts = [...def.parts, { kind: 'other', n: '0', valid: '', text: spec.note }];
    if (spec.zone && c.zone !== spec.zone) def.unavailable = `${spec.label} only from your ${spec.zone}`;
    defs.push(def);
  }
  // Alternative costs from statics ("rather than pay this spell's mana cost").
  let n = 0;
  for (const line of script?.statics ?? []) {
    const p = parseParams(line).params;
    if (p.Mode !== 'AlternativeCost' || !p.Cost) continue;
    if (!(p.ValidSA === 'Spell.Self' || p.ValidCard === 'Card.Self')) continue;
    const k = parseCost(p.Cost, name);
    const def: OptionDef = { id: `alt${n++}`, label: p.Description ? p.Description.replace(/CARDNAME/g, name) : 'Alternative cost', mana: k.mana, parts: [...additional, ...k.parts], flags: {}, delve };
    const env = { controller: pid, sourceIid: c.iid, lookup };
    if (p.IsPresent && !state.battlefield.some((iid) => matchCard(state.cards[iid], p.IsPresent, env) === true)) def.unavailable = `Needs ${describeValid(p.IsPresent.replace(/\.YouCtrl|\+YouCtrl/, ''))} you control`;
    if (p.Condition === 'PlayerTurn' && state.activePlayer !== pid) def.unavailable = 'Only during your turn';
    if (p.Condition === 'NotPlayerTurn' && state.activePlayer === pid) def.unavailable = "Only when it's not your turn";
    if (p.CheckSVar) def.parts = [...def.parts, { kind: 'other', n: '0', valid: '', text: 'Check the condition by hand' }];
    defs.push(def);
  }
  // Can the non-mana parts be paid?
  for (const d of defs) {
    for (const part of d.parts) {
      const need = count(part.n, x);
      if (part.kind === 'life' || part.kind === 'other' || part.kind === 'discardHand' || part.kind === 'sacSelf') continue;
      const have = candidates(state, pid, c.iid, part, lookup).length;
      if (have < need) { d.unpayable = `${part.text}: not enough (${have}/${need})`; break; }
    }
  }
  return defs;
}

/** Ways to cast a card (normal cost, kicker, alternative costs ...). Unavailable ones say why. */
export function castOptions(state: GameState, iid: string, face?: number, lookup: Lookup = getCard): CastOption[] {
  const c = state.cards[iid];
  if (!c) return [];
  const pid = c.zone === 'battlefield' || c.zone === 'stack' ? c.controller : c.owner;
  return optionDefs(state, c, pid, face, lookup, 0).map((d) => {
    const extra = d.parts.map((p) => p.text);
    if (d.delve) extra.push('Delve: you may exile cards from your graveyard to pay generic mana');
    const o: CastOption = { id: d.id, label: d.label, cost: d.mana, extra };
    const why = d.unpayable ?? d.unavailable;
    if (why) o.unavailable = why;
    return o;
  });
}

// ------------------------------------------------------------------ casting

export interface CastPlan {
  def: OptionDef;
  mana: string;
  parts: CostPart[];
  kicked: boolean;
  x: number;
}

/**
 * Validate a cast (timing, cost option, targets, division) before anything moves.
 * Returns the engine info for the stack item and the cost plan.
 */
export function planCast(state: GameState, c: CardInstance, pid: string, a: CastAction, ctx: Ctx): { error: string } | { plan: CastPlan; auto?: AutoInfo } {
  const name = a.faceDown ? 'A face-down spell' : cardName(c, ctx.lookup);
  if (!a.force) {
    const e = castTimingError(state, c, pid, a.face, ctx.lookup, !!a.faceDown);
    if (e) return { error: `${e} (cast with force to override)` };
    const restricted = castRestriction(state, c.iid, pid, ctx.lookup);
    if (restricted) return { error: `${restricted} (cast with force to override)` };
  }
  const x = a.x ?? 0;
  if (a.faceDown) return { plan: { def: { id: 'faceDown', label: 'Face down', mana: '{3}', parts: [], flags: {}, delve: false }, mana: '{3}', parts: [], kicked: false, x } };
  const defs = optionDefs(state, c, pid, a.face, ctx.lookup, x);
  const want = a.costOption ?? (a.kicked ? 'kicked' : 'normal');
  const def = defs.find((d) => d.id === want);
  if (!def) return { error: `${name} has no "${want}" cost` };
  if (def.unpayable) return { error: `${name}: ${def.unpayable}` };
  if (def.unavailable && !a.force) return { error: `${name}: ${def.unavailable}` };
  let mana = def.mana;
  let parts = def.parts;
  const kicked = def.id === 'kicked' || !!a.kicked;
  if (a.kicked && def.id !== 'kicked') {
    const k = defs.find((d) => d.id === 'kicked')?.kicker;
    if (!k) return { error: `${name} has no kicker` };
    mana += k.mana;
    parts = [...parts, ...k.parts];
  }
  const plan: CastPlan = { def, mana, parts, kicked, x };

  // Engine info (targets). Overload: "target" becomes "each" — every legal object is affected.
  if (def.flags.overloaded && c.cardId) {
    const sp = spellAbility(c.cardId, a.face ?? 0);
    if (sp) {
      const targets = targetSpecs(sp.ability, a.modes).map((spec) =>
        spec.zone === 'battlefield' ? state.battlefield.filter((iid) => isValidTarget(state, spec, { kind: 'card', iid }, pid, c.iid, ctx.lookup)).map((iid) => ({ kind: 'card', iid }) as TargetRef) : []);
      const auto: AutoInfo = { cardId: c.cardId, face: a.face ?? 0, source: 'spell', index: sp.index, targets, targetZones: Object.fromEntries(targets.flat().map((t) => [(t as { iid: string }).iid, 'battlefield'])) };
      if (a.x != null) auto.x = a.x;
      return { plan, auto };
    }
  }
  const prep = prepareCast(state, c, pid, a, ctx);
  if (prep.error) return { error: prep.error };
  if (a.division) {
    const sp = c.cardId ? spellAbility(c.cardId, a.face ?? 0) : undefined;
    if (!sp) return { error: `${name} doesn't divide damage` };
    const e = divisionError(sp.ability, a.modes, prep.auto?.targets ?? a.targets, a.division, x);
    if (e) return { error: `${name}: ${e}` };
  }
  return prep.auto ? { plan, auto: prep.auto } : { plan };
}

const COLORS = ['W', 'U', 'B', 'R', 'G'];

function spentColors(before: Record<string, number>, after: Record<string, number>): string[] {
  return COLORS.filter((k) => (before[k] ?? 0) > (after[k] ?? 0));
}

/** Pay the mana part of a planned cast from the pool. Returns a note for the log (or ''). */
export function payCastMana(state: GameState, me: GamePlayer, c: CardInstance, plan: CastPlan, lookup: Lookup = getCard): { note: string; colors: string[]; deferred: boolean } {
  // Static cost increases / reductions (Thalia, Sphere ...) apply to whichever cost was chosen.
  let note = '';
  if (plan.def.id !== 'faceDown') {
    const adj = adjustCost(state, c, me.pid, plan.mana, 'Spell', lookup);
    if (adj.notes.length) { plan.mana = adj.cost; note = ` (cost ${adj.cost || '{0}'}: ${adj.notes.join(', ')})`; }
  }
  const graveyard = me.zones.graveyard.filter((i) => i !== c.iid).length;
  if (plan.def.delve && graveyard > 0 && genericOf(plan.mana, plan.x) > 0) return { note, colors: [], deferred: true };
  if (!plan.mana) return { note, colors: [], deferred: false };
  const before = { ...me.manaPool };
  const res = payFromPool(plan.mana, me.manaPool, plan.x);
  if (res) {
    me.manaPool = res.pool;
    if (res.lifePaid) { me.life -= res.lifePaid; note += ` (paid ${res.lifePaid} life)`; }
    return { note, colors: spentColors(before, me.manaPool), deferred: false };
  }
  if (plan.def.id === 'faceDown') return { note, colors: [], deferred: false };
  if (Object.values(me.manaPool).some((v) => v > 0)) return { note: `${note} (mana pool did not cover the cost — not deducted)`, colors: [], deferred: false };
  return { note, colors: [], deferred: false };
}

// ------------------------------------------------------------------ paying the rest (Pending picks)

interface CostPick {
  kind: CostPart['kind'];
  valid: string;
  left: number;
  optional: boolean;
  label: string;
  delve?: boolean;
}

export interface CostData {
  kind: 'cost';
  pid: string;
  spellIid: string;
  spellName: string;
  picks: CostPick[];
  delved: number;
  deferred?: { mana: string; x: number };
}

const VERB: Record<string, string> = { exileHand: 'exiles', exileGrave: 'exiles', return: 'returns', sac: 'sacrifices', discard: 'discards' };

function doPick(state: GameState, ctx: Ctx, d: CostData, pk: CostPick, iid: string) {
  const c = state.cards[iid];
  if (!c) return;
  const nm = cardName(c, ctx.lookup);
  const who = player(state, d.pid).name;
  if (pk.kind === 'return') moveCard(state, ctx, iid, 'hand');
  else if (pk.kind === 'exileHand' || pk.kind === 'exileGrave') moveCard(state, ctx, iid, 'exile');
  else moveCard(state, ctx, iid, 'graveyard');
  if (pk.delve) d.delved++;
  log(state, ctx, d.pid, `${who} ${VERB[pk.kind] ?? 'uses'} ${nm} to pay for ${d.spellName}${pk.delve ? ' (delve)' : ''}.`);
}

function finishCosts(state: GameState, ctx: Ctx, d: CostData) {
  if (!d.deferred) return;
  const me = player(state, d.pid);
  const mana = reduceGeneric(d.deferred.mana, d.delved, d.deferred.x);
  if (state.strict && mana) autoTapFor(state, ctx, d.pid, mana); // rules-enforced: auto-pay the rest (engine/strict.ts)
  const before = { ...me.manaPool };
  const res = mana ? payFromPool(mana, me.manaPool, 0) : { pool: me.manaPool, lifePaid: 0 };
  if (res) {
    me.manaPool = res.pool;
    if (res.lifePaid) me.life -= res.lifePaid;
    log(state, ctx, d.pid, `${me.name} pays ${mana || '{0}'} for ${d.spellName}${d.delved ? ` (delved ${d.delved})` : ''}.`);
  } else log(state, ctx, d.pid, `${d.spellName}: the mana pool did not cover ${mana} — not deducted.`);
  const colors = spentColors(before, me.manaPool);
  const item = state.stack.find((s) => s.iid === d.spellIid);
  if (item?.castInfo) item.castInfo.colorsSpent = colors;
  if (item?.auto) item.auto.colorsSpent = colors;
}

function continueCosts(state: GameState, ctx: Ctx, d: CostData): void {
  while (d.picks.length) {
    const pk = d.picks[0];
    const cands = candidates(state, d.pid, d.spellIid, pk, ctx.lookup);
    if (pk.left <= 0 || !cands.length) { d.picks.shift(); continue; }
    if (!pk.optional && cands.length <= pk.left) {
      for (const iid of cands) doPick(state, ctx, d, pk, iid);
      d.picks.shift();
      continue;
    }
    const options = cands.map((iid) => ({ value: iid, label: cardName(state.cards[iid], ctx.lookup) }));
    if (pk.optional) options.push({ value: 'none', label: 'Done' });
    state.pending.push({
      id: randomId(ctx.rng), pid: d.pid, prompt: `${d.spellName}: ${pk.label}${pk.left > 1 ? ` (${pk.left} left)` : ''}`, options,
      data: JSON.parse(JSON.stringify(d)) as Record<string, unknown>,
    });
    return;
  }
  finishCosts(state, ctx, d);
}

/** Start paying cost choices (also used for activated abilities' costs, engine/turns.ts). */
export function startCostPicks(state: GameState, ctx: Ctx, d: CostData): void {
  continueCosts(state, ctx, d);
}

/** Answer to a cost question (called from answerPending). */
export function answerCostPending(state: GameState, ctx: Ctx, _pid: string, d: CostData, value: string): string | null {
  const pk = d.picks[0];
  if (!pk) { finishCosts(state, ctx, d); return null; }
  if (value === 'none') d.picks.shift();
  else {
    doPick(state, ctx, d, pk, value);
    pk.left--;
    if (pk.left <= 0) d.picks.shift();
  }
  continueCosts(state, ctx, d);
  return null;
}

/**
 * After the spell is on the stack: record how it was cast, pay life / other costs, ask for choices.
 */
export function finishCast(state: GameState, ctx: Ctx, pid: string, c: CardInstance, item: StackItem, plan: CastPlan, paid: { colors: string[]; deferred: boolean }, a: CastAction) {
  const me = player(state, pid);
  const info: CastInfo = { option: plan.def.id, ...plan.def.flags };
  if (plan.kicked) info.kicked = true;
  if (paid.colors.length) info.colorsSpent = paid.colors;
  if (plan.def.id !== 'faceDown') { c.castInfo = info; item.castInfo = { ...info }; }
  if (item.auto) {
    item.auto.costOption = plan.def.id;
    if (plan.kicked) item.auto.kicked = true;
    if (paid.colors.length) item.auto.colorsSpent = paid.colors;
    if (a.division) item.auto.division = { ...a.division };
  }
  if (plan.def.id !== 'normal' && plan.def.id !== 'faceDown') log(state, ctx, pid, `${me.name} casts ${item.text} for its ${plan.def.id === 'kicked' ? 'kicker' : /^alt/.test(plan.def.id) ? 'alternative' : plan.def.label.toLowerCase()} cost${plan.mana ? ` (${manaText(plan.mana)})` : ''}.`);
  else if (plan.kicked) log(state, ctx, pid, `${item.text} is kicked.`);

  const picks: CostPick[] = [];
  for (const part of plan.parts) {
    const n = count(part.n, plan.x);
    switch (part.kind) {
      case 'life': if (n) { me.life -= n; log(state, ctx, pid, `${me.name} pays ${n} life (${me.life}).`); } break;
      case 'discardHand': {
        const hand = [...me.zones.hand];
        for (const iid of hand) moveCard(state, ctx, iid, 'graveyard');
        log(state, ctx, pid, `${me.name} discards their hand (${hand.length}).`);
        break;
      }
      case 'exileHand': case 'exileGrave': case 'return': case 'sac': case 'discard':
        picks.push({ kind: part.kind, valid: part.valid, left: n, optional: false, label: `${part.text.charAt(0).toLowerCase()}${part.text.slice(1)}` });
        break;
      case 'sacSelf': break;
      case 'other': if (/\(by hand\)$/.test(part.text)) log(state, ctx, pid, `Pay by hand: ${part.text.replace(/ \(by hand\)$/, '')}.`); break;
    }
  }
  const d: CostData = { kind: 'cost', pid, spellIid: c.iid, spellName: item.text, picks, delved: 0 };
  if (paid.deferred) {
    const generic = genericOf(plan.mana, plan.x);
    d.deferred = { mana: plan.mana, x: plan.x };
    picks.push({ kind: 'exileGrave', valid: 'Card', left: generic, optional: true, delve: true, label: `delve — exile a card from your graveyard to pay {1} (${manaText(plan.mana)})` });
  }
  continueCosts(state, ctx, d);
}

// ------------------------------------------------------------------ after resolution

const DASH_LINE = 'DB$ ChangeZone | Defined$ Self | Origin$ Battlefield | Destination$ Hand | SpellDescription$ Dash: return it to its owner\'s hand.';
const EVOKE_LINE ='DB$ Sacrifice | Defined$ Self | SpellDescription$ Evoke: sacrifice it.';

/** Evoke / dash / buyback, after a spell resolved (`resolved` false = it fizzled). */
export function afterSpellResolved(state: GameState, ctx: Ctx, item: StackItem, resolved: boolean) {
  const info = item.castInfo;
  if (!info || !item.iid) return;
  const c = state.cards[item.iid];
  if (!c) return;
  const name = cardName(c, ctx.lookup);
  if (info.evoked && c.zone === 'battlefield') {
    // Evoke: "When it enters, if its evoke cost was paid, its controller sacrifices it" — a triggered ability.
    // Queued before the ETB triggers detected after this action, so it goes on the stack first and the
    // creature's own ETB trigger resolves before the sacrifice (the common ordering; reorder by hand if needed).
    const auto: AutoInfo = {
      cardId: c.cardId ?? '', face: c.transformed ? 1 : 0, source: 'trigger', index: -1, targets: [],
      line: EVOKE_LINE, trigger: { mode: 'ChangesZone', card: c.iid, player: c.controller },
    };
    (state.triggerQueue ??= []).push({
      id: randomId(ctx.rng), controller: c.controller, sourceIid: c.iid, sourceName: name,
      text: `${name}: Evoke — sacrifice ${name}.`, auto, targetsChosen: true,
    });
  }
  if (info.dashed && c.zone === 'battlefield') {
    c.tempKeywords = [...new Set([...(c.tempKeywords ?? []), 'Haste'])];
    // "Return it to its owner's hand at the beginning of the next end step" (delayed trigger).
    (state.delayedTriggers ??= []).push({
      id: randomId(ctx.rng), controller: item.controller, sourceIid: c.iid, sourceName: name, text: `${name}: Dash — return ${name} to its owner's hand.`,
      step: 'end', turn: state.turn, createdStep: state.step,
      auto: { cardId: c.cardId ?? '', face: 0, source: 'trigger', index: -1, targets: [], line: DASH_LINE, trigger: { mode: 'Delayed', card: c.iid } },
    });
  }
  if (info.buyback && resolved && c.zone === 'graveyard') {
    moveCard(state, ctx, c.iid, 'hand');
    log(state, ctx, item.controller, `${name} returns to its owner's hand (buyback).`);
  }
}
