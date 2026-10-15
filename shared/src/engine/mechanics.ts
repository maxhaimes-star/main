import { TRIGGER_KEYWORDS } from './kwtriggers.ts';

/**
 * Keyword mechanics (Forge K: lines): which ones the engine handles, for coverage tools.
 */

/** K: keywords the engine handles automatically (combat keywords, cast options, synthesized abilities / triggers ...). */
export const HANDLED_KEYWORDS = new Set([
  'Flying', 'Flash', 'Haste', 'Trample', 'Lifelink', 'Deathtouch', 'Vigilance', 'First Strike', 'Double Strike', 'Indestructible',
  'Reach', 'Shroud', 'Hexproof', 'Defender', 'Infect', 'Prowess', 'Menace', 'Shadow', 'Landwalk', 'Protection', 'Ward', 'Ascend',
  'Cycling', 'TypeCycling', 'Equip', 'Reconfigure', 'Level up', 'Crew', 'Ninjutsu', 'Chapter', 'Hideaway',
  'ETBReplacement', 'etbCounter', 'Enchant',
  'Flashback', 'Evoke', 'Overload', 'Kicker', 'Escape', 'Dash', 'Buyback', 'Delve', 'Surge',
  // Strict auto-pay taps untapped artifacts for generic mana (engine/strict.ts castHelp).
  'Improvise',
  // Triggered keywords synthesized as triggers (engine/kwtriggers.ts), rebound (resolve.ts).
  ...TRIGGER_KEYWORDS,
  // Splice onto Arcane: the cube's only Arcane spell is Through the Breach itself, so there is nothing to splice onto.
  'Splice',
  // No effect in a two-player cube game.
  'Companion', 'CARDNAME can be your commander.', 'Choose a Background', 'MayEffectFromOpeningDeck',
]);

/** Why a K: line isn't handled automatically (null = handled). */
export function keywordGap(k: string): string | null {
  const head = k.split(':')[0].trim();
  if (HANDLED_KEYWORDS.has(head) || /^Protection from /.test(head)) return null;
  return head;
}
