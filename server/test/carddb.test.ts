import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CUBE } from '@ojb/shared/src/cube.ts';
import { generateBooster, seededRng } from '@ojb/shared/src/boosters.ts';
import type { BoosterCard, SetData } from '@ojb/shared/src/carddb-types.ts';
import { parseDeckList } from '@ojb/shared/src/decklist.ts';
import {
  boosterFor, carddbAvailable, formatLegality, getCardById, getSet, printingsOf, resolveDeck, searchCards, setList,
} from '../src/carddb.ts';

const MTGA = `About
Name Izzet Test

Deck
4 Lightning Bolt (2XM) 117
4 Fable of the Mirror-Breaker (NEO) 141
2 Fire // Ice (MH2) 290
4 Expressive Iteration (STX) 186
24 Mountain (DMU) 269

Sideboard
2 Abrade (DMU) 114
1 Bonecrusher Giant (ELD) 115
`;

describe('deck list parsing', () => {
  it('reads MTGA exports with sections, set codes and collector numbers', () => {
    const d = parseDeckList(MTGA);
    expect(d.name).toBe('Izzet Test');
    expect(d.errors).toEqual([]);
    expect(d.lines[0]).toMatchObject({ count: 4, name: 'Lightning Bolt', set: '2XM', num: '117', section: 'main' });
    expect(d.lines.find((l) => l.name === 'Fire // Ice')).toMatchObject({ count: 2, set: 'MH2', num: '290' });
    const side = d.lines.filter((l) => l.section === 'side');
    expect(side.map((l) => [l.count, l.name])).toEqual([[2, 'Abrade'], [1, 'Bonecrusher Giant']]);
  });

  it('reads MTGO lists (blank line before sideboard, SB: prefix, 4x)', () => {
    const d = parseDeckList('4x Ponder\n56 Island\n\n3 Negate\nSB: 1 Duress');
    expect(d.lines.filter((l) => l.section === 'main').map((l) => l.count)).toEqual([4, 56]);
    expect(d.lines.filter((l) => l.section === 'side').map((l) => l.name)).toEqual(['Negate', 'Duress']);
  });
});

describe('booster templates (synthetic set)', () => {
  const p = (id: string, r: 'C' | 'U' | 'R' | 'M' | 'L', flags = '') => [id, r, '1', flags] as SetData['cards'][number];
  const set: SetData = {
    code: 'TST', name: 'Test', date: '2020-01-01', type: 'expansion', scryfall: 'tst',
    cards: [
      ...Array.from({ length: 20 }, (_, i) => p(`c${i}`, 'C')), ...Array.from({ length: 10 }, (_, i) => p(`u${i}`, 'U')),
      ...Array.from({ length: 5 }, (_, i) => p(`r${i}`, 'R')), p('m0', 'M'), p('plains', 'L', 'bl'),
    ],
    booster: { kind: 'draft', template: '10 Common, 3 Uncommon, 1 RareMythic, 1 BasicLand', slots: {} },
  };
  it('fills each slot with the right rarity and no duplicates', () => {
    const rng = seededRng(7);
    let mythics = 0;
    for (let i = 0; i < 800; i++) {
      const b = generateBooster(set, { getSet: () => undefined }, rng);
      expect(b.map((c) => c.rarity).join('')).toMatch(/^C{10}U{3}[RM]L$/);
      expect(new Set(b.map((c) => c.id)).size).toBe(15);
      if (b[13].rarity === 'M') mythics++;
    }
    expect(mythics / 800).toBeGreaterThan(0.08);
    expect(mythics / 800).toBeLessThan(0.18);
  });
});

const has = carddbAvailable();
if (!has) console.warn('data/carddb missing — run `npm run build-carddb` (or scripts/build-carddb.ts --forge …) to enable card DB tests');

