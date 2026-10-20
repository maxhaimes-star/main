/** Rooms (Duskmourn split enchantments): cast one door for its own cost, unlock the other later. Real card scripts. */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  abilitiesOfInstance, abilityUsability, applyAction, autoPayPreview, castability, castOptions, createGame, decideBotAction, faceOf, handClick, newBotMemory, viewFor, type Ctx, type GameAction, type GameState, moveCard,
} from '../src/index.ts';
import { seeded } from './helpers.ts';

const ROOM = 'walk_in_closet_forgotten_cellar';
const deck = (extra: string[], fill = 'basic_island') => [...extra, ...Array(40 - extra.length).fill(fill)];

function setup(a: string[] = [], fillA = 'basic_island') {
  const ctx: Ctx = { rng: seeded(11), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(a, fillA), side: [] },
    { pid: 'b', name: 'Bob', deck: deck([], 'basic_mountain'), side: [] },
  ], 'a', ctx, { strict: true });
  act(g, ctx, 'a', { t: 'keep' });
  act(g, ctx, 'b', { t: 'keep' });
  return { g, ctx };
}
function act(g: GameState, ctx: Ctx, pid: string, action: GameAction) {
  const err = applyAction(g, pid, action, ctx);
  if (err) throw new Error(err);
}
function find(g: GameState, pid: string, cardId: string, skip: string[] = []): string {
  const p = g.players.find((x) => x.pid === pid)!;
  const iid = [...p.zones.hand, ...p.zones.library, ...p.zones.graveyard, ...p.zones.exile].find((i) => g.cards[i].cardId === cardId && !skip.includes(i));
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}
function toHand(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId);
  if (g.cards[iid].zone !== 'hand') moveCard(g, ctx, iid, 'hand');
  return iid;
}
function put(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId, g.battlefield.slice());
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  g.events = []; g.triggerQueue = [];
  return iid;
}
function drain(g: GameState, ctx: Ctx) {
  for (let i = 0; i < 30 && g.stack.length && !g.pending.length; i++) act(g, ctx, g.priority, { t: 'pass' });
}
const logText = (g: GameState) => g.log.map((l) => l.text).join('\n');
const lands = (g: GameState, ctx: Ctx, n: number, id = 'basic_forest') => Array.from({ length: n }, () => put(g, ctx, 'a', id));
const unlockOf = (g: GameState, iid: string) => abilitiesOfInstance(g.cards[iid]).find((a) => a.ability.api === '_Unlock');

