/** Arcane Savant (real script): the pre-game exile from the sideboard (K:MayEffectFromOpeningDeck) and the free copy. */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  applyAction, botNeedsToAct, createGame, type Ctx, decideBotAction, type GameAction, type GameState, keywordGap, moveCard, newBotMemory, viewFor,
} from '../src/index.ts';
import { getScript } from '../src/engine/script.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[], fill = 'basic_island') => [...extra, ...Array(40 - extra.length).fill(fill)];

function setup(opts: { a?: string[]; sideA?: string[]; b?: string[]; sideB?: string[]; seed?: number; botA?: boolean } = {}) {
  const ctx: Ctx = { rng: seeded(opts.seed ?? 11), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(opts.a ?? ['arcane_savant']), side: opts.sideA ?? [], ...(opts.botA ? { bot: true } : {}) },
    { pid: 'b', name: 'Bob', deck: deck(opts.b ?? [], 'basic_mountain'), side: opts.sideB ?? [] },
  ], 'a', ctx);
  return { g, ctx };
}

function act(g: GameState, ctx: Ctx, pid: string, action: GameAction) {
  const err = applyAction(g, pid, action, ctx);
  if (err) throw new Error(err);
}

const exiled = (g: GameState, pid: string) => g.players.find((p) => p.pid === pid)!.zones.exile.map((i) => g.cards[i].cardId);
const lib = (g: GameState, pid: string) => g.players.find((p) => p.pid === pid)!.zones.library;

/** Answer the pre-game question by picking `cardId` (or 'no'), then keep both hands. */
function pregame(g: GameState, ctx: Ctx, pick: string | 'no') {
  const q = g.pending.find((x) => x.data.kind === 'pregame')!;
  const value = pick === 'no' ? 'no' : q.options.find((o) => g.cards[o.value]?.cardId === pick)!.value;
  act(g, ctx, q.pid, { t: 'choose', id: q.id, value });
}

function keepAll(g: GameState, ctx: Ctx) {
  for (const p of g.players) if (!p.kept) act(g, ctx, p.pid, { t: 'keep' });
}

/** Put Savant in Alice's hand with 5 Islands on the battlefield and cast it; resolve it. */
function castSavant(g: GameState, ctx: Ctx): string {
  const a = g.players[0];
  const sav = [...a.zones.hand, ...a.zones.library].find((i) => g.cards[i].cardId === 'arcane_savant')!;
  if (g.cards[sav].zone !== 'hand') moveCard(g, ctx, sav, 'hand');
  const islands = [...a.zones.hand, ...a.zones.library].filter((i) => g.cards[i].cardId === 'basic_island').slice(0, 5);
  for (const i of islands) moveCard(g, ctx, i, 'battlefield', { controller: 'a' });
  const sid = a.zones.hand.find((i) => g.cards[i].cardId === 'arcane_savant')!;
  act(g, ctx, 'a', { t: 'cast', iid: sid });
  for (let i = 0; i < 6 && g.cards[sid].zone !== 'battlefield'; i++) act(g, ctx, g.priority, { t: 'pass' });
  expect(g.cards[sid].zone).toBe('battlefield');
  return sid;
}

