import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  abilityUsability, activatedAbilitiesOf, applyAction, autoPayPreview, castability, createGame, type Ctx, type GameAction, type GameState, landPlaysLeft, moveCard, solveMana,
} from '../src/index.ts';
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

/** Find a card by id anywhere the owner has it (library / hand / ...). */
function find(g: GameState, pid: string, cardId: string, skip: string[] = []): string {
  const p = g.players.find((x) => x.pid === pid)!;
  const all = [...p.zones.hand, ...p.zones.library, ...p.zones.graveyard];
  const iid = all.find((i) => g.cards[i].cardId === cardId && !skip.includes(i));
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}

function toHand(g: GameState, ctx: Ctx, pid: string, cardId: string, skip: string[] = []): string {
  const iid = find(g, pid, cardId, skip);
  if (g.cards[iid].zone !== 'hand') moveCard(g, ctx, iid, 'hand');
  return iid;
}

/** Put a permanent onto the battlefield (test setup), not summoning sick. */
function put(g: GameState, ctx: Ctx, pid: string, cardId: string, sick = false): string {
  const used = g.battlefield.slice();
  const iid = find(g, pid, cardId, used);
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = sick;
  return iid;
}

/** Both players pass until the stack is empty (attack triggers ...). */
function drain(g: GameState, ctx: Ctx) {
  for (let i = 0; i < 20 && g.stack.length && !g.pending.length; i++) act(g, ctx, g.priority, { t: 'pass' });
}

const P = (pid: string) => [[{ kind: 'player' as const, pid }]];

describe('strict: lands', () => {
  it('rejects a second land drop', () => {
    const { g, ctx } = setup();
    expect(g.strict).toBe(true);
    const [m1, m2] = g.players[0].zones.hand.filter((i) => g.cards[i].cardId === 'basic_mountain');
    expect(landPlaysLeft(g, 'a')).toBe(1);
    act(g, ctx, 'a', { t: 'playLand', iid: m1 });
    expect(landPlaysLeft(g, 'a')).toBe(0);
    expect(applyAction(g, 'a', { t: 'playLand', iid: m2 }, ctx)).toMatch(/already played a land/);
    expect(castability(g, 'a', m2, getCard).ok).toBe(false);
  });

  it('Exploration allows two land drops', () => {
    const { g, ctx } = setup(['exploration']);
    put(g, ctx, 'a', 'exploration');
    act(g, ctx, 'a', { t: 'setStops', own: ['main1', 'main2'], opp: ['end'] }); // any action: re-evaluates
    const lands = g.players[0].zones.hand.filter((i) => g.cards[i].cardId === 'basic_mountain');
    expect(landPlaysLeft(g, 'a')).toBe(2);
    act(g, ctx, 'a', { t: 'playLand', iid: lands[0] });
    act(g, ctx, 'a', { t: 'playLand', iid: lands[1] });
    expect(applyAction(g, 'a', { t: 'playLand', iid: lands[2] }, ctx)).toMatch(/already played/);
  });

  it("can't play a land on the opponent's turn", () => {
    const { g, ctx } = setup();
    const m = g.players[1].zones.hand.find((i) => g.cards[i].cardId === 'basic_mountain')!;
    expect(applyAction(g, 'b', { t: 'playLand', iid: m }, ctx)).toBeTruthy();
  });
});

