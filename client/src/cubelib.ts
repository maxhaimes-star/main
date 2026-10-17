// Saved cube library, kept in the browser's localStorage so it survives server redeploys (the host's disk is wiped on every deploy).

export interface SavedCube {
  id: string;
  name: string;
  /** Card ids, repeated for counts (same shape as RoomSettings.customList). */
  cards: string[];
  /** CubeCobra cube id, when the list came from CubeCobra (enables "Refresh"). */
  cobraId?: string;
  updatedAt: number;
}

export const CUBE_LIB_KEY = 'ojb:cubes';
const MAX_CUBES = 50;

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

function valid(x: unknown): x is SavedCube {
  const c = x as SavedCube;
  return !!c && typeof c.id === 'string' && typeof c.name === 'string' && Array.isArray(c.cards)
    && c.cards.length > 0 && c.cards.every((i) => typeof i === 'string') && typeof c.updatedAt === 'number'
    && (c.cobraId === undefined || typeof c.cobraId === 'string');
}

/** Saved cubes, newest first. Never throws: unavailable storage or corrupt data gives an empty library. */
export function loadCubes(storage: StorageLike | null = defaultStorage()): SavedCube[] {
  try {
    const raw = storage?.getItem(CUBE_LIB_KEY);
    const arr = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(arr) ? arr.filter(valid).sort((a, b) => b.updatedAt - a.updatedAt) : [];
  } catch { return []; }
}

function persist(cubes: SavedCube[], storage: StorageLike | null): boolean {
  try { if (!storage) return false; storage.setItem(CUBE_LIB_KEY, JSON.stringify(cubes)); return true; } catch { return false; }
}

export const newCubeId = () => `cube-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Add a cube, or replace the one with the same id. A cube with the same CubeCobra id (or, for pastes, the same name) is replaced
 * rather than duplicated. Returns the saved cube and the new library; `saved` is false when storage was unavailable.
 */
export function saveCube(
  input: { name: string; cards: string[]; cobraId?: string; id?: string },
  storage: StorageLike | null = defaultStorage(),
  now = Date.now(),
): { cube: SavedCube; cubes: SavedCube[]; saved: boolean } {
  const existing = loadCubes(storage);
  const name = input.name.trim() || 'Imported list';
  const same = existing.find((c) => (input.id ? c.id === input.id : input.cobraId ? c.cobraId === input.cobraId : !c.cobraId && c.name === name));
  const cube: SavedCube = { id: same?.id ?? input.id ?? newCubeId(), name, cards: input.cards.slice(), cobraId: input.cobraId, updatedAt: now };
  const cubes = [cube, ...existing.filter((c) => c.id !== cube.id)].slice(0, MAX_CUBES);
  return { cube, cubes, saved: persist(cubes, storage) };
}

export function deleteCube(id: string, storage: StorageLike | null = defaultStorage()): SavedCube[] {
  const cubes = loadCubes(storage).filter((c) => c.id !== id);
  persist(cubes, storage);
  return cubes;
}

/** The CubeCobra id from a bare id or a cube link. */
export function cobraIdOf(input: string): string {
  return input.trim().replace(/.*cubecobra\.com\/cube\/\w+\//, '').replace(/[?#].*$/, '');
}
