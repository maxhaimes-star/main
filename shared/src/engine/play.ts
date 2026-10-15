/** Casting / activating with the engine: target validation and cost payment. */
import { cardName, payFromPool } from '../game/rules.ts';
import { type Ctx, log, moveCard, player, randomId } from '../game/state.ts';
import type { CardInstance, GameAction, GameState, StackItem } from '../game/types.ts';
import { abilityAt, abilityLine, getScript, GRANT_BASE, scriptRef, spellAbility, targetSpecs } from './script.ts';
import { hasGrantedAbility } from './animate.ts';
import { divisionError } from './divide.ts';
import { afterActivation, checkActivation } from './keyword-play.ts';
import { isValidTarget } from './targets.ts';
import { activateRestriction, adjustCost } from './statics.ts';
import { activationError, recordActivation } from './timing.ts';
import type { AutoInfo, ParsedAbility, TargetRef, TargetSpec } from './types.ts';
import { isUniqueCost, payUniqueCosts, uniqueActivationError, uniqueCostError } from './turns.ts';
import { abilityPayment, executeAutoPay } from './strict.ts';

type CastAction = Extract<GameAction, { t: 'cast' }>;
type ActivateAction = Extract<GameAction, { t: 'activate' }>;

/** Card refs to spells on the stack become stack refs. */
function normalize(state: GameState, spec: TargetSpec, ref: TargetRef): TargetRef {
  if (ref.kind === 'card' && spec.zone === 'stack') {
    const item = state.stack.find((s) => s.iid === ref.iid);
    if (item) return { kind: 'stack', id: item.id };
  }
  return ref;
}

function refKey(ref: TargetRef): string {
  return ref.kind === 'card' ? `c:${ref.iid}` : ref.kind === 'player' ? `p:${ref.pid}` : `s:${ref.id}`;
}

/** Validate targets for an ability chain. Returns normalized targets or an error. */
export function checkTargets(state: GameState, ab: ParsedAbility, modes: string[] | undefined, given: TargetRef[][], controller: string, sourceIid: string, ctx: Ctx, what: string):
  { targets: TargetRef[][]; targetZones: Record<string, string> } | { error: string } {
  const specs = targetSpecs(ab, modes);
  if (given.length > specs.length && given.slice(specs.length).some((l) => l.length)) return { error: `${what} doesn't have that many targets` };
  const targets: TargetRef[][] = [];
  const targetZones: Record<string, string> = {};
  for (let k = 0; k < specs.length; k++) {
    const spec = specs[k];
    const list = (given[k] ?? []).map((ref) => normalize(state, spec, ref));
    if (list.length < spec.min) return { error: `${what}: choose ${spec.min === spec.max ? spec.min : `at least ${spec.min}`} target${spec.min === 1 ? '' : 's'} (${spec.prompt})` };
    if (list.length > spec.max) return { error: `${what}: too many targets (max ${spec.max})` };
    if (new Set(list.map(refKey)).size !== list.length) return { error: `${what}: the same target was chosen twice` };
    for (const ref of list) {
      if (!isValidTarget(state, spec, ref, controller, sourceIid, ctx.lookup)) return { error: `${what}: illegal target` };
      if (ref.kind === 'card') targetZones[ref.iid] = state.cards[ref.iid].zone;
    }
    targets.push(list);
  }
  return { targets, targetZones };
}

function charmModes(ab: ParsedAbility, modes: string[] | undefined): string | null {
  if (!modes) return null;
  for (let a: ParsedAbility | undefined = ab; a; a = a.sub) {
    if (a.api !== 'Charm' || !a.choices) continue;
    const names = a.choices.map((c) => c.name);
    if (modes.some((m) => !names.includes(m))) return 'Unknown mode';
    if (new Set(modes).size !== modes.length) return 'A mode was chosen twice';
    if (modes.length < (a.charmMin ?? 1) || modes.length > (a.charmMax ?? 1)) return `Choose ${a.charmMin === a.charmMax ? a.charmMax : `${a.charmMin}–${a.charmMax}`} mode(s)`;
  }
  return null;
}

/**
 * Engine info for a cast, validated before anything moves. Returns {} when the spell isn't automated
 * (permanent without a spell ability, manual cast, or no targets supplied for a targeted spell).
 */
