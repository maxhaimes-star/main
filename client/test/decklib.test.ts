import { describe, expect, it } from 'vitest';
import { DECK_LIB_KEY, MAX_DECKS, defaultDeckName, deleteDeck, deckSignature, deckSize, loadDecks, nameLookup, renameDeck, saveDeck, type StorageLike } from '../src/decklib.ts';
import { deckToText } from '@ojb/shared';

function mem(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}
const broken: StorageLike = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
const B0 = { W: 0, U: 0, B: 0, R: 0, G: 0 };
const input = (main: string[], over: Record<string, unknown> = {}) => ({ main, side: ['s1'], basics: { ...B0, R: 5 }, cube: 'Cube', format: 'Cube draft', names: { a: 'Alpha', b: 'Beta' }, ...over });

describe('deck library', () => {
  it('saves with a default name, source cube and timestamp; loads newest first', () => {
    const s = mem();
    const r = saveDeck(input(['a', 'b']), s, Date.UTC(2026, 9, 17, 12));
    expect(r.saved).toBe(true);
    expect(r.deck.name).toMatch(/^Cube · Cube draft · Oct 1[67]$/);
    expect(r.deck).toMatchObject({ cube: 'Cube', createdAt: Date.UTC(2026, 9, 17, 12), main: ['a', 'b'], side: ['s1'] });
    saveDeck(input(['b']), s, Date.UTC(2026, 9, 18));
    expect(loadDecks(s).map((d) => d.main.length)).toEqual([1, 2]);
    expect(defaultDeckName('X', 'X', 0)).toMatch(/^X · /);
  });
  it('de-duplicates by content regardless of order; an auto-save keeps a chosen name', () => {
    const s = mem();
    saveDeck(input(['a', 'b'], { name: 'Mine' }), s, 1);
    const r = saveDeck(input(['b', 'a'], { auto: true }), s, 2);
    expect(r.duplicate).toBe(true);
    expect(r.decks).toHaveLength(1);
    expect(r.deck).toMatchObject({ name: 'Mine', updatedAt: 2 });
    expect(saveDeck(input(['b', 'a'], { name: 'Renamed' }), s, 3).deck.name).toBe('Renamed');
    expect(saveDeck(input(['a', 'b'], { basics: { ...B0, R: 6 } }), s, 4).duplicate).toBe(false);
    expect(deckSignature({ main: ['a', 'b'], side: [], basics: B0 })).toBe(deckSignature({ main: ['b', 'a'], side: [], basics: B0 }));
  });
  it('renames and deletes', () => {
    const s = mem();
    const a = saveDeck(input(['a']), s, 1).deck;
    const b = saveDeck(input(['b']), s, 2).deck;
    expect(renameDeck(a.id, '  New  ', s).find((d) => d.id === a.id)!.name).toBe('New');
    expect(renameDeck(a.id, '   ', s).find((d) => d.id === a.id)!.name).toBe('New');
    expect(deleteDeck(b.id, s).map((d) => d.id)).toEqual([a.id]);
    expect(loadDecks(s)).toHaveLength(1);
  });
  it('caps the library, dropping the oldest', () => {
    const s = mem();
    for (let i = 0; i < MAX_DECKS + 5; i++) saveDeck(input([`c${i}`]), s, i + 1);
    const d = loadDecks(s);
    expect(d).toHaveLength(MAX_DECKS);
    expect(d[0].main).toEqual([`c${MAX_DECKS + 4}`]);
    expect(d.some((x) => x.main[0] === 'c0')).toBe(false);
  });
  it('survives unavailable storage and corrupt data', () => {
    expect(loadDecks(broken)).toEqual([]);
    expect(loadDecks(null)).toEqual([]);
    expect(saveDeck(input(['a']), broken, 1).saved).toBe(false);
    expect(saveDeck(input(['a']), null, 1).saved).toBe(false);
    const s = mem();
    s.data.set(DECK_LIB_KEY, '{nope');
    expect(loadDecks(s)).toEqual([]);
    s.data.set(DECK_LIB_KEY, JSON.stringify([{ id: 1 }, null, 'x']));
    expect(loadDecks(s)).toEqual([]);
  });
  it('exports as text using stored names and counts cards and basics', () => {
    const d = saveDeck(input(['a', 'a', 'b']), mem(), 1).deck;
    expect(deckSize(d)).toBe(8);
    const text = deckToText({ main: d.main, side: d.side, basics: d.basics, ready: true }, nameLookup(d, () => undefined));
    expect(text).toContain('2 Alpha');
    expect(text).toContain('1 Beta');
    expect(text).toContain('5 Mountain');
  });
});