describe('Arcane Savant: before the game', () => {
  it('asks its owner before the opening hands, offering only sideboard instants and sorceries', () => {
    const { g } = setup({ sideA: ['lightning_bolt', 'ponder', 'questing_beast', 'basic_island', 'lightning_bolt'] });
    expect(g.phase).toBe('mulligan');
    expect(g.pregame).toBeTruthy();
    const a = g.players[0];
    expect(a.zones.hand).toHaveLength(0); // not drawn yet: "before you shuffle your deck to start the game"
    expect(g.players[1].zones.hand).toHaveLength(7); // the other player isn't affected
    const q = g.pending.find((x) => x.pid === 'a')!;
    expect(q.data.kind).toBe('pregame');
    const ids = q.options.filter((o) => o.value !== 'no').map((o) => g.cards[o.value].cardId).sort();
    expect(ids).toEqual(['lightning_bolt', 'ponder']); // one per card name, no creature / land
    expect(q.options.some((o) => o.value === 'no')).toBe(true);
    // Only Alice sees the options.
    expect(viewFor(g, 'b').pending[0].options).toEqual([]);
    expect(viewFor(g, 'b').pregame?.queue).toEqual([]);
  });

  it('exiles the chosen card before mulligans, notes it, reveals Savant and keeps it in the library', () => {
    const { g, ctx } = setup({ sideA: ['lightning_bolt', 'ponder'] });
    expect(applyAction(g, 'b', { t: 'keep' }, ctx)).toMatch(/before the game/);
    pregame(g, ctx, 'lightning_bolt');
    expect(g.pregame).toBeUndefined();
    expect(g.pending).toHaveLength(0);
    expect(g.phase).toBe('mulligan');
    const a = g.players[0];
    expect(exiled(g, 'a')).toEqual(['lightning_bolt']);
    expect(a.zones.sideboard.map((i) => g.cards[i].cardId)).toEqual(['ponder']);
    expect(a.notes?.ArcaneSavant).toEqual(a.zones.exile);
    expect(a.zones.hand).toHaveLength(7);
    expect(a.zones.library.length + a.zones.hand.length).toBe(40); // Savant stayed in the deck
    expect([...a.zones.library, ...a.zones.hand].some((i) => g.cards[i].cardId === 'arcane_savant')).toBe(true);
    // Revealed to both players.
    for (const v of ['a', 'b']) {
      const r = viewFor(g, v).reveals!;
      expect(r.some((x) => x.by === 'a' && x.cards[0].cardId === 'arcane_savant')).toBe(true);
    }
    keepAll(g, ctx);
    expect(g.phase).toBe('playing');
  });

  it('can be declined', () => {
    const { g, ctx } = setup({ sideA: ['lightning_bolt'] });
    pregame(g, ctx, 'no');
    expect(exiled(g, 'a')).toEqual([]);
    expect(g.players[0].zones.hand).toHaveLength(7);
    expect(g.reveals ?? []).toHaveLength(0);
  });

  it('asks once per Savant, each exiling its own card', () => {
    const { g, ctx } = setup({ a: ['arcane_savant', 'arcane_savant'], sideA: ['lightning_bolt', 'ponder'] });
    pregame(g, ctx, 'lightning_bolt');
    const q = g.pending.find((x) => x.data.kind === 'pregame')!;
    expect(q.options.filter((o) => o.value !== 'no').map((o) => g.cards[o.value].cardId)).toEqual(['ponder']);
    pregame(g, ctx, 'ponder');
    expect(exiled(g, 'a').sort()).toEqual(['lightning_bolt', 'ponder']);
    expect(g.pregame).toBeUndefined();
  });

  it('asks nothing without a sideboard instant or sorcery', () => {
    for (const side of [[], ['questing_beast', 'basic_island']]) {
      const { g, ctx } = setup({ sideA: side });
      expect(g.pregame).toBeUndefined();
      expect(g.pending).toHaveLength(0);
      expect(g.players[0].zones.hand).toHaveLength(7);
      keepAll(g, ctx);
      expect(g.phase).toBe('playing');
    }
  });

  it('a deck without Savant plays as before (same shuffle)', () => {
    const one = setup({ a: ['ponder'], sideA: ['lightning_bolt'] }).g;
    const two = setup({ a: ['ponder'], sideA: [] }).g;
    expect(one.players[0].zones.hand.map((i) => one.cards[i].cardId)).toEqual(two.players[0].zones.hand.map((i) => two.cards[i].cardId));
  });
});

