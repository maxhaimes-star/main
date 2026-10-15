/**
 * Keyword mechanics (Forge K: lines): which ones the engine handles, for coverage tools.
 */

/** K: keywords the engine handles automatically (combat keywords, cast options, synthesized abilities / triggers ...). */
export const HANDLED_KEYWORDS = new Set([
  'Flying', 'Flash', 'Haste', 'Trample', 'Lifelink', 'Deathtouch', 'Vigilance', 'First Strike', 'Double Strike', 'Indestructible',
  'Reach', 'Shroud', 'Hexproof', 'Defender', 'Infect', 'Prowess',
  'Cycling', 'TypeCycling', 'Equip', 'Reconfigure', 'Level up', 'Crew', 'Ninjutsu', 'Chapter', 'Hideaway',
  'ETBReplacement', 'etbCounter', 'Enchant',
  'Flashback', 'Evoke', 'Overload', 'Kicker', 'Escape', 'Dash', 'Buyback', 'Delve', 'Surge',
  // No effect in a two-player cube game.
  'Companion', 'CARDNAME can be your commander.', 'Choose a Background', 'MayEffectFromOpeningDeck',
]);

/** Why a K: line isn't handled automatically (null = handled). */
export function keywordGap(k: string): string | null {
  const head = k.split(':')[0].trim();
  if (HANDLED_KEYWORDS.has(head)) return null;
  return head;
}