describe('strict: casting and auto-pay', () => {
  it("can't cast Lightning Bolt without a red source", () => {
    const { g, ctx } = setup(['lightning_bolt'], [], 'basic_island');
    const isl = g.players[0].zones.hand.find((i) => g.cards[i].cardId === 'basic_island')!;
    act(g, ctx, 'a', { t: 'playLand', iid: isl });
    const bolt = toHand(g, ctx, 'a', 'lightning_bolt');
    const c = castability(g, 'a', bolt, getCard);
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/Not enough mana/);
    expect(applyAction(g, 'a', { t: 'cast', iid: bolt, targets: P('b') }, ctx)).toMatch(/Not enough mana/);
    expect(g.cards[bolt].zone).toBe('hand');
    expect(g.cards[isl].tapped).toBe(false);
  });

  it('auto-pay taps a Mountain, opponent gets priority, bolt resolves', () => {
    const { g, ctx } = setup(['lightning_bolt']);
    const m = g.players[0].zones.hand.find((i) => g.cards[i].cardId === 'basic_mountain')!;
    act(g, ctx, 'a', { t: 'playLand', iid: m });
    const bolt = toHand(g, ctx, 'a', 'lightning_bolt');
    expect(castability(g, 'a', bolt, getCard).ok).toBe(true);
    expect(autoPayPreview(g, 'a', bolt, undefined, undefined, undefined, getCard).taps).toEqual([{ iid: m, mana: 'R' }]);
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: P('b') });
    expect(g.cards[m].tapped).toBe(true);
    expect(g.priority).toBe('b');
    // the caster can't act without priority
    expect(applyAction(g, 'a', { t: 'pass' }, ctx)).toMatch(/priority/);
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.players[1].life).toBe(17);
    expect(g.players[0].manaPool.R ?? 0).toBe(0);
  });

  it('chooses lands well for {1}{U}{B} with duals and basics', () => {
    const { g, ctx } = setup(['ashiok_nightmare_weaver', 'underground_sea', 'basic_island', 'basic_swamp']);
    const sea = put(g, ctx, 'a', 'underground_sea');
    const isl = put(g, ctx, 'a', 'basic_island');
    const sw = put(g, ctx, 'a', 'basic_swamp');
    const mtn = put(g, ctx, 'a', 'basic_mountain');
    const ash = toHand(g, ctx, 'a', 'ashiok_nightmare_weaver');
    const pv = autoPayPreview(g, 'a', ash, undefined, undefined, undefined, getCard);
    expect(pv.ok).toBe(true);
    expect(pv.taps.map((t) => t.iid).sort()).toEqual([isl, sw, mtn].sort()); // keeps the Underground Sea open
    act(g, ctx, 'a', { t: 'cast', iid: ash });
    expect(g.cards[sea].tapped).toBe(false);
    expect([isl, sw, mtn].every((i) => g.cards[i].tapped)).toBe(true);
    // backtracking: the only U source is the dual, B must come from elsewhere
    const s2 = solveMana('{1}{U}{B}', 0, [
      { key: 'sea', options: [{ id: 'U', produces: 'U', penalty: 0 }, { id: 'B', produces: 'B', penalty: 0 }] },
      { key: 'bad', options: [{ id: 'B', produces: 'B', penalty: 0 }, { id: 'R', produces: 'R', penalty: 0 }] },
      { key: 'mtn', options: [{ id: 'R', produces: 'R', penalty: 0 }] },
    ]);
    expect(s2?.picks.map((p) => `${p.key}:${p.option}`).sort()).toEqual(['bad:B', 'mtn:R', 'sea:U']);
  });

  it('Phyrexian mana: pays with mana when possible, else 2 life', () => {
    const { g, ctx } = setup(['gitaxian_probe', 'gitaxian_probe'], [], 'basic_mountain');
    const probe = toHand(g, ctx, 'a', 'gitaxian_probe');
    act(g, ctx, 'a', { t: 'cast', iid: probe, targets: P('b') });
    expect(g.players[0].life).toBe(18);
    act(g, ctx, 'b', { t: 'pass' });
    const isl = put(g, ctx, 'a', 'basic_mountain'); // a Mountain doesn't help
    const probe2 = toHand(g, ctx, 'a', 'gitaxian_probe', [probe]);
    act(g, ctx, 'a', { t: 'cast', iid: probe2, targets: P('b') });
    expect(g.players[0].life).toBe(16);
    expect(g.cards[isl].tapped).toBe(false);
  });

  it('Phyrexian mana uses an Island when there is one', () => {
    const { g, ctx } = setup(['gitaxian_probe', 'basic_island']);
    const isl = put(g, ctx, 'a', 'basic_island');
    const probe = toHand(g, ctx, 'a', 'gitaxian_probe');
    act(g, ctx, 'a', { t: 'cast', iid: probe, targets: P('b') });
    expect(g.players[0].life).toBe(20);
    expect(g.cards[isl].tapped).toBe(true);
  });

  it('X spells cost X more', () => {
    const { g, ctx } = setup(['rolling_earthquake']);
    const lands = [put(g, ctx, 'a', 'basic_mountain'), put(g, ctx, 'a', 'basic_mountain'), put(g, ctx, 'a', 'basic_mountain')];
    const eq = toHand(g, ctx, 'a', 'rolling_earthquake');
    expect(applyAction(g, 'a', { t: 'cast', iid: eq, x: 3 }, ctx)).toMatch(/Not enough mana/);
    act(g, ctx, 'a', { t: 'cast', iid: eq, x: 2 });
    expect(lands.every((i) => g.cards[i].tapped)).toBe(true);
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.players[1].life).toBe(18);
  });

  it("can't cast a sorcery on the opponent's turn / while a spell is on the stack", () => {
    const { g, ctx } = setup(['lightning_bolt'], ['rolling_earthquake']);
    put(g, ctx, 'a', 'basic_mountain');
    put(g, ctx, 'b', 'basic_mountain');
    put(g, ctx, 'b', 'basic_mountain');
    const bolt = toHand(g, ctx, 'a', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: P('b') });
    const eq = toHand(g, ctx, 'b', 'rolling_earthquake');
    expect(g.priority).toBe('b');
    expect(applyAction(g, 'b', { t: 'cast', iid: eq, x: 1 }, ctx)).toMatch(/sorcery/);
  });

  it('mana creatures need to be free of summoning sickness', () => {
    const { g, ctx } = setup(['birds_of_paradise', 'exploration']);
    const birds = put(g, ctx, 'a', 'birds_of_paradise', true);
    const ex = toHand(g, ctx, 'a', 'exploration');
    expect(applyAction(g, 'a', { t: 'activateMana', iid: birds, option: '0:G' }, ctx)).toMatch(/summoning sickness/);
    expect(castability(g, 'a', ex, getCard).ok).toBe(false);
    g.cards[birds].summoningSick = false;
    expect(castability(g, 'a', ex, getCard).ok).toBe(true);
    act(g, ctx, 'a', { t: 'cast', iid: ex });
    expect(g.cards[birds].tapped).toBe(true);
  });
});

