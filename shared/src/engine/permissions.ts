/**
 * "You may play / cast that card" permissions: casting a card from somewhere other than your hand through the
 * normal cast action.
 *
 * Sources:
 *  - Effect records (engine/effects.ts) with a MayPlay$ True static: impulse draw (Light Up the Stage, Ragavan,
 *    Bonehoard Dracosaur ...), Hostage Taker / Valki-Tibalt ("spend mana as though it were mana of any type"),
 *    Elite Spellbinder (the card's owner may play it, {2} more), Dauthi Voidwalker / Golos / Fallen Shinobi
 *    (without paying its mana cost), Yawgmoth's Will (cards in your graveyard).
 *  - Permanents with a MayPlay$ True static: Crucible of Worlds, Lurrus / Serra Paragon (MayPlayLimit$ once per
 *    turn), Courser of Kruphix / Oracle of Mul Daya (lands from the top of the library), Bolas's Citadel (pay life
 *    instead of the mana cost).
 *  - Keywords granted to cards in a graveyard: Snapcaster Mage (flashback until end of turn, a 'grant' TimedEffect),
 *    Wrenn and Six's emblem / Six (retrace: discard a land card in addition), Underworld Breach (escape).
 *  - A card on an adventure (exiled after its adventure resolved) may be cast as its creature.
 *
 * costs.ts castOptions() / planCast() call applyPermissions(): without a permission the normal cost of a card that
 * isn't in its owner's hand is unavailable ("You can't cast X from your graveyard"); with one, the option says where
 * the permission comes from and its cost reflects it (free, any color, alternative life cost, extra costs).
 * mayPlayFrom() answers the same question for land plays and for the strict-mode castability check.
 */
import { getCard } from '../cube.ts';
import { cardName, type Lookup } from '../game/rules.ts';
import type { CardInstance, GameState, ViewCard } from '../game/types.ts';
import { isHidden } from '../game/types.ts';
import { getScript, parseParams, scriptFaceOf } from './script.ts';
import { matchCard, type MatchEnv } from './targets.ts';
import type { CastInfo, TimedEffect } from './types.ts';
import { type OptionDef, parseCost } from './costs.ts';

/** The parts of a GameState / GameView permissions read. */
export type PermState = Pick<GameState, 'battlefield' | 'players' | 'activePlayer' | 'turn'> & {
  cards: Record<string, CardInstance | ViewCard>;
  effects?: TimedEffect[];
  turnInfo?: GameState['turnInfo'];
  turnStats?: GameState['turnStats'];
};

export interface PlayPermission {
  /** Identifies the permission (MayPlayLimit$ bookkeeping). */
  key: string;
  /** Where it comes from, for the cast option label ("Light Up the Stage", "Lurrus of the Dream-Den" ...). */
  source: string;
  /** Without paying its mana cost. */
  free?: boolean;
  /** Spend mana as though it were mana of any color / type: the colored symbols become generic. */
  anyColor?: boolean;
  /** Pay this (Forge cost, e.g. "PayLife<3>") instead of the mana cost (Bolas's Citadel). */
  altCost?: string;
  /** Additional cost (Forge cost: retrace's "Discard<1/Land>", escape's "ExileFromGrave<3/Card.Other>"). */
  extraCost?: string;
  /** Costs {N} more (Elite Spellbinder). */
  raise?: number;
  /** Pay this mana cost rather than the card's (airbend: {2}). */
  manaCost?: string;
  /** Exiled when it leaves the stack (flashback / escape). */
  exileOnLeave?: boolean;
  /** Only lands / only nonland cards. */
  lands?: 'only' | 'never';
  /** Uses left this turn (MayPlayLimit$), undefined = unlimited. */
  limited?: boolean;
  /** Cast as this face only (a card on an adventure: the creature, face 0). */
  face?: number;
  /** Cast-info flags for the spell (escape ...). */
  flags?: Partial<CastInfo>;
}

const ZONE: Record<string, string> = { Battlefield: 'battlefield', Graveyard: 'graveyard', Exile: 'exile', Library: 'library', Hand: 'hand', Command: 'command', Stack: 'stack' };

function zonesOf(v: string | undefined): string[] {
  return (v ?? 'Battlefield').split(',').map((z) => ZONE[z.trim()] ?? z.trim().toLowerCase());
}

function visible(st: PermState, iid: string | undefined): CardInstance | undefined {
  const c = iid ? st.cards[iid] : undefined;
  return c && !isHidden(c) ? c : undefined;
}

