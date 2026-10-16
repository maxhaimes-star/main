/** Auto-pay: Convoke paying colored mana, Phyrexian mana (mana first, life only when needed / chosen). */
import { describe, expect, it } from 'vitest';
import { getCard, registerCards } from '../src/cube.ts';
import {
  applyAction, autoPayPreview, castability, createGame, type CardData, type Ctx, type GameAction, type GameState, moveCard, planAutoPay,
  solveMana,
} from '../src/index.ts';
import { registerScripts } from '../src/engine/script.ts';
import { seeded } from './helpers.ts';

// Stoke the Flames ({2}{R}{R}, Convoke, 4 damage to any target) — not a cube card: registered for these tests.
const STOKE: CardData = {
  id: 'test_stoke_the_flames', name: 'Stoke the Flames', manaCost: '{2}{R}{R}', cmc: 4, colors: ['R'], colorIdentity: ['R'], typeLine: 'Instant',
  supertypes: [], types: ['Instant'], subtypes: [], keywords: ['Convoke'], producedMana: [], layout: 'normal', tokens: [], image: '', rank: 9999,
  oracle: "Convoke (Your creatures can help cast this spell. Each creature you tap while casting this spell pays for {1} or one mana of that creature's color.)\nStoke the Flames deals 4 damage to any target.",
} as unknown as CardData;
// A green Convoke spell with a Phyrexian symbol ({G/P}).
const PHY_CONVOKE: CardData = {
  ...STOKE, id: 'test_phyrexian_convoke', name: 'Test Phyrexian Convoke', manaCost: '{1}{G/P}', cmc: 2, colors: ['G'], colorIdentity: ['G'], oracle: 'Convoke\nTest Phyrexian Convoke deals 4 damage to any target.',
} as unknown as CardData;
registerCards([STOKE, PHY_CONVOKE]);
registerScripts({
  test_stoke_the_flames: [{ name: 'Stoke the Flames', abilities: ['SP$ DealDamage | ValidTgts$ Any | NumDmg$ 4 | SpellDescription$ CARDNAME deals 4 damage to any target.'], triggers: [], statics: [], replacements: [], keywords: ['Convoke'], svars: {} }],
  test_phyrexian_convoke: [{ name: 'Test Phyrexian Convoke', abilities: ['SP$ DealDamage | ValidTgts$ Any | NumDmg$ 4 | SpellDescription$ CARDNAME deals 4 damage to any target.'], triggers: [], statics: [], replacements: [], keywords: ['Convoke'], svars: {} }],
} as never);

const deck = (extra: string[], fill = 'basic_mountain') => [...extra, ...Array(40 - extra.length).fill(fill)];

