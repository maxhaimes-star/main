import { describe, expect, it } from 'vitest';
import { Rooms } from '../src/rooms.ts';

/** Repeated events in the same room, with the same cube: each one is dealt from a fresh random seed. */
describe('a fresh shuffle for every event', () => {
  for (const mode of ['draft', 'auction', 'sealed'] as const) {
    it(`${mode}: every event gets a new seed and different cards`, () => {
      const rooms = new Rooms();
      const host = rooms.create('Seeds', 'Max');
      const rec = rooms.rooms.get(host.roomId)!;
      expect(rooms.handle(rec, host.pid, { t: 'updateSettings', settings: { mode, seats: 2, fillWithBots: true, sealedPacks: 1 } })).toBeNull();
      const seeds = new Set<number>();
      const deals: string[] = [];
      for (let i = 0; i < 4; i++) {
        expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
        const s = rec.state;
        expect(typeof s.seed).toBe('number');
        seeds.add(s.seed!);
        const dealt = mode === 'draft' ? s.draft!.queues.flat(2).concat(s.draft!.unopened.flat(2))
          : mode === 'auction' ? [...s.auction!.open, ...s.auction!.packs.flat()]
            : Object.values(s.pools).flat();
        deals.push(dealt.slice().sort().join(','));
        expect(rooms.handle(rec, host.pid, { t: 'backToLobby' })).toBeNull();
        expect(s.seed).toBeUndefined();
      }
      expect(seeds.size).toBe(4);
      expect(new Set(deals).size).toBe(4);
    });
  }
});
