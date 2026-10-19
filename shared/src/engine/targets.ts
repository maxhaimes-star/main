/**
 * Forge "Valid" expressions (ValidTgts$, ValidCards$, ChangeType$ ...) evaluated against game cards / players.
 * Grammar: comma = OR; each alternative is `Type[.prop+prop...]`. Unknown properties evaluate to 'unknown'
 * (targeting treats that as allowed so play is never blocked).
 */
import { type Lookup, faceOf, hasKeyword } from '../game/rules.ts';
import { type CardInstance, type GameState, type ViewCard, isHidden } from '../game/types.ts';
import type { TargetRef, TargetSpec } from './types.ts';
import { playerTargetable, protectedFrom } from './protection.ts';

export type Tri = boolean | 'unknown';

export interface MatchEnv {
  controller: string;
  sourceIid?: string;
  lookup: Lookup;
  /** Resolve a variable like "X" to a number (undefined = unknown). */
  num?: (name: string) => number | undefined;
  /** Stage 2: what the source is attached to ('' = nothing), for EquippedBy / EnchantedBy / AttachedBy. */
  attachedTo?: string;
  /** Current P/T of a battlefield card (e.g. including static effects); default: printed + counters + modifiers. */
  pt?: (c: CardInstance) => [number, number];
  /** Keyword check (e.g. including static effects); default: hasKeyword without statics. */
  kw?: (c: CardInstance, kw: string) => boolean;
  /** Choices of the source (ChosenType / ChosenColor / NamedCard); absent = unknown. */
  chosen?: import('./types.ts').Chosen;
  /** Objects the source / effect remembered (IsRemembered); absent = unknown. */
  remembered?: string[];
  /** Cards in exile that were exiled with the source (ExiledWithSource). */
  exiledWith?: string[];
  /** Cards chosen during this resolution (ChosenCard). */
  chosenCards?: string[];
  /** Cards imprinted during this resolution (IsImprinted: Atraxa's revealed cards); absent = unknown. */
  imprinted?: string[];
  /** This turn's bookkeeping (attackedThisCombat / attackedThisTurn / ThisTurnEntered); absent = unknown. */
  turnInfo?: { turn: number; activations: Record<string, number> };
  /** The trigger's defending player (DefenderCtrl). */
  defender?: string;
  /** Players the resolving spell / ability targets (TargetedPlayerCtrl / TargetedPlayerOwn); absent = unknown. */
  targetedPlayers?: string[];
  /** Cards the resolving spell / ability targets (targetedBy); absent = unknown. */
  targetedCards?: string[];
  /** Library order by player (TopLibrary / BottomLibrary); absent = unknown. */
  libraries?: Record<string, string[]>;
}

const CARD_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Kindred', 'Land', 'Planeswalker', 'Sorcery', 'Tribal'];
const PERMANENT_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Land', 'Planeswalker'];
const COLOR_WORDS: Record<string, string> = { White: 'W', Blue: 'U', Black: 'B', Red: 'R', Green: 'G' };
/** Words a "has all creature types" permanent doesn't match. */
const NOT_CREATURE_TYPES = new Set(['Legendary', 'Basic', 'Snow', 'World', 'Token', 'Aura', 'Equipment', 'Vehicle', 'Saga', 'Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Desert', 'Gate', 'Treasure', 'Clue', 'Food']);

function and(a: Tri, b: Tri): Tri {
  if (a === false || b === false) return false;
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return true;
}
function not(a: Tri): Tri { return a === 'unknown' ? 'unknown' : !a; }

interface CardFacts { types: string[]; typeLine: string; name: string; colors: string[]; cmc: number; power: number; toughness: number; allTypes?: boolean }

