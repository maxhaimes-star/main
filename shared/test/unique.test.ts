import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import { hasKeyword,
  activatedAbilitiesOf, applyAction, createGame, type Ctx, type GameAction, type GameState, manaOptionsFor, moveCard, viewFor, isHidden,
} from '../src/index.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[]) => [...extra, ...Array(40 - extra.length).fill('basic_mountain')];

function setup(aCards: string[], bCards: string[] = [], seed = 5) {
  const ctx: Ctx = { rng: seeded(seed), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(aCards), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(bCards), side: [] },
  ], 'a', ctx, { strict: false });
  act(g, ctx, 'a', { t: 'keep' });
  act(g, ctx, 'b', { t: 'keep' });
  return { g, ctx };
}

function act(g: GameState, ctx: Ctx, pid: string, action: GameAction) {
  const err = applyAction(g, pid, action, ctx);
  if (err) throw new Error(err);
}

const P = (g: GameState, pid: string) => g.players.find((p) => p.pid === pid)!;

function find(g: GameState, pid: string, cardId: string, skip: string[] = []): string {
  const p = P(g, pid);
  const iid = [p.zones.library, p.zones.hand, p.zones.graveyard, p.zones.exile].flat().find((i) => g.cards[i].cardId === cardId && !skip.includes(i));
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}
function tutor(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId);
  if (g.cards[iid].zone !== 'hand') moveCard(g, ctx, iid, 'hand');
  return iid;
}
function put(g: GameState, ctx: Ctx, pid: string, cardId: string, skip: string[] = []): string {
  const iid = find(g, pid, cardId, skip);
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  return iid;
}
/** Silent board setup: drop the events (no triggers). */
function quiet(g: GameState) { g.events = []; g.triggerQueue = []; }
function mana(g: GameState, ctx: Ctx, pid: string, m: string, n = 1) { act(g, ctx, pid, { t: 'addMana', mana: m, n }); }

/** Pass priority until the stack is empty (fails on an open question). */
function resolveAll(g: GameState, ctx: Ctx) {
  for (let k = 0; k < 30 && g.stack.length; k++) {
    if (g.pending.length) throw new Error(`pending: ${g.pending[0].prompt}`);
    act(g, ctx, g.priority, { t: 'pass' });
  }
}
/** Answer the open question with the option whose label matches. */
function answer(g: GameState, ctx: Ctx, match: RegExp | string, as?: string) {
  const q = g.pending[0];
  if (!q) throw new Error('no question');
  const o = typeof match === 'string' ? q.options.find((x) => x.value === match) : q.options.find((x) => match.test(x.label));
  if (!o) throw new Error(`no option ${match} in ${q.prompt}: ${q.options.map((x) => x.label).join(' / ')}`);
  act(g, ctx, as ?? q.pid, { t: 'choose', id: q.id, value: o.value });
}
const player = (pid: string) => ({ kind: 'player' as const, pid });
const cardRef = (iid: string) => ({ kind: 'card' as const, iid });
const logText = (g: GameState) => g.log.map((l) => l.text).join('\n');
const onBf = (g: GameState, pid: string, cardId: string) => g.battlefield.filter((i) => g.cards[i].cardId === cardId && g.cards[i].controller === pid);
const tokens = (g: GameState, pid: string, name: string) => g.battlefield.filter((i) => g.cards[i].token?.name === name && g.cards[i].controller === pid);
/** End the active player's turn (and walk to the next player's main phase). */
function endTurn(g: GameState, ctx: Ctx) { act(g, ctx, g.activePlayer, { t: 'nextTurn' }); }

