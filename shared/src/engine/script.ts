/**
 * Forge script access and parsing: A: lines / DB$ SVars -> ParsedAbility chains, target specs,
 * and "can the engine run this" checks.
 */
import data from '../../data/scripts.json' with { type: 'json' };
import { KNOWN_CONDITIONS, supportedCount } from './counts.ts';
import { type Animation, type AutoInfo, type ForgeFace, type ParsedAbility, type ScriptData, SYNTH_BASE, type TargetSpec } from './types.ts';
import { KEYWORD_APIS, synthAbilities, synthLine } from './keywords.ts';
import { uniqueReason, uniqueVarSupported } from './unique-support.ts';
import { EXT_APIS, extDefinedOk, extUnsupported } from './ext.ts';
import { MORE_DEFINED, moreReason, moreVarSupported } from './more-support.ts';

/** "Unless" costs resolve.ts can ask for (mana, X, life, energy, discard, sacrifice ...). */
export function unlessCostSupported(cost: string): boolean {
  if (/^DefinedCost_Remembered(_Minus\d+)?$/.test(cost.trim())) return true;
  return (cost.trim().match(/\S+<[^>]*>|\S+/g) ?? []).every((t) => /^(\d+|[WUBRGCX]|[WUBRG2]\/[WUBRGP])$/.test(t) || /^(PayLife|PayEnergy|Discard|Sac|ExileFromGrave|ExileFromHand|Return|tapXType)<[^>]+>$/.test(t));
}

export const SCRIPTS = data as unknown as ScriptData;

export function getScript(cardId: string): ForgeFace[] | undefined {
  return SCRIPTS.cards[cardId];
}

/**
 * Scripts for cards outside the built-in cube (card database): the server registers them when it
 * loads cards for a room, the client when the server sends them. Existing entries are kept.
 */
export function registerScripts(cards: Record<string, ForgeFace[]>, tokens?: Record<string, ScriptData['tokens'][string]>) {
  for (const [id, faces] of Object.entries(cards)) if (faces && !SCRIPTS.cards[id]) SCRIPTS.cards[id] = faces;
  for (const [id, t] of Object.entries(tokens ?? {})) if (t && !SCRIPTS.tokens[id]) SCRIPTS.tokens[id] = t;
}

/** The parts of a CardInstance that decide which script it uses. */
type ScriptHolder = { cardId?: string; copyOf?: string; copyFace?: number; transformed: boolean; zone?: string; animations?: Animation[] };

/**
 * The script (card id + face) an instance uses: a copy (copyOf, on the battlefield) uses the copied card's script, a
 * transformed card its back face. undefined = no card script, or it lost all its abilities (Oko's Elk).
 */
export function scriptRef(c: ScriptHolder): { cardId: string; face: number } | undefined {
  if (c.animations?.some((a) => a.removeAllAbilities)) return undefined;
  if (c.copyOf && (c.zone === undefined || c.zone === 'battlefield')) return { cardId: c.copyOf, face: c.copyFace ?? 0 };
  return c.cardId ? { cardId: c.cardId, face: c.transformed ? 1 : 0 } : undefined;
}

/** The script face an instance uses (see scriptRef). */
export function scriptFaceOf(c: ScriptHolder): ForgeFace | undefined {
  const r = scriptRef(c);
  return r ? getScript(r.cardId)?.[r.face] : undefined;
}

/**
 * Activated abilities granted by animate effects from a card's own SVars (Lavaclaw Reaches' "{X}: +X/+0") get
 * ability indexes GRANT_BASE + (index of the SVar in the face's svars).
 */
export const GRANT_BASE = 2000;