function facts(c: CardInstance, lookup: Lookup, pt?: MatchEnv['pt']): CardFacts {
  if (c.faceDown) return { types: ['Creature'], typeLine: 'Creature', name: '', colors: [], cmc: 0, power: 2, toughness: 2 };
  const f = faceOf(c, lookup);
  const id = (c.zone === 'battlefield' ? c.copyOf : undefined) ?? c.cardId;
  const data = id ? lookup(id) : undefined;
  const colors = f.colors ?? (c.token && !c.cardId ? c.token.colors : data?.colors ?? []);
  const allTypes = f.allCreatureTypes && (f.types.includes('Creature') || f.types.includes('Kindred') || f.types.includes('Tribal'));
  const plus = (c.counters['+1/+1'] ?? 0) - (c.counters['-1/-1'] ?? 0);
  const n = (v?: string) => { const x = parseInt(v ?? '', 10); return Number.isNaN(x) ? 0 : x; };
  const onBf = c.zone === 'battlefield';
  if (onBf && pt) {
    const [power, toughness] = pt(c);
    return { types: f.types, typeLine: f.typeLine, name: f.name, colors, cmc: !data ? 0 : data.cmc ?? 0, power, toughness, allTypes };
  }
  return {
    types: f.types, typeLine: f.typeLine, name: f.name, colors, cmc: !data ? 0 : data.cmc ?? 0, allTypes,
    power: n(f.power) + (onBf ? plus + c.tempPT[0] + c.permPT[0] : 0),
    toughness: n(f.toughness) + (onBf ? plus + c.tempPT[1] + c.permPT[1] : 0),
  };
}

function hasWord(typeLine: string, w: string): boolean {
  return typeLine.split(/[\s—-]+/).some((x) => x.toLowerCase() === w.toLowerCase());
}

function typeCheck(fx: CardFacts, c: CardInstance, t: string): Tri {
  switch (t) {
    case 'Card': case 'Spell': return true;
    case 'Permanent': return fx.types.some((x) => PERMANENT_TYPES.includes(x)) || c.faceDown;
    case 'Any': return fx.types.some((x) => ['Creature', 'Planeswalker', 'Battle'].includes(x));
    case 'Player': case 'Opponent': case 'Emblem': return false;
    case 'Historic': return hasWord(fx.typeLine, 'Legendary') || fx.types.includes('Artifact') || hasWord(fx.typeLine, 'Saga');
  }
  if (CARD_TYPES.includes(t)) return fx.types.includes(t);
  if (/^[A-Z][a-z]+$/.test(t)) return hasWord(fx.typeLine, t) || (!!fx.allTypes && !NOT_CREATURE_TYPES.has(t)); // subtype / supertype (Goblin, Aura, Legendary, Snow ...)
  return 'unknown';
}

function cmp(a: number, op: string, b: number): boolean {
  switch (op) {
    case 'LT': return a < b;
    case 'LE': return a <= b;
    case 'EQ': return a === b;
    case 'NE': return a !== b;
    case 'GE': return a >= b;
    case 'GT': return a > b;
  }
  return false;
}