describe('Rooms: Walk-In Closet // Forgotten Cellar', () => {
  it('with exactly {2}{G} available the Walk-In Closet door can be cast (castability and auto-pay agree)', () => {
    const { g, ctx } = setup([ROOM], 'basic_forest');
    const forests = lands(g, ctx, 3);
    const room = toHand(g, ctx, 'a', ROOM);
    expect(castOptions(g, room, 0, getCard).find((o) => o.id === 'normal')?.cost).toBe('{2}{G}');
    expect(castOptions(g, room, 1, getCard).find((o) => o.id === 'normal')?.cost).toBe('{3}{G}{G}');
    expect(castability(g, 'a', room, getCard).ok).toBe(true);
    expect(castability(g, 'a', room, getCard, 0).ok).toBe(true);
    expect(castability(g, 'a', room, getCard, 1).ok).toBe(false);
    expect(autoPayPreview(g, 'a', room, 0).ok).toBe(true);
    expect(autoPayPreview(g, 'a', room, 1).ok).toBe(false);
    expect(handClick(g, 'a', room, getCard)).toBe('menu'); // choose a door
    act(g, ctx, 'a', { t: 'cast', iid: room, face: 0 });
    expect(forests.every((f) => g.cards[f].tapped)).toBe(true);
    expect(logText(g)).toMatch(/casts Walk-In Closet\./); // on the stack it's only the cast door
    expect(faceOf(g.cards[room], getCard).manaCost).toBe('{2}{G}');
    drain(g, ctx);
    expect(g.cards[room].zone).toBe('battlefield');
    expect(g.cards[room].unlocked).toEqual([0]);
  });

  it('a cast without a face is the left door, for its own cost (never the combined cost)', () => {
    const { g, ctx } = setup([ROOM], 'basic_forest');
    lands(g, ctx, 3);
    const room = toHand(g, ctx, 'a', ROOM);
    expect(castOptions(g, room, undefined, getCard).find((o) => o.id === 'normal')?.cost).toBe('{2}{G}');
    act(g, ctx, 'a', { t: 'cast', iid: room });
    drain(g, ctx);
    expect(g.cards[room].unlocked).toEqual([0]);
  });

  it('either door can be cast; only the cast door is unlocked (casting is not unlocking: no unlock trigger)', () => {
    const { g, ctx } = setup([ROOM, 'basic_island'], 'basic_forest');
    lands(g, ctx, 5);
    const room = toHand(g, ctx, 'a', ROOM);
    expect(castability(g, 'a', room, getCard, 1).ok).toBe(true);
    act(g, ctx, 'a', { t: 'cast', iid: room, face: 1 });
    expect(logText(g)).toMatch(/casts Forgotten Cellar/);
    drain(g, ctx);
    expect(g.cards[room].zone).toBe('battlefield');
    expect(g.cards[room].unlocked).toEqual([1]);
    expect(g.stack.length).toBe(0);
    // Walk-In Closet is locked: no lands from the graveyard
    const isl = find(g, 'a', 'basic_island');
    moveCard(g, ctx, isl, 'graveyard');
    expect(castability(g, 'a', isl, getCard).ok).toBe(false);
    // the locked door can be unlocked for {2}{G}
    expect(unlockOf(g, room)?.ability.params.Door).toBe('0');
  });

  it("Walk-In Closet's static: you may play lands from your graveyard", () => {
    const { g, ctx } = setup([ROOM, 'basic_island', 'basic_island'], 'basic_forest');
    lands(g, ctx, 3);
    const room = toHand(g, ctx, 'a', ROOM);
    act(g, ctx, 'a', { t: 'cast', iid: room, face: 0 });
    drain(g, ctx);
    const isl = find(g, 'a', 'basic_island');
    moveCard(g, ctx, isl, 'graveyard');
    expect(castability(g, 'a', isl, getCard).ok).toBe(true);
    act(g, ctx, 'a', { t: 'playLand', iid: isl });
    expect(g.cards[isl].zone).toBe('battlefield');
    // only one land per turn
    const isl2 = find(g, 'a', 'basic_island', [isl]);
    moveCard(g, ctx, isl2, 'graveyard');
    expect(castability(g, 'a', isl2, getCard).ok).toBe(false);
  });

  it("unlocking the other door costs that door's cost, at sorcery speed, and fires its unlock trigger", () => {
    const { g, ctx } = setup([ROOM, 'once_upon_a_time'], 'basic_forest');
    lands(g, ctx, 3);
    const room = toHand(g, ctx, 'a', ROOM);
    act(g, ctx, 'a', { t: 'cast', iid: room, face: 0 });
    drain(g, ctx);
    const ouat = find(g, 'a', 'once_upon_a_time');
    moveCard(g, ctx, ouat, 'graveyard');
    const unlock = unlockOf(g, room)!;
    expect(unlock).toBeTruthy();
    expect(unlock.ability.params.Door).toBe('1');
    // all three lands are tapped: can't pay {3}{G}{G}
    expect(abilityUsability(g, 'a', room, unlock.index, getCard).ok).toBe(false);
    // five fresh lands (+2 for Once Upon a Time later): still not on the opponent's turn
    lands(g, ctx, 7);
    expect(abilityUsability(g, 'a', room, unlock.index, getCard).ok).toBe(true);
    g.activePlayer = 'b'; g.priority = 'a';
    expect(abilityUsability(g, 'a', room, unlock.index, getCard).ok).toBe(false);
    expect(applyAction(g, 'a', { t: 'activate', iid: room, ability: unlock.index, text: '' }, ctx)).toBeTruthy();
    g.activePlayer = 'a';
    expect(g.cards[room].unlocked).toEqual([0]);
    // only four untapped lands: not enough
    const fresh = g.battlefield.filter((i) => g.cards[i].cardId === 'basic_forest' && !g.cards[i].tapped);
    const spare = fresh.splice(5);
    for (const i of spare) g.cards[i].tapped = true;
    g.cards[fresh[0]].tapped = true;
    expect(abilityUsability(g, 'a', room, unlock.index, getCard).ok).toBe(false);
    g.cards[fresh[0]].tapped = false;
    act(g, ctx, 'a', { t: 'activate', iid: room, ability: unlock.index, text: '' });
    expect(fresh.every((f) => g.cards[f].tapped)).toBe(true);
    for (const i of spare) g.cards[i].tapped = false;
    expect(g.cards[room].unlocked).toEqual([0, 1]);
    expect(logText(g)).toMatch(/unlocks Forgotten Cellar/);
    drain(g, ctx);
    expect(logText(g)).toMatch(/Forgotten Cellar/);
    // the trigger resolved: spells from your graveyard this turn, and cards that would go there are exiled
    expect(castability(g, 'a', ouat, getCard).ok).toBe(true);
    const isl = put(g, ctx, 'a', 'basic_forest');
    moveCard(g, ctx, isl, 'graveyard');
    expect(g.cards[isl].zone).toBe('exile');
  });

  it("a fully unlocked Room has both doors' abilities and no unlock action", () => {
    const { g, ctx } = setup([ROOM, 'basic_island'], 'basic_forest');
    lands(g, ctx, 8);
    const room = toHand(g, ctx, 'a', ROOM);
    act(g, ctx, 'a', { t: 'cast', iid: room, face: 1 });
    drain(g, ctx);
    const unlock = unlockOf(g, room)!;
    expect(unlock.ability.params.Door).toBe('0');
    act(g, ctx, 'a', { t: 'activate', iid: room, ability: unlock.index, text: '' });
    drain(g, ctx);
    expect(g.cards[room].unlocked).toEqual([0, 1]);
    expect(unlockOf(g, room)).toBeUndefined();
    // Walk-In Closet now works (Forgotten Cellar has no unlock trigger from unlocking the other door)
    const isl = find(g, 'a', 'basic_island');
    moveCard(g, ctx, isl, 'graveyard');
    expect(castability(g, 'a', isl, getCard).ok).toBe(true);
    expect(logText(g)).toMatch(/unlocks Walk-In Closet/);
  });

  it('the bot casts the cheaper door, then unlocks the other one when it can', () => {
    const { g, ctx } = setup([ROOM], 'basic_forest');
    const p = g.players.find((x) => x.pid === 'a')!;
    for (const iid of [...p.zones.hand]) moveCard(g, ctx, iid, 'library');
    lands(g, ctx, 5);
    const room = toHand(g, ctx, 'a', ROOM);
    g.step = 'main1'; g.priority = 'a';
    const mem = newBotMemory(1);
    const a = decideBotAction(viewFor(g, 'a'), 'a', mem);
    expect(a).toMatchObject({ t: 'cast', iid: room, face: 0 });
    act(g, ctx, 'a', a!);
    drain(g, ctx);
    expect(g.cards[room].unlocked).toEqual([0]);
    // two untapped Forests left: can't unlock Forgotten Cellar yet
    const b = decideBotAction(viewFor(g, 'a'), 'a', mem);
    expect(b?.t === 'activate' && b.iid === room).toBe(false);
    lands(g, ctx, 3);
    const c = decideBotAction(viewFor(g, 'a'), 'a', mem);
    expect(c).toMatchObject({ t: 'activate', iid: room });
    act(g, ctx, 'a', c!);
    expect(g.cards[room].unlocked).toEqual([0, 1]);
  });

  it('with exactly 3 lands the bot casts Walk-In Closet', () => {
    const { g, ctx } = setup([ROOM], 'basic_forest');
    const p = g.players.find((x) => x.pid === 'a')!;
    for (const iid of [...p.zones.hand]) moveCard(g, ctx, iid, 'library');
    lands(g, ctx, 3);
    const room = toHand(g, ctx, 'a', ROOM);
    g.step = 'main1'; g.priority = 'a';
    expect(decideBotAction(viewFor(g, 'a'), 'a', newBotMemory(1))).toMatchObject({ t: 'cast', iid: room, face: 0 });
  });
});
