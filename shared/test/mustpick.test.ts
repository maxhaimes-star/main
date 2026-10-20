import { describe, expect, it } from 'vitest';
import { CUBE, getCard } from '../src/cube.ts';
import { botPick, type CardData } from '../src/index.ts';
import { isMustPick, MUST_PICK, MUST_PICK_POWER } from '../src/power.ts';
import { seeded } from './helpers.ts';

/** A bot firmly in two colours (W/U), with plenty of strong on-colour cards in the pack. */
const wu = CUBE.cards.filter((c) => c.colors.length === 1 && 'WU'.includes(c.colors[0]) && !c.types.includes('Land'));
const wuPicks = wu.slice(0, 20).map((c) => c.id);
const tempting = wu.slice(20, 33).map((c) => c.id);

const fake = (id: string, over: Partial<CardData> = {}): CardData => ({
  id, name: id, manaCost: '{0}', cmc: 0, colors: [], colorIdentity: [], typeLine: 'Artifact', supertypes: [], types: ['Artifact'], subtypes: [],
  oracle: '', keywords: [], producedMana: [], layout: 'normal', tokens: [], image: '', rank: 400, powerRanked: true, ...over,
});

describe('draft bots never pass the super busted cards', () => {
  it('the curated list covers the power and the usual bombs', () => {
    for (const id of ['black_lotus', 'mox_sapphire', 'ancestral_recall', 'time_walk', 'timetwister', 'mana_crypt', 'sol_ring', 'mana_vault', 'jeweled_lotus',
      'ragavan_nimble_pilferer', 'oko_thief_of_crowns', 'uro_titan_of_natures_wrath', 'wrenn_and_six', 'jace_the_mind_sculptor', 'sneak_attack',
      'strip_mine', 'library_of_alexandria', 'minds_desire']) expect(MUST_PICK.has(id), id).toBe(true);
    expect(isMustPick(getCard('sneak_attack')!)).toBe(true);
    expect(isMustPick(getCard('island') ?? fake('island', { supertypes: ['Basic'], types: ['Land'] }))).toBe(false);
  });

  it('a committed W/U bot takes off-colour bombs and colourless lands over its best on-colour cards', () => {
    for (const id of ['sneak_attack', 'strip_mine', 'library_of_alexandria', 'oko_thief_of_crowns', 'ragavan_nimble_pilferer', 'uro_titan_of_natures_wrath']) {
      expect(getCard(id), id).toBeTruthy();
      for (const seed of [1, 2, 3]) expect(botPick([...tempting, id], wuPicks, getCard, seeded(seed)), id).toBe(id);
    }
  });

  it('works for card-database cards (Power up): Black Lotus and Mana Crypt are taken', () => {
    const extra: Record<string, CardData> = { black_lotus: fake('black_lotus'), mana_crypt: fake('mana_crypt') };
    const lookup = (id: string) => extra[id] ?? getCard(id);
    expect(botPick([...tempting, 'black_lotus'], wuPicks, lookup, seeded(4))).toBe('black_lotus');
    expect(botPick(['mana_crypt', ...tempting], wuPicks, lookup, seeded(5))).toBe('mana_crypt');
  });

  it('a power rating above the threshold makes any card a must-pick', () => {
    const bomb = fake('unknown_bomb', { rank: 5, colors: ['R'], manaCost: '{R}', cmc: 1, types: ['Creature'], power: '3', toughness: '3' });
    expect(isMustPick(bomb)).toBe(true);
    expect(isMustPick(fake('filler', { rank: 300 }))).toBe(false);
    expect(MUST_PICK_POWER).toBeGreaterThan(0.9);
    const lookup = (id: string) => (id === bomb.id ? bomb : getCard(id));
    expect(botPick([...tempting, bomb.id], wuPicks, lookup, seeded(6))).toBe(bomb.id);
  });
});