function propCheck(c: CardInstance, fx: CardFacts, prop: string, env: MatchEnv): Tri {
  if (prop.startsWith('!')) return not(propCheck(c, fx, prop.slice(1), env));
  switch (prop) {
    case 'YouCtrl': return c.controller === env.controller;
    case 'OppCtrl': case 'YouDontCtrl': return c.controller !== env.controller;
    case 'YouOwn': return c.owner === env.controller;
    case 'OppOwn': case 'YouDontOwn': return c.owner !== env.controller;
    case 'Other': case 'StrictlyOther': return c.iid !== env.sourceIid;
    case 'Self': case 'StrictlySelf': return c.iid === env.sourceIid;
    case 'EquippedBy': case 'EnchantedBy': case 'AttachedBy': return env.attachedTo === undefined ? 'unknown' : c.iid === env.attachedTo;
    case 'tapped': return c.tapped;
    case 'untapped': return !c.tapped;
    case 'attacking': return !!c.attacking;
    case 'blocking': return !!c.blocking;
    case 'token': return !!c.token;
    case 'nonToken': case 'nontoken': return !c.token;
    case 'faceDown': return c.faceDown;
    case 'faceUp': return !c.faceDown;
    // How it was cast (engine/costs.ts): ETB triggers like "if it was kicked" / "unless it escaped".
    case 'kicked': return !!c.castInfo?.kicked;
    case 'notkicked': case 'unkicked': return !c.castInfo?.kicked;
    case 'escaped': return !!c.castInfo?.escaped;
    case 'evoked': return !!c.castInfo?.evoked;
    case 'Colorless': return fx.colors.length === 0;
    case 'MultiColor': return fx.colors.length >= 2;
    case 'MonoColor': return fx.colors.length === 1;
    // Choices of the source (engine/copy.ts) and remembered objects (engine/effects.ts).
    case 'ChosenType': return env.chosen === undefined ? 'unknown' : !!env.chosen.type && (hasWord(fx.typeLine, env.chosen.type) || !!fx.allTypes);
    case 'NamedCard': return env.chosen === undefined ? 'unknown' : !!env.chosen.name && fx.name === env.chosen.name;
    case 'ChosenColor': return env.chosen === undefined ? 'unknown' : !!env.chosen.color && fx.colors.includes(COLOR_WORDS[env.chosen.color] ?? env.chosen.color);
    case 'IsRemembered': return env.remembered === undefined ? 'unknown' : env.remembered.includes(c.iid);
    case 'targetedBy': return env.targetedCards === undefined ? 'unknown' : env.targetedCards.includes(c.iid);
    case 'HasCounters': return Object.values(c.counters).some((n) => n > 0);
    case 'IsImprinted': return env.imprinted === undefined ? 'unknown' : env.imprinted.includes(c.iid);
    case 'TargetedPlayerCtrl': return env.targetedPlayers === undefined ? 'unknown' : env.targetedPlayers.includes(c.controller);
    case 'TargetedPlayerOwn': return env.targetedPlayers === undefined ? 'unknown' : env.targetedPlayers.includes(c.owner);
    case 'TopLibrary': case 'BottomLibrary': {
      if (c.zone !== 'library') return false;
      const lib = env.libraries?.[c.owner];
      if (!lib) return 'unknown';
      return prop === 'TopLibrary' ? lib[0] === c.iid : lib[lib.length - 1] === c.iid;
    }
    case 'ChosenCard': return env.chosenCards === undefined ? 'unknown' : env.chosenCards.includes(c.iid);
    case 'ExiledWithSource': case 'ExiledWithSourceLKI': return env.exiledWith === undefined ? 'unknown' : env.exiledWith.includes(c.iid);
    // How / where it was cast (CastInfo.from is set when not cast from the hand).
    case 'wasCast': return !!c.castInfo;
    case 'wasCastByYou': return !!c.castInfo && c.controller === env.controller;
    case 'wasCastFromExile': return c.castInfo?.from === 'exile';
    case 'wasCastFromGraveyard': return c.castInfo?.from === 'graveyard';
    case 'wasCastFromHand': return !!c.castInfo && !c.castInfo.from;
    case 'wasCastFromYourHandByYou': return !!c.castInfo && !c.castInfo.from && c.controller === env.controller;
    case 'surged': return c.castInfo?.option === 'surge';
    case 'dashed': return !!c.castInfo?.dashed;
    case 'DefenderCtrl': return env.defender === undefined ? 'unknown' : c.controller === env.defender;
    case 'RememberedPlayerCtrl': return env.remembered === undefined ? 'unknown' : env.remembered.includes(c.controller);
    case 'RememberedPlayerOwn': return env.remembered === undefined ? 'unknown' : env.remembered.includes(c.owner);
    case 'inRealZoneGraveyard': return c.zone === 'graveyard';
    case 'inRealZoneBattlefield': return c.zone === 'battlefield';
    case 'inRealZoneExile': return c.zone === 'exile';
    case 'attackedThisCombat': case 'attackedThisTurn': case 'ThisTurnEntered': case 'enteredThisTurn': {
      if (!env.turnInfo) return 'unknown';
      const key = prop === 'ThisTurnEntered' || prop === 'enteredThisTurn' ? `entered|${c.iid}` : `attacked|${c.iid}`;
      return (env.turnInfo.activations[key] ?? 0) > 0 || (prop.startsWith('attacked') && !!c.attacking);
    }
    case 'IsNotRemembered': return env.remembered === undefined ? 'unknown' : !env.remembered.includes(c.iid);
  }
  if (COLOR_WORDS[prop]) return fx.colors.includes(COLOR_WORDS[prop]);
  let m = /^(cmc|power|toughness)(LT|LE|EQ|NE|GE|GT)(.+)$/.exec(prop);
  if (m) {
    const right = /^-?\d+$/.test(m[3]) ? parseInt(m[3], 10) : env.num?.(m[3]);
    if (right == null) return 'unknown';
    const left = m[1] === 'cmc' ? fx.cmc : m[1] === 'power' ? fx.power : fx.toughness;
    return cmp(left, m[2], right);
  }
  if ((m = /^inZone(\w+)$/.exec(prop))) return c.zone === m[1].toLowerCase();
  if ((m = /^counters_(LT|LE|EQ|NE|GE|GT)(\w+?)_(\w+)$/.exec(prop))) {
    const right = /^-?\d+$/.test(m[2]) ? parseInt(m[2], 10) : env.num?.(m[2]);
    if (right == null) return 'unknown';
    const t = m[3].toUpperCase();
    const kind = t === 'P1P1' ? '+1/+1' : t === 'M1M1' ? '-1/-1' : t.toLowerCase();
    return cmp(c.counters[kind] ?? 0, m[1], right);
  }
  if ((m = /^without(\w[\w ]*)$/.exec(prop))) return !(env.kw ? env.kw(c, m[1]) : hasKeyword(c, env.lookup, m[1]));
  if ((m = /^with(\w[\w ]*)$/.exec(prop))) return env.kw ? env.kw(c, m[1]) : hasKeyword(c, env.lookup, m[1]);
  if ((m = /^named(.+)$/.exec(prop))) return fx.name === m[1];
  if ((m = /^non(\w+)$/.exec(prop))) {
    const w = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    if (COLOR_WORDS[w]) return !fx.colors.includes(COLOR_WORDS[w]);
    if (w === 'Token') return !c.token;
    // nonChosenCard / nonIsRemembered ...: the negation of a property (Ajani, Nacatl Avenger: "sacrifices the rest").
    if (/^(ChosenCard|IsRemembered|ExiledWithSource|NamedCard|ChosenType|ChosenColor)$/.test(w)) return not(propCheck(c, fx, w, env));
    return not(typeCheck(fx, c, w));
  }
  if (CARD_TYPES.includes(prop) || prop === 'Permanent' || prop === 'Historic' || /^[A-Z][a-z]+$/.test(prop)) return typeCheck(fx, c, prop);
  return 'unknown';
}