/** Granted lines of one kind (abilities / triggers / statics) from the instance's animations, with the SVars they use. */
export function grantedLines(c: ScriptHolder, kind: 'abilities' | 'triggers' | 'statics'): { line: string; name: string; cardId: string; face: number; svars: Record<string, string>; faceName: string }[] {
  const out: { line: string; name: string; cardId: string; face: number; svars: Record<string, string>; faceName: string }[] = [];
  if (c.zone !== undefined && c.zone !== 'battlefield') return out;
  for (const a of c.animations ?? []) {
    const g = a.grant;
    const f = g ? getScript(g.cardId)?.[g.face] : undefined;
    if (!g || !f) continue;
    for (const name of g[kind] ?? []) {
      const line = f.svars[name];
      if (line) out.push({ line, name, cardId: g.cardId, face: g.face, svars: f.svars, faceName: f.name });
    }
  }
  return out;
}

/** Split "SP$ Api | Key$ value | ..." into kind / api / params. */
export function parseParams(line: string): { kind: string; api: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  let kind = '', api = '';
  for (const raw of line.split('|')) {
    const part = raw.trim();
    const i = part.indexOf('$');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!kind && (key === 'SP' || key === 'AB' || key === 'DB')) { kind = key; api = value; continue; }
    if (!(key in params)) params[key] = value;
  }
  return { kind, api, params };
}

function nameText(text: string, cardName: string): string {
  const nick = cardName.split(',')[0];
  return text
    .replace(/CARDNAME/g, cardName)
    .replace(/NICKNAME/g, nick)
    .replace(/\{[a-z]+:([^}]+)\}/g, (_m, v: string) => (v === 'Targeted' ? 'target' : v === 'You' ? 'You' : v))
    .trim();
}

/** Parse one ability line or DB$ SVar (with its SubAbility$ chain and Charm choices). */
export function parseAbility(line: string, svars: Record<string, string>, cardName: string, depth = 0): ParsedAbility | undefined {
  const { kind, api, params } = parseParams(line);
  if (kind !== 'SP' && kind !== 'AB' && kind !== 'DB') return undefined;
  let description = params.SpellDescription ?? '';
  if (!description && params.StackDescription && !['SpellDescription', 'None'].includes(params.StackDescription)) description = params.StackDescription;
  if (!description) description = api;
  const ab: ParsedAbility = { kind, api, params, description: nameText(description, cardName), svars };
  if (depth < 20 && params.SubAbility) {
    const sv = svars[params.SubAbility];
    if (sv && /^DB\$/.test(sv.trim())) ab.sub = parseAbility(sv, svars, cardName, depth + 1);
  }
  if (api === 'Charm' && params.Choices && depth < 20) {
    ab.choices = [];
    for (const name of params.Choices.split(',').map((s) => s.trim()).filter(Boolean)) {
      const sv = svars[name];
      const child = sv ? parseAbility(sv, svars, cardName, depth + 1) : undefined;
      if (child) ab.choices.push({ name, ability: child });
    }
    const n = parseInt(params.CharmNum ?? '1', 10);
    ab.charmMax = Number.isNaN(n) ? 1 : n;
    const m = parseInt(params.MinCharmNum ?? String(ab.charmMax), 10);
    ab.charmMin = Number.isNaN(m) ? ab.charmMax : m;
  }
  return ab;
}

const cache = new Map<string, ParsedAbility | null>();

/** Raw ability line for an index: A: line, -1 = aura spell (K:Enchant), >= SYNTH_BASE = keyword ability (keywords.ts). */
export function abilityLine(cardId: string, face: number, index: number): string | undefined {
  const f = getScript(cardId)?.[face];
  if (!f) return undefined;
  if (index === -1) return auraLine(f);
  if (index === BESTOW_INDEX) return bestowLine(f);
  if (index >= GRANT_BASE) { const sv = f.svars[Object.keys(f.svars)[index - GRANT_BASE] ?? '']; return sv && /^\s*AB\$/.test(sv) ? sv : undefined; }
  if (index >= SYNTH_BASE) return synthLine(f, index);
  return f.abilities[index];
}

/** Parsed A: line `index` of a face; -1 = synthesized aura spell (from K:Enchant); >= SYNTH_BASE = keyword ability. */
export function abilityAt(cardId: string, face: number, index: number): ParsedAbility | undefined {
  const key = `${cardId}|${face}|${index}`;
  if (cache.has(key)) return cache.get(key) ?? undefined;
  const f = getScript(cardId)?.[face];
  const line = abilityLine(cardId, face, index);
  const ab = f && line != null ? parseAbility(line, f.svars, f.name) : undefined;
  cache.set(key, ab ?? null);
  return ab;
}

