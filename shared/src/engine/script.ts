/**
 * Forge script access and parsing: A: lines / DB$ SVars -> ParsedAbility chains, target specs,
 * and "can the engine run this" checks.
 */
import data from '../../data/scripts.json' with { type: 'json' };
import type { ForgeFace, ParsedAbility, ScriptData, TargetSpec } from './types.ts';

export const SCRIPTS = data as unknown as ScriptData;

export function getScript(cardId: string): ForgeFace[] | undefined {
  return SCRIPTS.cards[cardId];
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
  if (!description && params.StackDescription && params.StackDescription !== 'SpellDescription') description = params.StackDescription;
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

/** Parsed A: line `index` of a face; -1 = synthesized aura spell (from K:Enchant). */
export function abilityAt(cardId: string, face: number, index: number): ParsedAbility | undefined {
  const key = `${cardId}|${face}|${index}`;
  if (cache.has(key)) return cache.get(key) ?? undefined;
  const f = getScript(cardId)?.[face];
  let ab: ParsedAbility | undefined;
  if (f) {
    if (index === -1) {
      const line = auraLine(f);
      ab = line ? parseAbility(line, f.svars, f.name) : undefined;
    } else if (f.abilities[index] != null) {
      ab = parseAbility(f.abilities[index], f.svars, f.name);
    }
  }
  cache.set(key, ab ?? null);
  return ab;
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

export function activatedAbilitiesOf(cardId: string, face: number): { index: number; ability: ParsedAbility; cost: string; loyalty?: number }[] {
  const f = getScript(cardId)?.[face];
  if (!f) return [];
  const out: { index: number; ability: ParsedAbility; cost: string; loyalty?: number }[] = [];
  f.abilities.forEach((line, index) => {
    if (!/^\s*AB\$/.test(line)) return;
    const ability = abilityAt(cardId, face, index);
    if (!ability || MANA_APIS.has(ability.api)) return;
    const cost = ability.params.Cost ?? '';
    const loyalty = loyaltyOf(cost);
    out.push(loyalty != null ? { index, ability, cost, loyalty } : { index, ability, cost });
  });
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
]);

export const SUPPORTED_DEFINED = new Set([
  'You', 'Self', 'Parent', 'Targeted', 'TargetedCard', 'TargetedController', 'TargetedOwner', 'TargetedPlayer', 'Player', 'Opponent',
  'ParentTarget', 'Remembered', 'RememberedLKI', 'Enchanted', 'Equipped', 'TargetedAndYou', 'Player.Opponent',
]);

const AMOUNT_PARAMS = ['NumDmg', 'NumCards', 'LifeAmount', 'TokenAmount', 'CounterNum', 'NumAtt', 'NumDef', 'ScryNum', 'DigNum', 'Amount'];

/** SVar values the engine can evaluate. */
export function supportedVar(v: string | undefined): boolean {
  if (!v) return false;
  return /^Count\$xPaid$/.test(v) || /^Number\$-?\d+$/.test(v)
    || /^(Targeted|TargetedLKI|Remembered|RememberedLKI)\$Card(Power|Toughness|ManaCost)$/.test(v)
    || /^Count\$(CardPower|CardToughness|CardManaCost|YourLifeTotal|CardsInYourHand)$/.test(v);
}

export function amountSupported(raw: string | undefined, svars: Record<string, string> | undefined): boolean {
  if (raw == null) return true;
  const s = raw.trim().replace(/^[+-]/, '');
  if (/^\d+$/.test(s)) return true;
  return supportedVar(svars?.[s]);
}

/** Reason this step can't be automated, or null. */
export function unsupportedReason(step: ParsedAbility): string | null {
  const p = step.params;
  const api = step.api;
  if (!SUPPORTED_APIS.has(api)) return api;
  if (api === 'Charm') return step.choices?.length ? null : api;
  if (p.Defined && !SUPPORTED_DEFINED.has(p.Defined)) return `${api} (Defined$ ${p.Defined})`;
  if (p.UnlessCost && api !== 'Counter') return `${api} (UnlessCost)`;
  if (p.Condition) return `${api} (Condition$ ${p.Condition})`;
  for (const k of AMOUNT_PARAMS) {
    if (k === 'Amount' && !['Surveil', 'Mana', 'Sacrifice'].includes(api)) continue;
    if (!amountSupported(p[k], step.svars)) return `${api} (${k}$ ${p[k]})`;
  }
  switch (api) {
    case 'Discard': if (p.Mode && !['Random', 'TgtChoose', 'RevealYouChoose', 'Hand'].includes(p.Mode)) return `Discard (Mode$ ${p.Mode})`; break;
    case 'Mana': if (!/^[WUBRGC]( [WUBRGC])*$/.test(p.Produced ?? '')) return 'Mana (choice)'; break;
    case 'Tap': case 'Untap': if (p.UntapType || p.TapType) return `${api} (choice)`; break;
    case 'Counter': if (p.UnlessCost && !/^[\dWUBRGCX ]+$/.test(p.UnlessCost)) return 'Counter (UnlessCost)'; break;
    case 'Token': if (!p.TokenScript || p.TokenScript.split(',').some((t) => !SCRIPTS.tokens[t.trim()])) return 'Token (unknown token)'; break;
    case 'ChangeZone': {
      if (p.Destination && !['Battlefield', 'Hand', 'Graveyard', 'Exile', 'Library'].includes(p.Destination)) return `ChangeZone (to ${p.Destination})`;
      break;
    }
    case 'ChangeZoneAll': if (!p.Destination || !['Battlefield', 'Hand', 'Graveyard', 'Exile', 'Library'].includes(p.Destination)) return 'ChangeZoneAll'; break;
    case 'DealDamage': if (p.DividedAsYouChoose) return 'DealDamage (divided)'; break;
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
