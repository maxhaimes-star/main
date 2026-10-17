/**
 * Zone-change replacement hook, in a module without runtime imports so modules in import cycles can install it at
 * load time: installed by engine/replacements.ts (R: lines such as "enters tapped", "exile it instead") and wrapped by
 * engine/copy.ts. state.ts moveCard calls it; `before` may change the destination / options and return work to do
 * after the move.
 */
import type { Ctx } from './state.ts';
import type { GameState, Zone } from './types.ts';

export interface MoveOpts { position?: 'top' | 'bottom' | number; faceDown?: boolean; /** face-down exile nobody may look at (CardInstance.unseen) */ unseen?: boolean; tapped?: boolean; controller?: string; cause?: 'discard' | 'sacrifice' }

export const moveHooks: {
  before?: (state: GameState, ctx: Ctx, iid: string, to: Zone, opts: MoveOpts) => { to: Zone; opts: MoveOpts; after?: () => void } | undefined;
} = {};