describe('strict: abilities and alternative payments', () => {
  it('activated abilities auto-pay; {T} abilities need no summoning sickness', () => {
    const { g, ctx } = setup(['umezawas_jitte', 'goblin_guide', 'grim_monolith']);
    const j = put(g, ctx, 'a', 'umezawas_jitte');
    const gg = put(g, ctx, 'a', 'goblin_guide');
    const m1 = put(g, ctx, 'a', 'basic_mountain');
    const equip = activatedAbilitiesOf('umezawas_jitte', 0).find((e) => e.keyword === 'Equip')!.index;
    expect(abilityUsability(g, 'a', j, equip, getCard)).toMatchObject({ ok: false, reason: 'Not enough mana' });
    expect(applyAction(g, 'a', { t: 'activate', iid: j, text: '', ability: equip, targets: [[{ kind: 'card', iid: gg }]] }, ctx)).toMatch(/Not enough mana/);
    const m2 = put(g, ctx, 'a', 'basic_mountain');
    expect(abilityUsability(g, 'a', j, equip, getCard).ok).toBe(true);
    act(g, ctx, 'a', { t: 'activate', iid: j, text: '', ability: equip, targets: [[{ kind: 'card', iid: gg }]] });
    expect(g.cards[m1].tapped && g.cards[m2].tapped).toBe(true);
    drain(g, ctx);
    expect(g.cards[j].attachedTo).toBe(gg);
  });

  it('delve: exile from the graveyard, the rest is auto-paid', () => {
    const { g, ctx } = setup(['treasure_cruise', 'basic_island']);
    const isl = put(g, ctx, 'a', 'basic_island');
    const gy: string[] = [];
    for (let k = 0; k < 7; k++) { const i = g.players[0].zones.library.find((x) => g.cards[x].cardId === 'basic_mountain')!; moveCard(g, ctx, i, 'graveyard'); gy.push(i); }
    const tc = toHand(g, ctx, 'a', 'treasure_cruise');
    expect(castability(g, 'a', tc, getCard).ok).toBe(true);
    act(g, ctx, 'a', { t: 'cast', iid: tc });
    for (let k = 0; k < 7; k++) act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: gy[k] });
    expect(g.pending).toHaveLength(0);
    expect(g.cards[isl].tapped).toBe(true);
  });
});

