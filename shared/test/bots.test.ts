import { describe, expect, it } from 'vitest';
import { CUBE, getCard } from '../src/cube.ts';
import {
  botDeck, botPick, cardPower, commitment, DEFAULT_SETTINGS, draftTick, pickProfile, startDraft, topColors,
  type Color, type RoomState,
} from '../src/index.ts';
import { seeded } from './helpers.ts';

function allBots(n: number): RoomState {
  return {
    id: 'r', name: 'r', hostId: 'p0', settings: { ...DEFAULT_SETTINGS },
    players: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `B${i}`, seat: i, isBot: true, connected: true })),
    phase: 'lobby', draft: null, auction: null, pools: {}, decks: {}, matches: [], chat: [], createdAt: 0, updatedAt: 0,
  };
}

function draftAll(seed: number, n = 8) {
  const r = allBots(n);
  const rng = seeded(seed);
  startDraft(r, CUBE.list, rng, getCard, 0);
  const order: string[][] = [];
  let t = 0;
  while (r.phase === 'drafting' && t < 10000) { draftTick(r, t, getCard, rng); t++; }
  for (const p of r.players) order.push(r.pools[p.id]);
  return { r, pools: order };
}

const cards = (ids: string[]) => ids.map((id) => getCard(id)!);
const nonLand = (ids: string[]) => cards(ids).filter((c) => !c.types.includes('Land'));

describe('bot picks', () => {
  it('are deterministic for a seed', () => {
    const a = draftAll(11).pools;
    const b = draftAll(11).pools;
    expect(a).toEqual(b);
    expect(draftAll(12).pools).not.toEqual(a);
  });

  it('rate cards by power: a strong card beats a weak one, whatever its position in the cube list', () => {
    const byPower = CUBE.cards.slice().sort((a, b) => cardPower(b) - cardPower(a));
    const best = byPower[0], worst = byPower[byPower.length - 1];
    expect(cardPower(best)).toBeGreaterThan(cardPower(worst));
    for (const seed of [1, 2, 3]) expect(botPick([worst.id, best.id], [], getCard, seeded(seed))).toBe(best.id);
    // The cube list is sorted by colour, so list position alone must not decide it: green's best isn't ranked behind white filler.
    const green = byPower.find((c) => c.colors.join('') === 'G')!;
    const whiteJunk = byPower.slice().reverse().find((c) => c.colors.join('') === 'W' && !c.types.includes('Land'))!;
    expect(botPick([whiteJunk.id, green.id], [], getCard, seeded(1))).toBe(green.id);
  });

  it('commits to two colours after the first few picks', () => {
    expect(commitment(0)).toBe(0);
    expect(commitment(11)).toBe(1);
    let inColor = 0, total = 0;
    for (const seed of [1, 2, 3, 4]) {
      for (const pool of draftAll(seed).pools) {
        const spells = nonLand(pool);
        const colors = new Map<Color, number>();
        for (const c of spells) for (const col of c.colors) colors.set(col, (colors.get(col) ?? 0) + 1);
        const top = [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
        // Look at the second half of the draft, when the bot should be firmly settled.
        for (const c of nonLand(pool.slice(18))) { total++; if (c.colors.every((x) => top.includes(x))) inColor++; }
      }
    }
    expect(inColor / total).toBeGreaterThan(0.8);
  });

  it('prefers on-colour cards once settled, even over a slightly more powerful off-colour card', () => {
    const red = CUBE.cards.filter((c) => c.colors.join('') === 'R' && !c.types.includes('Land') && cardPower(c) > 0.5).slice(0, 12).map((c) => c.id);
    const prof = pickProfile(red, getCard);
    expect(prof.commit).toBe(1);
    expect(topColors(prof.weights)[0]).toBe('R');
    const redCard = CUBE.cards.filter((c) => c.colors.join('') === 'R' && !c.types.includes('Land') && !red.includes(c.id) && cardPower(c) > 0.4 && cardPower(c) < 0.6)[0];
    const rp = cardPower(redCard);
    const offCard = CUBE.cards.find((c) => c.colors.join('') === 'B' && !c.types.includes('Land') && cardPower(c) > rp + 0.02 && cardPower(c) < rp + 0.15)!;
    expect(offCard).toBeTruthy();
    expect(botPick([offCard.id, redCard.id], red, getCard, seeded(1))).toBe(redCard.id);
  });

  it('asks for creatures when a settled pool has none', () => {
    const noncreature = CUBE.cards.filter((c) => c.colors.join('') === 'W' && !c.types.includes('Land') && !c.types.includes('Creature') && cardPower(c) > 0.3).slice(0, 14).map((c) => c.id);
    const creature = CUBE.cards.find((c) => c.colors.join('') === 'W' && c.types.includes('Creature') && cardPower(c) > 0.3 && cardPower(c) < 0.4 && c.cmc <= 3)!;
    const spell = CUBE.cards.find((c) => c.colors.join('') === 'W' && !c.types.includes('Land') && !c.types.includes('Creature') && !noncreature.includes(c.id) && Math.abs(cardPower(c) - cardPower(creature)) < 0.02 && c.cmc <= 3);
    if (spell) expect(botPick([spell.id, creature.id], noncreature, getCard, seeded(1))).toBe(creature.id);
  });
});

describe('bot decks', () => {
  it('are 40 cards, two colours, with enough creatures, a sane curve and 16-18 lands', () => {
    for (const seed of [1, 2, 3]) {
      for (const pool of draftAll(seed).pools) {
        const d = botDeck(pool, getCard);
        const basics = Object.values(d.basics).reduce((a, b) => a + b, 0);
        expect(d.main.length + basics).toBe(40);
        expect([...d.main, ...d.side].sort()).toEqual(pool.slice().sort());
        const main = cards(d.main);
        const spells = main.filter((c) => !c.types.includes('Land'));
        const lands = d.main.length - spells.length + basics;
        expect(lands).toBeGreaterThanOrEqual(16);
        expect(lands).toBeLessThanOrEqual(18);
        const colors = new Set(spells.flatMap((c) => c.colors));
        expect(colors.size).toBeLessThanOrEqual(2);
        expect(spells.filter((c) => c.types.includes('Creature')).length).toBeGreaterThanOrEqual(9);
        expect(spells.filter((c) => c.cmc >= 6).length).toBeLessThanOrEqual(4);
        // Basics only in colours the deck plays.
        for (const [c, n] of Object.entries(d.basics)) if (n > 0) expect(colors.has(c as Color) || colors.size === 0).toBe(true);
        expect(d.ready).toBe(true);
      }
    }
  });

  it('are deterministic', () => {
    const { pools } = draftAll(5);
    expect(botDeck(pools[0], getCard)).toEqual(botDeck(pools[0], getCard));
  });
});