export function prepareCast(state: GameState, inst: CardInstance, pid: string, a: CastAction, ctx: Ctx): { auto?: AutoInfo; error?: string } {
  if (a.manual || a.faceDown || !inst.cardId) return {};
  const face = a.face ?? 0;
  const sp = spellAbility(inst.cardId, face);
  if (!sp) return {};
  const specs = targetSpecs(sp.ability, a.modes);
  if (specs.length && a.targets === undefined) return {};
  const modeErr = charmModes(sp.ability, a.modes);
  if (modeErr) return { error: modeErr };
  const name = getScript(inst.cardId)?.[face]?.name ?? 'That spell';
  const res = checkTargets(state, sp.ability, a.modes, a.targets ?? [], pid, inst.iid, ctx, name);
  if ('error' in res) return { error: res.error };
  const auto: AutoInfo = { cardId: inst.cardId, face, source: 'spell', index: sp.index, targets: res.targets, targetZones: res.targetZones };
  if (a.x != null) auto.x = a.x;
  if (a.modes) auto.modes = [...a.modes];
  return { auto };
}

function counterKind(forge: string): string {
  const t = forge.trim().toUpperCase();
  if (t === 'P1P1') return '+1/+1';
  if (t === 'M1M1') return '-1/-1';
  if (t === 'LOYALTY') return 'loyalty';
  return t.toLowerCase();
}

/**
 * Activate the A: line `a.ability` of a card with the engine: pay costs, put the ability on the stack.
 * Returns an error (nothing changed) or null. The caller hands priority over.
 */