/** Cards a permanent exiled "until it leaves" / remembered (Valki's exiled creatures, Tibalt's emblem). */
function exiledWith(st: PermState, host: string | undefined): string[] {
  if (!host) return [];
  const out: string[] = [];
  for (const e of st.effects ?? []) if (e.kind === 'exiled' && e.hostIid === host) out.push(...e.cards.map((x) => x.iid));
  return out;
}

/** Valid$ with TopLibrary / ExiledWith* handled here (targets.ts has no game state). */
function matches(st: PermState, c: CardInstance, valid: string, env: MatchEnv, host?: string): boolean {
  const alts = valid.split(',').map((alt) => {
    let ok = true;
    const cleaned = alt.replace(/\+?TopLibrary/g, () => {
      const owner = st.players.find((p) => p.pid === c.owner);
      if (c.zone !== 'library' || owner?.zones.library[0] !== c.iid) ok = false;
      return '';
    }).replace(/\+?(ExiledWithEffectSource|ExiledWithSource)/g, () => {
      if (!(env.remembered ?? []).includes(c.iid) && !exiledWith(st, host).includes(c.iid)) ok = false;
      return '';
    }).replace(/\.$/, '');
    return ok ? cleaned : null;
  }).filter((x): x is string => !!x);
  if (!alts.length) return false;
  return matchCard(c, alts.join(','), env) === true;
}

function condition(st: PermState, p: Record<string, string>, controller: string): boolean {
  if (p.Condition === 'PlayerTurn' && st.activePlayer !== controller) return false;
  if (p.Condition === 'NotPlayerTurn' && st.activePlayer === controller) return false;
  return true;
}

function usedThisTurn(st: PermState, key: string): number {
  if (!st.turnInfo || st.turnInfo.turn !== st.turn) return 0;
  return st.turnInfo.activations[`perm|${key}`] ?? 0;
}

/** Permission details from one MayPlay static. */
function fromStatic(p: Record<string, string>, key: string, source: string, c: CardInstance, lookup: Lookup): PlayPermission {
  const perm: PlayPermission = { key, source };
  const desc = p.Description ?? '';
  if (p.MayPlayWithoutManaCost === 'True' || /without paying (its|their) mana costs?/i.test(desc)) perm.free = true;
  if (p.MayPlayIgnoreColor === 'True' || p.MayPlayIgnoreType === 'True' || /as though it were mana of any (color|type)/i.test(desc)) perm.anyColor = true;
  if (p.MayPlayAltManaCost) {
    const mv = c.cardId ? lookup(c.cardId)?.cmc ?? 0 : 0;
    perm.altCost = p.MayPlayAltManaCost.replace(/ConvertedManaCost/g, String(mv));
  }
  if (p.MayPlayLimit) perm.limited = true;
  if (/^Land\b/.test(p.Affected ?? '') && !/,/.test(p.Affected ?? '')) perm.lands = 'only';
  if (/\+nonLand|\.nonLand/.test(p.Affected ?? '') && !/Land\./.test(p.Affected ?? '')) perm.lands = 'never';
  return perm;
}

/** Keyword grants to cards in a graveyard (AddKeyword$ Retrace / Escape:... / Flashback) as permissions. */
function fromKeyword(kw: string, key: string, source: string): PlayPermission | undefined {
  const k = kw.trim();
  if (k === 'Retrace') return { key, source: `retrace — ${source}`, extraCost: 'Discard<1/Land/land card>', lands: 'never' };
  if (k === 'Airbend') return { key, source: `airbend — ${source}`, manaCost: '{2}' };
  if (k === 'Flashback') return { key, source: `flashback — ${source}`, exileOnLeave: true, lands: 'never' };
  const esc = /^Escape:CardManaCost\s*(.*)$/.exec(k);
  if (esc) return { key, source: `escape — ${source}`, extraCost: esc[1].trim(), exileOnLeave: true, flags: { escaped: true }, lands: 'never' };
  return undefined;
}

/**
 * Every permission `pid` has to play card `iid` from where it is now (not the hand). Works on a GameView too
 * (hidden cards have none).
 */
