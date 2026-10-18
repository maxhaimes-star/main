/** User-reported bugs (strict mode, real cube scripts). */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  activatedAbilitiesOf, applyAction, createGame, type Ctx, type GameAction, type GameState, manaOptionsFor, moveCard, viewFor,
} from '../src/index.ts';
import { createTokenInstance } from '../src/engine/resolve.ts';
import { effectivePT } from '../src/game/rules.ts';
import { SCRIPTS } from '../src/engine/script.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[], fill = 'basic_mountain') => [...extra, ...Array(40 - extra.length).fill(fill)];

function setup(a: string[] = [], b: string[] = [], fillA = 'basic_mountain', fillB = 'basic_mountain') {
  const ctx: Ctx = { rng: seeded(7), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(a, fillA), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(b, fillB), side: [] },
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
  const all = [...p.zones.hand, ...p.zones.library, ...p.zones.graveyard, ...p.zones.exile];
  const iid = all.find((i) => g.cards[i].cardId === cardId && !skip.includes(i));
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}

function toZone(g: GameState, ctx: Ctx, pid: string, cardId: string, zone: 'hand' | 'graveyard' | 'exile', skip: string[] = []): string {
  const iid = find(g, pid, cardId, skip);
  if (g.cards[iid].zone !== zone) moveCard(g, ctx, iid, zone);
  return iid;
}

function put(g: GameState, ctx: Ctx, pid: string, cardId: string, sick = false): string {
  const iid = find(g, pid, cardId, g.battlefield.slice());
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = sick;
  return iid;
}

/** Answer pending questions for `pid` with the first option (or `pick`). */
function answer(g: GameState, ctx: Ctx, pick?: (q: GameState['pending'][number]) => string) {
  for (let i = 0; i < 10 && g.pending.length; i++) {
    const q = g.pending[0];
    act(g, ctx, q.pid, { t: 'choose', id: q.id, value: pick ? pick(q) : q.options[0].value });
  }
}

function drain(g: GameState, ctx: Ctx, pick?: (q: GameState['pending'][number]) => string) {
  for (let i = 0; i < 30 && (g.stack.length || g.pending.length); i++) {
    if (g.pending.length) { answer(g, ctx, pick); continue; }
    act(g, ctx, g.priority, { t: 'pass' });
  }
}

function treasure(g: GameState, ctx: Ctx, pid: string): string {
  return createTokenInstance(g, ctx, pid, SCRIPTS.tokens.c_a_treasure_sac, false).iid;
}

const card = (iid: string) => [[{ kind: 'card' as const, iid }]];

describe('1: sacrifice-for-mana abilities in strict mode', () => {
  it('a Treasure token has a mana ability and can be sacrificed for mana without fix mode', () => {
    const { g, ctx } = setup();
    const t = treasure(g, ctx, 'a');
    const opts = manaOptionsFor(g, t, getCard);
    expect(opts.length).toBe(5);
    act(g, ctx, 'a', { t: 'activateMana', iid: t, option: opts.find((o) => o.produces === 'U')!.id });
    expect(g.players[0].manaPool.U).toBe(1);
    expect(g.cards[t]?.zone ?? 'gone').not.toBe('battlefield');
  });

  it('auto-pay sacrifices a Treasure when needed', () => {
    const { g, ctx } = setup(['brainstorm']);
    treasure(g, ctx, 'a');
    const bs = toZone(g, ctx, 'a', 'brainstorm', 'hand');
    act(g, ctx, 'a', { t: 'cast', iid: bs });
    expect(g.stack.length).toBe(1);
    expect(g.battlefield.filter((i) => g.cards[i].token?.name === 'Treasure')).toHaveLength(0);
  });

  it('a Clue token can be activated (token abilities)', () => {
    const { g, ctx } = setup();
    const clue = createTokenInstance(g, ctx, 'a', SCRIPTS.tokens.c_a_clue_draw, false).iid;
    for (const iid of g.players[0].zones.hand.slice(0, 2)) act(g, ctx, 'a', { t: 'playLand', iid }), (g.players[0].landsPlayed = 0);
    const hand = g.players[0].zones.hand.length;
    act(g, ctx, 'a', { t: 'activate', iid: clue, text: '', ability: 0 });
    drain(g, ctx);
    expect(g.cards[clue]).toBeUndefined();
    expect(g.players[0].zones.hand.length).toBe(hand + 1);
  });

  it('Lotus Petal: sacrifice for mana in strict mode', () => {
    const { g, ctx } = setup(['lotus_petal']);
    const lp = put(g, ctx, 'a', 'lotus_petal');
    const o = manaOptionsFor(g, lp, getCard).find((x) => x.produces === 'G')!;
    act(g, ctx, 'a', { t: 'activateMana', iid: lp, option: o.id });
    expect(g.players[0].manaPool.G).toBe(1);
    expect(g.cards[lp].zone).toBe('graveyard');
  });
});

