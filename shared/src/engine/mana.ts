/**
 * Mana abilities from Forge scripts ("AB$ Mana"): multi-mana (Ancient Tomb, Grim Monolith), counted
 * mana (Gaea's Cradle, Tolarian Academy, Serra's Sanctum, Everflowing Chalice), any-color / combo
 * (Lotus Petal, Lion's Eye Diamond, Mox Diamond, horizon lands, signets), with their costs and side
 * effects (tap, sacrifice, pay life, discard your hand, mana in the cost, "deals 2 damage to you").
 * Lands without a scripted mana ability (basics, duals) tap for their basic land types.
 *
 * Not covered: Chrome Mox (imprint isn't tracked — use the manual tap), loyalty abilities that add
 * mana, City of Traitors' "sacrifice when you play another land" (a trigger).
 */
import { foreignManaLines } from './grants.ts';
import { getCard } from '../cube.ts';
import { cardName, faceOf, hasKeyword, isCreature, type Lookup, payFromPool } from '../game/rules.ts';
import { type Ctx, log, moveCard, player } from '../game/state.ts';
import type { CardInstance, GameAction, GameState, ViewCard } from '../game/types.ts';
import { isHidden } from '../game/types.ts';
import { parseCost } from './costs.ts';
import { type CountState, evalCount } from './counts.ts';
import { parseAbility, scriptFaceOf, scriptRef } from './script.ts';
import { activateRestriction, staticMods, type StaticsState } from './statics.ts';
import type { ManaOption, ParsedAbility } from './types.ts';
import { chapterManaLines } from './turns.ts';
import { manaTapped, noteTapped } from './manatriggers.ts';
import { matchCard } from './targets.ts';

const BASIC: Record<string, string> = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
const ANY = ['W', 'U', 'B', 'R', 'G'];
const NAMES: Record<string, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green', C: 'colorless' };

export interface Planned extends ManaOption {
  /** Effects to apply. */
  tap: boolean;
  mana: string;
  life: number;
  sacSelf: boolean;
  discardHand: boolean;
  selfDamage: number;
  byHand: string[];
  /** tapXType<1/valid> (Urza, Lord High Artificer: "tap an untapped artifact you control"): the permanent tapped. */
  tapOther?: string;
}

function sym(s: string) {
  return s.split('').map((x) => `{${x}}`).join('');
}

function amountOf(raw: string | undefined, ab: ParsedAbility, state: CountState, c: CardInstance, lookup: Lookup): number | undefined {
  if (raw == null) return 1;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  const v = ab.svars?.[raw];
  if (!v) return undefined;
  return evalCount(v, { state, lookup, controller: c.controller, sourceIid: c.iid });
}

