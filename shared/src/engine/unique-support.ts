/**
 * Static support checks for the "unique / hard cards" effects (engine/unique.ts, engine/turns.ts).
 * Pure (no game-state imports) so script.ts can use it for coverage / unsupportedReason.
 *
 * Effect APIs (executed by unique.ts):
 *   AddTurn        extra turns (Time Warp, Temporal Mastery, Alrund's Epiphany, Emrakul)
 *   Balance        Balance: lands / hand / creatures down to the lowest player's count
 *   Vote           Council's Judgment (each player votes for a permanent; the most-voted ones get the VoteSubAbility)
 *   TwoPiles       Liliana of the Veil's ultimate (the separator splits, the target chooses a pile)
 *   RemoveCounter  Dark Depths, Moonshadow, Coalition Relic-style "remove counters"
 *   ControlPlayer  Mindslaver
 *   Play           Shelldock Isle (hideaway): play the card exiled with the source without paying its mana cost
 *   WinsGame       "you win the game"
 *   Untap / Tap with UntapType$/TapType$ (+ UntapUpTo$): "untap up to N lands" (Time Spiral, Frantic Search, Palinchron)
 *   Dig            on another player's library, one card (Jace, the Mind Sculptor +2)
 *   Animate        (fallback only) Keywords$ / Abilities$ on the source or remembered cards, AtEOT$ (Sneak Attack,
 *                  Through the Breach, Urza's Saga chapters). A full Animate implementation elsewhere takes precedence.
 *   Synthesized (engine-only) APIs: Hideaway, OathOfDruids, SylvanLibrary, SacSelfToken (Dark Depths), SagaLore.
 */
import type { ParsedAbility } from './types.ts';

/** Engine-only APIs used by synthesized trigger lines (turns.ts). */
export const SYNTH_UNIQUE_APIS = new Set(['Hideaway', 'OathOfDruids', 'SylvanLibrary', 'SacSelfToken']);

export const UNIQUE_APIS = new Set([
  'AddTurn', 'Balance', 'Vote', 'TwoPiles', 'RemoveCounter', 'ControlPlayer', 'Play', 'WinsGame', ...SYNTH_UNIQUE_APIS,
]);

/** Counting variables only the unique effects understand (see unique.ts uniqueVar). */
export function uniqueVarSupported(v: string | undefined): boolean {
  if (!v) return false;
  return v === 'Remembered$Amount'
    || /^PlayerCountPlayers\$LowestValidLibrary \S+$/.test(v)
    || /^Count\$Valid \S+\$DifferentCardNames$/.test(v);
}

/** The Dig steps unique.ts runs: one card of a targeted player's library, may go to the bottom (Jace TMS +2). */
export function isPeekOtherDig(step: ParsedAbility): boolean {
  const p = step.params;
  return step.api === 'Dig' && !!p.ValidTgts && (p.DigNum ?? '1') === '1' && p.ChangeNum === 'Any' && p.DestinationZone === 'Library';
}

/** Tap / Untap that chooses permanents of a type ("untap up to three lands"). */
export function isTypedTapChoice(step: ParsedAbility): boolean {
  const p = step.params;
  return (step.api === 'Untap' && !!p.UntapType && !p.ValidTgts) || (step.api === 'Tap' && !!p.TapType && !p.ValidTgts);
}

const ANIMATE_OK = new Set(['Defined', 'Keywords', 'Abilities', 'Duration', 'AtEOT', 'SubAbility', 'SpellDescription', 'StackDescription', 'AILogic']);

/** The narrow Animate cases unique.ts handles as a fallback. */
export function isSimpleAnimate(step: ParsedAbility): boolean {
  const p = step.params;
  if (step.api !== 'Animate') return false;
  if (Object.keys(p).some((k) => !ANIMATE_OK.has(k))) return false;
  if (!p.Keywords && !p.Abilities) return false;
  if (p.AtEOT && p.AtEOT !== 'Sacrifice' && p.AtEOT !== 'Exile') return false;
  if (p.Defined && !['Self', 'Remembered', 'Targeted'].includes(p.Defined)) return false;
  // Abilities$ only on the source itself (Urza's Saga): the granted abilities come from the Saga's chapters (turns.ts).
  if (p.Abilities && (p.Defined ?? 'Self') !== 'Self') return false;
  return true;
}

/**
 * Support check for steps the unique module handles: undefined = not ours, null = supported, string = reason.
 * Called first by script.ts unsupportedReason().
 */
export function uniqueReason(step: ParsedAbility): string | null | undefined {
  const p = step.params;
  if (isTypedTapChoice(step)) return /^[A-Za-z.+]+$/.test((step.api === 'Untap' ? p.UntapType : p.TapType) ?? '') ? null : `${step.api} (choice)`;
  if (isPeekOtherDig(step)) return null;
  if (isSimpleAnimate(step)) return null;
  if (!UNIQUE_APIS.has(step.api)) return undefined;
  switch (step.api) {
    case 'AddTurn': return p.ExtraPhase || p.ExtraStep || p.SkipUntap || p.ExtraTurnDelayedTrigger ? 'AddTurn (special turn)' : null;
    case 'Balance': return p.Zone && p.Zone !== 'Hand' ? `Balance (${p.Zone})` : null;
    case 'Vote': return p.VoteCard && p.VoteSubAbility ? null : 'Vote (choices)';
    case 'TwoPiles': return p.Zone && p.Zone !== 'Battlefield' ? 'TwoPiles (zone)' : null;
    case 'RemoveCounter': return p.CounterType && p.CounterType !== 'Any' ? null : 'RemoveCounter (choice of counter)';
    case 'Play': return p.Defined === 'ExiledWith' || p.Defined === 'Remembered' ? (p.PlayCost ? 'Play (cost)' : null) : 'Play';
    case 'WinsGame': return !p.Defined || p.Defined === 'You' ? null : 'WinsGame';
  }
  return null;
}