export function activateAuto(state: GameState, ctx: Ctx, pid: string, c: CardInstance, a: ActivateAction): string | null {
  const ref = c.zone === 'battlefield' ? scriptRef(c) : c.cardId ? { cardId: c.cardId, face: c.transformed ? 1 : 0 } : undefined; // a copy: the copied card's
  if (!ref) return 'That card has no abilities';
  const { cardId, face } = ref;
  const line = abilityLine(cardId, face, a.ability!);
  if (!line || !/^\s*AB\$/.test(line)) return 'No such ability';
  if (a.ability! >= GRANT_BASE && !hasGrantedAbility(c, a.ability!)) return 'No such ability';
  const ab = abilityAt(cardId, face, a.ability!);
  if (!ab) return 'No such ability';
  const src = cardName(c, ctx.lookup);
  if (!a.force) {
    const banned = activateRestriction(state, c.iid, pid, ctx.lookup);
    if (banned) return banned;
    const timing = activationError(state, c, pid, ab, a.ability!, src) ?? uniqueActivationError(state, ctx, c, pid, ab, src);
    if (timing) return timing;
  }
  const res = checkTargets(state, ab, undefined, a.targets ?? [], pid, c.iid, ctx, src);
  if ('error' in res) return res.error;
  const divErr = divisionError(ab, undefined, res.targets, a.division, a.x ?? 0);
  if (divErr) return `${src}: ${divErr}`;
  const kwErr = checkActivation(state, ctx, pid, c, ab, a.ability!, res.targets);
  if (kwErr) return kwErr;
  const x = a.x ?? 0;
  const num = (v: string) => (v === 'X' ? x : parseInt(v, 10) || 0);

  // ---- plan costs (validate first, then pay)
  const cost = ab.params.Cost ?? '';
  const tokens = cost.match(/\S+<[^>]*>|\S+/g) ?? [];
  let mana = '';
  let tap = false, untap = false, life = 0, sacSelf = false, exileSelf = false, discardSelf = false;
  const counterDelta: Record<string, number> = {};
  const byHand: string[] = [];
  const extraCosts: string[] = []; // choices paid by turns.ts (tapXType, Sac<1/Creature>, Return<1/CARDNAME> ...)
  for (const tok of tokens) {
    let m: RegExpExecArray | null;
    if (/^(\d+|[WUBRGCSX]|[WUBRG2]\/[WUBRGP])$/.test(tok)) mana += `{${tok === 'X' ? x : tok}}`;
    else if (/^[WUBRG]{2}$/.test(tok)) mana += `{${tok[0]}/${tok[1]}}`; // hybrid ("GW")
    else if (tok === 'T') tap = true;
    else if (tok === 'Q') untap = true;
    else if ((m = /^PayLife<(\d+|X)>$/.exec(tok))) life += num(m[1]);
    else if (/^Sac<1\/(CARDNAME|Self|NICKNAME)>$/.test(tok)) sacSelf = true;
    else if (/^Exile(FromGrave)?<1\/(CARDNAME|Self|NICKNAME)>$/.test(tok)) exileSelf = true;
    else if (/^Discard<1\/(CARDNAME|Self|NICKNAME)>$/.test(tok)) discardSelf = true;
    else if ((m = /^(Add|Sub)Counter<(\d+|X)\/([A-Za-z0-9]+)(\/[^>]*)?>$/.exec(tok)) && !m[4]) {
      const k = counterKind(m[3]);
      counterDelta[k] = (counterDelta[k] ?? 0) + (m[1] === 'Add' ? 1 : -1) * num(m[2]);
    } else if (isUniqueCost(tok)) extraCosts.push(tok);
    else byHand.push(tok);
  }
  if (tap && c.tapped) return `${src} is already tapped`;
  if (untap && !c.tapped) return `${src} is not tapped`;
  if (discardSelf && c.zone !== 'hand') return `${src} must be in your hand`;
  for (const [k, d] of Object.entries(counterDelta)) if (d < 0 && (c.counters[k] ?? 0) < -d) return `${src} doesn't have enough ${k} counters`;
  const extraErr = extraCosts.length ? uniqueCostError(state, ctx, pid, c, extraCosts, x) : null;
  if (extraErr) return extraErr;
  // Strict mode (engine/strict.ts): {T} needs no summoning sickness; mana is auto-paid (pool, then untapped sources).
  let strictPlan: import('../game/manapay.ts').PayResult | null = null;
  if (state.strict) {
    const pay = abilityPayment(state, pid, c, cost, x, ctx.lookup);
    if ('error' in pay) { if (!(state.fixMode?.on && a.force)) return pay.error; }
    else strictPlan = pay.plan;
  }

  // ---- pay
  const me = player(state, pid);
  const notes: string[] = [];
  if (tap) c.tapped = true;
  if (untap) c.tapped = false;
  if (mana) {
    if (strictPlan) executeAutoPay(state, ctx, pid, strictPlan);
    const adj = adjustCost(state, c, pid, mana, 'Ability', ctx.lookup);
    if (adj.notes.length) { mana = adj.cost; notes.push(`cost ${mana || '{0}'}: ${adj.notes.join(', ')}`); }
    const paid = payFromPool(mana, me.manaPool, x);
    if (paid) { me.manaPool = paid.pool; if (paid.lifePaid) { me.life -= paid.lifePaid; notes.push(`paid ${paid.lifePaid} life`); } }
    else notes.push('mana not deducted');
  }
  if (life) { me.life -= life; notes.push(`paid ${life} life`); }
  for (const [k, d] of Object.entries(counterDelta)) {
    c.counters[k] = (c.counters[k] ?? 0) + d;
    if (!c.counters[k] && k !== 'loyalty') delete c.counters[k];
  }
  const auto: AutoInfo = { cardId, face, source: 'ability', index: a.ability!, targets: res.targets, targetZones: res.targetZones };
  if (a.x != null) auto.x = a.x;
  if (a.division) auto.division = { ...a.division };
  recordActivation(state, c, ab, a.ability!, counterDelta.loyalty != null);
  const item: StackItem = { id: randomId(ctx.rng), kind: 'ability', sourceIid: c.iid, controller: pid, text: `${src}: ${ab.description}`, auto };
  if (a.x != null) item.x = a.x;
  state.stack.push(item);
  const loy = counterDelta.loyalty;
  log(state, ctx, pid, `${me.name} activates ${src}${loy != null ? ` [${loy > 0 ? '+' : ''}${loy}]` : ''}: ${ab.description}${notes.length ? ` (${notes.join(', ')})` : ''}`);
  if (byHand.length) log(state, ctx, pid, `Pay by hand: ${byHand.join(' ')}.`);
  if (sacSelf && c.zone === 'battlefield') { moveCard(state, ctx, c.iid, 'graveyard', { cause: 'sacrifice' }); log(state, ctx, pid, `${me.name} sacrifices ${src}.`); }
  if (exileSelf) { moveCard(state, ctx, c.iid, 'exile'); log(state, ctx, pid, `${me.name} exiles ${src}.`); }
  if (discardSelf && c.zone === 'hand') { moveCard(state, ctx, c.iid, 'graveyard', { cause: 'discard' }); log(state, ctx, pid, `${me.name} discards ${src}.`); }
  if (extraCosts.length) payUniqueCosts(state, ctx, pid, c, item, extraCosts, x);
  afterActivation(state, ctx, pid, c, ab, item);
  return null;
}