describe('2: Deathrite Shaman', () => {
  it('exiles a land card from a graveyard and adds one mana of any color', () => {
    const { g, ctx } = setup(['deathrite_shaman']);
    const drs = put(g, ctx, 'a', 'deathrite_shaman');
    const land = toZone(g, ctx, 'b', 'basic_mountain', 'graveyard');
    act(g, ctx, 'a', { t: 'activate', iid: drs, text: '', ability: 0, targets: card(land) });
    drain(g, ctx, (q) => (q.options.some((o) => o.value === 'B') ? 'B' : q.options[0].value));
    expect(g.cards[land].zone).toBe('exile');
    expect(g.players[0].manaPool.B).toBe(1);
    expect(g.cards[drs].tapped).toBe(true);
  });

  it('exiles an instant: opponent loses 2; exiles a creature: gain 2', () => {
    const { g, ctx } = setup(['deathrite_shaman', 'lightning_bolt', 'basic_swamp', 'basic_forest'], ['giver_of_runes']);
    const drs = put(g, ctx, 'a', 'deathrite_shaman');
    put(g, ctx, 'a', 'basic_swamp');
    put(g, ctx, 'a', 'basic_forest');
    const bolt = toZone(g, ctx, 'a', 'lightning_bolt', 'graveyard');
    act(g, ctx, 'a', { t: 'activate', iid: drs, text: '', ability: 1, targets: card(bolt) });
    drain(g, ctx);
    expect(g.cards[bolt].zone).toBe('exile');
    expect(g.players[1].life).toBe(18);
    g.cards[drs].tapped = false;
    const bears = toZone(g, ctx, 'b', 'giver_of_runes', 'graveyard');
    act(g, ctx, 'a', { t: 'activate', iid: drs, text: '', ability: 2, targets: card(bears) });
    drain(g, ctx);
    expect(g.cards[bears].zone).toBe('exile');
    expect(g.players[0].life).toBe(22);
    expect(activatedAbilitiesOf('deathrite_shaman', 0).map((e) => e.index)).toEqual([0, 1, 2]);
  });
});

/** Pass priority until something needs an answer or the stack is empty. */
function passUntilQuestion(g: GameState, ctx: Ctx) {
  for (let i = 0; i < 10 && g.stack.length && !g.pending.length && !g.players.some((p) => p.peek); i++) act(g, ctx, g.priority, { t: 'pass' });
}

/** Put these cards (by card id, from anywhere) on top of `pid`'s library in this order. */
function stackLibrary(g: GameState, pid: string, ids: string[]): string[] {
  const p = g.players.find((x) => x.pid === pid)!;
  const used: string[] = [];
  const iids = ids.map((id) => {
    const iid = [...p.zones.library, ...p.zones.hand].find((i) => g.cards[i].cardId === id && !used.includes(i))!;
    used.push(iid);
    for (const z of [p.zones.library, p.zones.hand]) { const k = z.indexOf(iid); if (k >= 0) z.splice(k, 1); }
    g.cards[iid].zone = 'library';
    return iid;
  });
  p.zones.library.unshift(...iids);
  return iids;
}

describe('3: Narset, Parter of Veils −2', () => {
  it('puts the chosen noncreature nonland card into hand, reveals it, rest on the bottom', () => {
    const { g, ctx } = setup(['narset_parter_of_veils', 'brainstorm', 'ponder', 'giver_of_runes']);
    const nar = put(g, ctx, 'a', 'narset_parter_of_veils');
    const top = stackLibrary(g, 'a', ['brainstorm', 'giver_of_runes', 'basic_mountain', 'ponder']);
    const abil = activatedAbilitiesOf('narset_parter_of_veils', 0)[0];
    act(g, ctx, 'a', { t: 'activate', iid: nar, text: '', ability: abil.index });
    passUntilQuestion(g, ctx);
    const p = g.players[0];
    expect(g.pending.length, `peek: ${JSON.stringify(p.peek)}`).toBe(1);
    const q = g.pending[0];
    expect(q.pid).toBe('a');
    const opt = q.options.find((o) => o.value === top[3]);
    expect(opt, JSON.stringify(q.options)).toBeTruthy();
    expect(q.options.some((o) => o.value === top[1] || o.value === top[2])).toBe(false);
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: top[3] });
    drain(g, ctx);
    expect(g.cards[top[3]].zone).toBe('hand');
    expect(g.cards[top[3]].revealedTo).toContain('b');
    const v = viewFor(g, 'b');
    expect('hidden' in v.cards[top[3]]).toBe(false);
    for (const i of [top[0], top[1], top[2]]) expect(p.zones.library.slice(-3)).toContain(i);
    expect(p.peek).toBeNull();
  });
});

describe('4: Vampiric Tutor', () => {
  it('puts the chosen card on top after shuffling', () => {
    for (const seed of [1, 2, 3]) {
      const { g, ctx } = setup(['vampiric_tutor', 'basic_swamp', 'brainstorm']);
      ctx.rng = seeded(seed);
      put(g, ctx, 'a', 'basic_swamp');
      const vt = toZone(g, ctx, 'a', 'vampiric_tutor', 'hand');
      act(g, ctx, 'a', { t: 'cast', iid: vt });
      passUntilQuestion(g, ctx);
      const q = g.pending[0];
      expect(q?.pid).toBe('a');
      const bs = q.options.find((o) => g.cards[o.value]?.cardId === 'brainstorm')!;
      expect(bs).toBeTruthy();
      act(g, ctx, 'a', { t: 'choose', id: q.id, value: bs.value });
      drain(g, ctx);
      const top = g.players[0].zones.library[0];
      expect(g.cards[top].cardId).toBe('brainstorm');
      expect(g.players[0].life).toBe(18);
    }
  });
});

