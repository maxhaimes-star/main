/** Draft bots read signals (what's flowing) and pick for synergy with their pool. */
import { describe, expect, it } from 'vitest';
import { CUBE, getCard } from '../src/cube.ts';
import { botPick, cardPower, type CardData, type Color, DEFAULT_SETTINGS, draftTick, noteSignals, type RoomState, startDraft, synergy } from '../src/index.ts';
import { seeded } from './helpers.ts';

const mono = (col: Color) => CUBE.cards.filter((c) => c.colors.join('') === col && !c.types.includes('Land'));

describe('draft bots: colour signals', () => {
  it('early on, between two equally good cards, takes the colour that is flowing', () => {
    // Two cards of the same power in different colours.
    let pair: [CardData, CardData] | undefined;
    for (const r of mono('R')) {
      const g = mono('G').find((x) => Math.abs(cardPower(x) - cardPower(r)) < 0.005);
      if (g) { pair = [r, g]; break; }
    }
    expect(pair).toBeTruthy();
    const [red, green] = pair!;
    const signalsG: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 3 };
    const signalsR: Record<Color, number> = { W: 0, U: 0, B: 0, R: 3, G: 0 };
    for (const seed of [1, 2, 3]) {
      expect(botPick([red.id, green.id], [], getCard, seeded(seed), signalsG)).toBe(green.id);
      expect(botPick([red.id, green.id], [], getCard, seeded(seed), signalsR)).toBe(red.id);
    }
  });

  it('notes strong cards still in packs passed to it (late = open)', () => {
    const s: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    const strongBlue = mono('U').sort((a, b) => cardPower(b) - cardPower(a)).slice(0, 3).map((c) => c.id);
    noteSignals(s, strongBlue, 10, 15, getCard);
    expect(s.U).toBeGreaterThan(0);
    expect(s.R).toBe(0);
    // A fresh pack (first pick) says nothing about what's open.
    const fresh: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
    noteSignals(fresh, strongBlue, 15, 15, getCard);
    expect(fresh.U).toBe(0);
  });

  it('bots keep their signals through a full draft', () => {
    const r: RoomState = {
      id: 'r', name: 'r', hostId: 'p0', settings: { ...DEFAULT_SETTINGS },
      players: Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, name: `B${i}`, seat: i, isBot: true, connected: true })),
      phase: 'lobby', draft: null, auction: null, pools: {}, decks: {}, matches: [], chat: [], createdAt: 0, updatedAt: 0,
    };
    const rng = seeded(3);
    startDraft(r, CUBE.list, rng, getCard, 0);
    let t = 0;
    while (r.phase === 'drafting' && t < 10000) { draftTick(r, t, getCard, rng); t++; }
    expect(r.phase).toBe('deckbuilding');
    for (const s of r.draft!.signals!) expect(Object.values(s).some((v) => v > 0)).toBe(true);
  });
});

describe('draft bots: synergy with the pool', () => {
  it('a tribal card is worth more next to creatures of its type', () => {
    const goblin = CUBE.cards.find((c) => c.subtypes.includes('Goblin') && c.types.includes('Creature'));
    if (!goblin) return;
    const others = CUBE.cards.filter((c) => c.id !== goblin.id && c.subtypes.includes('Goblin')).map((c) => c.id);
    const plain = CUBE.cards.filter((c) => c.colors.join('') === 'W' && c.types.includes('Creature')).slice(0, 3).map((c) => c.id);
    if (others.length) expect(synergy(goblin, others, getCard)).toBeGreaterThan(synergy(goblin, plain, getCard));
  });

  it('instants and sorceries are worth more in a spells-matter pool', () => {
    const payoff = CUBE.cards.filter((c) => /instant (and|or) sorcery|noncreature spell/i.test(c.oracle) && !c.types.includes('Instant') && !c.types.includes('Sorcery')).map((c) => c.id);
    const bolt = getCard('lightning_bolt')!;
    const creatures = CUBE.cards.filter((c) => c.types.includes('Creature') && !/instant|sorcery/i.test(c.oracle)).slice(0, 4).map((c) => c.id);
    expect(payoff.length).toBeGreaterThan(1);
    expect(synergy(bolt, payoff.slice(0, 3), getCard)).toBeGreaterThan(synergy(bolt, creatures, getCard));
  });
});
