import { TRIGGER_KEYWORDS } from './kwtriggers.ts';
import { PREGAME_KEYWORD, pregameKeywordSupported } from './pregame.ts';

/**
 * Keyword mechanics (Forge K: lines): which ones the engine handles, for coverage tools.
 */

/** K: keywords the engine handles automatically (combat keywords, cast options, synthesized abilities / triggers ...). */
export const HANDLED_KEYWORDS = new Set([
  'Flying', 'Flash', 'Haste', 'Trample', 'Lifelink', 'Deathtouch', 'Vigilance', 'First Strike', 'Double Strike', 'Indestructible',
  'Reach', 'Shroud', 'Hexproof', 'Defender', 'Infect', 'Prowess', 'Menace', 'Shadow', 'Landwalk', 'Protection', 'Ward', 'Ascend',
  // Changeling: every creature type (game/rules.ts printedFace -> allCreatureTypes).
  'Changeling',
  // Affinity for <type> (statics.ts adjustCost); Convoke (strict.ts auto-pay taps creatures).
  'Affinity', 'Convoke',
  'Cycling', 'TypeCycling', 'Equip', 'Reconfigure', 'Level up', 'Crew', 'Ninjutsu', 'Chapter', 'Hideaway',
  'ETBReplacement', 'etbCounter', 'Enchant',
  'Flashback', 'Evoke', 'Overload', 'Kicker', 'Escape', 'Dash', 'Buyback', 'Delve', 'Surge',
  // Strict auto-pay taps untapped artifacts for generic mana (engine/strict.ts castHelp).
  'Improvise',
  // Fewer loyalty counters when life was paid for Phyrexian mana (engine/replacements.ts).
  'Compleated',
  // Cast as an Aura for the bestow cost (costs.ts option, script.ts castSpellAbility, rules.ts faceOf).
  'Bestow',
  // engine/facedown.ts, engine/newmech.ts
  'Morph', 'Megamorph', 'Disguise', 'Plot', 'Warp', 'Saddle', 'Station', 'Start your engines', 'Sneak',
  // Triggered keywords synthesized as triggers (engine/kwtriggers.ts), rebound (resolve.ts).
  ...TRIGGER_KEYWORDS,
  // Splice onto Arcane: the cube's only Arcane spell is Through the Breach itself, so there is nothing to splice onto.
  'Splice',
  // No effect in a two-player cube game.
  'Companion', 'CARDNAME can be your commander.', 'Choose a Background',
]);

/**
 * Why a K: line isn't handled automatically (null = handled). `svars`: the face's SVars, for keywords that name an
 * ability chain (MayEffectFromOpeningDeck: Arcane Savant's pre-game exile, engine/pregame.ts).
 */
export function keywordGap(k: string, svars?: Record<string, string>): string | null {
  const head = k.split(':')[0].trim();
  if (head === PREGAME_KEYWORD) return pregameKeywordSupported(k, svars) ? null : head;
  if (HANDLED_KEYWORDS.has(head) || /^Protection from /.test(head)) return null;
  return head;
}