describe('5: Bomat Courier', () => {
  it('exiles face down, hidden from everyone; returns them to hand', () => {
    const { g, ctx } = setup(['bomat_courier']);
    const bomat = put(g, ctx, 'a', 'bomat_courier');
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: bomat, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    drain(g, ctx);
    const ex = [...g.players[0].zones.exile];
    expect(ex).toHaveLength(1);
    expect(g.cards[ex[0]].faceDown).toBe(true);
    for (const viewer of ['a', 'b', null]) expect('hidden' in viewFor(g, viewer).cards[ex[0]], String(viewer)).toBe(true);
    // to main 2, activate: discard hand, sacrifice, return the exiled card
    for (let i = 0; i < 20 && g.step !== 'main2'; i++) act(g, ctx, g.priority, { t: 'pass' });
    expect(g.step).toBe('main2');
    const m = g.players[0].zones.hand.find((i) => g.cards[i].cardId === 'basic_mountain')!;
    act(g, ctx, 'a', { t: 'playLand', iid: m });
    act(g, ctx, 'a', { t: 'activate', iid: bomat, text: '', ability: 0 });
    drain(g, ctx);
    expect(g.cards[ex[0]].zone).toBe('hand');
    expect(g.cards[ex[0]].faceDown).toBe(false);
    expect(g.players[0].zones.hand).toEqual([ex[0]]);
    expect(g.cards[bomat].zone).toBe('graveyard');
  });
});

describe('6: Currency Converter', () => {
  function run(discardId: string) {
    const { g, ctx } = setup(['currency_converter', 'basic_island', 'basic_island', 'brainstorm']);
    const cc = put(g, ctx, 'a', 'currency_converter');
    put(g, ctx, 'a', 'basic_island');
    put(g, ctx, 'a', 'basic_island', );
    const target = discardId === 'brainstorm' ? toZone(g, ctx, 'a', 'brainstorm', 'hand') : g.players[0].zones.hand.find((i) => g.cards[i].cardId === 'basic_mountain')!;
    act(g, ctx, 'a', { t: 'activate', iid: cc, text: '', ability: 0 });
    drain(g, ctx, (q) => (q.options.some((o) => o.value === target) ? target : q.options.some((o) => /yes|accept|true/i.test(o.value)) ? q.options.find((o) => /yes|accept|true/i.test(o.value))!.value : q.options[0].value));
    expect(g.cards[target].zone).toBe('exile');
    g.cards[cc].tapped = false;
    act(g, ctx, 'a', { t: 'activate', iid: cc, text: '', ability: 1 });
    drain(g, ctx);
    expect(g.cards[target].zone).toBe('graveyard');
    return g;
  }
  it('a land card: creates a Treasure', () => {
    const g = run('basic_mountain');
    expect(g.battlefield.filter((i) => g.cards[i].token?.name === 'Treasure')).toHaveLength(1);
  });
  it('a nonland card: creates a 2/2 black Rogue', () => {
    const g = run('brainstorm');
    expect(g.battlefield.filter((i) => g.cards[i].token?.name === 'Rogue')).toHaveLength(1);
    expect(g.battlefield.filter((i) => g.cards[i].token?.name === 'Treasure')).toHaveLength(0);
  });
});

describe('7: Broadside Bombardiers (boast, sacrifice another creature or artifact)', () => {
  it('after attacking, sacrifices an artifact and deals 2 + its mana value', () => {
    const { g, ctx } = setup(['broadside_bombardiers', 'boros_signet']);
    const bb = put(g, ctx, 'a', 'broadside_bombardiers', true); // haste
    const signet = put(g, ctx, 'a', 'boros_signet');
    expect(applyAction(g, 'a', { t: 'activate', iid: bb, text: '', ability: 0, targets: [[{ kind: 'player', pid: 'b' }]] }, ctx)).toMatch(/attack/i);
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: bb, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    drain(g, ctx);
    act(g, ctx, 'a', { t: 'activate', iid: bb, text: '', ability: 0, targets: [[{ kind: 'player', pid: 'b' }]] });
    drain(g, ctx, (q) => (q.options.some((o) => o.value === signet) ? signet : q.options[0].value));
    expect(g.cards[signet].zone).toBe('graveyard');
    expect(g.players[1].life).toBe(14); // 2 combat + 2 + 2
    expect(applyAction(g, 'a', { t: 'activate', iid: bb, text: '', ability: 0, targets: [[{ kind: 'player', pid: 'b' }]] }, ctx)).toMatch(/once/);
  });

  it('can sacrifice another creature (Artifact.Other;Creature.Other)', () => {
    const { g, ctx } = setup(['broadside_bombardiers', 'giver_of_runes']);
    const bb = put(g, ctx, 'a', 'broadside_bombardiers', true);
    const giver = put(g, ctx, 'a', 'giver_of_runes');
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: bb, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    drain(g, ctx);
    act(g, ctx, 'a', { t: 'activate', iid: bb, text: '', ability: 0, targets: [[{ kind: 'player', pid: 'b' }]] });
    drain(g, ctx, (q) => (q.options.some((o) => o.value === giver) ? giver : q.options[0].value));
    expect(g.cards[giver].zone).toBe('graveyard');
    expect(g.players[1].life, g.log.slice(-8).map((l) => l.text).join("\n")).toBe(15);
  });
});

