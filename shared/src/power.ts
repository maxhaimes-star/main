/**
 * A rough power estimate for card-database cards, used by draft bots in place of the cube list
 * order (CardData.rank: lower = better, ~0..600 like a cube list position).
 * Rarity sets the baseline; removal, card advantage and efficient creatures move a card up,
 * clunky or narrow cards move it down. Basic lands are never worth a pick.
 */
import type { CardData } from './cards.ts';
import type { Rarity } from './carddb-types.ts';

const RARITY_BASE: Record<Rarity, number> = { M: 90, R: 140, U: 280, C: 400, S: 200, L: 9999 };

export function heuristicRank(card: CardData, rarity: Rarity = 'C'): number {
  if (card.supertypes.includes('Basic') && card.types.includes('Land')) return 9999;
  let r = RARITY_BASE[rarity] ?? 400;
  const o = card.oracle.toLowerCase();
  const isCreature = card.types.includes('Creature');
  // Removal and interaction.
  if (/(destroy|exile) target (creature|nonland permanent|permanent|planeswalker)/.test(o)) r -= 140;
  else if (/deals? \d+ damage to (any target|target creature)/.test(o) || /deals damage equal to .* to target creature/.test(o)) r -= 120;
  else if (/target creature gets -\d+\/-\d+/.test(o) || /fights? (target|another target|up to one target) creature/.test(o)) r -= 90;
  else if (/counter target spell/.test(o)) r -= 40;
  else if (/(return|put) target (creature|nonland permanent).*(to its owner's hand|on top of)/.test(o) || /tap target creature.*doesn't untap/.test(o)) r -= 40;
  // Card advantage, evasion, bombs.
  if (/draw (two|three|a card)/.test(o)) r -= 30;
  if (/(create|creates) .* token/.test(o)) r -= 25;
  if (card.types.includes('Planeswalker')) r -= 120;
  if (isCreature) {
    const p = Number(card.power), t = Number(card.toughness);
    if (Number.isFinite(p) && Number.isFinite(t)) {
      const stats = p + t;
      const curve = Math.max(1, card.cmc);
      r -= Math.max(-60, Math.min(80, (stats - 2 * curve - 1) * 25));
    }
    for (const k of ['flying', 'deathtouch', 'lifelink', 'trample', 'first strike', 'menace', 'vigilance', 'haste']) if (card.keywords.some((x) => x.toLowerCase() === k) || o.includes(k)) r -= 12;
  }
  // Mana fixing lands are fine, other non-creature filler and expensive cards are worse.
  if (card.types.includes('Land')) r += card.colorIdentity.length >= 2 ? 40 : 120;
  if (card.cmc >= 7) r += 80;
  else if (card.cmc >= 6) r += 30;
  if (card.colors.length >= 3) r += 60;
  if (!isCreature && !card.types.includes('Land') && r >= RARITY_BASE[rarity]) r += 40; // vanilla-ish noncreature spells
  return Math.max(1, Math.min(800, Math.round(r)));
}