describe('strict: combat', () => {
  function toAttackers(g: GameState, ctx: Ctx) {
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    expect(g.step).toBe('attackers');
  }

  it("can't attack with a summoning-sick creature (haste can)", () => {
    const { g, ctx } = setup(['stoneforge_mystic', 'goblin_guide']);
    const sfm = put(g, ctx, 'a', 'stoneforge_mystic', true);
    const gg = put(g, ctx, 'a', 'goblin_guide', true);
    toAttackers(g, ctx);
    expect(applyAction(g, 'a', { t: 'declareAttacker', iid: sfm, target: 'b' }, ctx)).toMatch(/summoning sickness/);
    act(g, ctx, 'a', { t: 'declareAttacker', iid: gg, target: 'b' });
    act(g, ctx, 'a', { t: 'pass' }); // confirm attackers
    drain(g, ctx); // Goblin Guide's attack trigger
    for (let i = 0; i < 5 && g.step !== 'main2'; i++) act(g, ctx, g.priority, { t: 'pass' });
    // Bob has no creatures: no blocks to declare, damage is dealt automatically
    expect(g.players[1].life).toBe(18);
  });

  it('menace needs two blockers; flying is blocked only by flying / reach', () => {
    const { g, ctx } = setup(['generous_plunderer', 'birds_of_paradise'], ['stoneforge_mystic', 'goblin_guide', 'birds_of_paradise']);
    const men = put(g, ctx, 'a', 'generous_plunderer');
    const fly = put(g, ctx, 'a', 'birds_of_paradise');
    const b1 = put(g, ctx, 'b', 'stoneforge_mystic');
    const b2 = put(g, ctx, 'b', 'goblin_guide');
    const birds = put(g, ctx, 'b', 'birds_of_paradise');
    toAttackers(g, ctx);
    act(g, ctx, 'a', { t: 'declareAttacker', iid: men, target: 'b' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: fly, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    drain(g, ctx);
    for (let i = 0; i < 3 && g.step !== 'blockers'; i++) act(g, ctx, g.priority, { t: 'pass' });
    expect(g.step).toBe('blockers');
    expect(g.priority).toBe('b');
    expect(applyAction(g, 'b', { t: 'declareBlocker', iid: b1, attacker: fly }, ctx)).toMatch(/flying/);
    act(g, ctx, 'b', { t: 'declareBlocker', iid: birds, attacker: fly });
    act(g, ctx, 'b', { t: 'declareBlocker', iid: b1, attacker: men });
    expect(applyAction(g, 'b', { t: 'confirmBlockers' }, ctx)).toMatch(/menace/);
    expect(applyAction(g, 'b', { t: 'pass' }, ctx)).toMatch(/menace/);
    act(g, ctx, 'b', { t: 'declareBlocker', iid: b2, attacker: men });
    act(g, ctx, 'b', { t: 'confirmBlockers' });
    expect(g.log.some((l) => /^Bob blocks: .*Stoneforge.*Goblin Guide|^Bob blocks: .*Goblin Guide.*Stoneforge/.test(l.text) || /^Bob blocks:/.test(l.text))).toBe(true);
    expect(g.step).not.toBe('blockers');
  });
});

describe('strict: state-based actions', () => {
  it('a player at 0 life loses and the game ends', () => {
    const { g, ctx } = setup(['lightning_bolt']);
    put(g, ctx, 'a', 'basic_mountain');
    g.players[1].life = 3;
    const bolt = toHand(g, ctx, 'a', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: P('b') });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.phase).toBe('over');
    expect(g.winner).toBe('a');
    expect(g.players[1].lost).toMatch(/life/);
  });

  it('drawing from an empty library loses', () => {
    const { g, ctx } = setup();
    for (const iid of [...g.players[1].zones.library]) moveCard(g, ctx, iid, 'exile');
    act(g, ctx, 'a', { t: 'nextTurn' }); // pass until end of turn
    while (g.phase === 'playing' && g.activePlayer === 'a') act(g, ctx, g.priority, { t: 'pass' });
    expect(g.phase).toBe('over');
    expect(g.winner).toBe('a');
    expect(g.players[1].lost).toMatch(/empty library/);
  });

  it('legend rule: the controller chooses which one stays', () => {
    const { g, ctx } = setup(['super_shredder', 'super_shredder']);
    const one = put(g, ctx, 'a', 'super_shredder');
    const two = put(g, ctx, 'a', 'super_shredder');
    act(g, ctx, 'a', { t: 'setStops', own: ['main1', 'main2'], opp: ['end'] });
    const q = g.pending.find((p) => p.data.kind === 'legend')!;
    expect(q.pid).toBe('a');
    expect(applyAction(g, 'a', { t: 'pass' }, ctx)).toMatch(/Waiting/);
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: two });
    expect(g.cards[two].zone).toBe('battlefield');
    expect(g.cards[one].zone).toBe('graveyard');
  });

  it('lethal damage and -1/-1 counters; counters annihilate', () => {
    const { g, ctx } = setup(['goblin_guide', 'stoneforge_mystic']);
    const gg = put(g, ctx, 'a', 'goblin_guide');
    const sfm = put(g, ctx, 'a', 'stoneforge_mystic');
    g.cards[gg].counters = { '+1/+1': 2, '-1/-1': 1 };
    g.cards[sfm].damage = 2;
    act(g, ctx, 'a', { t: 'setStops', own: ['main1', 'main2'], opp: ['end'] });
    expect(g.cards[gg].counters).toEqual({ '+1/+1': 1 });
    expect(g.cards[sfm].zone).toBe('graveyard');
  });
});