describe('8: Nadu, Winged Wisdom', () => {
  it('a creature becoming a target reveals the top card: land onto the battlefield, else into hand; twice per turn', () => {
    const { g, ctx } = setup(['nadu_winged_wisdom', 'giver_of_runes', 'lightning_bolt', 'brainstorm', 'ponder']);
    const nadu = put(g, ctx, 'a', 'nadu_winged_wisdom');
    const giver = put(g, ctx, 'a', 'giver_of_runes');
    put(g, ctx, 'a', 'basic_mountain');
    const bolt = toZone(g, ctx, 'a', 'lightning_bolt', 'hand');
    const [mtn, bs] = stackLibrary(g, 'a', ['basic_mountain', 'brainstorm']);
    // a spell targets Giver of Runes: Mountain onto the battlefield
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: card(giver) });
    expect(g.stack.length, g.log.slice(-5).map((l) => l.text).join('\n')).toBe(2); // bolt + Nadu trigger
    drain(g, ctx);
    expect(g.cards[mtn].zone).toBe('battlefield');
    expect(g.cards[giver].zone).toBe('graveyard');
    // an ability targets Nadu (twice): Brainstorm into hand, then the next card
    const giver2 = put(g, ctx, 'a', 'giver_of_runes');
    const prot = (q: GameState['pending'][number]) => (q.options.find((o) => /red/i.test(o.value + o.label)) ?? q.options[0]).value;
    act(g, ctx, 'a', { t: 'activate', iid: giver2, text: '', ability: 0, targets: card(nadu) });
    expect(g.stack.length).toBe(2);
    drain(g, ctx, prot);
    expect(g.cards[bs].zone).toBe('hand');
    g.cards[giver2].tapped = false;
    act(g, ctx, 'a', { t: 'activate', iid: giver2, text: '', ability: 0, targets: card(nadu) });
    expect(g.stack.length).toBe(2);
    drain(g, ctx, prot);
    const top = g.players[0].zones.library[0];
    g.cards[giver2].tapped = false;
    act(g, ctx, 'a', { t: 'activate', iid: giver2, text: '', ability: 0, targets: card(nadu) });
    expect(g.stack.length).toBe(1); // third time this turn for Nadu: no trigger
    drain(g, ctx, prot);
    expect(g.players[0].zones.library[0]).toBe(top);
  });

  it("an opponent's spell targeting my creature triggers it (I control the trigger)", () => {
    const { g, ctx } = setup(['nadu_winged_wisdom', 'brainstorm', 'ponder', 'basic_island'], ['lightning_bolt']);
    const nadu = put(g, ctx, 'a', 'nadu_winged_wisdom');
    put(g, ctx, 'a', 'basic_island');
    put(g, ctx, 'b', 'basic_mountain');
    const bs = toZone(g, ctx, 'a', 'brainstorm', 'hand');
    const bolt = toZone(g, ctx, 'b', 'lightning_bolt', 'hand');
    const [pd] = stackLibrary(g, 'a', ['ponder']);
    act(g, ctx, 'a', { t: 'cast', iid: bs });
    expect(g.priority).toBe('b');
    act(g, ctx, 'b', { t: 'cast', iid: bolt, targets: card(nadu) });
    expect(g.stack.length, g.log.slice(-4).map((l) => l.text).join('\n')).toBe(3);
    expect(g.stack[2].controller).toBe('a');
    drain(g, ctx);
    expect(g.cards[pd].zone).toBe('hand');
  });

  it('a triggered ability targeting it (Bristly Bill landfall) triggers it', () => {
    const { g, ctx } = setup(['nadu_winged_wisdom', 'bristly_bill_spine_sower', 'brainstorm', 'ponder']);
    const nadu = put(g, ctx, 'a', 'nadu_winged_wisdom');
    put(g, ctx, 'a', 'bristly_bill_spine_sower');
    const [bs] = stackLibrary(g, 'a', ['brainstorm', 'ponder']);
    const land = g.players[0].zones.hand.find((i) => g.cards[i].cardId === 'basic_mountain')!;
    act(g, ctx, 'a', { t: 'playLand', iid: land });
    for (let k = 0; k < 5 && g.pending.length; k++) {
      const q = g.pending[0];
      if (q.targets) act(g, ctx, q.pid, { t: 'chooseTargets', id: q.id, targets: card(nadu) });
      else act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options[0].value });
    }
    expect(g.stack.length, g.log.slice(-4).map((l) => l.text).join('\n')).toBe(2);
    drain(g, ctx);
    expect(g.cards[bs].zone).toBe('hand');
  });

  it('equip triggers it too', () => {
    const { g, ctx } = setup(['nadu_winged_wisdom', 'skullclamp', 'brainstorm', 'ponder']);
    const nadu = put(g, ctx, 'a', 'nadu_winged_wisdom');
    const clamp = put(g, ctx, 'a', 'skullclamp');
    put(g, ctx, 'a', 'basic_mountain');
    const [bs] = stackLibrary(g, 'a', ['brainstorm', 'ponder']);
    const equip = activatedAbilitiesOf('skullclamp', 0).find((e) => /Equip/i.test(e.keyword ?? e.ability.api))!;
    act(g, ctx, 'a', { t: 'activate', iid: clamp, text: '', ability: equip.index, targets: card(nadu) });
    expect(g.stack.length, g.log.slice(-4).map((l) => l.text).join('\n')).toBe(2);
    drain(g, ctx);
    expect(g.cards[bs].zone).toBe('hand');
    expect(g.cards[clamp].attachedTo).toBe(nadu);
  });
});

