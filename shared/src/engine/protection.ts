/**
 * Protection, player keywords and evasion:
 *  - protection from <quality> (Forge K:Protection:<valid>:<text>, "Protection from white", granted by statics /
 *    Pump KW / Protection effects, True-Name Nemesis' chosen player): can't be targeted, blocked or dealt damage
 *    by sources with that quality (targets.ts, statics.ts blockRestriction, damage in resolve.ts / combat.ts).
 *  - player keywords: "You have shroud / hexproof / protection from everything" (Solitary Confinement statics,
 *    The One Ring's Pump Defined$ You -> a 'playerKw' TimedEffect).
 *  - evasion for blocks: flying / reach, menace (checked for the whole block), shadow, landwalk, fear, intimidate,
 *    "can't be blocked".
 */
import { faceOf, hasKeyword, isCreature, type Lookup } from '../game/rules.ts';
import type { CardInstance, GameState, ViewCard } from '../game/types.ts';
import { isHidden } from '../game/types.ts';
import { scriptFaceOf } from './script.ts';
import { staticMods, type StaticsState } from './statics.ts';
import { matchCard } from './targets.ts';

type St = StaticsState & { effects?: GameState['effects']; activePlayer?: string };

function visible(st: St, iid: string | undefined): CardInstance | undefined {
  const c = iid ? (st.cards[iid] as CardInstance | ViewCard | undefined) : undefined;
  return c && !isHidden(c) ? c : undefined;
}

const QUALITY: Record<string, string> = {
  white: 'Card.White', blue: 'Card.Blue', black: 'Card.Black', red: 'Card.Red', green: 'Card.Green', everything: 'Card', creatures: 'Creature',
  instants: 'Instant', sorceries: 'Sorcery', artifacts: 'Artifact', enchantments: 'Enchantment', planeswalkers: 'Planeswalker', multicolored: 'Card.MultiColor',
  monocolored: 'Card.MonoColor', colorless: 'Card.Colorless', 'colored spells': 'Card.nonColorless', 'each color': 'Card.nonColorless', 'all colors': 'Card.nonColorless',
};

/** A protection keyword -> Forge valid for the sources it protects from (or a player rule). */
export function protectionQuality(kw: string): string | undefined {
  const k = kw.trim();
  let m = /^Protection:([^:]+)(?::.*)?$/.exec(k);
  if (m) return m[1].replace(/^Spell\./, 'Card.');
  m = /^Protection from (.+)$/i.exec(k);
  if (m) return QUALITY[m[1].trim().toLowerCase()] ?? `Card.${m[1].trim().replace(/s$/, '').replace(/^./, (x) => x.toUpperCase())}`;
  return undefined;
}