describe.skipIf(!has)('card database (built data)', () => {
  it('contains every OJ cube card under the same id', () => {
    for (const c of CUBE.cards) {
      const db = getCardById(c.id);
      expect(db, c.name).toBeDefined();
      expect(db!.name).toBe(c.name);
      expect(db!.typeLine).toBe(c.typeLine);
      expect(db!.manaCost).toBe(c.manaCost);
      expect(db!.oracle).toBe(c.oracle);
    }
  });

  it('lists sets with types and dates', () => {
    const sets = setList();
    expect(sets.length).toBeGreaterThan(300);
    expect(sets.find((s) => s.code === 'DMU')).toMatchObject({ name: 'Dominaria United', date: '2022-09-09', type: 'expansion', booster: 'draft' });
    expect(sets.find((s) => s.code === '2XM')?.type).toBe('masters');
    expect(getSet('USG')!.cards.find((p) => p[0] === 'gaeas_cradle')?.[1]).toBe('R');
    expect(printingsOf('lightning_bolt').some((p) => p.set === 'LEA')).toBe(true);
  });

  const many = (code: string, n = 200) => { const rng = seededRng(42); return Array.from({ length: n }, () => boosterFor(code, rng)); };
  const rar = (b: BoosterCard[], r: string) => b.filter((c) => r.includes(c.rarity)).length;

  it('Dominaria United draft boosters: 10 C, 3 U, 1 R/M, 1 land', () => {
    for (const b of many('DMU')) {
      expect(b).toHaveLength(15);
      expect(rar(b.slice(0, 10), 'C')).toBe(10);
      expect(rar(b.slice(10, 13), 'U')).toBe(3);
      expect('RM').toContain(b[13].rarity);
      expect(getCardById(b[14].id)!.types).toContain('Land');
      expect(new Set(b.map((c) => c.id)).size).toBeGreaterThanOrEqual(14);
      for (const c of b) expect(getCardById(c.id), c.id).toBeDefined();
    }
  });

  it("Urza's Saga boosters: 11 C, 3 U, 1 R", () => {
    for (const b of many('USG')) {
      expect(b.map((c) => c.rarity).join('')).toBe('CCCCCCCCCCCUUUR');
      expect(b.every((c) => c.set === 'USG' && c.num)).toBe(true);
    }
  });

  it('Double Masters boosters: 8 C, 3 U, 2 R/M, 2 foils', () => {
    for (const b of many('2XM')) {
      expect(b).toHaveLength(15);
      expect(rar(b.slice(0, 8), 'C')).toBe(8);
      expect(rar(b.slice(8, 11), 'U')).toBe(3);
      expect(rar(b.slice(11, 13), 'RM')).toBe(2);
    }
  });

  it('recent sets use 14-card Play Boosters (MKM)', () => {
    expect(getSet('MKM')!.booster!.kind).toBe('play');
    for (const b of many('MKM')) {
      expect(b).toHaveLength(14);
      expect(rar(b.slice(0, 6), 'C')).toBe(6);
      expect(rar(b.slice(7, 10), 'U')).toBe(3);
      expect('RM').toContain(b[10].rarity);
      expect(getCardById(b[11].id)!.supertypes).toContain('Basic');
      expect(b[13].foil).toBe(true);
    }
  });

  it('every set with a template produces a non-empty booster', () => {
    const rng = seededRng(1);
    for (const s of setList().filter((x) => x.booster)) expect(boosterFor(s.code, rng).length, s.code).toBeGreaterThanOrEqual(8);
  });

  const deck = (main: string, side = '') => `Deck\n${main}\n\nSideboard\n${side}`;

  it('Modern accepts a legal deck and rejects banned cards', () => {
    expect(formatLegality(deck('4 Lightning Bolt\n4 Monastery Swiftspear\n52 Mountain'), 'Modern')).toEqual([]);
    const errs = formatLegality(deck('4 Lightning Bolt\n4 Ponder\n52 Island'), 'Modern');
    expect(errs.some((e) => /Ponder is banned/.test(e))).toBe(true);
  });

  it('catches 4-of, restricted, deck size, sideboard and set-legality violations', () => {
    expect(formatLegality(deck('5 Lightning Bolt\n55 Mountain'), 'Modern').some((e) => /5 copies of Lightning Bolt/.test(e))).toBe(true);
    expect(formatLegality(deck('20 Relentless Rats\n40 Swamp'), 'Modern')).toEqual([]);
    expect(formatLegality(deck('2 Sol Ring\n58 Island'), 'Vintage').some((e) => /restricted/.test(e))).toBe(true);
    expect(formatLegality(deck('4 Lightning Bolt\n40 Mountain'), 'Modern').some((e) => /at least 60/.test(e))).toBe(true);
    expect(formatLegality(deck('4 Lightning Bolt\n56 Mountain', '16 Island'), 'Modern').some((e) => /Sideboard has 16/.test(e))).toBe(true);
    expect(formatLegality(deck('4 Lightning Bolt\n56 Mountain'), 'Standard').some((e) => /Lightning Bolt is not legal/.test(e))).toBe(true);
    expect(formatLegality(deck('4 Tarmogoyf\n56 Forest'), 'Pauper').some((e) => /Tarmogoyf is not legal/.test(e))).toBe(true);
  });

  it('resolves MTGA lists to card ids', () => {
    const r = resolveDeck(MTGA);
    expect(r.errors).toEqual([]);
    expect(r.entries.map((e) => e.id)).toEqual([
      'lightning_bolt', 'fable_of_the_mirror_breaker', 'fire_ice', 'expressive_iteration', 'mountain', 'abrade', 'bonecrusher_giant',
    ]);
    expect(resolveDeck('1 Lim-Dul\'s Vault\n1 Not A Real Card').errors).toHaveLength(1);
  });

  it('searches by name and filters', () => {
    const r = searchCards('lightning bolt');
    expect(r.cards[0].name).toBe('Lightning Bolt');
    expect(searchCards('t:creature c:g s:dmu r:mythic').cards.every((c) => c.types.includes('Creature') && c.colors.includes('G'))).toBe(true);
    expect(searchCards('ponder f:modern').cards.some((c) => c.id === 'ponder')).toBe(false);
  });

  it('data dir stays out of git', () => {
    expect(fs.readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8')).toMatch(/^data\/carddb$/m);
  });
});
