/**
 * A rough power estimate for card-database cards, used by draft bots in place of the cube list
 * order (CardData.rank: lower = better, ~0..600 like a cube list position).
 * Rarity sets the baseline; removal, card advantage and efficient creatures move a card up,
 * clunky or narrow cards move it down. Basic lands are never worth a pick.
 */
import type { CardData } from './cards.ts';
import type { Rarity } from './carddb-types.ts';

const RARITY_BASE: Record<Rarity, number> = { M: 90, R: 140, U: 280, C: 400, S: 200, L: 9999 };

const powerCache = new WeakMap<CardData, number>();

/**
 * 0..1 power estimate (1 = best) used by bots. Database cards already carry a power-derived rank
 * (`powerRanked`); for cube cards `rank` is only the list position (sorted by colour), so the
 * heuristic is applied to them directly.
 */
export function cardPower(card: CardData): number {
  let v = powerCache.get(card);
  if (v == null) {
    const rank = card.powerRanked ? card.rank : heuristicRank(card, 'U');
    v = Math.max(0, Math.min(1, 1 - rank / 450));
    powerCache.set(card, v);
  }
  return v;
}

/**
 * The "must-pick" tier: cards so far above the rest that a drafter takes them whatever their colours.
 * Curated (Power 9, fast mana, the usual cube bombs), in rough priority order.
 */
export const MUST_PICK_LIST = [
  // Power 9 and friends
  'black_lotus', 'ancestral_recall', 'time_walk', 'mox_sapphire', 'mox_jet', 'mox_ruby', 'mox_emerald', 'mox_pearl', 'timetwister',
  // Fast mana
  'mana_crypt', 'sol_ring', 'mana_vault', 'jeweled_lotus', 'mana_drain', 'grim_monolith', 'chrome_mox', 'mox_diamond', 'lotus_petal',
  // Lands
  'library_of_alexandria', 'strip_mine', 'bazaar_of_baghdad', 'mishras_workshop', 'gaeas_cradle', 'the_tabernacle_at_pendrell_vale',
  // Spells and threats
  'minds_desire', 'tinker', 'yawgmoths_will', 'demonic_tutor', 'vampiric_tutor', 'sneak_attack', 'show_and_tell', 'channel', 'balance',
  'necropotence', 'wheel_of_fortune', 'treasure_cruise', 'force_of_will', 'oath_of_druids', 'recurring_nightmare', 'survival_of_the_fittest',
  'ragavan_nimble_pilferer', 'oko_thief_of_crowns', 'uro_titan_of_natures_wrath', 'wrenn_and_six', 'jace_the_mind_sculptor',
  'the_one_ring', 'orcish_bowmasters', 'sheoldred_the_apocalypse', 'grief', 'griselbrand', 'emrakul_the_aeons_torn', 'hogaak_arisen_necropolis',
  'skullclamp', 'urzas_saga', 'expressive_iteration', 'dack_fayden', 'true_name_nemesis', 'fable_of_the_mirror_breaker',
] as const;
export const MUST_PICK: ReadonlySet<string> = new Set(MUST_PICK_LIST);
/** Any card at or above this power rating (cardPower, 0..1) is a must-pick too. */
export const MUST_PICK_POWER = 0.95;

/** A card a bot never passes: on the curated list, or rated at least MUST_PICK_POWER. Basic lands never are. */
export function isMustPick(card: CardData): boolean {
  if (card.supertypes.includes('Basic') && card.types.includes('Land')) return false;
  return MUST_PICK.has(card.id) || cardPower(card) >= MUST_PICK_POWER;
}

/** Priority among must-picks: curated order first, then power. Lower is better. */
export function mustPickPriority(card: CardData): number {
  const i = (MUST_PICK_LIST as readonly string[]).indexOf(card.id);
  return i >= 0 ? i : MUST_PICK_LIST.length + (1 - cardPower(card));
}

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