function plan(state: CountState, c: CardInstance, lookup: Lookup): Planned[] {
  const out: Planned[] = [];
  const name = cardName(c, lookup);
  const face = scriptFaceOf(c); // a copy: the copied card's mana abilities
  let scripted = false;
  // A: lines, plus mana abilities a Saga's chapters granted (Urza's Saga, turns.ts).
  const lines: [string, string | number, Record<string, string>?, string?][] = [...(face?.abilities ?? []).map((l, i) => [l, i] as [string, number]), ...chapterManaLines(c as CardInstance)];
  // Mana abilities other permanents grant it (Joraga Treespeaker, Goldspan Dragon): engine/grants.ts.
  if ('effects' in state || 'battlefield' in state) for (const g of foreignManaLines(state as unknown as StaticsState, c.iid, lookup)) lines.push([g.line, g.id, g.svars, g.name]);
  if (face || lines.length) lines.forEach(([line, index, svars, faceName]) => {
    if (!/^\s*AB\$\s*Mana\b/.test(line)) return;
    const ab = parseAbility(line, svars ?? face?.svars ?? {}, faceName ?? face?.name ?? name);
    if (!ab || ab.params.Planeswalker === 'True') return;
    scripted = true;
    const n = amountOf(ab.params.Amount, ab, state, c, lookup);
    if (n == null) return;
    const cost = parseCost(ab.params.Cost ?? '', name);
    const tokens = (ab.params.Cost ?? '').split(/\s+/);
    const base: Omit<Planned, 'id' | 'label' | 'produces'> = {
      sideEffects: [], tap: tokens.includes('T'), mana: cost.mana, life: 0, sacSelf: false, discardHand: false, selfDamage: 0, byHand: [],
    };
    if (cost.mana) base.sideEffects.push(`Pay ${cost.mana}`);
    let tapType: string | undefined;
    for (const part of cost.parts) {
      const tm = /^tapXType<1\/([^>]+)> \(by hand\)$/.exec(part.text);
      if (tm) { tapType = tm[1]; continue; }
      if (part.kind === 'life') { base.life += parseInt(part.n, 10) || 0; base.sideEffects.push(part.text); }
      else if (part.kind === 'sacSelf') { base.sacSelf = true; base.sideEffects.push(part.text); }
      else if (part.kind === 'discardHand') { base.discardHand = true; base.sideEffects.push(part.text); }
      else { base.byHand.push(part.text.replace(/ \(by hand\)$/, '')); base.sideEffects.push(part.text); }
    }
    for (let sub = ab.sub; sub; sub = sub.sub) {
      if (sub.api === 'DealDamage' && sub.params.Defined === 'You' && /^\d+$/.test(sub.params.NumDmg ?? '')) {
        base.selfDamage += parseInt(sub.params.NumDmg, 10);
        base.sideEffects.push(`${name} deals ${sub.params.NumDmg} damage to you`);
      } else { base.byHand.push(sub.description); base.sideEffects.push(`${sub.description} (by hand)`); }
    }
    if (ab.params.RestrictValid) base.sideEffects.push(`Spend only on: ${ab.params.RestrictValid}`);
    const produced = (ab.params.Produced ?? '').trim();
    let choices: string[];
    if (produced === 'Any') choices = ANY;
    else if (/^Combo /.test(produced)) choices = produced.slice(6).split(/\s+/).filter((x) => /^[WUBRGC]$/.test(x));
    else if (/^[WUBRGC]( [WUBRGC])*$/.test(produced)) choices = [produced.replace(/ /g, '')];
    else return;
    // "Tap an untapped artifact you control": one option per permanent that can be tapped (id "<index>@<iid>").
    const others: (string | undefined)[] = tapType ? untappedOfType(state, c, tapType, lookup) : [undefined];
    for (const other of others) {
      const oc = other ? state.cards[other] as CardInstance : undefined;
      for (const ch of choices) {
        const produces = ch.repeat(n);
        const id = `${choices.length > 1 ? `${index}:${ch}` : String(index)}${other ? `@${other}` : ''}`;
        const extra = oc ? [`Tap ${cardName(oc, lookup)}`] : [];
        out.push({ ...base, sideEffects: [...extra, ...base.sideEffects], id, label: `${produces ? `Add ${sym(produces)}${ch.length === 1 && choices.length > 1 ? ` (${NAMES[ch]})` : ''}` : 'Add nothing'}${oc ? ` (tap ${cardName(oc, lookup)})` : ''}`, produces, ...(other ? { tapOther: other } : {}) });
      }
    }
  });
  if (!scripted) {
    const f = faceOf(c, lookup);
    if (f.types.includes('Land')) {
      const added = 'battlefield' in state ? staticMods(state as never, c.iid, lookup)?.addTypes ?? [] : [];
      for (const [type, color] of Object.entries(BASIC)) {
        if (!new RegExp(`\\b${type}\\b`).test(f.typeLine) && !added.includes(type) && !added.includes('AllBasicLandType')) continue;
        out.push({ id: `type:${color}`, label: `Add {${color}}`, produces: color, sideEffects: [], tap: true, mana: '', life: 0, sacSelf: false, discardHand: false, selfDamage: 0, byHand: [] });
      }
    }
  }
  return out;
}

/** Untapped permanents matching `valid` that `c`'s controller controls (tapXType costs). */
function untappedOfType(state: CountState, c: CardInstance, valid: string, lookup: Lookup): string[] {
  if (!('battlefield' in state)) return [];
  return state.battlefield.filter((iid) => {
    const o = state.cards[iid];
    if (!o || isHidden(o) || o.controller !== c.controller || o.tapped) return false;
    return matchCard(o, valid.replace(/;/g, ','), { controller: c.controller, sourceIid: c.iid, lookup }) === true;
  });
}