export function playPermissions(st: PermState, pid: string, iid: string, lookup: Lookup = getCard): PlayPermission[] {
  const c = visible(st, iid);
  const out: PlayPermission[] = [];
  if (!c || c.zone === 'hand' || c.zone === 'battlefield' || c.zone === 'stack') return out;
  // A card on an adventure: its owner may cast the creature.
  const data = c.cardId ? lookup(c.cardId) : undefined;
  if (c.zone === 'exile' && c.owner === pid && c.castAs && data?.layout === 'adventure') out.push({ key: `adventure|${c.iid}`, source: 'on an adventure', face: 0 });

  // Effect records.
  for (const e of st.effects ?? []) {
    if (e.kind === 'grant') {
      if (e.iid === c.iid && e.controller === pid && e.zone === c.zone) { const g = fromKeyword(e.keyword, `grant|${e.id}`, e.source); if (g) out.push(g); }
      continue;
    }
    if (e.kind !== 'effect') continue;
    const f = getScript(e.cardId)?.[e.face];
    if (!f) continue;
    let raise = 0;
    const perms: PlayPermission[] = [];
    for (const name of e.statics) {
      const line = f.svars[name];
      if (!line) continue;
      const p = parseParams(line).params;
      const env: MatchEnv = { controller: e.controller, sourceIid: e.hostIid, lookup, remembered: e.remembered };
      if (p.Mode === 'RaiseCost' && /IsRemembered/.test(p.ValidCard ?? '') && e.remembered.includes(c.iid)) raise += parseInt(p.Amount ?? '0', 10) || 0;
      if (p.Mode !== 'Continuous') continue;
      if (!zonesOf(p.AffectedZone).includes(c.zone)) continue;
      const who = p.MayPlayPlayer === 'CardOwner' ? c.owner : e.controller;
      if (who !== pid || !condition(st, p, e.controller)) continue;
      if (p.Affected && !matches(st, c, p.Affected, env, e.hostIid)) continue;
      if (p.MayPlay === 'True') perms.push(fromStatic(p, `effect|${e.id}|${name}`, e.name, c, lookup));
      for (const kw of (p.AddKeyword ?? '').split('&')) { const g = fromKeyword(kw, `effect|${e.id}|${name}`, e.name); if (g) perms.push(g); }
    }
    for (const perm of perms) out.push(raise ? { ...perm, raise } : perm);
  }

  // Permanents' statics.
  for (const hid of st.battlefield) {
    const host = visible(st, hid);
    if (!host || host.faceDown || host.controller !== pid) continue;
    const f = scriptFaceOf(host);
    if (!f) continue;
    f.statics.forEach((line, k) => {
      const p = parseParams(line).params;
      if (p.Mode !== 'Continuous' || !zonesOf(p.AffectedZone).includes(c.zone)) return;
      if (!condition(st, p, host.controller)) return;
      const env: MatchEnv = { controller: host.controller, sourceIid: host.iid, lookup };
      if (p.Affected && !matches(st, c, p.Affected, env, host.iid)) return;
      const key = `static|${host.iid}|${k}`;
      const source = cardName(host, lookup);
      if (p.MayPlay === 'True') {
        const perm = fromStatic(p, key, source, c, lookup);
        if (perm.limited && usedThisTurn(st, key) >= (parseInt(p.MayPlayLimit, 10) || 1)) return;
        out.push(perm);
      }
      for (const kw of (p.AddKeyword ?? '').split('&')) { const g = fromKeyword(kw, key, source); if (g) out.push(g); }
    });
  }
  const isLand = !!data && (data.types.includes('Land') && data.layout !== 'modal_dfc');
  return out.filter((perm) => !(perm.lands === 'only' && !isLand) && !(perm.lands === 'never' && isLand));
}

/**
 * "You may look at the top card of your library any time" (Bolas's Citadel, MayLookAt$ You) / "Play with the top card of your
 * library revealed" (Courser of Kruphix, Oracle of Mul Daya, MayLookAt$ Player): can `viewer` see library card `iid`?
 */
export function topCardVisible(st: PermState, viewer: string | null, iid: string, lookup: Lookup = getCard): boolean {
  const c = st.cards[iid];
  if (!c || isHidden(c) || c.zone !== 'library') return false;
  const owner = st.players.find((p) => p.pid === c.owner);
  if (owner?.zones.library[0] !== iid) return false;
  for (const hid of st.battlefield) {
    const host = visible(st, hid);
    if (!host || host.faceDown || host.controller !== c.owner) continue;
    for (const line of scriptFaceOf(host)?.statics ?? []) {
      const p = parseParams(line).params;
      if (!p.MayLookAt || !zonesOf(p.AffectedZone).includes('library')) continue;
      if (p.MayLookAt === 'Player' || viewer === c.owner) return true;
    }
  }
  void lookup;
  return false;
}

/** Can `pid` play / cast this card from where it is (hand: always)? For the strict-mode castability check and land plays. */
export function mayPlayFrom(st: PermState, pid: string, iid: string, lookup: Lookup = getCard): boolean {
  const c = visible(st, iid);
  if (!c) return false;
  if (c.zone === 'hand') return c.owner === pid;
  return playPermissions(st, pid, iid, lookup).length > 0;
}