/** All protection qualities of a permanent right now. */
export function protectionsOf(st: St, c: CardInstance, lookup: Lookup): string[] {
  if (c.faceDown) return [];
  const kws: string[] = [...(scriptFaceOf(c)?.keywords ?? []), ...(c.tempKeywords ?? [])];
  for (const a of c.animations ?? []) kws.push(...(a.keywords ?? []));
  const mods = c.zone === 'battlefield' ? staticMods(st, c.iid, lookup) : undefined;
  if (mods) kws.push(...mods.addKw);
  // Its own "has protection from the chosen player" static (True-Name Nemesis): statics.ts can't carry a keyword
  // that depends on a choice, so it is read here.
  if (c.zone === 'battlefield') {
    for (const line of scriptFaceOf(c)?.statics ?? []) {
      if (!/AffectedDefined\$\s*Self\b/.test(line)) continue;
      const kw = /AddKeyword\$\s*(Protection:[^|]*ChosenPlayer[^|]*)/.exec(line)?.[1];
      if (kw) kws.push(kw.trim());
    }
  }
  const f = faceOf(c, lookup);
  for (const m of f.oracle.matchAll(/^Protection from ([\w ,]+?)(?:\s*\(|$)/gim)) kws.push(`Protection from ${m[1]}`);
  const out: string[] = [];
  for (const k of kws) {
    if (!/^Protection/i.test(k)) continue;
    if (/ChosenPlayer/.test(k)) { if (c.chosen?.player) out.push(`player:${c.chosen.player}`); continue; }
    // "Protection from each of your opponents" (Figure of Fable): sources an opponent of its controller controls.
    if (/^Protection:Player\.Opponent\b/.test(k)) { out.push(`opponentOf:${c.controller}`); continue; }
    // "Protection from red and from blue"
    for (const part of k.split(/ and from /i)) { const q = protectionQuality(/^Protection/i.test(part) ? part : `Protection from ${part}`); if (q) out.push(q); }
  }
  return [...new Set(out)];
}

/** Does `quality` protect against `source` (a card on the stack / battlefield)? */
function qualityMatches(st: St, quality: string, source: CardInstance, lookup: Lookup): boolean {
  if (quality.startsWith('player:')) return source.controller === quality.slice(7);
  if (quality.startsWith('opponentOf:')) return source.controller !== quality.slice(11);
  return matchCard(source, quality, { controller: source.controller, sourceIid: source.iid, lookup }) === true;
}

/** Is the permanent `targetIid` protected from `sourceIid`? */
export function protectedFrom(st: St, targetIid: string, sourceIid: string | undefined, lookup: Lookup): boolean {
  const t = visible(st, targetIid);
  const s = visible(st, sourceIid);
  if (!t || !s || t.zone !== 'battlefield') return false;
  return protectionsOf(st, t, lookup).some((q) => qualityMatches(st, q, s, lookup));
}

/** Keywords a player has: statics "You have shroud" (Affected$ You / Player / Opponent) and 'playerKw' effects. */
export function playerKeywords(st: St, pid: string, lookup: Lookup): string[] {
  const out: string[] = [];
  for (const iid of st.battlefield) {
    const c = visible(st, iid);
    if (!c || c.faceDown) continue;
    for (const line of scriptFaceOf(c)?.statics ?? []) {
      if (!/Mode\$ Continuous/.test(line) || !/AddKeyword\$/.test(line)) continue;
      const aff = /Affected\$ ([^|]+)/.exec(line)?.[1].trim();
      if (!aff || !/^(You|Player|Opponent)\b/.test(aff)) continue;
      const mine = c.controller === pid;
      if ((aff.startsWith('You') && !mine) || (aff.startsWith('Opponent') && mine)) continue;
      const kw = /AddKeyword\$ ([^|]+)/.exec(line)![1].split('&').map((k) => k.trim());
      out.push(...kw);
    }
  }
  for (const e of st.effects ?? []) if (e.kind === 'playerKw' && e.pid === pid) out.push(...e.keywords);
  return out;
}

/** Can a spell / ability from `sourceIid` controlled by `controller` target player `pid`? */
export function playerTargetable(st: St, pid: string, controller: string, sourceIid: string | undefined, lookup: Lookup): boolean {
  const kws = playerKeywords(st, pid, lookup);
  if (kws.some((k) => /^Shroud$/i.test(k))) return false;
  if (controller !== pid && kws.some((k) => /^Hexproof$/i.test(k))) return false;
  const s = visible(st, sourceIid);
  for (const k of kws) {
    const q = protectionQuality(k);
    if (q && (q === 'Card' || (s && qualityMatches(st, q, s, lookup)))) return false;
  }
  return true;
}

/** Is damage from `sourceIid` to player `pid` prevented by the player's protection? */
export function playerProtectedFrom(st: St, pid: string, sourceIid: string | undefined, lookup: Lookup): boolean {
  const s = visible(st, sourceIid);
  return playerKeywords(st, pid, lookup).some((k) => { const q = protectionQuality(k); return !!q && (q === 'Card' || (!!s && qualityMatches(st, q, s, lookup))); });
}

// ------------------------------------------------------------------ evasion (blocks)

const BASIC = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];