/** Mana options of a permanent (empty = no scripted / basic-type mana ability: fall back to manual tapping). */
export function manaOptionsFor(state: CountState, iid: string, lookup: Lookup = getCard): ManaOption[] {
  const c = state.cards[iid] as CardInstance | ViewCard | undefined;
  if (!c || isHidden(c) || c.zone !== 'battlefield' || !(c.cardId || c.copyOf || scriptRef(c)) || c.faceDown) return [];
  return plan(state, c, lookup).map(({ id, label, produces, sideEffects }) => ({ id, label, produces, sideEffects }));
}

/** Full mana plans of a permanent (costs and side effects), for auto-pay (engine/strict.ts). */
export function manaPlansFor(state: CountState, c: CardInstance, lookup: Lookup): Planned[] {
  if (c.zone !== 'battlefield' || !(c.cardId || c.copyOf || scriptRef(c)) || c.faceDown) return [];
  return plan(state, c, lookup);
}

/** The activateMana action. Returns an error or null. */
export function activateMana(state: GameState, ctx: Ctx, pid: string, a: Extract<GameAction, { t: 'activateMana' }>): string | null {
  const c = state.cards[a.iid];
  if (!c || c.zone !== 'battlefield') return 'Not on the battlefield';
  if (c.controller !== pid) return 'Not your permanent';
  const opt = plan(state, c, ctx.lookup).find((o) => o.id === a.option);
  if (!opt) return 'No such mana ability';
  const banned = activateRestriction(state, c.iid, pid, ctx.lookup, true);
  if (banned) return banned;
  const name = cardName(c, ctx.lookup);
  if (opt.tap && c.tapped) return `${name} is already tapped`;
  const sickNow = opt.tap && c.summoningSick && isCreature(c, ctx.lookup, state) && !hasKeyword(c, ctx.lookup, 'Haste', state);
  if (state.strict && sickNow) return `${name} has summoning sickness`;
  if (state.strict && !state.fixMode?.on && opt.byHand.length) return `${name}: this mana ability can't be activated automatically (${opt.byHand.join('; ')})`;
  const me = player(state, pid);
  if (opt.mana) {
    const paid = payFromPool(opt.mana, me.manaPool);
    if (!paid) return `${name}: add ${opt.mana} to your mana pool first`;
    me.manaPool = paid.pool;
    if (paid.lifePaid) me.life -= paid.lifePaid;
  }
  if (opt.tapOther) {
    const o = state.cards[opt.tapOther];
    if (!o || o.zone !== 'battlefield' || o.tapped) return `${name}: that permanent can't be tapped`;
    o.tapped = true;
    noteTapped(state, o.iid, pid);
  }
  if (opt.tap) c.tapped = true;
  if (opt.life) me.life -= opt.life;
  if (opt.discardHand) for (const iid of [...me.zones.hand]) moveCard(state, ctx, iid, 'graveyard');
  for (const s of opt.produces) me.manaPool[s] = (me.manaPool[s] ?? 0) + 1;
  if (opt.tap) manaTapped(state, ctx, pid, c.iid, opt.produces); // High Tide, Utopia Sprawl, Mana Flare ... (engine/manatriggers.ts)
  if (opt.selfDamage) me.life -= opt.selfDamage;
  const sick = opt.tap && c.summoningSick && faceOf(c, ctx.lookup).types.includes('Creature') && !faceOf(c, ctx.lookup).keywords.includes('Haste') && !c.tempKeywords?.includes('Haste');
  const notes = opt.sideEffects.filter((x) => !/^Pay \{/.test(x));
  log(state, ctx, pid, `${me.name} ${opt.tap ? 'taps' : 'uses'} ${name} for ${opt.produces ? sym(opt.produces) : 'nothing'}${notes.length ? ` (${notes.join('; ')})` : ''}${opt.life || opt.selfDamage ? ` — life ${me.life}` : ''}.`);
  if (sick) log(state, ctx, pid, `Warning: ${name} has summoning sickness.`);
  if (opt.sacSelf) moveCard(state, ctx, c.iid, 'graveyard', { cause: 'sacrifice' });
  if (opt.byHand.length) log(state, ctx, pid, `Do by hand: ${opt.byHand.join('; ')}.`);
  return null;
}