/** Stage 2: the chain of a triggered ability (Execute$ SVar of a T: line, or a synthesized line). */
export function triggerChain(cardId: string, face: number, svar: string | undefined, line: string | undefined): ParsedAbility | undefined {
  const key = `${cardId}|${face}|t|${svar ?? ''}|${line ?? ''}`;
  if (cache.has(key)) return cache.get(key) ?? undefined;
  const f = getScript(cardId)?.[face];
  const svars = f?.svars ?? {};
  const src = line ?? (svar ? svars[svar] : undefined);
  const ab = src ? parseAbility(src, svars, f?.name ?? 'It') : undefined;
  cache.set(key, ab ?? null);
  return ab;
}

/** The ability chain an AutoInfo refers to (spell / activated / triggered). */
export function chainOf(auto: AutoInfo): ParsedAbility | undefined {
  if (auto.source === 'trigger') return triggerChain(auto.cardId, auto.face, auto.svar, auto.line);
  return abilityAt(auto.cardId, auto.face, auto.index);
}

/** Stage 2: the T: lines of a face, parsed into params. */
export function triggersOf(cardId: string, face: number): { index: number; params: Record<string, string> }[] {
  const key = `${cardId}|${face}`;
  let out = trigCache.get(key);
  if (!out) {
    out = (getScript(cardId)?.[face]?.triggers ?? []).map((line, index) => ({ index, params: parseParams(line).params }));
    trigCache.set(key, out);
  }
  return out;
}
const trigCache = new Map<string, { index: number; params: Record<string, string> }[]>();

/** Human text with CARDNAME replaced. */
export function describe(text: string, cardName: string): string {
  return nameText(text, cardName);
}

/** Ability index of the Aura spell a creature with bestow becomes when cast for its bestow cost. */
export const BESTOW_INDEX = -2;

/** Bestow: "K:Bestow:<cost>" -> the Aura spell "enchant creature". */
function bestowLine(f: ForgeFace): string | undefined {
  if (!f.keywords.some((k) => /^Bestow:/.test(k))) return undefined;
  return 'SP$ Attach | ValidTgts$ Creature | TgtPrompt$ Choose a creature to enchant | SpellDescription$ Bestow — enchant creature';
}

/** The spell ability a cast uses: the bestow Aura spell for costOption 'bestow', else the face's spell ability. */
export function castSpellAbility(cardId: string, face: number, costOption?: string): { index: number; ability: ParsedAbility } | undefined {
  if (costOption === 'bestow') {
    const ability = abilityAt(cardId, face, BESTOW_INDEX);
    if (ability) return { index: BESTOW_INDEX, ability };
  }
  return spellAbility(cardId, face);
}

/** Auras: "K:Enchant:<valid>[:<description>]" -> an equivalent "SP$ Attach" line. */
function auraLine(f: ForgeFace): string | undefined {
  const k = f.keywords.find((x) => /^Enchant:/.test(x));
  if (!k) return undefined;
  const [, valid, desc] = k.split(':');
  if (!valid || /inZone|Remembered/i.test(valid)) return undefined; // e.g. Animate Dead: handled by its trigger
  return `SP$ Attach | ValidTgts$ ${valid} | TgtPrompt$ Choose ${desc ?? valid.toLowerCase()} to enchant | SpellDescription$ Enchant ${desc ?? valid.toLowerCase()}`;
}

export function spellAbility(cardId: string, face: number): { index: number; ability: ParsedAbility } | undefined {
  const f = getScript(cardId)?.[face];
  if (!f) return undefined;
  const index = f.abilities.findIndex((l) => /^\s*SP\$/.test(l));
  if (index >= 0) {
    const ability = abilityAt(cardId, face, index);
    return ability ? { index, ability } : undefined;
  }
  const aura = abilityAt(cardId, face, -1);
  return aura ? { index: -1, ability: aura } : undefined;
}