describe('extra turns', () => {
  it('Time Warp on yourself: Alice, Alice, then Bob', () => {
    const { g, ctx } = setup(['time_warp']);
    const tw = tutor(g, ctx, 'a', 'time_warp');
    mana(g, ctx, 'a', 'U', 2); mana(g, ctx, 'a', 'C', 3);
    act(g, ctx, 'a', { t: 'cast', iid: tw, targets: [[player('a')]] });
    resolveAll(g, ctx);
    expect(g.extraTurns).toEqual(['a']);
    endTurn(g, ctx);
    expect([g.turn, g.activePlayer]).toEqual([2, 'a']);
    endTurn(g, ctx);
    expect([g.turn, g.activePlayer]).toEqual([3, 'b']);
    endTurn(g, ctx);
    expect([g.turn, g.activePlayer]).toEqual([4, 'a']);
  });

  it('extra turn for the opponent keeps the rotation (A, B extra, B, A)', () => {
    const { g, ctx } = setup(['time_warp']);
    const tw = tutor(g, ctx, 'a', 'time_warp');
    act(g, ctx, 'a', { t: 'cast', iid: tw, targets: [[player('b')]], force: true });
    resolveAll(g, ctx);
    const order: string[] = [];
    for (let k = 0; k < 3; k++) { endTurn(g, ctx); order.push(g.activePlayer); }
    expect(order).toEqual(['b', 'b', 'a']);
  });

  it("Alrund's Epiphany + Temporal Mastery stack (LIFO); birds; both exiled", () => {
    const { g, ctx } = setup(['alrunds_epiphany', 'temporal_mastery']);
    const ae = tutor(g, ctx, 'a', 'alrunds_epiphany');
    const tm = tutor(g, ctx, 'a', 'temporal_mastery');
    act(g, ctx, 'a', { t: 'cast', iid: ae, force: true });
    resolveAll(g, ctx);
    act(g, ctx, 'a', { t: 'cast', iid: tm, force: true });
    resolveAll(g, ctx);
    expect(tokens(g, 'a', 'Bird')).toHaveLength(2);
    expect(g.cards[ae].zone).toBe('exile');
    expect(g.cards[tm].zone).toBe('exile');
    expect(g.extraTurns).toEqual(['a', 'a']);
    const order: string[] = [];
    for (let k = 0; k < 3; k++) { endTurn(g, ctx); order.push(g.activePlayer); }
    expect(order).toEqual(['a', 'a', 'b']);
  });

  it('Emrakul: casting it gives an extra turn', () => {
    const { g, ctx } = setup(['emrakul_the_aeons_torn']);
    const em = tutor(g, ctx, 'a', 'emrakul_the_aeons_torn');
    act(g, ctx, 'a', { t: 'cast', iid: em, force: true });
    resolveAll(g, ctx);
    expect(g.cards[em].zone).toBe('battlefield');
    expect(g.extraTurns).toEqual(['a']);
  });
});

describe('mass zone effects', () => {
  it('Upheaval returns every permanent to its owner\'s hand (tokens cease to exist)', () => {
    const { g, ctx } = setup(['upheaval', 'goblin_guide', 'alrunds_epiphany'], ['thraben_inspector']);
    const gg = put(g, ctx, 'a', 'goblin_guide');
    const ti = put(g, ctx, 'b', 'thraben_inspector');
    const lands = [put(g, ctx, 'a', 'basic_mountain'), put(g, ctx, 'b', 'basic_mountain')];
    quiet(g);
    const ae = tutor(g, ctx, 'a', 'alrunds_epiphany');
    act(g, ctx, 'a', { t: 'cast', iid: ae, force: true });
    resolveAll(g, ctx);
    const up = tutor(g, ctx, 'a', 'upheaval');
    act(g, ctx, 'a', { t: 'cast', iid: up, force: true });
    resolveAll(g, ctx);
    expect(g.battlefield).toHaveLength(0);
    expect(g.cards[gg].zone).toBe('hand');
    expect(g.cards[ti]).toMatchObject({ zone: 'hand', owner: 'b' });
    expect(P(g, 'b').zones.hand).toContain(ti);
    for (const l of lands) expect(g.cards[l].zone).toBe('hand');
    expect(g.cards[up].zone).toBe('graveyard');
  });

  it('Timetwister: hands and graveyards shuffled in, everyone draws seven', () => {
    const { g, ctx } = setup(['timetwister', 'lightning_bolt']);
    moveCard(g, ctx, find(g, 'a', 'lightning_bolt'), 'graveyard');
    moveCard(g, ctx, P(g, 'b').zones.hand[0], 'graveyard');
    const tt = tutor(g, ctx, 'a', 'timetwister');
    act(g, ctx, 'a', { t: 'cast', iid: tt, force: true });
    resolveAll(g, ctx);
    expect(P(g, 'a').zones.hand).toHaveLength(7);
    expect(P(g, 'b').zones.hand).toHaveLength(7);
    expect(P(g, 'a').zones.graveyard.map((i) => g.cards[i].cardId)).toEqual(['timetwister']);
    expect(P(g, 'b').zones.graveyard).toHaveLength(0);
    expect(P(g, 'a').zones.library.length + P(g, 'a').zones.hand.length).toBe(39);
  });

  it('Time Spiral: untap up to six lands (choose, then Done), exiled', () => {
    const { g, ctx } = setup(['time_spiral']);
    const lands = [0, 1, 2].map(() => put(g, ctx, 'a', 'basic_mountain'));
    for (const l of lands) g.cards[l].tapped = true;
    quiet(g);
    const ts = tutor(g, ctx, 'a', 'time_spiral');
    act(g, ctx, 'a', { t: 'cast', iid: ts, force: true });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.pending[0].prompt).toMatch(/untap/);
    answer(g, ctx, lands[0]);
    answer(g, ctx, lands[1]);
    answer(g, ctx, 'done');
    expect(lands.map((l) => g.cards[l].tapped)).toEqual([false, false, true]);
    expect(g.cards[ts].zone).toBe('exile');
  });

  it('Balance: lands, hands and creatures go down to the lowest count', () => {
    const { g, ctx } = setup(['balance', 'goblin_guide', 'thraben_inspector'], ['goblin_guide']);
    const aLands = [0, 1, 2].map(() => put(g, ctx, 'a', 'basic_mountain'));
    put(g, ctx, 'b', 'basic_mountain');
    const aG = put(g, ctx, 'a', 'goblin_guide');
    const aT = put(g, ctx, 'a', 'thraben_inspector');
    quiet(g);
    const bal = tutor(g, ctx, 'a', 'balance');
    // Alice: hand 8 - balance = 7, Bob 7 → trim Bob's hand to make him the lowest.
    for (const iid of P(g, 'b').zones.hand.slice(0, 4)) moveCard(g, ctx, iid, 'library');
    act(g, ctx, 'a', { t: 'cast', iid: bal, force: true });
    act(g, ctx, 'b', { t: 'pass' });
    // Lands: Alice sacrifices 2 of 3.
    expect(g.pending[0]).toMatchObject({ pid: 'a' });
    answer(g, ctx, aLands[0]);
    answer(g, ctx, aLands[1]);
    expect(onBf(g, 'a', 'basic_mountain')).toEqual([aLands[2]]);
    // Hands: Alice has 7, Bob 3 → Alice discards 4.
    for (let k = 0; k < 4; k++) { expect(g.pending[0].pid).toBe('a'); answer(g, ctx, /./); }
    expect(P(g, 'a').zones.hand).toHaveLength(3);
    // Creatures: Alice 2, Bob 0 → both sacrificed automatically? (no choice: all must go) — she picks both.
    while (g.pending.length) answer(g, ctx, /./);
    expect(g.cards[aG].zone).toBe('graveyard');
    expect(g.cards[aT].zone).toBe('graveyard');
    expect(g.cards[bal].zone).toBe('graveyard');
  });

  it("Council's Judgment: each player votes; ties exile both", () => {
    const { g, ctx } = setup(['councils_judgment'], ['goblin_guide', 'thraben_inspector']);
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const ti = put(g, ctx, 'b', 'thraben_inspector');
    quiet(g);
    const cj = tutor(g, ctx, 'a', 'councils_judgment');
    act(g, ctx, 'a', { t: 'cast', iid: cj, force: true });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.pending[0].pid).toBe('a');
    expect(g.pending[0].options.map((o) => o.value).sort()).toEqual([gg, ti].sort());
    answer(g, ctx, gg);
    expect(g.pending[0].pid).toBe('b');
    answer(g, ctx, ti);
    expect(g.cards[gg].zone).toBe('exile');
    expect(g.cards[ti].zone).toBe('exile');
  });

  it("Council's Judgment: the most-voted permanent only", () => {
    const { g, ctx } = setup(['councils_judgment'], ['goblin_guide', 'thraben_inspector']);
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const ti = put(g, ctx, 'b', 'thraben_inspector');
    quiet(g);
    const cj = tutor(g, ctx, 'a', 'councils_judgment');
    act(g, ctx, 'a', { t: 'cast', iid: cj, force: true });
    act(g, ctx, 'b', { t: 'pass' });
    answer(g, ctx, gg);
    answer(g, ctx, gg);
    expect(g.cards[gg].zone).toBe('exile');
    expect(g.cards[ti].zone).toBe('battlefield');
  });
});