describe('strict: manual tools and turn flow', () => {
  it('manual move is rejected unless fix mode is on', () => {
    const { g, ctx } = setup();
    const iid = g.players[0].zones.hand[0];
    expect(applyAction(g, 'a', { t: 'move', iid, to: 'battlefield' }, ctx)).toMatch(/fix mode/);
    expect(applyAction(g, 'a', { t: 'life', pid: 'b', delta: -5 }, ctx)).toMatch(/fix mode/);
    expect(applyAction(g, 'a', { t: 'cast', iid, force: true }, ctx)).toMatch(/fix mode/);
    act(g, ctx, 'a', { t: 'requestFixMode' });
    expect(g.fixMode).toEqual({ on: false, requestedBy: 'a' });
    expect(applyAction(g, 'a', { t: 'answerFixMode', accept: true }, ctx)).toBeTruthy(); // the other player answers
    act(g, ctx, 'b', { t: 'answerFixMode', accept: true });
    expect(g.fixMode?.on).toBe(true);
    act(g, ctx, 'a', { t: 'move', iid, to: 'battlefield' });
    expect(g.cards[iid].zone).toBe('battlefield');
    act(g, ctx, 'b', { t: 'endFixMode' });
    const other = g.players[0].zones.hand[0];
    expect(applyAction(g, 'a', { t: 'move', iid: other, to: 'graveyard' }, ctx)).toMatch(/fix mode/);
  });

  it('cleanup: discard down to seven via a choice', () => {
    const { g, ctx } = setup();
    // Alice has 7 (no draw on the play): give her two more
    toHand(g, ctx, 'a', 'basic_mountain', g.players[0].zones.hand);
    toHand(g, ctx, 'a', 'basic_mountain', g.players[0].zones.hand);
    expect(g.players[0].zones.hand).toHaveLength(9);
    act(g, ctx, 'a', { t: 'nextTurn' });
    while (!g.pending.length && g.activePlayer === 'a') act(g, ctx, g.priority, { t: 'pass' });
    const q = g.pending[0];
    expect(q.data.kind).toBe('cleanupDiscard');
    expect(q.pid).toBe('a');
    expect(g.step).toBe('cleanup');
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: g.players[0].zones.hand[0] });
    const q2 = g.pending[0];
    expect(q2.data.kind).toBe('cleanupDiscard');
    act(g, ctx, 'a', { t: 'choose', id: q2.id, value: g.players[0].zones.hand[0] });
    expect(g.players[0].zones.hand).toHaveLength(7);
    expect(g.players[0].zones.graveyard).toHaveLength(2);
    expect(g.activePlayer).toBe('b');
    expect(g.players[1].zones.hand).toHaveLength(8); // Bob drew
  });

  it('non-strict games keep the manual tools', () => {
    const ctx: Ctx = { rng: seeded(3), lookup: getCard, now: 0 };
    const g = createGame('g', [
      { pid: 'a', name: 'A', deck: deck([]), side: [] }, { pid: 'b', name: 'B', deck: deck([]), side: [] },
    ], 'a', ctx, { strict: false });
    act(g, ctx, 'a', { t: 'keep' });
    act(g, ctx, 'b', { t: 'keep' });
    act(g, ctx, 'a', { t: 'life', pid: 'b', delta: -25 });
    expect(g.phase).toBe('playing');
  });
});
