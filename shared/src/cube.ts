import type { CardData, CubeData } from './cards.ts';
import cubeJson from '../data/cube.json' with { type: 'json' };
import { withBasics } from './game/reducer.ts';

export const CUBE = cubeJson as unknown as CubeData;
const byId = new Map<string, CardData>(CUBE.cards.map((c) => [c.id, c]));

/** Look up any cube card or basic land by id. */
export const getCard = withBasics((id) => byId.get(id));
export const ALL_CARDS = CUBE.cards;