describe('Mindslaver', () => {
  it('controls the next turn: routing, hidden information, ends afterwards', () => {
    const { g, ctx } = setup(['mindslaver'], ['goblin_guide']);
    const ms = put(g, ctx, 'a', 'mindslaver');
    quiet(g);
    mana(g, ctx, 'a', 'C', 4);
    act(g, ctx, 'a', { t: 'activate', iid: ms, text: '', ability: 0, targets: [[player('b')]] });
    expect(g.cards[ms].zone).toBe('graveyard');
    resolveAll(g, ctx);
    expect(g.controlledBy).toMatchObject({ pid: 'b', by: 'a', active: false });
    // Bob's hand is hidden from Alice before his turn.
    const bHand = P(g, 'b').zones.hand;
    expect(isHidden(viewFor(g, 'a').cards[bHand[0]])).toBe(true);
    endTurn(g, ctx);
    expect(g.activePlayer).toBe('b');
    expect(g.controlledBy).toMatchObject({ active: true });
    // Alice sees Bob's hand; Bob can't act; Alice's actions are Bob's.
    const v = viewFor(g, 'a');
    expect(P(g, 'b').zones.hand.every((i) => !isHidden(v.cards[i]))).toBe(true);
    expect(applyAction(g, 'b', { t: 'pass' }, ctx)).toMatch(/controls you/);
    const land = P(g, 'b').zones.hand.find((i) => g.cards[i].cardId === 'basic_mountain')!;
    act(g, ctx, 'a', { t: 'playLand', iid: land });
    expect(g.cards[land]).toMatchObject({ zone: 'battlefield', controller: 'b' });
    expect(P(g, 'b').landsPlayed).toBe(1);
    // A Goblin Guide cast "by Bob" (Alice controls the decision).
    const gg = tutor(g, ctx, 'b', 'goblin_guide');
    act(g, ctx, 'a', { t: 'cast', iid: gg, force: true });
    expect(g.stack[0].controller).toBe('b');
    resolveAll(g, ctx);
    expect(g.cards[gg]).toMatchObject({ zone: 'battlefield', controller: 'b' });
    // End Bob's turn (as Bob, via Alice): control ends.
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(g.activePlayer).toBe('a');
    expect(g.controlledBy).toBeNull();
    expect(isHidden(viewFor(g, 'a').cards[P(g, 'b').zones.hand[0]])).toBe(true);
    expect(applyAction(g, 'a', { t: 'pass', as: 'b' }, ctx)).toMatch(/don't control/);
  });
});

describe('lands', () => {
  it('Karakas bounces a legendary creature', () => {
    const { g, ctx } = setup(['karakas'], ['ajani_nacatl_pariah']);
    const k = put(g, ctx, 'a', 'karakas');
    const aj = put(g, ctx, 'b', 'ajani_nacatl_pariah');
    quiet(g);
    act(g, ctx, 'a', { t: 'activate', iid: k, text: '', ability: 1, targets: [[cardRef(aj)]] });
    resolveAll(g, ctx);
    expect(g.cards[aj].zone).toBe('hand');
  });

  it('Strip Mine destroys a land', () => {
    const { g, ctx } = setup(['strip_mine']);
    const sm = put(g, ctx, 'a', 'strip_mine');
    const m = put(g, ctx, 'b', 'basic_mountain');
    quiet(g);
    act(g, ctx, 'a', { t: 'activate', iid: sm, text: '', ability: 1, targets: [[cardRef(m)]] });
    resolveAll(g, ctx);
    expect(g.cards[m].zone).toBe('graveyard');
    expect(g.cards[sm].zone).toBe('graveyard');
  });

  it('Dark Depths: remove the last ice counter → Marit Lage', () => {
    const { g, ctx } = setup(['dark_depths']);
    const dd = put(g, ctx, 'a', 'dark_depths');
    quiet(g);
    expect(g.cards[dd].counters.ice).toBe(10);
    g.cards[dd].counters.ice = 2;
    mana(g, ctx, 'a', 'C', 3);
    act(g, ctx, 'a', { t: 'activate', iid: dd, text: '', ability: 0 });
    resolveAll(g, ctx);
    expect(g.cards[dd].counters.ice).toBe(1);
    expect(tokens(g, 'a', 'Marit Lage')).toHaveLength(0);
    mana(g, ctx, 'a', 'C', 3);
    act(g, ctx, 'a', { t: 'activate', iid: dd, text: '', ability: 0 });
    resolveAll(g, ctx); // counter removed → state trigger → sacrifice + token
    expect(g.cards[dd].zone).toBe('graveyard');
    expect(tokens(g, 'a', 'Marit Lage')).toHaveLength(1);
    expect(logText(g)).toMatch(/creates Marit Lage/);
  });

  it('Shelldock Isle: hideaway on entering, then play the card when a library has ≤ 20 cards', () => {
    const { g, ctx } = setup(['shelldock_isle', 'goblin_guide']);
    const gg = find(g, 'a', 'goblin_guide');
    const si = tutor(g, ctx, 'a', 'shelldock_isle');
    // goblin guide on top of the library
    moveCard(g, ctx, gg, 'library');
    act(g, ctx, 'a', { t: 'playLand', iid: si });
    expect(g.cards[si].tapped).toBe(true);
    resolveAll(g, ctx);
    expect(g.pending[0]?.prompt).toMatch(/exile/);
    const top = P(g, 'a').zones.library.slice(0, 4);
    expect(g.pending[0].options.map((o) => o.value)).toEqual(top);
    answer(g, ctx, top[0]);
    const hidden = top[0];
    expect(g.cards[hidden]).toMatchObject({ zone: 'exile', faceDown: true });
    expect(g.remembered?.[si]).toEqual([hidden]);
    expect(isHidden(viewFor(g, 'b').cards[hidden])).toBe(true);
    expect(isHidden(viewFor(g, 'a').cards[hidden])).toBe(false);
    expect(P(g, 'a').zones.library.slice(-3)).toEqual(top.slice(1));
    // Not yet: libraries are big.
    g.cards[si].tapped = false;
    mana(g, ctx, 'a', 'U');
    act(g, ctx, 'a', { t: 'activate', iid: si, text: '', ability: 1 });
    resolveAll(g, ctx);
    expect(g.cards[hidden].zone).toBe('exile');
    expect(logText(g)).toMatch(/condition not met/);
    // Mill Bob down to 20.
    for (const iid of P(g, 'b').zones.library.slice(20)) moveCard(g, ctx, iid, 'graveyard');
    g.cards[si].tapped = false;
    mana(g, ctx, 'a', 'U');
    act(g, ctx, 'a', { t: 'activate', iid: si, text: '', ability: 1 });
    act(g, ctx, 'b', { t: 'pass' });
    answer(g, ctx, 'yes');
    resolveAll(g, ctx);
    expect(g.cards[hidden].zone).toBe('battlefield');
  });

  it("Urza's Saga: lore counters, chapter abilities, tutor, sacrificed after III", () => {
    const { g, ctx } = setup(['urzas_saga', 'senseis_divining_top']);
    const us = tutor(g, ctx, 'a', 'urzas_saga');
    act(g, ctx, 'a', { t: 'playLand', iid: us });
    expect(g.cards[us].counters.lore).toBe(1);
    expect(g.stack[0]?.text).toMatch(/Chapter I/);
    resolveAll(g, ctx);
    expect(manaOptionsFor(g, us).map((o) => o.produces)).toEqual(['C']);
    const construct = activatedAbilitiesOf('urzas_saga', 0).find((a) => a.ability.api === 'Token')!;
    expect(construct).toBeTruthy();
    mana(g, ctx, 'a', 'C', 2);
    expect(applyAction(g, 'a', { t: 'activate', iid: us, text: '', ability: construct.index }, ctx)).toMatch(/chapter II/);
    endTurn(g, ctx); endTurn(g, ctx);
    expect(g.activePlayer).toBe('a');
    expect(g.cards[us].counters.lore).toBe(2);
    resolveAll(g, ctx);
    mana(g, ctx, 'a', 'C', 2);
    act(g, ctx, 'a', { t: 'activate', iid: us, text: '', ability: construct.index });
    resolveAll(g, ctx);
    expect(tokens(g, 'a', 'Construct')).toHaveLength(1);
    g.cards[us].tapped = false;
    endTurn(g, ctx); endTurn(g, ctx);
    expect(g.cards[us].counters.lore).toBe(3);
    act(g, ctx, 'b', { t: 'pass' });
    // Chapter III: search for a {0}/{1} artifact.
    const peek = P(g, 'a').peek!;
    expect(peek.mode).toBe('search');
    const top = find(g, 'a', 'senseis_divining_top');
    act(g, ctx, 'a', { t: 'resolvePeek', top: [], bottom: [], graveyard: [], hand: [], battlefield: [top], exile: [], shuffle: true });
    expect(g.cards[top].zone).toBe('battlefield');
    expect(g.cards[us].zone).toBe('graveyard');
    expect(logText(g)).toMatch(/sacrifices Urza's Saga \(final chapter\)/);
  });

  it('Fable of the Mirror-Breaker: chapter I makes a Goblin Shaman, chapter III flips it', () => {
    const { g, ctx } = setup(['fable_of_the_mirror_breaker']);
    const f = tutor(g, ctx, 'a', 'fable_of_the_mirror_breaker');
    act(g, ctx, 'a', { t: 'cast', iid: f, force: true });
    resolveAll(g, ctx);
    expect(tokens(g, 'a', 'Goblin Shaman')).toHaveLength(1);
    endTurn(g, ctx); endTurn(g, ctx);
    expect(g.cards[f].counters.lore).toBe(2);
    act(g, ctx, 'b', { t: 'pass' });
    // Chapter II: discard up to two, draw that many.
    const hand = P(g, 'a').zones.hand.length;
    answer(g, ctx, /./);
    answer(g, ctx, 'none');
    expect(P(g, 'a').zones.hand.length).toBe(hand);
    expect(P(g, 'a').zones.graveyard).toHaveLength(1);
    endTurn(g, ctx); endTurn(g, ctx);
    resolveAll(g, ctx);
    expect(g.cards[f]).toMatchObject({ zone: 'battlefield', transformed: true });
    expect(logText(g)).not.toMatch(/sacrifices Fable/);
  });
});

describe('enchantments and engines', () => {
  it('Opposition: tap an untapped creature you control to tap target land', () => {
    const { g, ctx } = setup(['opposition', 'goblin_guide', 'thraben_inspector']);
    const op = put(g, ctx, 'a', 'opposition');
    const gg = put(g, ctx, 'a', 'goblin_guide');
    const ti = put(g, ctx, 'a', 'thraben_inspector');
    const m = put(g, ctx, 'b', 'basic_mountain');
    quiet(g);
    act(g, ctx, 'a', { t: 'activate', iid: op, text: '', ability: 0, targets: [[cardRef(m)]] });
    expect(g.pending[0].prompt).toMatch(/tap an untapped creature/);
    answer(g, ctx, ti);
    expect(g.cards[ti].tapped).toBe(true);
    expect(g.cards[gg].tapped).toBe(false);
    resolveAll(g, ctx);
    expect(g.cards[m].tapped).toBe(true);
    // Only Goblin Guide left: paid automatically. No creature left: refused.
    act(g, ctx, 'a', { t: 'activate', iid: op, text: '', ability: 0, targets: [[cardRef(m)]] });
    expect(g.cards[gg].tapped).toBe(true);
    resolveAll(g, ctx);
    expect(applyAction(g, 'a', { t: 'activate', iid: op, text: '', ability: 0, targets: [[cardRef(m)]] }, ctx)).toMatch(/can't tap/);
  });

  it('Oath of Druids: at upkeep, reveal until a creature when an opponent has more creatures', () => {
    const { g, ctx } = setup(['oath_of_druids', 'griselbrand'], ['goblin_guide']);
    put(g, ctx, 'a', 'oath_of_druids');
    put(g, ctx, 'b', 'goblin_guide');
    // Griselbrand 3rd from the top.
    const gb = find(g, 'a', 'griselbrand');
    moveCard(g, ctx, gb, 'library', { position: 2 });
    quiet(g);
    endTurn(g, ctx); // Bob's upkeep: Bob has more creatures than Alice → no trigger for Bob
    expect(g.stack).toHaveLength(0);
    expect(g.pending).toHaveLength(0);
    act(g, ctx, 'b', { t: 'nextTurn' }); // Alice's upkeep
    expect(g.stack[0]?.text).toMatch(/Oath of Druids/);
    resolveAll(g, ctx);
    expect(g.pending[0]).toMatchObject({ pid: 'a' });
    answer(g, ctx, 'yes');
    expect(g.cards[gb]).toMatchObject({ zone: 'battlefield', controller: 'a' });
    expect(P(g, 'a').zones.graveyard.length).toBeGreaterThanOrEqual(2);
  });

  it('Sneak Attack: put a creature onto the battlefield with haste, sacrificed at end of turn', () => {
    const { g, ctx } = setup(['sneak_attack', 'griselbrand']);
    const sa = put(g, ctx, 'a', 'sneak_attack');
    const gb = tutor(g, ctx, 'a', 'griselbrand');
    quiet(g);
    mana(g, ctx, 'a', 'R');
    act(g, ctx, 'a', { t: 'activate', iid: sa, text: '', ability: 0 });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.pending[0].prompt).toMatch(/battlefield/);
    answer(g, ctx, gb);
    expect(g.cards[gb]).toMatchObject({ zone: 'battlefield', controller: 'a' });
    expect(hasKeyword(g.cards[gb], getCard, 'Haste', g)).toBe(true);
    expect(g.delayedTriggers?.length).toBe(1);
    act(g, ctx, 'a', { t: 'gotoStep', step: 'end' });
    resolveAll(g, ctx);
    expect(g.cards[gb].zone).toBe('graveyard');
  });

  it('Recurring Nightmare: sacrifice a creature and return it to hand as costs', () => {
    const { g, ctx } = setup(['recurring_nightmare', 'goblin_guide', 'griselbrand']);
    const rn = put(g, ctx, 'a', 'recurring_nightmare');
    const gg = put(g, ctx, 'a', 'goblin_guide');
    const gb = find(g, 'a', 'griselbrand');
    moveCard(g, ctx, gb, 'graveyard');
    quiet(g);
    act(g, ctx, 'a', { t: 'activate', iid: rn, text: '', ability: 0, targets: [[cardRef(gb)]] });
    expect(g.cards[rn].zone).toBe('hand');
    expect(g.cards[gg].zone).toBe('graveyard');
    resolveAll(g, ctx);
    expect(g.cards[gb].zone).toBe('battlefield');
  });

  it('Library of Alexandria: draw only with exactly seven cards in hand', () => {
    const { g, ctx } = setup(['library_of_alexandria']);
    const lib = put(g, ctx, 'a', 'library_of_alexandria');
    quiet(g);
    while (P(g, 'a').zones.hand.length > 6) moveCard(g, ctx, P(g, 'a').zones.hand[0], 'graveyard');
    expect(applyAction(g, 'a', { t: 'activate', iid: lib, text: '', ability: 1 }, ctx)).toMatch(/exactly|EQ 7|needs/);
    moveCard(g, ctx, P(g, 'a').zones.library[0], 'hand');
    act(g, ctx, 'a', { t: 'activate', iid: lib, text: '', ability: 1 });
    resolveAll(g, ctx);
    expect(P(g, 'a').zones.hand).toHaveLength(8);
  });

  it('Liliana of the Veil −6: separate into piles, the target sacrifices the chosen pile', () => {
    const { g, ctx } = setup(['liliana_of_the_veil'], ['goblin_guide', 'thraben_inspector']);
    const lv = put(g, ctx, 'a', 'liliana_of_the_veil');
    g.cards[lv].counters.loyalty = 6;
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const ti = put(g, ctx, 'b', 'thraben_inspector');
    const m = put(g, ctx, 'b', 'basic_mountain');
    quiet(g);
    act(g, ctx, 'a', { t: 'activate', iid: lv, text: '', ability: 2, targets: [[player('b')]] });
    act(g, ctx, 'b', { t: 'pass' });
    answer(g, ctx, gg);
    answer(g, ctx, 'done');
    expect(g.pending[0].pid).toBe('b');
    answer(g, ctx, 'pile:2');
    expect(g.cards[gg].zone).toBe('battlefield');
    expect(g.cards[ti].zone).toBe('graveyard');
    expect(g.cards[m].zone).toBe('graveyard');
  });

  it('Jace, the Mind Sculptor +2 on the opponent\'s library', () => {
    const { g, ctx } = setup(['jace_the_mind_sculptor']);
    const j = put(g, ctx, 'a', 'jace_the_mind_sculptor');
    quiet(g);
    const top = P(g, 'b').zones.library[0];
    act(g, ctx, 'a', { t: 'activate', iid: j, text: '', ability: 0, targets: [[player('b')]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(viewFor(g, 'b').pending[0].options).toHaveLength(0);
    answer(g, ctx, 'bottom');
    expect(P(g, 'b').zones.library.at(-1)).toBe(top);
  });
});

describe('cube staples work end to end', () => {
  it('Wheel of Fortune, Mind Twist, Armageddon, Terminus', () => {
    const { g, ctx } = setup(['wheel_of_fortune', 'mind_twist', 'armageddon', 'terminus', 'goblin_guide'], ['goblin_guide']);
    const wf = tutor(g, ctx, 'a', 'wheel_of_fortune');
    act(g, ctx, 'a', { t: 'cast', iid: wf, force: true });
    resolveAll(g, ctx);
    expect(P(g, 'a').zones.hand).toHaveLength(7);
    expect(P(g, 'b').zones.hand).toHaveLength(7);
    const mt = tutor(g, ctx, 'a', 'mind_twist');
    act(g, ctx, 'a', { t: 'cast', iid: mt, x: 3, targets: [[player('b')]], force: true });
    resolveAll(g, ctx);
    expect(P(g, 'b').zones.hand).toHaveLength(4);
    const lands = [put(g, ctx, 'a', 'basic_mountain'), put(g, ctx, 'b', 'basic_mountain')];
    const gg = put(g, ctx, 'b', 'goblin_guide');
    quiet(g);
    const ar = tutor(g, ctx, 'a', 'armageddon');
    act(g, ctx, 'a', { t: 'cast', iid: ar, force: true });
    resolveAll(g, ctx);
    for (const l of lands) expect(g.cards[l].zone).toBe('graveyard');
    const te = tutor(g, ctx, 'a', 'terminus');
    act(g, ctx, 'a', { t: 'cast', iid: te, force: true });
    resolveAll(g, ctx);
    expect(P(g, 'b').zones.library.at(-1)).toBe(gg);
  });

  it('Toxic Deluge pays X life; Damn overloaded destroys every creature', () => {
    const { g, ctx } = setup(['toxic_deluge', 'damn', 'goblin_guide'], ['goblin_guide', 'thraben_inspector']);
    const a1 = put(g, ctx, 'a', 'goblin_guide');
    const b1 = put(g, ctx, 'b', 'goblin_guide');
    quiet(g);
    const td = tutor(g, ctx, 'a', 'toxic_deluge');
    act(g, ctx, 'a', { t: 'cast', iid: td, x: 2, force: true });
    expect(P(g, 'a').life).toBe(18);
    resolveAll(g, ctx);
    expect(g.cards[a1].zone).toBe('graveyard');
    expect(g.cards[b1].zone).toBe('graveyard');
    const b2 = put(g, ctx, 'b', 'thraben_inspector');
    quiet(g);
    const dm = tutor(g, ctx, 'a', 'damn');
    act(g, ctx, 'a', { t: 'cast', iid: dm, costOption: 'overload', force: true });
    resolveAll(g, ctx);
    expect(g.cards[b2].zone).toBe('graveyard');
  });

  it('Liliana of the Veil +1 (each player discards) and −2 (edict)', () => {
    const { g, ctx } = setup(['liliana_of_the_veil'], ['goblin_guide']);
    const lv = put(g, ctx, 'a', 'liliana_of_the_veil');
    const gg = put(g, ctx, 'b', 'goblin_guide');
    quiet(g);
    act(g, ctx, 'a', { t: 'activate', iid: lv, text: '', ability: 0 });
    act(g, ctx, 'b', { t: 'pass' });
    answer(g, ctx, /./);
    answer(g, ctx, /./);
    expect(P(g, 'a').zones.graveyard).toHaveLength(1);
    expect(P(g, 'b').zones.graveyard).toHaveLength(1);
    endTurn(g, ctx); endTurn(g, ctx);
    act(g, ctx, 'a', { t: 'activate', iid: lv, text: '', ability: 1, targets: [[player('b')]] });
    resolveAll(g, ctx);
    answer(g, ctx, gg);
    expect(g.cards[gg].zone).toBe('graveyard');
  });

  it('Memory Jar: exile hands face down, draw seven, return them at end of turn', () => {
    const { g, ctx } = setup(['memory_jar']);
    const mj = put(g, ctx, 'a', 'memory_jar');
    quiet(g);
    const aHand = [...P(g, 'a').zones.hand];
    act(g, ctx, 'a', { t: 'activate', iid: mj, text: '', ability: 0 });
    resolveAll(g, ctx);
    for (const iid of aHand) expect(g.cards[iid]).toMatchObject({ zone: 'exile', faceDown: true });
    expect(P(g, 'a').zones.hand).toHaveLength(7);
    act(g, ctx, 'a', { t: 'gotoStep', step: 'end' });
    resolveAll(g, ctx);
    expect([...P(g, 'a').zones.hand].sort()).toEqual([...aHand].sort());
  });

  it('Bazaar of Baghdad, Survival of the Fittest', () => {
    const { g, ctx } = setup(['bazaar_of_baghdad', 'survival_of_the_fittest', 'goblin_guide', 'griselbrand']);
    const bz = put(g, ctx, 'a', 'bazaar_of_baghdad');
    quiet(g);
    const hand = P(g, 'a').zones.hand.length;
    act(g, ctx, 'a', { t: 'activate', iid: bz, text: '', ability: 0 });
    act(g, ctx, 'b', { t: 'pass' });
    for (let k = 0; k < 3; k++) answer(g, ctx, /./);
    expect(P(g, 'a').zones.hand).toHaveLength(hand - 1);
    const sv = put(g, ctx, 'a', 'survival_of_the_fittest');
    const gg = tutor(g, ctx, 'a', 'goblin_guide');
    quiet(g);
    mana(g, ctx, 'a', 'G');
    act(g, ctx, 'a', { t: 'activate', iid: sv, text: '', ability: 0 });
    if (g.pending.length) answer(g, ctx, gg);
    expect(g.cards[gg].zone).toBe('graveyard');
    act(g, ctx, 'b', { t: 'pass' });
    expect(P(g, 'a').peek?.mode).toBe('search');
    const gb = find(g, 'a', 'griselbrand');
    act(g, ctx, 'a', { t: 'resolvePeek', top: [], bottom: [], graveyard: [], hand: [gb], battlefield: [], exile: [], shuffle: true });
    expect(P(g, 'a').zones.hand.some((i) => g.cards[i].cardId === 'griselbrand')).toBe(true);
  });

  it('Through the Breach and Sylvan Library', () => {
    const { g, ctx } = setup(['through_the_breach', 'griselbrand', 'sylvan_library']);
    const gb = tutor(g, ctx, 'a', 'griselbrand');
    const tb = tutor(g, ctx, 'a', 'through_the_breach');
    act(g, ctx, 'a', { t: 'cast', iid: tb, force: true });
    act(g, ctx, 'b', { t: 'pass' });
    answer(g, ctx, gb);
    expect(hasKeyword(g.cards[gb], getCard, 'Haste', g)).toBe(true);
    act(g, ctx, 'a', { t: 'gotoStep', step: 'end' });
    resolveAll(g, ctx);
    expect(g.cards[gb].zone).toBe('graveyard');
    put(g, ctx, 'a', 'sylvan_library');
    quiet(g);
    endTurn(g, ctx);
    act(g, ctx, 'b', { t: 'nextTurn' });
    // Alice's draw step: Sylvan Library
    resolveAll(g, ctx);
    expect(g.pending[0].prompt).toMatch(/draw 2 additional/);
    const life = P(g, 'a').life;
    const hand = P(g, 'a').zones.hand.length;
    answer(g, ctx, 'yes');
    answer(g, ctx, /./); answer(g, ctx, 'pay');
    answer(g, ctx, /./); answer(g, ctx, 'top');
    expect(P(g, 'a').life).toBe(life - 4);
    expect(P(g, 'a').zones.hand.length).toBe(hand + 1);
  });

  it('Scroll Rack exchanges any number of cards with the top of the library', () => {
    const { g, ctx } = setup(['scroll_rack']);
    const sr = put(g, ctx, 'a', 'scroll_rack');
    quiet(g);
    const hand = [...P(g, 'a').zones.hand];
    const top2 = P(g, 'a').zones.library.slice(0, 2);
    mana(g, ctx, 'a', 'C');
    act(g, ctx, 'a', { t: 'activate', iid: sr, text: '', ability: 0 });
    act(g, ctx, 'b', { t: 'pass' });
    answer(g, ctx, hand[0]);
    answer(g, ctx, hand[1]);
    answer(g, ctx, 'none');
    expect(P(g, 'a').zones.hand).toHaveLength(hand.length);
    for (const iid of top2) expect(P(g, 'a').zones.hand).toContain(iid);
    expect(P(g, 'a').zones.library.slice(0, 2).sort()).toEqual(hand.slice(0, 2).sort());
  });

  it('Field of the Dead makes a Zombie with seven differently named lands', () => {
    const lands = ['strip_mine', 'karakas', 'library_of_alexandria', 'bazaar_of_baghdad', 'shelldock_isle', 'dark_depths'];
    const { g, ctx } = setup(['field_of_the_dead', ...lands]);
    for (const l of lands) put(g, ctx, 'a', l);
    quiet(g);
    const fd = tutor(g, ctx, 'a', 'field_of_the_dead');
    act(g, ctx, 'a', { t: 'playLand', iid: fd });
    resolveAll(g, ctx);
    expect(tokens(g, 'a', 'Zombie')).toHaveLength(1);
  });
});