const MANA_APIS = new Set(['Mana', 'ManaReflected']);

/** Loyalty change from a Cost$ (undefined if not a loyalty ability). X counts as 0. */
export function loyaltyOf(cost: string): number | undefined {
  const add = /AddCounter<(\d+|X)\/LOYALTY>/.exec(cost);
  if (add) return add[1] === 'X' ? 0 : parseInt(add[1], 10);
  const sub = /SubCounter<(\d+|X)\/LOYALTY>/.exec(cost);
  if (sub) return sub[1] === 'X' ? 0 : -parseInt(sub[1], 10);
  return undefined;
}

export interface ActivatedEntry {
  index: number;
  ability: ParsedAbility;
  cost: string;
  loyalty?: number;
  /** Zone the source must be in to activate (ActivationZone$); absent = battlefield. */
  zone?: 'hand' | 'graveyard' | 'exile';
  /** Keyword this ability was synthesized from (index >= SYNTH_BASE), e.g. "Equip", "Cycling". */
  keyword?: string;
}

/** AB$ abilities (no mana abilities), then keyword-granted ones (Equip, Cycling, Crew ... see keywords.ts). */
export function activatedAbilitiesOf(cardId: string, face: number): ActivatedEntry[] {
  const f = getScript(cardId)?.[face];
  if (!f) return [];
  const out: ActivatedEntry[] = [];
  const push = (index: number, keyword?: string) => {
    const ability = abilityAt(cardId, face, index);
    if (!ability || MANA_APIS.has(ability.api)) return;
    const cost = ability.params.Cost ?? '';
    const e: ActivatedEntry = { index, ability, cost };
    const loyalty = loyaltyOf(cost);
    if (loyalty != null) e.loyalty = loyalty;
    const z = ability.params.ActivationZone?.trim().toLowerCase();
    if (z === 'hand' || z === 'graveyard' || z === 'exile') e.zone = z;
    if (keyword) e.keyword = keyword;
    out.push(e);
  };
  f.abilities.forEach((line, index) => { if (/^\s*AB\$/.test(line)) push(index); });
  for (const s of synthAbilities(f)) push(s.index, s.keyword);
  return out;
}

/** The chain in execution order. Charm steps expand into the chosen modes' chains (when modes are given). */
export function flatten(ab: ParsedAbility, modes?: string[]): ParsedAbility[] {
  const out: ParsedAbility[] = [];
  for (let a: ParsedAbility | undefined = ab; a; a = a.sub) {
    if (a.api === 'Charm' && a.choices && modes) {
      for (const ch of a.choices) if (modes.includes(ch.name)) out.push(...flatten(ch.ability, modes));
    } else out.push(a);
  }
  return out;
}

const ZONES: Record<string, TargetSpec['zone']> = {
  battlefield: 'battlefield', graveyard: 'graveyard', stack: 'stack', hand: 'hand', exile: 'exile', library: 'library',
};

function tgtCount(v: string | undefined, dflt: number, unknown: number): number {
  if (v == null) return dflt;
  const n = parseInt(v, 10);
  return Number.isNaN(n) || String(n) !== v.trim() ? unknown : n;
}

function humanValid(valid: string): string {
  return valid.split(',').map((alt) => {
    const [type, props] = [alt.split('.')[0], alt.split('.').slice(1).join('.')];
    const t = type === 'Any' ? 'any target' : type === 'Card' ? 'card' : type.toLowerCase();
    if (!props) return t;
    const p = props.split('+').map((x) => x.replace(/^YouCtrl$/, 'you control').replace(/^OppCtrl$/, 'an opponent controls').replace(/^non/, 'non-').toLowerCase());
    return `${t} (${p.join(', ')})`;
  }).join(' or ');
}