describe('9: Vicious Rivalry (additional cost: pay X life)', () => {
  it('pays X life and destroys artifacts and creatures with mana value X or less', () => {
    const { g, ctx } = setup(['vicious_rivalry', 'basic_swamp', 'basic_forest', 'giver_of_runes', 'boros_signet', 'nadu_winged_wisdom']);
    for (const id of ['basic_swamp', 'basic_forest', 'basic_mountain', 'basic_mountain']) put(g, ctx, 'a', id);
    const giver = put(g, ctx, 'a', 'giver_of_runes');
    const signet = put(g, ctx, 'a', 'boros_signet');
    const nadu = put(g, ctx, 'a', 'nadu_winged_wisdom');
    const vr = toZone(g, ctx, 'a', 'vicious_rivalry', 'hand');
    act(g, ctx, 'a', { t: 'cast', iid: vr, x: 2 });
    drain(g, ctx);
    expect(g.players[0].life).toBe(18);
    expect(g.cards[giver].zone).toBe('graveyard');
    expect(g.cards[signet].zone).toBe('graveyard');
    expect(g.cards[nadu].zone).toBe('battlefield');
  });

  it("can't pay more life than you have", () => {
    const { g, ctx } = setup(['vicious_rivalry', 'basic_swamp', 'basic_forest']);
    for (const id of ['basic_swamp', 'basic_forest', 'basic_mountain', 'basic_mountain']) put(g, ctx, 'a', id);
    g.players[0].life = 3;
    const vr = toZone(g, ctx, 'a', 'vicious_rivalry', 'hand');
    expect(applyAction(g, 'a', { t: 'cast', iid: vr, x: 5 }, ctx)).toMatch(/life/i);
  });
});

describe('10: attacking planeswalkers', () => {
  it("an attacker attacks the opponent's planeswalker; combat damage removes loyalty", () => {
    const { g, ctx } = setup(['nadu_winged_wisdom', 'narset_parter_of_veils'], ['narset_parter_of_veils']);
    const nadu = put(g, ctx, 'a', 'nadu_winged_wisdom');
    const mine = put(g, ctx, 'a', 'narset_parter_of_veils');
    const pw = put(g, ctx, 'b', 'narset_parter_of_veils');
    expect(g.cards[pw].counters.loyalty).toBe(5);
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    expect(applyAction(g, 'a', { t: 'declareAttacker', iid: nadu, target: mine }, ctx)).toMatch(/own planeswalker/);
    act(g, ctx, 'a', { t: 'declareAttacker', iid: nadu, target: pw });
    expect(viewFor(g, 'b').cards[nadu].attacking).toBe(pw);
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    for (let i = 0; i < 20 && g.step !== 'main2'; i++) act(g, ctx, g.priority, { t: 'pass' });
    expect(g.cards[pw].counters.loyalty).toBe(2); // Nadu is a 3/4
    expect(g.players[1].life).toBe(20);
  });

  it('lethal damage to the planeswalker puts it into the graveyard', () => {
    const { g, ctx } = setup(['broadside_bombardiers', 'nadu_winged_wisdom'], ['narset_parter_of_veils']);
    const a1 = put(g, ctx, 'a', 'nadu_winged_wisdom');
    const a2 = put(g, ctx, 'a', 'broadside_bombardiers');
    const pw = put(g, ctx, 'b', 'narset_parter_of_veils');
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: a1, target: pw });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: a2, target: pw });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    for (let i = 0; i < 20 && g.step !== 'main2'; i++) act(g, ctx, g.priority, { t: 'pass' });
    expect(g.cards[pw].zone).toBe('graveyard');
  });
});

describe('11: fix mode draw tool', () => {
  it('draw is rejected in a rules-enforced game, allowed once fix mode is on', () => {
    const { g, ctx } = setup();
    const n = g.players[0].zones.hand.length;
    expect(applyAction(g, 'a', { t: 'draw', n: 1 }, ctx)).toMatch(/fix mode/);
    act(g, ctx, 'a', { t: 'requestFixMode' });
    act(g, ctx, 'b', { t: 'answerFixMode', accept: true });
    act(g, ctx, 'b', { t: 'draw', n: 1 }); // either player, any time
    act(g, ctx, 'a', { t: 'draw', n: 2 });
    expect(g.players[0].zones.hand.length).toBe(n + 2);
    act(g, ctx, 'a', { t: 'endFixMode' });
    expect(applyAction(g, 'a', { t: 'draw', n: 1 }, ctx)).toMatch(/fix mode/);
  });
});

describe('12: free mulligan (both players agree)', () => {
  function fresh() {
    const ctx: Ctx = { rng: seeded(3), lookup: getCard, now: 0 };
    const g = createGame('g', [
      { pid: 'a', name: 'Alice', deck: deck([]), side: [] },
      { pid: 'b', name: 'Bob', deck: deck([]), side: [] },
    ], 'a', ctx);
    return { g, ctx };
  }

  it('after both agree, the first mulligan keeps seven cards; the second costs one', () => {
    const { g, ctx } = fresh();
    expect(applyAction(g, 'a', { t: 'answerFreeMulligan', accept: true }, ctx)).toBeTruthy();
    act(g, ctx, 'a', { t: 'requestFreeMulligan' });
    expect(g.freeMulligan?.on).toBe(false);
    expect(applyAction(g, 'a', { t: 'answerFreeMulligan', accept: true }, ctx)).toBeTruthy(); // not your own request
    act(g, ctx, 'b', { t: 'answerFreeMulligan', accept: true });
    expect(g.freeMulligan?.on).toBe(true);
    act(g, ctx, 'a', { t: 'mulligan' });
    act(g, ctx, 'a', { t: 'keep' });
    expect(g.players[0].needsBottom).toBe(0);
    act(g, ctx, 'b', { t: 'mulligan' });
    act(g, ctx, 'b', { t: 'mulligan' });
    act(g, ctx, 'b', { t: 'keep' });
    expect(g.players[1].needsBottom).toBe(1);
    act(g, ctx, 'b', { t: 'bottom', iids: [g.players[1].zones.hand[0]] });
    expect(g.phase).toBe('playing');
    expect(g.players[0].zones.hand.length).toBe(7);
    expect(g.players[1].zones.hand.length).toBe(6);
  });

  it('declined: mulligans cost a card as usual; no proposals once the game started', () => {
    const { g, ctx } = fresh();
    act(g, ctx, 'a', { t: 'requestFreeMulligan' });
    act(g, ctx, 'b', { t: 'answerFreeMulligan', accept: false });
    expect(g.freeMulligan).toBeUndefined();
    act(g, ctx, 'a', { t: 'mulligan' });
    act(g, ctx, 'a', { t: 'keep' });
    expect(g.players[0].needsBottom).toBe(1);
    act(g, ctx, 'a', { t: 'bottom', iids: [g.players[0].zones.hand[0]] });
    act(g, ctx, 'b', { t: 'keep' });
    expect(applyAction(g, 'a', { t: 'requestFreeMulligan' }, ctx)).toMatch(/before the game/);
  });
});

