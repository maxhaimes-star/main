/** Recent-set mechanics found by the playtester: Empower (Jace token), Recruit, Discover, Behold ("enters tapped unless"). */
import { describe, expect, it } from 'vitest';
import { getCard, registerCards } from '../src/cube.ts';
import {
  abilitiesOfInstance, applyAction, createGame, type CardData, type Ctx, type GameAction, type GameState, moveCard,
} from '../src/index.ts';
import { registerScripts } from '../src/engine/script.ts';
import { seeded } from './helpers.ts';

const base = { cmc: 1, colorIdentity: [], supertypes: [], subtypes: [], keywords: [], producedMana: [], layout: 'normal', tokens: [], image: '', rank: 9999 };
const sorcery = (id: string, name: string, line: string, oracle: string): [CardData, Record<string, unknown[]>] => [
  { ...base, id, name, manaCost: '{U}', colors: ['U'], typeLine: 'Sorcery', types: ['Sorcery'], oracle } as unknown as CardData,
  { [id]: [{ name, abilities: [line], triggers: [], statics: [], replacements: [], keywords: [], svars: {} }] },
];
const defs = [
  sorcery('test_empower', 'Test Empower', 'SP$ Empower | Type$ Jace | Num$ 2 | SpellDescription$ Empower Jace 2.', 'Empower Jace 2.'),
  sorcery('test_recruit', 'Test Recruit', 'SP$ Recruit | SpellDescription$ Recruit.', 'Recruit.'),
  sorcery('test_discover', 'Test Discover', 'SP$ Discover | Num$ 2 | SpellDescription$ Discover 2.', 'Discover 2.'),
];
const land: CardData = {
  ...base, id: 'test_behold_land', name: 'Test Behold Land', manaCost: '', cmc: 0, colors: [], typeLine: 'Land', types: ['Land'], producedMana: ['G'],
  oracle: 'As this land enters, you may behold an Elf. If you don\'t, this land enters tapped.\n{T}: Add {G}.',
} as unknown as CardData;
registerCards([...defs.map((d) => d[0]), land]);
registerScripts(Object.assign({}, ...defs.map((d) => d[1]), {
  test_behold_land: [{
    name: 'Test Behold Land', abilities: ['AB$ Mana | Cost$ T | Produced$ G | SpellDescription$ Add {G}.'], triggers: [], statics: [], keywords: [],
    replacements: ['Event$ Moved | ValidCard$ Card.Self | Destination$ Battlefield | ReplaceWith$ DBTap | ReplacementResult$ Updated | Description$ As this land enters, you may behold an Elf. If you don\'t, this land enters tapped.'],
    svars: { DBTap: 'DB$ Tap | ETB$ True | Defined$ Self | UnlessCost$ Behold<1/Elf> | UnlessPayer$ You | StackDescription$ enters tapped.' },
  }],
}) as never);

const deck = (extra: string[], fill = 'basic_island') => [...extra, ...Array(40 - extra.length).fill(fill)];
function setup(a: string[]) {
  const ctx: Ctx = { rng: seeded(9), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(a), side: [] },
    { pid: 'b', name: 'Bob', deck: deck([]), side: [] },
  ], 'a', ctx);
  act(g, ctx, 'a', { t: 'keep' });
  act(g, ctx, 'b', { t: 'keep' });
  return { g, ctx };
}
function act(g: GameState, ctx: Ctx, pid: string, action: GameAction) {
  const err = applyAction(g, pid, action, ctx);
  if (err) throw new Error(err);
}
function find(g: GameState, pid: string, cardId: string): string {
  const p = g.players.find((x) => x.pid === pid)!;
  const iid = [...p.zones.hand, ...p.zones.library].find((i) => g.cards[i].cardId === cardId && g.cards[i].zone !== 'battlefield');
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}
function toHand(g: GameState, ctx: Ctx, cardId: string): string {
  const iid = find(g, 'a', cardId);
  if (g.cards[iid].zone !== 'hand') moveCard(g, ctx, iid, 'hand');
  return iid;
}
function put(g: GameState, ctx: Ctx, cardId: string): string {
  const iid = find(g, 'a', cardId);
  moveCard(g, ctx, iid, 'battlefield', { controller: 'a' });
  g.cards[iid].summoningSick = false;
  g.events = []; g.triggerQueue = [];
  return iid;
}
/** Resolve the stack, answering questions with the option matching `pick` (else the first). */
function resolveAll(g: GameState, ctx: Ctx, pick?: (labels: string[]) => number) {
  for (let i = 0; i < 40 && (g.stack.length || g.pending.length); i++) {
    const q = g.pending[0];
    if (q?.options.length) act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options[Math.max(0, pick ? pick(q.options.map((o) => o.label)) : 0)].value });
    else if (q) throw new Error(`unanswerable: ${q.prompt}`);
    else act(g, ctx, g.priority, { t: 'pass' });
  }
}
const logText = (g: GameState) => g.log.map((l) => l.text).join('\n');
const me = (g: GameState) => g.players[0];

