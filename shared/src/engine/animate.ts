/**
 * Forge "Animate" / "AnimateAll": "becomes a 3/3 red and green Elemental creature until end of turn" (creature lands,
 * Life // Death, Kytheon, Oko, Figure of Destiny, Koth ...).
 *
 * Each effect is an Animation record on the permanent (CardInstance.animations); faceOf() layers it in (engine/layers.ts),
 * so types / P/T / colors / keywords are derived and stay correct after undo. Granted abilities, triggers and statics
 * come from the creating card's SVars (script.ts grantedLines: activated abilities get GRANT_BASE indexes).
 * Durations: end of turn (default), Permanent, UntilYourNextTurn, UntilHostLeavesPlay, UntilEndOfCombat.
 */
import { cardName } from '../game/rules.ts';
import { type Ctx, log, randomId } from '../game/state.ts';
import type { CardInstance, GameState } from '../game/types.ts';
import type { StepApi } from './ext.ts';
import { activatedAbilitiesOf, type ActivatedEntry, GRANT_BASE, grantedLines, parseAbility, scriptRef } from './script.ts';
import { matchCard } from './targets.ts';
import type { Lookup } from '../game/rules.ts';
import type { StaticsState } from './statics.ts';
import { foreignAbilities } from './grants.ts';
import type { Animation, EffectDuration, ParsedAbility } from './types.ts';

const COLOR_LETTER: Record<string, string> = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G' };

const DURATIONS: Record<string, EffectDuration> = {
  UntilEndOfTurn: 'eot', Permanent: 'permanent', UntilYourNextTurn: 'yourNextTurn', UntilHostLeavesPlay: 'hostLeaves', UntilEndOfCombat: 'endOfCombat',
};

/** Params an Animate step may have (anything else: not automated). */
const KNOWN = new Set([
  'Defined', 'ValidTgts', 'TgtPrompt', 'TargetMin', 'TargetMax', 'TgtZone', 'ValidCards', 'Power', 'Toughness', 'Types', 'RemoveTypes', 'Colors', 'OverwriteColors',
  'Keywords', 'RemoveKeywords', 'RemoveAllAbilities', 'RemoveCardTypes', 'RemoveCreatureTypes', 'AddAllCreatureTypes', 'Abilities', 'Triggers',
  'staticAbilities', 'StaticAbilities', 'Duration', 'AtEOT', 'sVars', 'SpellDescription', 'StackDescription', 'Cost', 'SubAbility', 'Planeswalker', 'Ultimate',
  'AILogic', 'ConditionPresent', 'ConditionCompare', 'ConditionDefined', 'ConditionCheckSVar', 'ConditionSVarCompare', 'ConditionDescription', 'Condition',
  'DefinedDesc', 'ActivationLimit', 'SorcerySpeed', 'IsCurse', 'PrecostDesc', 'ActivationPhases', 'AnyPlayer', 'Secondary', 'StackDescriptionAddendum',
  'ActivationZone', 'PlayerTurn', 'Activator', 'CostDesc', 'NonBasicSpell',
]);

const list = (v: string | undefined, sep: string | RegExp = ',') => (v ? v.split(sep).map((x) => x.trim()).filter(Boolean) : []);

export function animateUnsupported(step: ParsedAbility): string | null {
  const p = step.params;
  const extra = Object.keys(p).find((k) => !KNOWN.has(k));
  if (extra) return `${step.api} (${extra})`;
  if (p.Duration && !DURATIONS[p.Duration]) return `${step.api} (Duration$ ${p.Duration})`;
  if (p.AtEOT && !['Sacrifice', 'Exile', 'Hand'].includes(p.AtEOT)) return `${step.api} (AtEOT$ ${p.AtEOT})`;
  if (list(p.Colors).some((c) => !COLOR_LETTER[c] && c !== 'Colorless')) return `${step.api} (Colors$ ${p.Colors})`;
  if (list(p.Types).some((t) => /Chosen|Remembered/.test(t))) return `${step.api} (Types$ ${p.Types})`;
  if (list(p.Keywords, '&').some((k) => k.includes(':') && !/^(Protection|Enchant):/.test(k))) return `${step.api} (Keywords$ ${p.Keywords})`;
  for (const k of ['Power', 'Toughness']) if (p[k] != null && !/^-?\d+$/.test(p[k]) && !step.svars?.[p[k]]) return `${step.api} (${k}$ ${p[k]})`;
  if (step.api === 'AnimateAll' && !p.ValidCards) return 'AnimateAll (ValidCards)';
  if (p.Defined && /\./.test(p.Defined) && !/^Targeted\.[!A-Za-z+]+$/.test(p.Defined)) return `Animate (Defined$ ${p.Defined})`;
  for (const name of [...list(p.Abilities), ...list(p.Triggers), ...list(p.staticAbilities ?? p.StaticAbilities)]) if (!step.svars?.[name]) return `${step.api} (missing SVar ${name})`;
  return null;
}