function altParts(alt: string): [string, string[]] {
  const i = alt.indexOf('.');
  if (i < 0) return [alt.trim(), []];
  return [alt.slice(0, i).trim(), alt.slice(i + 1).split('+').map((x) => x.trim()).filter(Boolean)];
}

/** Does a card match a Valid expression? */
export function matchCard(c: CardInstance, valid: string, env: MatchEnv): Tri {
  const fx = facts(c, env.lookup, env.pt);
  let result: Tri = false;
  for (const alt of valid.split(',')) {
    const [type, props] = altParts(alt);
    let r: Tri = type.startsWith('non') ? propCheck(c, fx, type, env) : typeCheck(fx, c, type);
    for (const p of props) { if (r === false) break; r = and(r, propCheck(c, fx, p, env)); }
    if (r === true) return true;
    if (r === 'unknown') result = 'unknown';
  }
  return result;
}

/** Does a player match a Valid expression? */
export function matchPlayer(pid: string, valid: string, env: MatchEnv): Tri {
  let result: Tri = false;
  for (const alt of valid.split(',')) {
    const [type, props] = altParts(alt);
    let r: Tri;
    if (type === 'Any' || type === 'Player') r = true;
    else if (type === 'Opponent') r = pid !== env.controller;
    else if (type === 'You') r = pid === env.controller;
    else continue;
    for (const p of props) {
      if (p === 'Opponent' || p === 'OppCtrl' || p === 'Other' || p === 'NonYou') r = and(r, pid !== env.controller);
      else if (p === 'You' || p === 'YouCtrl') r = and(r, pid === env.controller);
      else if (p === 'IsRemembered') r = and(r, env.remembered === undefined ? 'unknown' : env.remembered.includes(pid));
      else r = and(r, 'unknown');
    }
    if (r === true) return true;
    if (r === 'unknown') result = 'unknown';
  }
  return result;
}