describe('Empower', () => {
  it('creates a Jace planeswalker token with the loyalty, then adds to it; its loyalty abilities work', () => {
    const { g, ctx } = setup(['test_empower', 'test_empower']);
    put(g, ctx, 'basic_island'); put(g, ctx, 'basic_island');
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'test_empower') });
    resolveAll(g, ctx);
    const jaces = g.battlefield.filter((i) => g.cards[i].token && g.cards[i].cardId === 'token_empower_jace');
    expect(jaces).toHaveLength(1);
    const jace = g.cards[jaces[0]];
    expect(jace.counters.loyalty).toBe(2);
    expect(logText(g)).not.toMatch(/Not automated/);
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'test_empower') });
    resolveAll(g, ctx);
    expect(g.battlefield.filter((i) => g.cards[i].cardId === 'token_empower_jace')).toHaveLength(1);
    expect(jace.counters.loyalty).toBe(4);
    // [-3]: Draw a card.
    const draw = abilitiesOfInstance(jace, g, getCard).find((e) => e.ability.api === 'Draw')!;
    const hand = me(g).zones.hand.length;
    act(g, ctx, 'a', { t: 'activate', iid: jace.iid, ability: draw.index, text: '' });
    resolveAll(g, ctx);
    expect(jace.counters.loyalty).toBe(1);
    expect(me(g).zones.hand.length).toBe(hand + 1);
  });
});

describe('Recruit', () => {
  it('draws, discards; a nonland discard makes a 1/1 Human Soldier', () => {
    const { g, ctx } = setup(['test_recruit', 'lightning_bolt']);
    put(g, ctx, 'basic_island');
    const bolt = toHand(g, ctx, 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'test_recruit') });
    resolveAll(g, ctx, (labels) => labels.findIndex((l) => /Lightning Bolt/.test(l)));
    expect(g.cards[bolt].zone).toBe('graveyard');
    expect(g.battlefield.some((i) => g.cards[i].token?.name === 'Human Soldier')).toBe(true);
    expect(logText(g)).not.toMatch(/Not automated/);
  });

  it('discarding a land makes no token', () => {
    const { g, ctx } = setup(['test_recruit']);
    put(g, ctx, 'basic_island');
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'test_recruit') });
    resolveAll(g, ctx, (labels) => labels.findIndex((l) => /Island/.test(l)));
    expect(g.battlefield.some((i) => g.cards[i].token?.name === 'Human Soldier')).toBe(false);
  });
});

describe('Discover', () => {
  it('exiles to a nonland card with mana value <= N; declined: it goes to hand, the rest to the bottom', () => {
    const { g, ctx } = setup(['test_discover', 'counterspell']);
    put(g, ctx, 'basic_island');
    const cs = find(g, 'a', 'counterspell');
    const lib = me(g).zones.library;
    lib.splice(lib.indexOf(cs), 1);
    lib.splice(2, 0, cs); // two Islands, then Counterspell
    const top2 = lib.slice(0, 2);
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'test_discover') });
    resolveAll(g, ctx, (labels) => labels.findIndex((l) => /^(No|Don't|Decline)/i.test(l)));
    expect(g.cards[cs].zone).toBe('hand');
    expect(top2.every((i) => g.cards[i].zone === 'library' && lib.indexOf(i) >= lib.length - 2)).toBe(true);
    expect(logText(g)).toMatch(/Discover 2/);
    expect(logText(g)).not.toMatch(/Not automated/);
  });
});

describe('Behold (enters tapped unless you behold)', () => {
  it('enters untapped when you control an Elf, tapped otherwise', () => {
    const { g, ctx } = setup(['test_behold_land', 'test_behold_land', 'llanowar_elves']);
    const l1 = put(g, ctx, 'test_behold_land');
    expect(g.cards[l1].tapped).toBe(true);
    put(g, ctx, 'llanowar_elves');
    const l2 = put(g, ctx, 'test_behold_land');
    expect(g.cards[l2].tapped).toBe(false);
    expect(logText(g)).toMatch(/beholds Llanowar Elves/);
    expect(logText(g)).not.toMatch(/by hand/);
  });
});