/** "{2}{U}{U}" -> "{4}" (spend mana as though it were mana of any color). */
export function anyColorCost(cost: string): string {
  let generic = 0;
  const rest: string[] = [];
  for (const m of cost.match(/\{[^}]+\}/g) ?? []) {
    const s = m.slice(1, -1);
    if (/^\d+$/.test(s)) generic += parseInt(s, 10);
    else if (s === 'X') rest.push(s);
    else if (/^[WUBRGC]$/.test(s) || s.includes('/')) generic += s.startsWith('2/') ? 2 : 1;
    else rest.push(s);
  }
  return [...rest, ...(generic ? [String(generic)] : [])].map((s) => `{${s}}`).join('');
}

/** "{1}{U}" + 2 -> "{3}{U}". */
export function raiseGeneric(cost: string, n: number): string {
  if (!n) return cost;
  let generic = 0;
  const rest: string[] = [];
  for (const m of cost.match(/\{[^}]+\}/g) ?? []) {
    const s = m.slice(1, -1);
    if (/^\d+$/.test(s)) generic += parseInt(s, 10); else rest.push(s);
  }
  return [String(generic + n), ...rest].map((s) => `{${s}}`).join('');
}

/** Record that a limited permission was used (called for each spell cast / land played with one). */
export function notePermissionUse(state: GameState, key: string | undefined) {
  if (!key) return;
  if (!state.turnInfo || state.turnInfo.turn !== state.turn) state.turnInfo = { turn: state.turn, leftBattlefield: [], loyaltyUsed: [], activations: {} };
  state.turnInfo.activations[`perm|${key}`] = (state.turnInfo.activations[`perm|${key}`] ?? 0) + 1;
}

/** Which permission a cast from a non-hand zone uses (first one that applies), or undefined. */
export function bestPermission(st: PermState, pid: string, iid: string, face: number | undefined, lookup: Lookup = getCard): PlayPermission | undefined {
  const perms = playPermissions(st, pid, iid, lookup).filter((p) => p.face == null || (face ?? 0) === p.face);
  // Prefer free, then no extra cost.
  return perms.sort((a, b) => Number(!!b.free) - Number(!!a.free) || Number(!!a.extraCost) - Number(!!b.extraCost))[0];
}

// ------------------------------------------------------------------ cast options (costs.ts)

/** Cast options that carry their own zone requirement (they don't need a permission). */
const OWN_ZONE_OPTIONS = new Set(['flashback', 'escape', 'madness', 'evoke', 'dash', 'overload', 'spectacle', 'surge', 'miracle', 'faceDown']);

const ZONE_WORD: Record<string, string> = { graveyard: 'your graveyard', exile: 'exile', library: 'your library', command: 'the command zone', sideboard: 'your sideboard' };

/**
 * Called by costs.ts for every cast option of a card: outside the hand, options need a permission (else they are
 * unavailable) and the permission changes their cost.
 */
export function applyPermissions(st: GameState, c: CardInstance, pid: string, face: number | undefined, defs: OptionDef[], lookup: Lookup) {
  if (c.zone === 'hand' || c.zone === 'battlefield' || c.zone === 'stack') return;
  const perm = bestPermission(st, pid, c.iid, face, lookup);
  const where = ZONE_WORD[c.zone] ?? c.zone;
  for (const d of defs) {
    d.flags = { ...d.flags, from: c.zone };
    if (OWN_ZONE_OPTIONS.has(d.id)) continue;
    if (!perm) { d.unavailable ??= `You can't cast it from ${where}`; continue; }
    let mana = d.mana;
    if (perm.free || perm.altCost) mana = d.kicker?.mana ?? '';
    if (perm.manaCost) mana = perm.manaCost + (d.kicker?.mana ?? '');
    if (perm.anyColor) mana = anyColorCost(mana);
    if (perm.raise) mana = raiseGeneric(mana, perm.raise);
    d.mana = mana;
    const extra = [perm.altCost, perm.extraCost].filter((x): x is string => !!x).flatMap((x) => parseCost(x).parts);
    if (extra.length) d.parts = [...d.parts, ...extra];
    d.flags = { ...d.flags, ...(perm.flags ?? {}), ...(perm.exileOnLeave ? { exileOnLeave: true } : {}), ...(perm.limited ? { permission: perm.key } : {}) };
    d.label = `${d.label} (${perm.source}${perm.free ? ', free' : ''}${perm.anyColor ? ', any color' : ''})`;
  }
}