/** Run an Animate / AnimateAll step. */
export function execAnimate(state: GameState, ctx: Ctx, step: ParsedAbility, api: StepApi) {
  const p = step.params;
  let cards: string[];
  if (step.api === 'AnimateAll') {
    cards = state.battlefield.filter((iid) => matchCard(state.cards[iid], p.ValidCards ?? 'Card', api.env) === true);
  } else {
    const def = p.Defined?.startsWith('Targeted.') ? 'Targeted' : undefined;
    const o = def ? api.defined(def) : api.objects('Self');
    if (!o) { api.manual(); return; }
    cards = o.cards;
    // "Targeted.!Creature" (Tezzeret): only the targets that match.
    if (def) cards = cards.filter((iid) => state.cards[iid] && matchCard(state.cards[iid], `Card.${p.Defined!.slice('Targeted.'.length)}`, api.env) !== false);
  }
  cards = cards.filter((iid) => state.cards[iid]?.zone === 'battlefield');
  const until = DURATIONS[p.Duration ?? 'UntilEndOfTurn'] ?? 'eot';
  const num = (k: string) => (p[k] != null ? api.amount(p[k], 0) : undefined);
  const types = list(p.Types);
  const colors = list(p.Colors).filter((c) => c !== 'Colorless').map((c) => COLOR_LETTER[c]);
  const a: Omit<Animation, 'id'> = { controller: api.controller, until, turn: state.turn };
  if (until === 'hostLeaves') {
    if (!api.sourceIid || state.cards[api.sourceIid]?.zone !== 'battlefield') { log(state, ctx, api.controller, `${api.sourceName} already left the battlefield — the effect ends at once.`); return; }
    a.hostIid = api.sourceIid;
  }
  const pw = num('Power'), tg = num('Toughness');
  if (pw != null) a.power = pw;
  if (tg != null) a.toughness = tg;
  if (types.length) a.addTypes = types;
  if (p.RemoveTypes) a.removeTypes = list(p.RemoveTypes, /[,&]/);
  if (p.RemoveCardTypes === 'True') a.removeCardTypes = true;
  if (p.RemoveCreatureTypes === 'True') a.removeCreatureTypes = true;
  if (p.AddAllCreatureTypes === 'True') a.allCreatureTypes = true;
  if (p.Colors) { a.colors = colors; if (p.OverwriteColors === 'True') a.overwriteColors = true; }
  if (p.Keywords) a.keywords = list(p.Keywords, '&');
  if (p.RemoveKeywords) a.removeKeywords = list(p.RemoveKeywords, '&');
  if (p.RemoveAllAbilities === 'True') a.removeAllAbilities = true;
  const abilities = list(p.Abilities), triggers = list(p.Triggers), statics = list(p.staticAbilities ?? p.StaticAbilities);
  if (abilities.length || triggers.length || statics.length) {
    a.grant = { cardId: api.auto.cardId, face: api.auto.face };
    if (abilities.length) a.grant.abilities = abilities;
    if (triggers.length) a.grant.triggers = triggers;
    if (statics.length) a.grant.statics = statics;
  }
  const names: string[] = [];
  for (const iid of cards) {
    const c = state.cards[iid];
    c.animations = [...(c.animations ?? []), { ...a, id: randomId(ctx.rng) }];
    names.push(cardName(c, ctx.lookup));
  }
  api.remember(cards);
  if (!names.length) { log(state, ctx, api.controller, `${api.sourceName}: nothing to animate.`); return; }
  const bits: string[] = [];
  if (pw != null || tg != null) bits.push(`${pw ?? '*'}/${tg ?? '*'}`);
  if (types.length) bits.push(types.join(' '));
  if (a.keywords?.length) bits.push(`with ${a.keywords.join(', ').toLowerCase()}`);
  if (a.removeKeywords?.length) bits.push(`without ${a.removeKeywords.join(', ').toLowerCase()}`);
  if (a.removeAllAbilities) bits.push('with no abilities');
  const span = until === 'eot' ? ' until end of turn' : until === 'yourNextTurn' ? ' until your next turn' : until === 'hostLeaves' ? ` for as long as ${api.sourceName} remains` : until === 'endOfCombat' ? ' until end of combat' : '';
  log(state, ctx, api.controller, `${names.join(', ')} ${names.length === 1 ? 'becomes' : 'become'} ${bits.join(' ') || 'animated'}${span}.`);
  if (p.AtEOT) {
    const dest = p.AtEOT === 'Sacrifice' ? 'Graveyard' : p.AtEOT === 'Hand' ? 'Hand' : 'Exile';
    const verb = p.AtEOT === 'Sacrifice' ? 'sacrifice' : p.AtEOT === 'Hand' ? 'return to hand' : 'exile';
    api.delayed('end', `DB$ ChangeZone | Defined$ DelayTriggerRemembered | Origin$ Battlefield | Destination$ ${dest} | SpellDescription$ ${verb[0].toUpperCase()}${verb.slice(1)} ${names.join(', ')}.`, cards, `${verb} ${names.join(', ')} at the beginning of the next end step`);
  }
}