function specFor(step: ParsedAbility, index: number): TargetSpec {
  const p = step.params;
  const valid = p.ValidTgts;
  const alts = valid.split(',').map((a) => a.split('.')[0].trim());
  const players = alts.some((a) => a === 'Any' || a === 'Player' || a === 'Opponent');
  const cards = alts.some((a) => a !== 'Player' && a !== 'Opponent');
  let zone: TargetSpec['zone'] = 'battlefield';
  if (p.TargetType && /Spell|Activated|Triggered/.test(p.TargetType)) zone = 'stack';
  else if (p.TgtZone) {
    const zs = p.TgtZone.split(',').map((z) => ZONES[z.trim().toLowerCase()]);
    zone = zs.length === 1 && zs[0] ? zs[0] : 'any';
  } else if (step.api === 'ChangeZone' && p.Origin) {
    const zs = p.Origin.split(',').map((z) => ZONES[z.trim().toLowerCase()]);
    zone = zs.length === 1 && zs[0] ? zs[0] : 'any';
  }
  const min = tgtCount(p.TargetMin, 1, 0);
  const max = Math.max(min, tgtCount(p.TargetMax, Math.max(1, min), 99));
  const spec: TargetSpec = {
    step: index, prompt: p.TgtPrompt ?? `Choose ${max > 1 ? `up to ${max} targets` : 'a target'}: ${humanValid(valid)}`,
    min, max, zone, valid, players, cards: cards || zone === 'stack',
  };
  if (p.TargetType) spec.targetType = p.TargetType;
  return spec;
}

/** Forge Phase$ names -> steps. */
export const PHASES: Record<string, import('../game/types.ts').Step> = {
  Upkeep: 'upkeep', Draw: 'draw', Main1: 'main1', 'Main 1': 'main1', BeginCombat: 'beginCombat', 'Beginning of Combat': 'beginCombat',
  'Declare Attackers': 'attackers', 'Declare Blockers': 'blockers', 'Combat Damage': 'damage', EndCombat: 'endCombat', 'End Combat': 'endCombat',
  Main2: 'main2', 'Main 2': 'main2', 'End of Turn': 'end', End: 'end', Cleanup: 'cleanup',
};

export function targetSpecs(ab: ParsedAbility, modes?: string[]): TargetSpec[] {
  const out: TargetSpec[] = [];
  flatten(ab, modes).forEach((step, i) => { if (step.params.ValidTgts) out.push(specFor(step, i)); });
  return out;
}

/** Which flattened step uses which TargetSpec index. */
export function specIndexByStep(steps: ParsedAbility[]): (number | undefined)[] {
  let n = 0;
  return steps.map((s) => (s.params.ValidTgts ? n++ : undefined));
}

// ------------------------------------------------------------------ support checks

export const SUPPORTED_APIS = new Set([
  'DealDamage', 'DamageAll', 'Draw', 'Destroy', 'DestroyAll', 'ChangeZone', 'ChangeZoneAll', 'Token', 'PutCounter', 'PutCounterAll',
  'GainLife', 'LoseLife', 'SetLife', 'Counter', 'Pump', 'PumpAll', 'Tap', 'Untap', 'TapAll', 'UntapAll', 'Discard', 'Mill',
  'Scry', 'Surveil', 'Dig', 'RearrangeTopOfLibrary', 'GainControl', 'Sacrifice', 'SacrificeAll', 'Attach', 'Mana', 'Charm',
  'Cleanup', 'Shuffle', 'BecomeMonarch', 'TakeInitiative', 'RevealHand',
  // Stage 2
  'Investigate', 'DelayedTrigger', 'ImmediateTrigger', 'CopyPermanent',
]);

export const SUPPORTED_DEFINED = new Set([
  'You', 'Self', 'Parent', 'Targeted', 'TargetedCard', 'TargetedController', 'TargetedOwner', 'TargetedPlayer', 'Player', 'Opponent',
  'ParentTarget', 'Remembered', 'RememberedLKI', 'Enchanted', 'Equipped', 'TargetedAndYou', 'Player.Opponent',
  // Stage 2: objects a trigger saw
  'TriggeredCard', 'TriggeredCardLKICopy', 'TriggeredNewCardLKICopy', 'TriggeredCardController', 'TriggeredCardOwner',
  'TriggeredPlayer', 'TriggeredActivator', 'TriggeredTarget', 'TriggeredDefendingPlayer', 'TriggeredSourceController',
  'TriggeredAttackingPlayer', 'TriggeredSource', 'DelayTriggerRemembered', 'DelayTriggerRememberedLKI',
  // engine/copy.ts
  'ChosenPlayer',
]);