const logTail = (g: GameState, n = 10) => g.log.slice(-n).map((l) => l.text).join('\n');

describe('13: Skullclamp draws when the equipped creature dies', () => {
  const equipIdx = () => activatedAbilitiesOf('skullclamp', 0).find((e) => /Equip/i.test(e.keyword ?? e.ability.api))!.index;
  const hand = (g: GameState) => g.players[0].zones.hand.length;
  const equip = (g: GameState, ctx: Ctx, clamp: string, target: string) =>
    act(g, ctx, 'a', { t: 'activate', iid: clamp, text: '', ability: equipIdx(), targets: card(target) });

  it('equipping a 1/1 token kills it (+1/-1): its controller draws 2', () => {
    const { g, ctx } = setup(['skullclamp']);
    const clamp = put(g, ctx, 'a', 'skullclamp');
    put(g, ctx, 'a', 'basic_mountain');
    const tok = createTokenInstance(g, ctx, 'a', SCRIPTS.tokens.w_1_1_soldier, false).iid;
    const n = hand(g);
    equip(g, ctx, clamp, tok);
    drain(g, ctx);
    expect(g.cards[tok]?.zone ?? 'gone').not.toBe('battlefield');
    expect(hand(g), logTail(g)).toBe(n + 2);
    expect(g.cards[clamp].attachedTo).toBeFalsy();
  });

  it('a nontoken 1-toughness creature dies to the equip: draw 2', () => {
    const { g, ctx } = setup(['skullclamp', 'esper_sentinel']);
    const clamp = put(g, ctx, 'a', 'skullclamp');
    put(g, ctx, 'a', 'basic_mountain');
    const giver = put(g, ctx, 'a', 'esper_sentinel');
    const n = hand(g);
    equip(g, ctx, clamp, giver);
    drain(g, ctx);
    expect(g.cards[giver].zone).toBe('graveyard');
    expect(hand(g), logTail(g)).toBe(n + 2);
  });

  it('an equipped 2/2 token (3/1) dies blocked in combat: draw 2', () => {
    const { g, ctx } = setup(['skullclamp'], ['nadu_winged_wisdom']);
    const clamp = put(g, ctx, 'a', 'skullclamp');
    put(g, ctx, 'a', 'basic_mountain');
    const tok = createTokenInstance(g, ctx, 'a', SCRIPTS.tokens.b_2_2_zombie, false).iid;
    g.cards[tok].summoningSick = false;
    const nadu = put(g, ctx, 'b', 'nadu_winged_wisdom');
    equip(g, ctx, clamp, tok);
    drain(g, ctx);
    expect(g.cards[clamp].attachedTo).toBe(tok);
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: tok, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    for (let i = 0; i < 10 && g.step !== 'blockers'; i++) act(g, ctx, g.priority, { t: 'pass' });
    act(g, ctx, 'b', { t: 'declareBlocker', iid: nadu, attacker: tok });
    act(g, ctx, 'b', { t: 'confirmBlockers' });
    const n = hand(g);
    for (let i = 0; i < 30 && g.step !== 'main2'; i++) {
      if (g.pending.length) answer(g, ctx); else act(g, ctx, g.priority, { t: 'pass' });
    }
    drain(g, ctx);
    expect(g.cards[tok]?.zone ?? 'gone').not.toBe('battlefield');
    expect(hand(g), logTail(g, 20)).toBe(n + 2);
  });

  it('the equipped creature destroyed by a spell: draw 2', () => {
    const { g, ctx } = setup(['skullclamp', 'nadu_winged_wisdom'], ['lightning_bolt']);
    const clamp = put(g, ctx, 'a', 'skullclamp');
    put(g, ctx, 'a', 'basic_mountain');
    put(g, ctx, 'b', 'basic_mountain');
    const tok = createTokenInstance(g, ctx, 'a', SCRIPTS.tokens.b_2_2_zombie, false).iid;
    equip(g, ctx, clamp, tok);
    drain(g, ctx);
    const n = hand(g);
    const bolt = toZone(g, ctx, 'b', 'lightning_bolt', 'hand');
    g.priority = 'b'; // b holds priority in a's main phase
    act(g, ctx, 'b', { t: 'cast', iid: bolt, targets: card(tok) });
    drain(g, ctx);
    expect(g.cards[tok]).toBeUndefined();
    expect(hand(g), logTail(g)).toBe(n + 2);
  });
});

