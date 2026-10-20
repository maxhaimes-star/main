/**
 * Cast-option keywords (costs.ts optionDefs hook): conditions and variants the plain option table can't express.
 *  - Spectacle (an opponent lost life this turn), Surge (you cast another spell this turn): availability.
 *  - Miracle / Madness: cast through their triggers (engine/triggers.ts miracle(), replacements' madness), not directly.
 *  - AlternateAdditionalCost:A:B (Bone Shards, Bitter Triumph): pay either additional cost — two options.
 *  - Multikicker:cost / Replicate:cost: options paying the extra cost 1-4 times (CastInfo.timesKicked / replicated).
 *  - Mayhem:cost: cast from your graveyard if you discarded it this turn.
 *  - MayFlashSac (Necromancy): flash, sacrificed at the next cleanup if cast when a sorcery couldn't have been.
 *  - Escalate:cost: the extra cost for each mode beyond the first (planCast hook escalateParts).
 */
import type { Lookup } from '../game/rules.ts';
import type { CardInstance, GameState } from '../game/types.ts';
import type { CostPart, OptionDef } from './costs.ts';
import { turnInfo } from './durations.ts';
import { getScript } from './script.ts';

type ParseCost = (cost: string, selfName?: string) => { mana: string; parts: CostPart[] };

const MAX_TIMES = 4;

function kwArgs(keywords: readonly string[], head: string): string[][] {
  return keywords.filter((k) => k.split(':')[0].trim() === head).map((k) => k.split(':').slice(1));
}

/** Did `pid` discard `iid` this turn (Mayhem)? */
export function discardedThisTurn(state: GameState, iid: string): boolean {
  return (turnInfo(state).activations[`discarded|${iid}`] ?? 0) > 0;
}

function sorceryTiming(state: GameState, pid: string): boolean {
  return state.activePlayer === pid && (state.step === 'main1' || state.step === 'main2') && state.stack.length === 0;
}

/** Adjust / add cast options for keyword costs. */
export function applyCastKeywords(state: GameState, c: CardInstance, pid: string, face: number | undefined, defs: OptionDef[], name: string, parseCost: ParseCost, _lookup: Lookup) {
  const script = c.cardId ? getScript(c.cardId)?.[face ?? 0] : undefined;
  const kws = script?.keywords ?? [];
  const ti = turnInfo(state);
  const dropNote = (d: OptionDef) => { d.parts = d.parts.filter((p) => !(p.kind === 'other' && p.n === '0')); };
  for (const d of defs) {
    if (d.id === 'spectacle') {
      dropNote(d);
      const lost = state.players.some((p) => p.pid !== pid && (ti.activations[`life-|${p.pid}`] ?? 0) > 0);
      if (!lost && !d.unavailable) d.unavailable = 'Spectacle: no opponent lost life this turn';
    }
    if (d.id === 'surge') {
      dropNote(d);
      if (!((state.turnStats?.cast[pid] ?? 0) > 0) && !d.unavailable) d.unavailable = "Surge: you haven't cast another spell this turn";
    }
    if (d.id === 'miracle') { dropNote(d); d.unavailable = 'Miracle: cast it as you draw it (the miracle trigger offers it)'; }
    if (d.id === 'madness') { dropNote(d); d.unavailable = 'Madness: cast it as you discard it (the madness trigger offers it)'; }
  }
  const normal = defs.find((d) => d.id === 'normal');
  // AlternateAdditionalCost:A:B
  for (const [a, b] of kwArgs(kws, 'AlternateAdditionalCost')) {
    if (!normal || !a || !b) continue;
    const ca = parseCost(a, name), cb = parseCost(b, name);
    const alt: OptionDef = { ...normal, id: 'altadd', label: `Cast (${cb.parts.map((p) => p.text).join(', ') || cb.mana})`, mana: normal.mana + cb.mana, parts: [...normal.parts, ...cb.parts], flags: { ...normal.flags } };
    normal.label = `Cast (${ca.parts.map((p) => p.text).join(', ') || ca.mana})`;
    normal.mana += ca.mana;
    normal.parts = [...normal.parts, ...ca.parts];
    defs.push(alt);
  }
  // Multikicker / Replicate: pay the extra cost N times.
  for (const [head, flag] of [['Multikicker', 'timesKicked'], ['Replicate', 'replicated']] as const) {
    for (const [cost] of kwArgs(kws, head)) {
      if (!normal || !cost) continue;
      const k = parseCost(cost, name);
      for (let n = 1; n <= MAX_TIMES; n++) {
        defs.push({
          ...normal, id: `${head.toLowerCase()}${n}`, label: `${head} ×${n}`, mana: normal.mana + k.mana.repeat(n),
          parts: [...normal.parts, ...Array.from({ length: n }, () => k.parts).flat()],
          flags: { ...normal.flags, ...(flag === 'timesKicked' ? { kicked: true, timesKicked: n } : { replicated: n }) },
        });
      }
    }
  }
  // Mayhem: from the graveyard, if you discarded it this turn.
  for (const [cost] of kwArgs(kws, 'Mayhem')) {
    if (!cost) continue;
    const k = parseCost(cost, name);
    const d: OptionDef = { id: 'mayhem', label: 'Mayhem', mana: k.mana, parts: [...(normal?.parts ?? []), ...k.parts], flags: { from: 'graveyard' }, delve: !!normal?.delve };
    if (c.zone !== 'graveyard') d.unavailable = 'Mayhem only from your graveyard';
    else if (!discardedThisTurn(state, c.iid)) d.unavailable = "Mayhem: you didn't discard it this turn";
    defs.push(d);
  }
  // Foretell: from exile (foretold on an earlier turn) for the foretell cost.
  for (const [cost] of kwArgs(kws, 'Foretell')) {
    if (!cost) continue;
    const k = parseCost(cost, name);
    const when = state.remembered?.[`foretold|${c.iid}`]?.[0];
    const d: OptionDef = { id: 'foretell', label: 'Foretell', mana: k.mana, parts: [...(normal?.parts ?? []), ...k.parts], flags: { from: 'exile' }, delve: !!normal?.delve };
    if (c.zone !== 'exile' || when == null) d.unavailable = 'Foretell: foretell it first (exile it face down from your hand during your turn)';
    else if (parseInt(when, 10) >= state.turn) d.unavailable = "Foretell: you can't cast it the turn you foretold it";
    defs.push(d);
  }
  // MayFlashSac: cast at instant speed, sacrificed at the next cleanup step.
  if (kws.includes('MayFlashSac') && normal && !sorceryTiming(state, pid)) normal.flags = { ...normal.flags, flashSac: true };
}

/** Escalate: the extra cost for each mode beyond the first. */
export function escalateParts(c: CardInstance, modes: string[] | undefined, name: string, parseCost: ParseCost): { mana: string; parts: CostPart[] } | undefined {
  const script = c.cardId ? getScript(c.cardId)?.[0] : undefined;
  const [args] = kwArgs(script?.keywords ?? [], 'Escalate');
  if (!args?.[0] || !modes || modes.length < 2) return undefined;
  const k = parseCost(args[0], name);
  const n = modes.length - 1;
  return { mana: k.mana.repeat(n), parts: Array.from({ length: n }, () => k.parts).flat() };
}

/** MayFlashSac: may this card be cast at instant speed? */
export function mayFlash(c: CardInstance): boolean {
  return !!c.cardId && !!getScript(c.cardId)?.[0]?.keywords.includes('MayFlashSac');
}