const AMOUNT_PARAMS = ['NumDmg', 'NumCards', 'LifeAmount', 'TokenAmount', 'CounterNum', 'NumAtt', 'NumDef', 'ScryNum', 'DigNum', 'Amount'];

/** SVar values the engine can evaluate. */
export function supportedVar(v: string | undefined): boolean {
  if (!v) return false;
  return /^Count\$xPaid$/.test(v) || /^Number\$-?\d+$/.test(v) || v === 'Count$TriggerRememberAmount' || v === 'TriggerCount$Amount'
    || /^(Targeted|TargetedLKI|Remembered|RememberedLKI)\$Card(Power|Toughness|ManaCost)$/.test(v)
    || /^Count\$(CardPower|CardToughness|CardManaCost|YourLifeTotal|CardsInYourHand)$/.test(v)
    || supportedCount(v)
    || /^Count\$Valid [A-Za-z.+,!]+$/.test(v)
    || uniqueVarSupported(v)
    || moreVarSupported(v);
}

export function amountSupported(raw: string | undefined, svars: Record<string, string> | undefined): boolean {
  if (raw == null) return true;
  const s = raw.trim().replace(/^[+-]/, '');
  if (/^\d+$/.test(s)) return true;
  return supportedVar(svars?.[s] ?? (/\$/.test(s) ? s : undefined));
}