type TargetState = Pick<GameState, 'players' | 'stack' | 'battlefield'> & { cards: Record<string, CardInstance | ViewCard> };

function genericCardValid(valid: string): boolean {
  return valid.split(',').every((a) => { const [t, p] = altParts(a); return (t === 'Card' || t === 'Spell') && p.length === 0; });
}

function stackItemOk(state: TargetState, spec: TargetSpec, itemId: string, env: MatchEnv): boolean {
  const item = state.stack.find((s) => s.id === itemId);
  if (!item) return false;
  const tt = spec.targetType ?? 'Spell';
  const kinds = tt.split(',').map((k) => k.trim());
  const kindOk = (item.kind === 'spell' && kinds.includes('Spell')) || (item.kind === 'ability' && kinds.includes('Activated')) || (item.kind === 'trigger' && kinds.includes('Triggered'));
  if (!kindOk) return false;
  if (item.kind !== 'spell') return true;
  const c = item.iid ? state.cards[item.iid] : undefined;
  if (!c) return false;
  if (isHidden(c)) return genericCardValid(spec.valid);
  return matchCard(c, spec.valid, env) !== false;
}

export function isValidTarget(state: TargetState, spec: TargetSpec, ref: TargetRef, controller: string, sourceIid: string | undefined, lookup: Lookup): boolean {
  const env: MatchEnv = { controller, sourceIid, lookup };
  if (ref.kind === 'player') {
    if (!spec.players) return false;
    const p = state.players.find((x) => x.pid === ref.pid);
    if (!p || p.conceded) return false;
    if ('effects' in state || state.battlefield.length) { if (!playerTargetable(state as never, ref.pid, controller, sourceIid, lookup)) return false; } // shroud / hexproof / protection
    return matchPlayer(ref.pid, spec.valid, env) !== false;
  }
  if (ref.kind === 'stack') {
    if (spec.zone !== 'stack') return false;
    return stackItemOk(state, spec, ref.id, env);
  }
  if (!spec.cards) return false;
  const c = state.cards[ref.iid];
  if (!c) return false;
  if (spec.zone === 'stack') {
    const item = state.stack.find((s) => s.iid === ref.iid);
    return !!item && stackItemOk(state, spec, item.id, env);
  }
  if (isHidden(c)) return false;
  if (spec.zone !== 'any' && c.zone !== spec.zone) return false;
  if (c.zone === 'library' || c.zone === 'sideboard') return false;
  if (c.iid === sourceIid && c.zone === 'stack') return false;
  if (c.zone === 'battlefield') {
    if (hasKeyword(c, lookup, 'Shroud', state)) return false;
    if (c.controller !== controller && hasKeyword(c, lookup, 'Hexproof', state)) return false;
    if (sourceIid && protectedFrom(state as never, c.iid, sourceIid, lookup)) return false; // protection from the source's quality
  }
  return matchCard(c, spec.valid, env) !== false;
}
