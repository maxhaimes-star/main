/**
 * Server side of card overrides (the card database applies shared/data/overrides.json; old and new names resolve)
 * and of the "Power up" room option (the power cards come from the card database, like an imported cube's).
 */
import { describe, expect, it } from 'vitest';
import { CUBE, getCard } from '@ojb/shared/src/cube.ts';
import { getScript } from '@ojb/shared/src/engine/script.ts';
import { POWER_CARDS } from '@ojb/shared/src/powerup.ts';
import { carddbAvailable, getCardById, resolveCardName, resolveDeck, searchCards } from '../src/carddb.ts';
import { Rooms } from '../src/rooms.ts';

const has = carddbAvailable();

describe.skipIf(!has)('card overrides in the card database', () => {
  it('Burning Inquiry is Burning Sensation; both names resolve; same art', () => {
    expect(resolveCardName('Burning Inquiry')).toBe('burning_inquiry');
    expect(resolveCardName('Burning Sensation')).toBe('burning_inquiry');
    expect(resolveCardName('burning sensation')).toBe('burning_inquiry');
    const c = getCardById('burning_inquiry')!;
    expect(c.name).toBe('Burning Sensation');
    expect(c.oracle).toMatch(/draws seven cards/);
    expect(c.image).toContain('Burning%20Inquiry');
    const d = resolveDeck('2 Burning Sensation\n1 Burning Inquiry');
    expect(d.errors).toEqual([]);
    expect(d.entries.map((e) => [e.id, e.name])).toEqual([['burning_inquiry', 'Burning Sensation'], ['burning_inquiry', 'Burning Sensation']]);
    expect(searchCards('Burning Sensation').cards.map((x) => x.id)).toContain('burning_inquiry');
  });
});

describe('Power up', () => {
  function room(settings: Record<string, unknown>) {
    const rooms = new Rooms();
    const host = rooms.create('Test', 'Max');
    const rec = rooms.rooms.get(host.roomId)!;
    expect(rooms.handle(rec, host.pid, { t: 'updateSettings', settings })).toBeNull();
    return { rooms, rec, host };
  }

  it.skipIf(!has)('adds the power cards the cube lacks (default cube: +11, Timetwister is already in it)', () => {
    const plain = room({});
    expect(plain.rooms.view(plain.rec, plain.host.pid).cubeSize).toBe(CUBE.list.length);
    const { rooms, rec, host } = room({ powerUp: true });
    expect(rec.state.settings.powerUp).toBe(true);
    expect(rooms.view(rec, host.pid).cubeSize).toBe(CUBE.list.length + 11);
  });

  it.skipIf(!has)('works with an imported cube: +12, or fewer when the list has some already', () => {
    const list = ['lightning_bolt', 'counterspell', 'llanowar_elves', 'ponder', 'brainstorm'];
    const a = room({ customList: list, powerUp: true });
    expect(a.rooms.view(a.rec, a.host.pid).cubeSize).toBe(list.length + 12);
    const b = room({ customList: [...list, 'sol_ring', 'black_lotus'], powerUp: true });
    expect(b.rooms.view(b.rec, b.host.pid).cubeSize).toBe(list.length + 2 + 10);
  });

  it.skipIf(!has)('a powered draft deals the power cards; they load from the card database with their scripts', () => {
    const { rooms, rec, host } = room({ powerUp: true, customList: CUBE.list.filter((id) => !(POWER_CARDS as readonly string[]).includes(id)).slice(0, 14), seats: 2, packs: 1, packSize: 13, fillWithBots: true, colorBalance: false });
    expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
    const dealt = [...(rec.state.draft?.queues.flat(2) ?? []), ...(rec.state.draft?.unopened.flat(2) ?? [])];
    for (const id of POWER_CARDS) expect(dealt).toContain(id);
    for (const id of POWER_CARDS) {
      expect(getCard(id)?.name, id).toBeTruthy();
      expect(getScript(id), id).toBeTruthy();
    }
  });
});
