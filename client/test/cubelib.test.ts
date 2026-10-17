import { describe, expect, it } from 'vitest';
import { CUBE_LIB_KEY, cobraIdOf, deleteCube, loadCubes, saveCube, type StorageLike } from '../src/cubelib.ts';

function mem(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}
const broken: StorageLike = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };

describe('cube library', () => {
  it('saves, loads newest first, and deletes', () => {
    const s = mem();
    const a = saveCube({ name: 'A', cards: ['x', 'x', 'y'] }, s, 1);
    const b = saveCube({ name: 'B', cards: ['z'] }, s, 2);
    expect(a.saved && b.saved).toBe(true);
    expect(loadCubes(s).map((c) => c.name)).toEqual(['B', 'A']);
    expect(loadCubes(s)[1].cards).toEqual(['x', 'x', 'y']);
    expect(deleteCube(a.cube.id, s).map((c) => c.name)).toEqual(['B']);
    expect(loadCubes(s)).toHaveLength(1);
  });
  it('replaces rather than duplicates a re-saved cube', () => {
    const s = mem();
    saveCube({ name: 'Cobra', cards: ['a'], cobraId: 'abc' }, s, 1);
    const r = saveCube({ name: 'Cobra v2', cards: ['a', 'b'], cobraId: 'abc' }, s, 2);
    expect(r.cubes).toHaveLength(1);
    expect(loadCubes(s)[0]).toMatchObject({ name: 'Cobra v2', cards: ['a', 'b'], cobraId: 'abc', updatedAt: 2 });
    saveCube({ name: 'Mine', cards: ['a'] }, s, 3);
    saveCube({ name: 'Mine', cards: ['b'] }, s, 4);
    expect(loadCubes(s).filter((c) => c.name === 'Mine')).toHaveLength(1);
  });
  it('refreshes in place by id', () => {
    const s = mem();
    const a = saveCube({ name: 'N', cards: ['a'], cobraId: 'q' }, s, 1);
    saveCube({ id: a.cube.id, name: 'N', cards: ['a', 'b'], cobraId: 'q' }, s, 5);
    expect(loadCubes(s)).toHaveLength(1);
    expect(loadCubes(s)[0].cards).toEqual(['a', 'b']);
  });
  it('survives unavailable storage and corrupt data', () => {
    expect(loadCubes(broken)).toEqual([]);
    expect(loadCubes(null)).toEqual([]);
    const r = saveCube({ name: 'X', cards: ['a'] }, broken);
    expect(r.saved).toBe(false);
    expect(r.cube.name).toBe('X');
    const s = mem();
    s.data.set(CUBE_LIB_KEY, '{nope');
    expect(loadCubes(s)).toEqual([]);
    s.data.set(CUBE_LIB_KEY, JSON.stringify([{ id: 1 }, { id: 'ok', name: 'n', cards: ['a'], updatedAt: 1 }]));
    expect(loadCubes(s).map((c) => c.id)).toEqual(['ok']);
  });
  it('extracts CubeCobra ids', () => {
    expect(cobraIdOf('https://cubecobra.com/cube/list/abc123?x=1')).toBe('abc123');
    expect(cobraIdOf(' mycube ')).toBe('mycube');
  });
});
