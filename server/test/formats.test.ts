import { describe, expect, it } from 'vitest';
import { applyAction, type GameAction, type GameState, moveCard } from '@ojb/shared';
import { getCard, isCubeCard } from '@ojb/shared/src/cube.ts';
import { getScript } from '@ojb/shared/src/engine/script.ts';
import { carddbAvailable } from '../src/carddb.ts';
import { Rooms } from '../src/rooms.ts';

const has = carddbAvailable();
if (!has) console.warn('data/carddb missing — skipping card database format tests');

function room(settings: Record<string, unknown>, humans = 1) {
  const rooms = new Rooms();
  const host = rooms.create('Test', 'Max');
  const others = Array.from({ length: humans - 1 }, (_, i) => rooms.join(host.roomId, `P${i}`)!);
  const rec = rooms.rooms.get(host.roomId)!;
  expect(rooms.handle(rec, host.pid, { t: 'updateSettings', settings })).toBeNull();
  return { rooms, rec, host, others };
}

function runDraft(rooms: Rooms, rec: ReturnType<typeof room>['rec']) {
  let now = Date.now();
  for (let i = 0; i < 5000 && rec.state.phase === 'drafting'; i++) {
    // Humans pick the first card of their pack.
    for (const p of rec.state.players.filter((x) => !x.isBot)) {
      const pack = rec.state.draft!.queues[p.seat][0];
      if (pack) rooms.handle(rec, p.id, { t: 'pick', cardId: pack[0] });
    }
    rooms.tick((now += 300));
  }
}

const MONO_RED = `Deck
4 Shock
4 Lightning Strike
4 Play with Fire
4 Kumano Faces Kakkazan
4 Bloodthirsty Adversary
40 Mountain`;