// ------------------------------------------------------------------ granted abilities / triggers

/** Activated abilities granted to a permanent by animate effects (Lavaclaw Reaches' pump), with GRANT_BASE indexes. */
export function grantedAbilities(c: Pick<CardInstance, 'cardId' | 'copyOf' | 'copyFace' | 'transformed' | 'zone' | 'animations'>): ActivatedEntry[] {
  const out: ActivatedEntry[] = [];
  const ref = scriptRef(c);
  for (const g of grantedLines(c, 'abilities')) {
    // Only abilities from the permanent's own script can be addressed by an ability index.
    if (!ref || g.cardId !== ref.cardId || g.face !== ref.face) continue;
    const k = Object.keys(g.svars).indexOf(g.name);
    const ability = parseAbility(g.line, g.svars, g.faceName);
    if (k < 0 || !ability || ability.kind !== 'AB' || out.some((e) => e.index === GRANT_BASE + k)) continue;
    out.push({ index: GRANT_BASE + k, ability, cost: ability.params.Cost ?? '' });
  }
  return out;
}

/**
 * All activated abilities of a permanent right now: its script's (a copy: the copied card's) plus granted ones.
 * Pass `state` and `lookup` to include abilities other objects grant it (Splinter Twin, Koth's emblem: FOREIGN_BASE indexes, engine/grants.ts).
 */
export function abilitiesOfInstance(c: CardInstance, state?: StaticsState, lookup?: Lookup): ActivatedEntry[] {
  const ref = scriptRef(c);
  return [...(ref ? activatedAbilitiesOf(ref.cardId, ref.face) : []), ...grantedAbilities(c), ...(state && lookup ? foreignAbilities(state, c.iid, lookup) : [])];
}

/** Is ability index `index` (>= GRANT_BASE) currently granted to `c`? */
export function hasGrantedAbility(c: CardInstance, index: number): boolean {
  return grantedAbilities(c).some((e) => e.index === index);
}

// ------------------------------------------------------------------ durations

function expire(state: GameState, ctx: Ctx, gone: (a: Animation, c: CardInstance) => boolean) {
  for (const iid of state.battlefield) {
    const c = state.cards[iid];
    if (!c?.animations?.length) continue;
    const keep = c.animations.filter((a) => !gone(a, c));
    if (keep.length === c.animations.length) continue;
    c.animations = keep.length ? keep : undefined;
    void ctx;
  }
}

export function animateAtCleanup(state: GameState, ctx: Ctx) {
  expire(state, ctx, (a) => a.until === 'eot' || a.until === 'endOfCombat');
}

export function animateAtTurnStart(state: GameState, ctx: Ctx, pid: string) {
  expire(state, ctx, (a) => a.until === 'yourNextTurn' && a.controller === pid && state.turn > a.turn);
}

/** A permanent left the battlefield: its animations are gone, and effects whose host it was end. */
export function animateLeft(state: GameState, ctx: Ctx, inst: CardInstance) {
  inst.animations = undefined;
  expire(state, ctx, (a) => a.until === 'hostLeaves' && a.hostIid === inst.iid);
}
