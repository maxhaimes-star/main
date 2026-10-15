/**
 * Activated abilities granted by other objects' statics (AddAbility$): Splinter Twin's "{T}: create a token copy",
 * Koth's emblem ("Mountains you control have '{T}: This land deals 1 damage to any target'"), Goldspan Dragon's
 * Treasures. The ability's script lives on the granting card, so it gets an index of its own on the permanent
 * (FOREIGN_BASE + n, in the order foreignAbilities lists them); activating it puts an ability on the stack whose
 * AutoInfo points at the granting card's SVar (GRANT_BASE + SVar index) with the permanent as its source.
 * Granted mana abilities aren't included (they'd need mana.ts).
 */
import type { Lookup } from '../game/rules.ts';
import type { CardInstance } from '../game/types.ts';
import { type ActivatedEntry, activatedAbilitiesOf, GRANT_BASE, getScript, parseAbility, scriptRef, parseParams } from './script.ts';
import { matchCard } from './targets.ts';
import { abilityGrants, type StaticsState } from './statics.ts';

export const FOREIGN_BASE = 4000;

export interface ForeignAbility extends ActivatedEntry {
  /** Script holding the ability's SVar, and its index there (GRANT_BASE + SVar index). */
  cardId: string;
  face: number;
  scriptIndex: number;
  /** Granting object (card iid or "effect:<id>"). */
  grantor: string;
}

/** Abilities other objects grant to permanent `iid`. */
export function foreignAbilities(st: StaticsState, iid: string, lookup: Lookup): ForeignAbility[] {
  const c = st.cards[iid] as CardInstance | undefined;
  if (!c || c.zone !== 'battlefield') return [];
  const out: ForeignAbility[] = [];
  let grants: ReturnType<typeof abilityGrants>;
  try { grants = abilityGrants(st, lookup); } catch { return []; }
  const effects = ((st as { effects?: { kind: string; id: string; cardId?: string; face?: number }[] }).effects ?? []);
  for (const { s, iids } of grants) {
    if (!iids.includes(iid)) continue;
    let ref: { cardId: string; face: number } | undefined;
    if (s.sourceIid.startsWith('effect:')) {
      const e = effects.find((x) => x.kind === 'effect' && `effect:${x.id}` === s.sourceIid);
      if (e?.cardId) ref = { cardId: e.cardId, face: e.face ?? 0 };
    } else {
      const src = st.cards[s.sourceIid] as CardInstance | undefined;
      ref = src ? scriptRef(src) : undefined;
    }
    const f = ref ? getScript(ref.cardId)?.[ref.face] : undefined;
    if (!ref || !f) continue;
    const keys = Object.keys(f.svars);
    for (const name of (s.params.AddAbility ?? '').split('&').map((x) => x.trim()).filter(Boolean)) {
      const line = f.svars[name];
      const k = keys.indexOf(name);
      if (!line || k < 0 || !/^\s*AB\$/.test(line) || /^\s*AB\$\s*Mana\b/.test(line)) continue;
      const ability = parseAbility(line, f.svars, f.name);
      if (!ability) continue;
      out.push({ index: FOREIGN_BASE + out.length, ability, cost: ability.params.Cost ?? '', cardId: ref.cardId, face: ref.face, scriptIndex: GRANT_BASE + k, grantor: s.sourceIid });
    }
  }
  // Activated abilities of cards exiled with Agatha's Soul Cauldron (their own A: lines, the permanent as the source).
  for (const card of gainedFrom(st, iid, lookup, grants)) {
    for (const e of activatedAbilitiesOf(card.cardId!, 0)) {
      if (e.zone || e.index >= GRANT_BASE) continue;
      out.push({ ...e, index: FOREIGN_BASE + out.length, cardId: card.cardId!, face: 0, scriptIndex: e.index, grantor: card.iid });
    }
  }
  return out;
}

/**
 * Triggered abilities other permanents grant to permanent `iid` (S:Mode$ Continuous | AddTrigger$: Kaldra Compleat's
 * equipped creature, Nadu's creatures). `ref` is the granting card's script (the Execute$ chain's SVars); "Self" in
 * the trigger is the permanent that has it. Indexes start at 700.
 */