describe('Arcane Savant: when it enters', () => {
  it('casts a copy of the exiled card without paying its mana cost; the original stays in exile', () => {
    const { g, ctx } = setup({ sideA: ['lightning_bolt'] });
    pregame(g, ctx, 'lightning_bolt');
    keepAll(g, ctx);
    const boltIid = g.players[0].zones.exile[0];
    castSavant(g, ctx);
    // ETB trigger: may cast a copy of Lightning Bolt.
    for (let i = 0; i < 6 && !g.pending.length; i++) act(g, ctx, g.priority, { t: 'pass' });
    let q = g.pending[0];
    expect(q.prompt).toMatch(/copy of Lightning Bolt/);
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: 'yes' });
    q = g.pending[0];
    expect(q.targets).toBeTruthy();
    act(g, ctx, 'a', { t: 'chooseTargets', id: q.id, targets: [[{ kind: 'player', pid: 'b' }]] });
    const top = g.stack[g.stack.length - 1];
    expect(top.kind).toBe('spell');
    expect(g.cards[top.iid!].cardId).toBe('lightning_bolt');
    expect(g.cards[top.iid!].token).toBeTruthy(); // a copy
    expect(top.iid).not.toBe(boltIid);
    expect(g.stack[g.stack.length - 1].castInfo?.option).toBe('free'); // without paying its mana cost
    const life = g.players[1].life;
    for (let i = 0; i < 6 && g.stack.length; i++) act(g, ctx, g.priority, { t: 'pass' });
    expect(g.players[1].life).toBe(life - 3);
    expect(g.cards[top.iid!]).toBeUndefined(); // the copy ceased to exist
    expect(g.cards[boltIid].zone).toBe('exile');
    expect(g.players[0].zones.exile).toContain(boltIid);
    expect(g.players[0].zones.graveyard.some((i) => g.cards[i].cardId === 'lightning_bolt')).toBe(false);
  });

  it('with two noted cards, the player picks which one to copy; a second Savant copies again', () => {
    const { g, ctx } = setup({ a: ['arcane_savant', 'arcane_savant'], sideA: ['lightning_bolt', 'ponder'] });
    pregame(g, ctx, 'lightning_bolt');
    pregame(g, ctx, 'ponder');
    keepAll(g, ctx);
    castSavant(g, ctx);
    for (let i = 0; i < 6 && !g.pending.length; i++) act(g, ctx, g.priority, { t: 'pass' });
    const q = g.pending[0];
    expect(q.options.map((o) => o.label)).toEqual(expect.arrayContaining(['Copy and cast Lightning Bolt', 'Copy and cast Ponder', "Don't"]));
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: q.options.find((o) => /Ponder/.test(o.label))!.value });
    expect(g.stack.some((s) => s.text === 'Ponder')).toBe(true);
    expect(exiled(g, 'a').sort()).toEqual(['lightning_bolt', 'ponder']);
  });

  it('declining leaves nothing behind', () => {
    const { g, ctx } = setup({ sideA: ['lightning_bolt'] });
    pregame(g, ctx, 'lightning_bolt');
    keepAll(g, ctx);
    castSavant(g, ctx);
    for (let i = 0; i < 6 && !g.pending.length; i++) act(g, ctx, g.priority, { t: 'pass' });
    const q = g.pending[0];
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: 'yes' });
    const t = g.pending[0];
    act(g, ctx, 'a', { t: 'choose', id: t.id, value: 'cancel' });
    expect(g.stack.filter((s) => s.kind === 'spell')).toHaveLength(0);
    expect(Object.values(g.cards).filter((c) => c.token)).toHaveLength(0);
    expect(exiled(g, 'a')).toEqual(['lightning_bolt']);
  });

  it('copies nothing when nothing was exiled with Savant', () => {
    const { g, ctx } = setup({ sideA: [] });
    keepAll(g, ctx);
    castSavant(g, ctx);
    for (let i = 0; i < 6 && (g.stack.length || g.pending.length); i++) act(g, ctx, g.priority, { t: 'pass' });
    expect(g.pending).toHaveLength(0);
    expect(g.log.some((l) => /no card to play/.test(l.text))).toBe(true);
  });
});

describe('Arcane Savant: bot and audit', () => {
  it('the bot exiles its best sideboard instant or sorcery, then keeps', () => {
    const { g, ctx } = setup({ sideA: ['opt', 'demonic_tutor', 'lightning_bolt', 'questing_beast'], botA: true });
    const mem = newBotMemory(1);
    expect(botNeedsToAct(g, 'a')).toBe(true);
    expect(botNeedsToAct(g, 'b')).toBe(false); // Bob waits: mulligans come after
    const a1 = decideBotAction(viewFor(g, 'a'), 'a', mem)!;
    expect(a1.t).toBe('choose');
    act(g, ctx, 'a', a1);
    expect(exiled(g, 'a')).toHaveLength(1);
    expect(['demonic_tutor', 'lightning_bolt']).toContain(exiled(g, 'a')[0]);
    const a2 = decideBotAction(viewFor(g, 'a'), 'a', mem)!;
    expect(a2.t === 'keep' || a2.t === 'mulligan').toBe(true);
  });

  it('the bot casts the copy when Savant enters', () => {
    const { g, ctx } = setup({ sideA: ['lightning_bolt'], botA: true });
    pregame(g, ctx, 'lightning_bolt');
    keepAll(g, ctx);
    castSavant(g, ctx);
    const mem = newBotMemory(2);
    for (let i = 0; i < 20 && !g.stack.some((s) => s.text === 'Lightning Bolt'); i++) {
      if (g.pending.length) { const q = g.pending[0]; expect(q.pid).toBe('a'); act(g, ctx, 'a', decideBotAction(viewFor(g, 'a'), 'a', mem)!); } else act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(g.stack.some((s) => s.text === 'Lightning Bolt')).toBe(true);
  });

  it('the keyword is handled only through the pre-game chain', () => {
    const f = getScript('arcane_savant')![0];
    expect(keywordGap(f.keywords[0], f.svars)).toBeNull();
    expect(keywordGap(f.keywords[0])).toBe('MayEffectFromOpeningDeck');
    expect(keywordGap('MayEffectFromOpeningDeck:DBNope', f.svars)).toBe('MayEffectFromOpeningDeck');
  });
});