describe.skipIf(!has)('card database formats', () => {
  it('set draft: three DMU boosters per player, bots draft to completion', () => {
    const { rooms, rec, host } = room({ mode: 'draft', source: 'set', setCodes: ['DMU', 'DMU', 'DMU'], seats: 4, fillWithBots: true, pickTimer: 0 });
    expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
    expect(rec.state.phase).toBe('drafting');
    const firstPack = rec.state.draft!.queues[0][0];
    expect(firstPack.length).toBe(15);
    expect(Object.keys(rec.state.prints ?? {}).length).toBeGreaterThan(20);
    runDraft(rooms, rec);
    expect(rec.state.phase).toBe('deckbuilding');
    for (const p of rec.state.players) {
      expect(rec.state.pools[p.id]).toHaveLength(45);
      for (const id of rec.state.pools[p.id]) expect(getCard(id), id).toBeDefined();
    }
    // Bots built 40-card decks.
    const bot = rec.state.players.find((p) => p.isBot)!;
    const d = rec.state.decks[bot.id];
    expect(d.ready).toBe(true);
    expect(d.main.length + Object.values(d.basics).reduce((a, b) => a + b, 0)).toBe(40);
    // The client gets card data with the set's printing art.
    const view = rooms.view(rec, host.pid);
    const payload = rooms.cardsFor(rec, view, new Set())!;
    const nonCube = view.pool.find((id) => !isCubeCard(id) && rec.state.prints?.[id])!;
    expect(payload.cards[nonCube].image).toMatch(/api\.scryfall\.com\/cards\/dmu\/\d+/);
    expect(rooms.cardsFor(rec, view, new Set(Object.keys(payload.cards)))).toBeNull();
  });

  it('set draft with mixed sets and 14-card play boosters', () => {
    const { rooms, rec, host } = room({ mode: 'draft', source: 'set', setCodes: ['MKM', 'MKM', 'DMU'], seats: 3, fillWithBots: true, pickTimer: 0 });
    expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
    runDraft(rooms, rec);
    expect(rec.state.phase).toBe('deckbuilding');
    const n = rec.state.pools[host.pid].length;
    expect([42, 43, 44, 45]).toContain(n);
  });

  it('set sealed: six packs (default) from a set', () => {
    const { rooms, rec, host } = room({ mode: 'sealed', source: 'set', setCodes: ['DMU'], seats: 1 });
    expect(rec.state.settings.sealedPacks).toBe(6);
    expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
    expect(rec.state.pools[host.pid]).toHaveLength(90);
  });

  it('rejects unknown sets and sets without boosters', () => {
    const { rooms, rec, host } = room({ mode: 'draft', source: 'set', setCodes: ['ZZZZ'] });
    expect(rooms.handle(rec, host.pid, { t: 'start' })).toMatch(/Unknown set/);
  });

  it('imported cube list (outside the OJ cube) resolves and drafts', () => {
    const names = ['Shock', 'Llanowar Elves', 'Divination', 'Duress', 'Pacifism', 'Grizzly Bears', 'Giant Growth', 'Counterspell', 'Doom Blade', 'Serra Angel'];
    const ids = names.map((n) => n.toLowerCase().replace(/ /g, '_'));
    const list = Array.from({ length: 360 }, (_, i) => ids[i % ids.length]);
    const { rooms, rec, host } = room({ mode: 'draft', customList: list, customListName: 'Test cube', seats: 8, fillWithBots: true, pickTimer: 0 });
    expect(rec.state.settings.customList).toHaveLength(360);
    expect(rec.state.settings.customListName).toBe('Test cube');
    // Other settings changes keep the list.
    rooms.handle(rec, host.pid, { t: 'updateSettings', settings: { packSize: 15 } });
    expect(rec.state.settings.customList).toHaveLength(360);
    expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
    runDraft(rooms, rec);
    expect(rec.state.pools[host.pid]).toHaveLength(45);
    expect(rec.state.pools[host.pid].every((id) => ids.includes(id))).toBe(true);
  });

  it('constructed: deck lists are validated against the format, then a game with DB cards runs Shock automatically', () => {
    const { rooms, rec, host, others } = room({ mode: 'constructed', format: 'Pioneer' }, 2);
    const friend = others[0];
    expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
    expect(rec.state.phase).toBe('deckbuilding');
    // Illegal: Black Lotus in Pioneer, and too few cards.
    const bad = rooms.handle(rec, friend.pid, { t: 'submitDeck', text: '1 Black Lotus\n20 Mountain' });
    expect(bad).toMatch(/Black Lotus/);
    expect(bad).toMatch(/60/);
    expect(rooms.handle(rec, friend.pid, { t: 'submitDeck', text: '4 Not A Real Card\n60 Mountain' })).toMatch(/unknown card/i);
    expect(rooms.handle(rec, host.pid, { t: 'submitDeck', text: MONO_RED })).toBeNull();
    expect(rooms.handle(rec, friend.pid, { t: 'submitDeck', text: MONO_RED })).toBeNull();
    expect(rec.state.decks[host.pid].basics.R).toBe(40);
    expect(rec.state.decks[host.pid].ready).toBe(true);
    expect(rooms.handle(rec, host.pid, { t: 'createMatch', players: [host.pid, friend.pid], bestOf: 3 })).toBeNull();
    const m = rec.state.matches[0];
    const g = m.game! as GameState;
    expect(isCubeCard('shock')).toBe(false);
    expect(getScript('shock')).toBeDefined();
    const ctx = { rng: Math.random, lookup: getCard, now: Date.now() };
    const act = (pid: string, a: GameAction) => { const e = applyAction(g, pid, a, ctx); if (e) throw new Error(e); };
    act(host.pid, { t: 'keep' });
    act(friend.pid, { t: 'keep' });
    g.strict = false;
    const me = g.players.find((p) => p.pid === host.pid)!;
    const shock = [...me.zones.library, ...me.zones.hand].find((i) => g.cards[i].cardId === 'shock')!;
    if (g.cards[shock].zone !== 'hand') moveCard(g, ctx, shock, 'hand');
    g.priority = host.pid;
    g.activePlayer = host.pid;
    g.step = 'main1';
    const opp = g.players.find((p) => p.pid === friend.pid)!;
    const before = opp.life;
    act(host.pid, { t: 'cast', iid: shock, targets: [[{ kind: 'player', pid: friend.pid }]] });
    expect(g.stack[0].auto).toBeDefined();
    act(friend.pid, { t: 'pass' });
    expect(opp.life).toBe(before - 2);
    expect(g.cards[shock].zone).toBe('graveyard');
    // The playing client is sent Shock's card data and rules script.
    const view = rooms.view(rec, host.pid);
    const payload = rooms.cardsFor(rec, view, new Set())!;
    expect(payload.cards.shock).toBeDefined();
    expect(payload.scripts.shock).toBeDefined();
  });

  it('freeform constructed accepts any resolvable deck', () => {
    const { rooms, rec, host } = room({ mode: 'constructed', format: 'Freeform' }, 1);
    rooms.handle(rec, host.pid, { t: 'start' });
    expect(rooms.handle(rec, host.pid, { t: 'submitDeck', text: '1 Black Lotus\n4 Shock' })).toBeNull();
  });
});