export function foreignTriggers(st: StaticsState, iid: string, lookup: Lookup): { index: number; params: Record<string, string>; ref: { cardId: string; face: number } }[] {
  const c = st.cards[iid] as CardInstance | undefined;
  if (!c || c.zone !== 'battlefield') return [];
  let grants: ReturnType<typeof abilityGrants>;
  try { grants = abilityGrants(st, lookup); } catch { return []; }
  const out: { index: number; params: Record<string, string>; ref: { cardId: string; face: number } }[] = [];
  for (const { s, iids } of grants) {
    if (!s.params.AddTrigger || !iids.includes(iid) || s.sourceIid.startsWith('effect:')) continue;
    const src = st.cards[s.sourceIid] as CardInstance | undefined;
    const ref = src ? scriptRef(src) : undefined;
    const f = ref ? getScript(ref.cardId)?.[ref.face] : undefined;
    if (!ref || !f) continue;
    for (const name of s.params.AddTrigger.split('&').map((x) => x.trim())) {
      const line = f.svars[name];
      if (line) out.push({ index: 700 + out.length, params: parseParams(line).params, ref });
    }
  }
  return out;
}

/** Mana abilities other objects grant to permanent `iid` (Joraga Treespeaker's Elves, Goldspan Dragon's Treasures), for mana.ts. */
export function foreignManaLines(st: StaticsState, iid: string, lookup: Lookup): { line: string; id: string; svars: Record<string, string>; name: string }[] {
  const c = st.cards[iid] as CardInstance | undefined;
  if (!c || c.zone !== 'battlefield') return [];
  const out: { line: string; id: string; svars: Record<string, string>; name: string }[] = [];
  let grants: ReturnType<typeof abilityGrants>;
  try { grants = abilityGrants(st, lookup); } catch { return []; }
  for (const { s, iids } of grants) {
    if (!iids.includes(iid) || s.sourceIid.startsWith('effect:')) continue;
    const src = st.cards[s.sourceIid] as CardInstance | undefined;
    const ref = src ? scriptRef(src) : undefined;
    const f = ref ? getScript(ref.cardId)?.[ref.face] : undefined;
    if (!f) continue;
    for (const name of (s.params.AddAbility ?? '').split('&').map((x) => x.trim())) {
      const line = f.svars[name];
      if (line && /^\s*AB\$\s*Mana\b/.test(line)) out.push({ line, id: `g:${s.sourceIid}:${name}`, svars: f.svars, name: f.name });
    }
  }
  // Mana abilities of creature cards exiled with Agatha's Soul Cauldron.
  for (const card of gainedFrom(st, iid, lookup, grants)) {
    const f = getScript(card.cardId!)?.[0];
    f?.abilities.forEach((line, k) => { if (/^\s*AB\$\s*Mana\b/.test(line)) out.push({ line, id: `x:${card.iid}:${k}`, svars: f.svars, name: f.name }); });
  }
  return out;
}

/**
 * GainsAbilitiesOf$ (Agatha's Soul Cauldron: "creatures you control with +1/+1 counters on them have all activated
 * abilities of all creature cards exiled with CARDNAME"): the cards whose activated abilities `iid` gains.
 */
function gainedFrom(st: StaticsState, iid: string, lookup: Lookup, grants: ReturnType<typeof abilityGrants>): CardInstance[] {
  const out: CardInstance[] = [];
  const mem = (st as { remembered?: Record<string, string[]> }).remembered ?? {};
  for (const { s, iids } of grants) {
    if (!s.params.GainsAbilitiesOf || !iids.includes(iid) || s.sourceIid.startsWith('effect:')) continue;
    if ((s.params.GainsAbilitiesOfZones ?? 'Exile') !== 'Exile') continue;
    const valid = s.params.GainsAbilitiesOf.replace(/\.ExiledWithSource$|\+ExiledWithSource/, '');
    for (const x of [...(mem[`exiled|${s.sourceIid}`] ?? []), ...(mem[s.sourceIid] ?? [])]) {
      const card = st.cards[x] as CardInstance | undefined;
      if (!card || card.zone !== 'exile' || !card.cardId || out.includes(card)) continue;
      if (matchCard(card, valid, { controller: s.controller, sourceIid: s.sourceIid, lookup }) !== true) continue;
      out.push(card);
    }
  }
  return out;
}

/** The foreign ability with index `index` on `iid`, if granted right now. */
export function foreignAbility(st: StaticsState, iid: string, index: number, lookup: Lookup): ForeignAbility | undefined {
  if (index < FOREIGN_BASE) return undefined;
  return foreignAbilities(st, iid, lookup).find((a) => a.index === index);
}