/** Why `blocker` can't block `attacker` because of evasion / protection (single-blocker rules), or null. */
export function evasionRestriction(st: St, blocker: CardInstance, attacker: CardInstance, lookup: Lookup): string | null {
  const kw = (c: CardInstance, k: string) => hasKeyword(c, lookup, k, st);
  const an = faceOf(attacker, lookup).name;
  if (kw(attacker, 'Flying') && !kw(blocker, 'Flying') && !kw(blocker, 'Reach')) return `${an} has flying`;
  if (kw(attacker, 'Shadow') !== kw(blocker, 'Shadow')) return kw(attacker, 'Shadow') ? `${an} has shadow` : `${faceOf(blocker, lookup).name} has shadow and can only block creatures with shadow`;
  if (kw(attacker, 'Unblockable') || /can't be blocked\.?$/im.test(faceOf(attacker, lookup).oracle.split('\n').find((l) => /^[^(]*can't be blocked\.?$/i.test(l.trim())) ?? '')) return `${an} can't be blocked`;
  if (kw(attacker, 'Fear') && !faceOf(blocker, lookup).types.includes('Artifact') && !(faceOf(blocker, lookup).colors ?? []).includes('B')) return `${an} has fear`;
  if (kw(attacker, 'Intimidate')) {
    const ac = faceOf(attacker, lookup).colors ?? [];
    const bc = faceOf(blocker, lookup).colors ?? [];
    if (!faceOf(blocker, lookup).types.includes('Artifact') && !ac.some((c) => bc.includes(c))) return `${an} has intimidate`;
  }
  // Landwalk: K:Landwalk:<Type> or "swampwalk" in the oracle.
  const walks = [...(scriptFaceOf(attacker)?.keywords ?? []).filter((k) => /^Landwalk:/.test(k)).map((k) => k.split(':')[1]),
    ...[...faceOf(attacker, lookup).oracle.matchAll(/\b(plains|island|swamp|mountain|forest)walk\b/gi)].map((m) => m[1][0].toUpperCase() + m[1].slice(1).toLowerCase())];
  for (const w of walks) {
    const type = BASIC.find((b) => w.includes(b)) ?? w;
    const has = st.battlefield.some((iid) => { const c = visible(st, iid); return !!c && c.controller === blocker.controller && faceOf(c, lookup).typeLine.includes(type); });
    if (has) return `${an} has ${type.toLowerCase()}walk`;
  }
  if (protectedFrom(st, attacker.iid, blocker.iid, lookup)) return `${an} has protection from ${faceOf(blocker, lookup).name}`;
  return null;
}

/** Minimum number of blockers for an attacker (menace: 2; MinMaxBlocker statics). */
export function minBlockers(st: St, attacker: CardInstance, lookup: Lookup): number {
  let n = hasKeyword(attacker, lookup, 'Menace', st) ? 2 : 1;
  for (const iid of st.battlefield) {
    const c = visible(st, iid);
    if (!c) continue;
    for (const line of scriptFaceOf(c)?.statics ?? []) {
      if (!/Mode\$ MinMaxBlocker/.test(line)) continue;
      const valid = /ValidCard\$ ([^|]+)/.exec(line)?.[1].trim();
      const min = parseInt(/Min\$ (\d+)/.exec(line)?.[1] ?? '1', 10);
      if (valid && matchCard(attacker, valid, { controller: c.controller, sourceIid: c.iid, lookup }) === true) n = Math.max(n, min);
    }
  }
  return n;
}

/** Creatures that block alone / too few for an attacker with menace etc. are removed from the block (with the reason). */
export function illegalBlocks(st: St, defender: string, lookup: Lookup): { blocker: string; why: string }[] {
  const out: { blocker: string; why: string }[] = [];
  const byAttacker = new Map<string, string[]>();
  for (const iid of st.battlefield) {
    const c = visible(st, iid);
    if (!c?.blocking || c.controller !== defender) continue;
    byAttacker.set(c.blocking, [...(byAttacker.get(c.blocking) ?? []), iid]);
  }
  for (const [a, bs] of byAttacker) {
    const att = visible(st, a);
    if (!att) continue;
    const min = minBlockers(st, att, lookup);
    if (bs.length < min) for (const b of bs) out.push({ blocker: b, why: `${faceOf(att, lookup).name} can't be blocked except by ${min} or more creatures` });
  }
  return out;
}

/** Is this a creature that could block now (for "must be blocked" style checks)? */
export function canBlockNow(st: St, c: CardInstance, lookup: Lookup): boolean {
  return !c.tapped && isCreature(c, lookup, st);
}