function setup(a: string[] = [], fillA = 'basic_mountain') {
  const ctx: Ctx = { rng: seeded(5), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(a, fillA), side: [] },
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
function find(g: GameState, pid: string, cardId: string, skip: string[] = []): string {
  const p = g.players.find((x) => x.pid === pid)!;
  const iid = [...p.zones.hand, ...p.zones.library, ...p.zones.graveyard].find((i) => g.cards[i].cardId === cardId && !skip.includes(i));
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
  for (let i = 0; i < 20 && g.stack.length && !g.pending.length; i++) act(g, ctx, g.priority, { t: 'pass' });
}
const life = (g: GameState, pid: string) => g.players.find((p) => p.pid === pid)!.life;
const B = [[{ kind: 'player' as const, pid: 'b' }]];

describe('solver: Convoke helpers paying colored symbols', () => {
  const help = (key: string, colors: string[]) => ({ key, options: [{ id: 'help', produces: '*', penalty: 4 }, ...colors.map((m) => ({ id: `help:${m}`, produces: m, penalty: 4.5, helper: true }))] });
  it('a red creature pays {R}; the symbol it paid is reported', () => {
    const r = solveMana('{2}{R}{R}', 0, [{ key: 'mtn', options: [{ id: 'R', produces: 'R', penalty: 0 }] }, help('red', ['R']), help('w1', ['W']), help('w2', ['W'])]);
    expect(r).not.toBeNull();
    const red = r!.picks.find((p) => p.key === 'red')!;
    expect(red.option).toBe('help:R');
    expect(red.paid).toEqual(['R']);
    expect(r!.picks.filter((p) => p.option === 'help')).toHaveLength(2);
  });
  it('helpers of the wrong color only pay generic', () => {
    expect(solveMana('{R}', 0, [help('w', ['W'])])).toBeNull();
    expect(solveMana('{1}', 0, [help('w', ['W'])])!.picks[0].option).toBe('help');
  });
  it('generic mana is paid with the plain help option, not a colored one', () => {
    const r = solveMana('{1}{G}', 0, [{ key: 'f', options: [{ id: 'G', produces: 'G', penalty: 0 }] }, help('elf', ['G'])])!;
    expect(r.picks.find((p) => p.key === 'elf')!.option).toBe('help');
  });
});

describe('Convoke in a game (auto-pay and castability)', () => {
  it('Stoke the Flames: Mountain + red creature pay {R}{R}, two white creatures pay {2}', () => {
    const { g, ctx } = setup(['test_stoke_the_flames', 'monastery_swiftspear', 'thraben_inspector', 'esper_sentinel']);
    const mtn = put(g, ctx, 'a', 'basic_mountain');
    const crs = ['monastery_swiftspear', 'thraben_inspector', 'esper_sentinel'].map((id) => put(g, ctx, 'a', id));
    const s = toHand(g, ctx, 'a', 'test_stoke_the_flames');
    expect(castability(g, 'a', s, getCard).ok).toBe(true);
    expect(autoPayPreview(g, 'a', s, undefined, undefined, undefined, getCard).ok).toBe(true);
    act(g, ctx, 'a', { t: 'cast', iid: s, targets: B });
    expect(g.cards[mtn].tapped).toBe(true);
    expect(crs.every((i) => g.cards[i].tapped)).toBe(true);
    expect(g.log.map((l) => l.text).join('\n')).toMatch(/Monastery Swiftspear for \{R\}/);
    drain(g, ctx);
    expect(life(g, 'b')).toBe(16);
    expect(Object.values(g.players[0].manaPool).every((v) => !v)).toBe(true);
  });

  it('two red creatures alone pay {R}{R}; non-red creatures cannot', () => {
    const { g, ctx } = setup(['test_stoke_the_flames', 'monastery_swiftspear', 'goblin_guide', 'thraben_inspector', 'esper_sentinel'], 'basic_plains');
    for (const id of ['thraben_inspector', 'esper_sentinel']) put(g, ctx, 'a', id);
    put(g, ctx, 'a', 'basic_plains'); put(g, ctx, 'a', 'basic_plains');
    const s = toHand(g, ctx, 'a', 'test_stoke_the_flames');
    expect(castability(g, 'a', s, getCard).ok).toBe(false); // 4 sources but no red
    put(g, ctx, 'a', 'monastery_swiftspear');
    put(g, ctx, 'a', 'goblin_guide');
    expect(castability(g, 'a', s, getCard).ok).toBe(true);
    act(g, ctx, 'a', { t: 'cast', iid: s, targets: B });
    drain(g, ctx);
    expect(life(g, 'b')).toBe(16);
  });

  it('a (summoning-sick) green creature can pay a {G/P} symbol (no life paid)', () => {
    const { g, ctx } = setup(['test_phyrexian_convoke', 'llanowar_elves']);
    put(g, ctx, 'a', 'basic_mountain');
    const elf = put(g, ctx, 'a', 'llanowar_elves');
    g.cards[elf].summoningSick = true; // can't tap for mana, but can still convoke
    const s = toHand(g, ctx, 'a', 'test_phyrexian_convoke');
    act(g, ctx, 'a', { t: 'cast', iid: s, targets: B });
    expect(g.cards[elf].tapped).toBe(true);
    drain(g, ctx);
    expect(life(g, 'a')).toBe(20);
    expect(life(g, 'b')).toBe(16);
  });
});

describe('Phyrexian mana', () => {
  it('pays with mana when the color is available', () => {
    const { g, ctx } = setup(['gitaxian_probe'], 'basic_island');
    const isl = put(g, ctx, 'a', 'basic_island');
    const p = toHand(g, ctx, 'a', 'gitaxian_probe');
    const pv = autoPayPreview(g, 'a', p, undefined, undefined, undefined, getCard);
    expect(pv.ok).toBe(true);
    expect(pv.life).toBeUndefined();
    expect(pv.phyrexian).toBe(true);
    act(g, ctx, 'a', { t: 'cast', iid: p, targets: B });
    expect(g.cards[isl].tapped).toBe(true);
    expect(life(g, 'a')).toBe(20);
  });

  it('pays 2 life when the color is not available', () => {
    const { g, ctx } = setup(['gitaxian_probe']);
    const mtn = put(g, ctx, 'a', 'basic_mountain');
    const p = toHand(g, ctx, 'a', 'gitaxian_probe');
    expect(autoPayPreview(g, 'a', p, undefined, undefined, undefined, getCard).life).toBe(2);
    act(g, ctx, 'a', { t: 'cast', iid: p, targets: B });
    expect(g.cards[mtn].tapped).toBe(false);
    expect(life(g, 'a')).toBe(18);
  });

  it('auto-pay does not pay life down to 0, but the player may choose to', () => {
    const { g, ctx } = setup(['gitaxian_probe']);
    g.players[0].life = 2;
    const p = toHand(g, ctx, 'a', 'gitaxian_probe');
    expect(autoPayPreview(g, 'a', p, undefined, undefined, undefined, getCard).ok).toBe(false);
    expect(autoPayPreview(g, 'a', p, undefined, undefined, undefined, getCard, 'life').ok).toBe(true);
    expect(castability(g, 'a', p, getCard).ok).toBe(true);
    expect(applyAction(g, 'a', { t: 'cast', iid: p, targets: B }, ctx)).toMatch(/Not enough mana/);
    g.players[0].life = 3;
    expect(autoPayPreview(g, 'a', p, undefined, undefined, undefined, getCard).ok).toBe(true);
  });

  it("phyrexian: 'life' pays life even when the color is available (and leaves the land untapped)", () => {
    const { g, ctx } = setup(['dismember'], 'basic_swamp');
    const sw = [put(g, ctx, 'a', 'basic_swamp'), put(g, ctx, 'a', 'basic_swamp'), put(g, ctx, 'a', 'basic_swamp')];
    const d = toHand(g, ctx, 'a', 'dismember');
    expect(autoPayPreview(g, 'a', d, undefined, undefined, undefined, getCard).life).toBeUndefined();
    expect(autoPayPreview(g, 'a', d, undefined, undefined, undefined, getCard, 'life').life).toBe(4);
    g.players[0].manaPool.B = 1; // floating mana is not spent on the Phyrexian symbols either
    const plan = planAutoPay(g, 'a', '{1}{B/P}{B/P}', 0, getCard, undefined, undefined, 'life')!;
    expect(plan.lifePaid).toBe(4);
    expect(plan.picks).toHaveLength(1);
    expect(plan.picks[0].pool).toBe(true);
    expect(sw.every((i) => !g.cards[i].tapped)).toBe(true);
  });

  it("casting with phyrexian: 'life' pays life from a full pool", () => {
    const { g, ctx } = setup(['gitaxian_probe'], 'basic_island');
    const isl = put(g, ctx, 'a', 'basic_island');
    const p = toHand(g, ctx, 'a', 'gitaxian_probe');
    act(g, ctx, 'a', { t: 'cast', iid: p, targets: B, phyrexian: 'life' });
    expect(g.cards[isl].tapped).toBe(false);
    expect(life(g, 'a')).toBe(18);
  });
});