describe('13b: other "equipped creature" triggers look back at a creature that died', () => {
  it("Umezawa's Jitte: the equipped creature trades in combat and Jitte still gets two counters", () => {
    const { g, ctx } = setup(['umezawas_jitte'], ['nadu_winged_wisdom']);
    const jitte = put(g, ctx, 'a', 'umezawas_jitte');
    for (let i = 0; i < 2; i++) put(g, ctx, 'a', 'basic_mountain');
    const tok = createTokenInstance(g, ctx, 'a', SCRIPTS.tokens.b_2_2_zombie, false).iid;
    g.cards[tok].summoningSick = false;
    const nadu = put(g, ctx, 'b', 'nadu_winged_wisdom');
    const eq = activatedAbilitiesOf('umezawas_jitte', 0).find((e) => /Equip/i.test(e.keyword ?? e.ability.api))!.index;
    act(g, ctx, 'a', { t: 'activate', iid: jitte, text: '', ability: eq, targets: card(tok) });
    drain(g, ctx);
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: tok, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    for (let i = 0; i < 10 && g.step !== 'blockers'; i++) act(g, ctx, g.priority, { t: 'pass' });
    act(g, ctx, 'b', { t: 'declareBlocker', iid: nadu, attacker: tok });
    act(g, ctx, 'b', { t: 'confirmBlockers' });
    for (let i = 0; i < 30 && g.step !== 'main2'; i++) {
      if (g.pending.length) answer(g, ctx); else act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(g.cards[tok]).toBeUndefined();
    expect(g.cards[jitte].counters.charge, logTail(g)).toBe(2);
  });
});

describe('14: exile, then return transformed (Ajani, Kytheon, Tamiyo)', () => {
  const yes = (q: GameState['pending'][number]) => (q.options.find((o) => /^(yes|exile)/i.test(o.label ?? o.value)) ?? q.options[0]).value;
  const no = (q: GameState['pending'][number]) => (q.options.find((o) => /^(no|decline|skip)/i.test(o.label ?? o.value)) ?? q.options[q.options.length - 1]).value;
  const cats = (g: GameState) => g.battlefield.filter((i) => g.cards[i].token && g.cards[i].controller === 'a').length;

  function ajaniAndCat(b = ['lightning_bolt']) {
    const { g, ctx } = setup(['ajani_nacatl_pariah'], b);
    put(g, ctx, 'b', 'basic_mountain');
    const ajani = put(g, ctx, 'a', 'ajani_nacatl_pariah');
    const cat = createTokenInstance(g, ctx, 'a', SCRIPTS.tokens.w_2_1_cat_warrior, false).iid;
    g.events = []; // no ETB token: put() bypasses the stack
    return { g, ctx, ajani, cat };
  }

  it('Ajani: another Cat dies, he is exiled and returns as Ajani, Nacatl Avenger with 3 loyalty', () => {
    const { g, ctx, ajani, cat } = ajaniAndCat();
    const bolt = toZone(g, ctx, 'b', 'lightning_bolt', 'hand');
    g.priority = 'b';
    act(g, ctx, 'b', { t: 'cast', iid: bolt, targets: card(cat) });
    drain(g, ctx, yes);
    expect(g.cards[ajani].zone, logTail(g)).toBe('battlefield');
    expect(g.cards[ajani].transformed).toBe(true);
    expect(g.cards[ajani].counters.loyalty).toBe(3);
    expect(cats(g), 'the front face ETB must not trigger again').toBe(0);
    expect(g.log.some((l) => /Avenger is put into the graveyard/.test(l.text))).toBe(false);
    // His loyalty abilities work: 0: create a 2/1 Cat Warrior.
    const zero = activatedAbilitiesOf('ajani_nacatl_pariah', 1).find((e) => e.ability.api === 'Token')!;
    act(g, ctx, 'a', { t: 'activate', iid: ajani, text: '', ability: zero.index });
    drain(g, ctx);
    expect(cats(g)).toBe(1);
    expect(g.cards[ajani].counters.loyalty).toBe(3);
  });

  it('Ajani: the Cat dies in combat and he flips; declining keeps him as the 1/2', () => {
    const { g, ctx, ajani, cat } = ajaniAndCat(['nadu_winged_wisdom']);
    g.cards[cat].summoningSick = false;
    const nadu = put(g, ctx, 'b', 'nadu_winged_wisdom');
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: cat, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    for (let i = 0; i < 10 && g.step !== 'blockers'; i++) act(g, ctx, g.priority, { t: 'pass' });
    act(g, ctx, 'b', { t: 'declareBlocker', iid: nadu, attacker: cat });
    act(g, ctx, 'b', { t: 'confirmBlockers' });
    for (let i = 0; i < 30 && g.step !== 'main2'; i++) {
      if (g.pending.length) answer(g, ctx, yes); else act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(g.cards[ajani]).toMatchObject({ zone: 'battlefield', transformed: true });
    expect(g.cards[ajani].counters.loyalty).toBe(3);

    const s2 = ajaniAndCat();
    const bolt = toZone(s2.g, s2.ctx, 'b', 'lightning_bolt', 'hand');
    s2.g.priority = 'b';
    act(s2.g, s2.ctx, 'b', { t: 'cast', iid: bolt, targets: card(s2.cat) });
    drain(s2.g, s2.ctx, no);
    expect(s2.g.cards[s2.ajani]).toMatchObject({ zone: 'battlefield', transformed: false });
  });

  it('Kytheon: attacks with two others, at end of combat returns as Gideon, Battle-Forged with 3 loyalty', () => {
    const { g, ctx } = setup(['kytheon_hero_of_akros', 'esper_sentinel', 'thraben_inspector']);
    const ky = put(g, ctx, 'a', 'kytheon_hero_of_akros');
    const others = [put(g, ctx, 'a', 'esper_sentinel'), put(g, ctx, 'a', 'thraben_inspector')];
    g.events = [];
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    for (const iid of [ky, ...others]) act(g, ctx, 'a', { t: 'declareAttacker', iid, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    for (let i = 0; i < 30 && g.step !== 'main2'; i++) {
      if (g.pending.length) answer(g, ctx, yes); else act(g, ctx, g.priority, { t: 'pass' });
    }
    drain(g, ctx, yes);
    expect(g.cards[ky], logTail(g)).toMatchObject({ zone: 'battlefield', transformed: true });
    expect(g.cards[ky].counters.loyalty).toBe(3);
  });

  it('Tamiyo: the third card drawn in a turn flips her into Tamiyo, Seasoned Scholar with 2 loyalty', () => {
    const { g, ctx } = setup(['tamiyo_inquisitive_student', 'brainstorm'], [], 'basic_island');
    const tam = put(g, ctx, 'a', 'tamiyo_inquisitive_student');
    put(g, ctx, 'a', 'basic_island');
    g.events = [];
    const bs = toZone(g, ctx, 'a', 'brainstorm', 'hand');
    act(g, ctx, 'a', { t: 'cast', iid: bs });
    drain(g, ctx, yes);
    for (let i = 0; i < 5 && g.players[0].needsBottom; i++) answer(g, ctx);
    drain(g, ctx, yes);
    expect(g.cards[tam], logTail(g)).toMatchObject({ zone: 'battlefield', transformed: true });
    expect(g.cards[tam].counters.loyalty).toBe(2);
  });

  it('Ajani, Nacatl Avenger −4: the opponent keeps one artifact, creature, enchantment and planeswalker, sacrifices the rest', () => {
    const { g, ctx } = setup(['ajani_nacatl_pariah'], ['nadu_winged_wisdom', 'esper_sentinel', 'giver_of_runes', 'skullclamp', 'boros_signet']);
    const ajani = put(g, ctx, 'a', 'ajani_nacatl_pariah');
    g.cards[ajani].transformed = true;
    g.cards[ajani].counters.loyalty = 5;
    const bs = ['nadu_winged_wisdom', 'esper_sentinel', 'giver_of_runes', 'skullclamp', 'boros_signet', 'basic_mountain'].map((id) => put(g, ctx, 'b', id));
    g.events = [];
    const ult = activatedAbilitiesOf('ajani_nacatl_pariah', 1).find((e) => e.ability.api === 'ChooseCard')!;
    act(g, ctx, 'a', { t: 'activate', iid: ajani, text: '', ability: ult.index });
    drain(g, ctx); // b picks the first option each time
    expect(g.log.some((l) => /by hand|Not automated/i.test(l.text)), logTail(g)).toBe(false);
    const left = bs.filter((x) => g.cards[x].zone === 'battlefield');
    // Esper Sentinel is an artifact creature: it can be kept for both; the land always stays.
    expect(left, logTail(g)).toContain(bs[5]);
    expect(left.length).toBeLessThanOrEqual(3);
    expect(left.length).toBeGreaterThanOrEqual(2);
    expect(g.cards[ajani].counters.loyalty).toBe(1);
  });

  it("Tamiyo, Seasoned Scholar +2: until her controller's next turn, a creature attacking her or him gets -1/-0", () => {
    const { g, ctx } = setup(['tamiyo_inquisitive_student'], ['nadu_winged_wisdom', 'esper_sentinel']);
    const tam = put(g, ctx, 'a', 'tamiyo_inquisitive_student');
    g.cards[tam].transformed = true;
    g.cards[tam].counters.loyalty = 2;
    const nadu = put(g, ctx, 'b', 'nadu_winged_wisdom');
    const sentinel = put(g, ctx, 'b', 'esper_sentinel');
    g.events = [];
    const plus = activatedAbilitiesOf('tamiyo_inquisitive_student', 1).find((e) => e.ability.api === 'Effect')!;
    act(g, ctx, 'a', { t: 'activate', iid: tam, text: '', ability: plus.index });
    drain(g, ctx);
    expect(g.cards[tam].counters.loyalty).toBe(4);
    for (let i = 0; i < 40 && !(g.activePlayer === 'b' && g.step === 'main1'); i++) {
      if (g.pending.length) answer(g, ctx); else act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(g.activePlayer).toBe('b');
    act(g, ctx, 'b', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'b', { t: 'declareAttacker', iid: nadu, target: 'a' });
    act(g, ctx, 'b', { t: 'declareAttacker', iid: sentinel, target: tam });
    act(g, ctx, 'b', { t: 'confirmAttackers' });
    drain(g, ctx);
    expect(g.log.some((l) => /by hand/i.test(l.text)), logTail(g)).toBe(false);
    expect(effectivePT(g.cards[nadu], getCard, g)[0], logTail(g)).toBe(2); // 3/4 -> 2/4
    expect(effectivePT(g.cards[sentinel], getCard, g)[0]).toBe(0);
  });
});