/** Reason this step can't be automated, or null. */
export function unsupportedReason(step: ParsedAbility): string | null {
  const p = step.params;
  const api = step.api;
  const unique = uniqueReason(step); // unique / hard cards (unique-support.ts)
  if (unique !== undefined) return unique === null && p.Condition && !KNOWN_CONDITIONS.has(p.Condition) ? `${api} (Condition$ ${p.Condition})` : unique;
  const more = moreReason(step); // engine/more.ts
  if (more !== undefined) return more;
  if (api === 'Charm' && step.choices?.length) return null; // modes are asked on resolution when none were chosen
  if (api === 'Effect' && p.AILogic === 'CantRegenerate') return null; // regeneration isn't modelled: no-op
  const ext = EXT_APIS.has(api); // Animate, Effect, Clone ... (engine/ext.ts)
  if (!SUPPORTED_APIS.has(api) && !KEYWORD_APIS.has(api) && !ext) return api;
  if (api === 'Charm') return step.choices?.length ? null : api;
  if (p.Defined && !SUPPORTED_DEFINED.has(p.Defined) && !MORE_DEFINED.has(p.Defined) && !/^Valid [A-Za-z.+,!]+$/.test(p.Defined) && !/^Targeted\.[!A-Za-z.+]+$/.test(p.Defined) && !(ext && extDefinedOk(p.Defined))) return `${api} (Defined$ ${p.Defined})`;
  if (p.UnlessCost && api !== 'Counter' && !unlessCostSupported(p.UnlessCost)) return `${api} (UnlessCost)`;
  if (p.Condition && !KNOWN_CONDITIONS.has(p.Condition)) return `${api} (Condition$ ${p.Condition})`;
  for (const k of AMOUNT_PARAMS) {
    if (k === 'Amount' && !['Surveil', 'Mana', 'Sacrifice'].includes(api)) continue;
    if (!amountSupported(p[k], step.svars)) return `${api} (${k}$ ${p[k]})`;
  }
  if (ext) return extUnsupported(step);
  switch (api) {
    case 'Discard': if (p.Mode && !['Random', 'TgtChoose', 'RevealYouChoose', 'Hand', 'Defined'].includes(p.Mode)) return `Discard (Mode$ ${p.Mode})`;
      if (p.Mode === 'Defined' && !(SUPPORTED_DEFINED.has(p.DefinedCards ?? '') || MORE_DEFINED.has(p.DefinedCards ?? ''))) return 'Discard (DefinedCards)'; break;
    case 'Mana': if (!/^[WUBRGC]( [WUBRGC])*$/.test(p.Produced ?? '') && p.Produced !== 'Any' && !/^Combo (Any|[WUBRGC]( [WUBRGC])*)$/.test(p.Produced ?? '')) return 'Mana (choice)'; break;
    case 'DelayedTrigger':
      if (!p.Execute || !step.svars?.[p.Execute]) return 'DelayedTrigger';
      if (p.Mode === 'Phase' ? (step.kind !== 'DB' && p.Planeswalker !== 'True') || !PHASES[(p.Phase ?? '').replace(/->$/, '')] : !['SpellCast', 'ChangesZone'].includes(p.Mode ?? '')) return 'DelayedTrigger';
      if (p.ValidPlayer && !['Player', 'Player.controlsCard.IsTriggerRemembered'].includes(p.ValidPlayer)) return 'DelayedTrigger (ValidPlayer)';
      if (p.RememberObjects && !SUPPORTED_DEFINED.has(p.RememberObjects) && !MORE_DEFINED.has(p.RememberObjects)) return 'DelayedTrigger (remembered objects)';
      break;
    case 'ImmediateTrigger': if (step.kind === 'SP' || !p.Execute || !step.svars?.[p.Execute] || (p.TriggerAmount && p.TriggerAmount !== 'Remembered$Amount')) return 'ImmediateTrigger'; break;
    case 'Investigate': if (p.Num && !amountSupported(p.Num, step.svars)) return 'Investigate'; break;
    case 'Tap': case 'Untap': if (p.UntapType || p.TapType) return `${api} (choice)`; break;
    case 'Counter': if (p.UnlessCost && !unlessCostSupported(p.UnlessCost)) return 'Counter (UnlessCost)'; break;
    case 'Token': if (p.AtEOT && !['Sacrifice', 'Exile', 'ExileCombat'].includes(p.AtEOT)) return 'Token (AtEOT)';
      if (!p.TokenScript || p.TokenScript.split(',').some((t) => !SCRIPTS.tokens[t.trim()])) return 'Token (unknown token)'; break;
    case 'ChangeZone': {
      if (p.Destination && !['Battlefield', 'Hand', 'Graveyard', 'Exile', 'Library'].includes(p.Destination)) return `ChangeZone (to ${p.Destination})`;
      break;
    }
    case 'ChangeZoneAll': if (!p.Destination || !['Battlefield', 'Hand', 'Graveyard', 'Exile', 'Library'].includes(p.Destination) || !p.Origin || /Stack|Any/.test(p.Origin)) return 'ChangeZoneAll'; break;
    case 'PutCounter': if (!p.CounterType && !p.Adapt) return 'PutCounter'; break;
    case 'Pump': case 'PumpAll':
      if (p.PumpZone && !(api === 'Pump' && (/^(Flashback|Retrace)$/.test(p.KW ?? '') || !p.KW))) return `${api} (special keyword)`;
      if (p.KW && /HIDDEN|:/.test(p.KW) && !/^Protection/.test(p.KW) && p.KW !== "HIDDEN CARDNAME can't block.") return `${api} (special keyword)`;
      if (p.Defined && ['You', 'Player', 'Opponent', 'TargetedPlayer'].includes(p.Defined) && (api === 'PumpAll' || !p.KW || p.NumAtt || p.NumDef)) return `${api} (player)`;
      break;
  }
  return null;
}

export function isAutomatable(ab: ParsedAbility): { ok: boolean; unsupported: string[] } {
  const unsupported: string[] = [];
  const visit = (a: ParsedAbility) => {
    for (let s: ParsedAbility | undefined = a; s; s = s.sub) {
      const r = unsupportedReason(s);
      if (r) unsupported.push(r);
      if (s.api === 'Charm' && s.choices) for (const c of s.choices) visit(c.ability);
    }
  };
  visit(ab);
  return { ok: unsupported.length === 0, unsupported };
}
