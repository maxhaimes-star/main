import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import { applyAction, createGame, type Ctx, type GameAction, type GameState, moveCard, viewFor } from '../src/index.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[]) => [...extra, ...Array(40 - extra.length).fill('basic_mountain')];

function setup(aCards: string[], bCards: string[] = []) {
  const ctx: Ctx = { rng: seeded(7), lookup: getCard, now: 0 };
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

function find(g: GameState, pid: string, cardId: string): string {
  const p = P(g, pid);
  return [p.zones.library, p.zones.hand, p.zones.graveyard, p.zones.exile].flat().find((i) => g.cards[i].cardId === cardId)!;
}

function tutor(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId);
  if (g.cards[iid].zone !== 'hand') moveCard(g, ctx, iid, 'hand');
  return iid;
}

/** Put a card onto the battlefield silently (no triggers: board setup). */
function put(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId);
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  return iid;
}

/** Pass priority until the stack is empty (fails on an open question). */
function resolveAll(g: GameState, ctx: Ctx) {
  for (let k = 0; k < 20 && g.stack.length; k++) {
    if (g.pending.length) throw new Error(`pending: ${g.pending[0].prompt}`);
    act(g, ctx, g.priority, { t: 'pass' });
  }
}

const player = (pid: string) => ({ kind: 'player' as const, pid });
const cardRef = (iid: string) => ({ kind: 'card' as const, iid });
const logText = (g: GameState) => g.log.map((l) => l.text).join('\n');
const tokens = (g: GameState, pid: string, name: string) => g.battlefield.filter((i) => g.cards[i].token?.name === name && g.cards[i].controller === pid);

describe('ETB triggers', () => {
  it('Spirited Companion: cast, resolve, ETB draw goes on the stack and resolves', () => {
    const { g, ctx } = setup(['spirited_companion']);
    const sc = tutor(g, ctx, 'a', 'spirited_companion');
    const hand = P(g, 'a').zones.hand.length;
    act(g, ctx, 'a', { t: 'cast', iid: sc });
    act(g, ctx, 'b', { t: 'pass' }); // creature resolves, trigger goes on the stack
    expect(g.cards[sc].zone).toBe('battlefield');
    expect(g.stack).toHaveLength(1);
    expect(g.stack[0]).toMatchObject({ kind: 'trigger', controller: 'a', sourceIid: sc, auto: { source: 'trigger', svar: 'TrigDraw' } });
    expect(g.priority).toBe('b'); // the controller's own trigger: the opponent may respond
    expect(logText(g)).toMatch(/Spirited Companion's trigger: When Spirited Companion enters, draw a card/);
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.stack).toHaveLength(0);
    expect(P(g, 'a').zones.hand.length).toBe(hand); // -1 cast, +1 draw
  });

  it('Thraben Inspector investigates; Ajani makes a Cat Warrior', () => {
    const { g, ctx } = setup(['thraben_inspector', 'ajani_nacatl_pariah']);
    act(g, ctx, 'a', { t: 'move', iid: find(g, 'a', 'thraben_inspector'), to: 'battlefield' });
    expect(g.stack).toHaveLength(1);
    resolveAll(g, ctx);
    expect(tokens(g, 'a', 'Clue')).toHaveLength(1);
    act(g, ctx, 'a', { t: 'move', iid: find(g, 'a', 'ajani_nacatl_pariah'), to: 'battlefield' });
    resolveAll(g, ctx);
    expect(tokens(g, 'a', 'Cat Warrior')).toHaveLength(1);
  });

  it('Orcish Bowmasters: ETB damage needs a target (chooseTargets); also triggers on an extra draw', () => {
    const { g, ctx } = setup(['orcish_bowmasters'], ['goblin_guide']);
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const ob = find(g, 'a', 'orcish_bowmasters');
    act(g, ctx, 'a', { t: 'move', iid: ob, to: 'battlefield' });
    expect(g.stack).toHaveLength(0);
    expect(g.pending).toHaveLength(1);
    const q = g.pending[0];
    expect(q.pid).toBe('a');
    expect(q.targets).toMatchObject({ controller: 'a', sourceIid: ob, label: 'Orcish Bowmasters', specs: [{ valid: 'Any', players: true, cards: true }] });
    // the opponent sees the question but not the options / internals
    expect(viewFor(g, 'b').pending[0].data).toEqual({});
    expect(applyAction(g, 'b', { t: 'chooseTargets', id: q.id, targets: [[player('b')]] }, ctx)).toMatch(/another player/);
    expect(applyAction(g, 'a', { t: 'chooseTargets', id: q.id, targets: [[cardRef(ob)], [player('b')]] }, ctx)).toBeTruthy();
    act(g, ctx, 'a', { t: 'chooseTargets', id: q.id, targets: [[cardRef(gg)]] });
    expect(g.stack).toHaveLength(1);
    expect(g.stack[0].auto?.targets).toEqual([[cardRef(gg)]]);
    resolveAll(g, ctx);
    expect(g.cards[gg].damage).toBe(1);
    // amass Orcs 1: a 0/0 Orc Army token with a +1/+1 counter
    const army = g.battlefield.map((i) => g.cards[i]).find((c) => c.token?.name === 'Orc Army');
    expect(army?.counters['+1/+1']).toBe(1);
    // opponent draws an extra card -> Bowmasters triggers again
    act(g, ctx, 'b', { t: 'draw', n: 1 });
    expect(g.pending[0]?.targets).toBeDefined();
    act(g, ctx, 'a', { t: 'chooseTargets', id: g.pending[0].id, targets: [[player('b')]] });
    resolveAll(g, ctx);
    expect(P(g, 'b').life).toBe(19);
    expect(army && g.cards[army.iid].counters['+1/+1']).toBe(2); // the existing Army grows
  });

  it('flicker (Stage 1 Ephemerate) re-triggers ETBs', () => {
    const { g, ctx } = setup(['ephemerate', 'thraben_inspector']);
    const ti = put(g, ctx, 'a', 'thraben_inspector');
    act(g, ctx, 'a', { t: 'cast', iid: tutor(g, ctx, 'a', 'ephemerate'), targets: [[cardRef(ti)]] });
    resolveAll(g, ctx);
    expect(g.cards[ti].zone).toBe('battlefield');
    expect(tokens(g, 'a', 'Clue')).toHaveLength(1);
  });

  it('a trigger with no legal target is removed', () => {
    const { g, ctx } = setup(['flickerwisp']);
    // Flickerwisp: "exile another target permanent" — remove every other permanent first
    for (const iid of [...g.battlefield]) moveCard(g, ctx, iid, 'graveyard');
    act(g, ctx, 'a', { t: 'move', iid: find(g, 'a', 'flickerwisp'), to: 'battlefield' });
    expect(g.pending).toHaveLength(0);
    expect(g.stack).toHaveLength(0);
    expect(logText(g)).toMatch(/no legal targets — removed/);
  });
});

describe('other trigger events', () => {
  it('dies: Haywire Mite killed by Lightning Bolt gains its controller 2 life', () => {
    const { g, ctx } = setup(['haywire_mite', 'lightning_bolt']);
    const mite = put(g, ctx, 'a', 'haywire_mite');
    const bolt = tutor(g, ctx, 'a', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: [[cardRef(mite)]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[mite].zone).toBe('graveyard');
    expect(g.stack[0]?.kind).toBe('trigger');
    resolveAll(g, ctx);
    expect(P(g, 'a').life).toBe(22);
  });

  it('upkeep: Dark Confidant reveals the top card, puts it in hand and loses life equal to its mana value', () => {
    const { g, ctx } = setup(['dark_confidant', 'questing_beast']);
    put(g, ctx, 'a', 'dark_confidant');
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(g.activePlayer).toBe('b');
    const qb = find(g, 'a', 'questing_beast');
    moveCard(g, ctx, qb, 'library', { position: 'top' });
    act(g, ctx, 'b', { t: 'nextTurn' });
    expect(g.activePlayer).toBe('a');
    expect(g.step).toBe('upkeep');
    expect(g.stack[0]).toMatchObject({ kind: 'trigger', controller: 'a' });
    resolveAll(g, ctx);
    expect(g.cards[qb].zone).toBe('hand');
    expect(P(g, 'a').life).toBe(16);
    expect(logText(g)).toMatch(/reveals Questing Beast/);
  });

  it('attack: Goblin Guide reveals the defending player\'s top card and gives them a land', () => {
    const { g, ctx } = setup(['goblin_guide']);
    const gg = put(g, ctx, 'a', 'goblin_guide');
    const bHand = P(g, 'b').zones.hand.length;
    act(g, ctx, 'a', { t: 'pass' });
    expect(g.step).toBe('attackers');
    act(g, ctx, 'a', { t: 'declareAttacker', iid: gg, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    expect(g.stack[0]).toMatchObject({ kind: 'trigger', sourceIid: gg });
    expect(g.stack[0].auto?.trigger).toMatchObject({ mode: 'Attacks', card: gg, defender: 'b' });
    resolveAll(g, ctx);
    expect(P(g, 'b').zones.hand.length).toBe(bHand + 1); // b's deck is all Mountains
  });

  it('combat damage to a player: Ragavan makes a Treasure and exiles the top card of their library', () => {
    const { g, ctx } = setup(['ragavan_nimble_pilferer']);
    const rag = put(g, ctx, 'a', 'ragavan_nimble_pilferer');
    act(g, ctx, 'a', { t: 'pass' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: rag, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    for (let k = 0; k < 10 && !g.stack.length; k++) {
      if (g.step === 'blockers' && g.priority === 'b') act(g, ctx, 'b', { t: 'confirmBlockers' });
      else act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(P(g, 'b').life).toBe(18);
    expect(g.stack[0]?.auto?.trigger).toMatchObject({ mode: 'DamageDone', target: 'b', source: rag });
    resolveAll(g, ctx);
    expect(tokens(g, 'a', 'Treasure')).toHaveLength(1);
    expect(P(g, 'b').zones.exile).toHaveLength(1);
  });

  it('spell cast: Monastery Mentor makes a Monk (above the spell); prowess triggers too', () => {
    const { g, ctx } = setup(['monastery_mentor', 'lightning_bolt', 'counterspell']);
    const mm = put(g, ctx, 'a', 'monastery_mentor');
    const bolt = tutor(g, ctx, 'a', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: [[player('b')]] });
    expect(g.stack.map((s) => s.kind)).toEqual(['spell', 'trigger', 'trigger']); // Mentor's token trigger + its prowess
    resolveAll(g, ctx);
    expect(P(g, 'b').life).toBe(17);
    expect(g.cards[mm].tempPT).toEqual([1, 1]);
    const monks = tokens(g, 'a', 'Monk');
    expect(monks).toHaveLength(1);
    // second noncreature spell (cast by hand): Mentor + its prowess + the Monk's prowess
    const cs = tutor(g, ctx, 'a', 'counterspell');
    act(g, ctx, 'a', { t: 'cast', iid: cs, manual: true });
    expect(g.stack.filter((s) => s.kind === 'trigger')).toHaveLength(3);
    resolveAll(g, ctx);
    expect(g.cards[monks[0]].tempPT).toEqual([1, 1]);
    expect(tokens(g, 'a', 'Monk')).toHaveLength(2);
  });

  it('another creature enters: Guide of Souls gains life and energy', () => {
    const { g, ctx } = setup(['guide_of_souls', 'goblin_guide']);
    put(g, ctx, 'a', 'guide_of_souls');
    act(g, ctx, 'a', { t: 'move', iid: find(g, 'a', 'goblin_guide'), to: 'battlefield' });
    resolveAll(g, ctx);
    expect(P(g, 'a').life).toBe(21);
    expect(P(g, 'a').counters.energy).toBe(1);
  });

  it('landfall: Lotus Cobra adds one mana of a chosen color', () => {
    const { g, ctx } = setup(['lotus_cobra']);
    put(g, ctx, 'a', 'lotus_cobra');
    const land = tutor(g, ctx, 'a', 'basic_mountain');
    act(g, ctx, 'a', { t: 'playLand', iid: land });
    expect(g.stack[0]?.kind).toBe('trigger');
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.pending[0]).toMatchObject({ pid: 'a' });
    act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: 'G' });
    expect(P(g, 'a').manaPool.G).toBe(1);
  });
});

describe('leaves-the-battlefield + remembered objects', () => {
  it('Journey to Nowhere exiles on ETB and returns the card when it leaves', () => {
    const { g, ctx } = setup(['journey_to_nowhere'], ['goblin_guide']);
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const jn = find(g, 'a', 'journey_to_nowhere');
    act(g, ctx, 'a', { t: 'move', iid: jn, to: 'battlefield' });
    act(g, ctx, 'a', { t: 'chooseTargets', id: g.pending[0].id, targets: [[cardRef(gg)]] });
    resolveAll(g, ctx);
    expect(g.cards[gg].zone).toBe('exile');
    act(g, ctx, 'a', { t: 'move', iid: jn, to: 'graveyard' });
    resolveAll(g, ctx);
    expect(g.cards[gg].zone).toBe('battlefield');
    expect(g.cards[gg].controller).toBe('b');
  });

  it('Tidehollow Sculler: you pick a nonland card from the target opponent\'s hand; it comes back when Sculler leaves', () => {
    const { g, ctx } = setup(['tidehollow_sculler'], ['lightning_bolt']);
    const bolt = tutor(g, ctx, 'b', 'lightning_bolt');
    const ts = find(g, 'a', 'tidehollow_sculler');
    act(g, ctx, 'a', { t: 'move', iid: ts, to: 'battlefield' });
    act(g, ctx, 'a', { t: 'chooseTargets', id: g.pending[0].id, targets: [[player('b')]] });
    resolveAll(g, ctx);
    const pick = g.pending[0];
    expect(pick.pid).toBe('a');
    expect(pick.options.map((o) => o.value)).toEqual([bolt]); // lands can't be chosen
    expect(viewFor(g, 'b').pending[0].options).toEqual([]);
    act(g, ctx, 'a', { t: 'choose', id: pick.id, value: bolt });
    expect(g.cards[bolt].zone).toBe('exile');
    act(g, ctx, 'a', { t: 'move', iid: ts, to: 'graveyard' });
    resolveAll(g, ctx);
    expect(g.cards[bolt].zone).toBe('hand');
  });
});

describe('optional, delayed and ordering', () => {
  it('"may" with a target: Eternal Witness — decline, then accept', () => {
    const { g, ctx } = setup(['eternal_witness', 'lightning_bolt']);
    const bolt = find(g, 'a', 'lightning_bolt');
    moveCard(g, ctx, bolt, 'graveyard');
    const ew = find(g, 'a', 'eternal_witness');
    act(g, ctx, 'a', { t: 'move', iid: ew, to: 'battlefield' });
    let q = g.pending[0];
    expect(q.targets?.specs[0].zone).toBe('graveyard');
    expect(q.options.map((o) => o.value)).toContain('decline');
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: 'decline' });
    expect(g.stack).toHaveLength(0);
    expect(g.pending).toHaveLength(0);
    act(g, ctx, 'a', { t: 'move', iid: ew, to: 'hand' });
    act(g, ctx, 'a', { t: 'move', iid: ew, to: 'battlefield' });
    q = g.pending[0];
    act(g, ctx, 'a', { t: 'chooseTargets', id: q.id, targets: [[cardRef(bolt)]] });
    resolveAll(g, ctx);
    expect(g.cards[bolt].zone).toBe('hand');
  });

  it('"may" without targets + graveyard trigger: Bloodghast returns on landfall when you say yes', () => {
    const { g, ctx } = setup(['bloodghast']);
    const bg = find(g, 'a', 'bloodghast');
    moveCard(g, ctx, bg, 'graveyard');
    act(g, ctx, 'a', { t: 'playLand', iid: tutor(g, ctx, 'a', 'basic_mountain') });
    const q = g.pending[0];
    expect(q.prompt).toMatch(/Use Bloodghast's ability/);
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: 'yes' });
    resolveAll(g, ctx);
    expect(g.cards[bg].zone).toBe('battlefield');
  });

  it('delayed trigger: Flickerwisp exiles a permanent and returns it at the beginning of the next end step', () => {
    const { g, ctx } = setup(['flickerwisp'], ['goblin_guide']);
    const gg = put(g, ctx, 'b', 'goblin_guide');
    act(g, ctx, 'a', { t: 'move', iid: find(g, 'a', 'flickerwisp'), to: 'battlefield' });
    act(g, ctx, 'a', { t: 'chooseTargets', id: g.pending[0].id, targets: [[cardRef(gg)]] });
    resolveAll(g, ctx);
    expect(g.cards[gg].zone).toBe('exile');
    expect(g.delayedTriggers).toHaveLength(1);
    act(g, ctx, 'a', { t: 'gotoStep', step: 'end' });
    expect(g.stack[0]).toMatchObject({ kind: 'trigger', auto: { trigger: { mode: 'Delayed', remembered: [gg] } } });
    resolveAll(g, ctx);
    expect(g.cards[gg].zone).toBe('battlefield');
    expect(g.cards[gg].controller).toBe('b');
    expect(g.delayedTriggers).toHaveLength(0);
  });

  it('delayed trigger: Kiki-Jiki copy (with its own ETB) is sacrificed at end of turn', () => {
    const { g, ctx } = setup(['kiki_jiki_mirror_breaker', 'thraben_inspector']);
    const kiki = put(g, ctx, 'a', 'kiki_jiki_mirror_breaker');
    const ti = put(g, ctx, 'a', 'thraben_inspector');
    act(g, ctx, 'a', { t: 'activate', iid: kiki, text: '', ability: 0, targets: [[cardRef(ti)]] });
    resolveAll(g, ctx);
    const copy = g.battlefield.find((i) => g.cards[i].token && g.cards[i].cardId === 'thraben_inspector')!;
    expect(copy).toBeDefined();
    expect(tokens(g, 'a', 'Clue')).toHaveLength(1); // the copy's ETB
    act(g, ctx, 'a', { t: 'gotoStep', step: 'end' });
    resolveAll(g, ctx);
    expect(g.cards[copy]).toBeUndefined();
    expect(g.cards[ti].zone).toBe('battlefield');
  });

  it('APNAP: both players\' upkeep triggers — active player\'s go on the stack first', () => {
    const { g, ctx } = setup(['ophiomancer'], ['ophiomancer']);
    put(g, ctx, 'a', 'ophiomancer');
    put(g, ctx, 'b', 'ophiomancer');
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(g.activePlayer).toBe('b');
    expect(g.stack.map((s) => s.controller)).toEqual(['b', 'a']);
    expect(g.priority).toBe('b');
    resolveAll(g, ctx);
    expect(tokens(g, 'a', 'Snake')).toHaveLength(1);
    expect(tokens(g, 'b', 'Snake')).toHaveLength(1);
    // intervening if: with a Snake already, no trigger next upkeep
    act(g, ctx, 'b', { t: 'nextTurn' });
    expect(g.stack).toHaveLength(0);
  });

  it('autoTriggers off: nothing goes on the stack automatically', () => {
    const { g, ctx } = setup(['thraben_inspector']);
    act(g, ctx, 'a', { t: 'setAutoTriggers', on: false });
    expect(P(g, 'a').autoTriggers).toBe(false);
    act(g, ctx, 'a', { t: 'move', iid: find(g, 'a', 'thraben_inspector'), to: 'battlefield' });
    expect(g.stack).toHaveLength(0);
    expect(g.pending).toHaveLength(0);
    expect(tokens(g, 'a', 'Clue')).toHaveLength(0);
    // manual trigger still works
    act(g, ctx, 'a', { t: 'trigger', text: 'Investigate' });
    expect(g.stack[0]).toMatchObject({ kind: 'trigger', text: 'Investigate' });
  });

  it('engine internals stay off the client view', () => {
    const { g, ctx } = setup(['flickerwisp'], ['goblin_guide']);
    put(g, ctx, 'b', 'goblin_guide');
    act(g, ctx, 'a', { t: 'move', iid: find(g, 'a', 'flickerwisp'), to: 'battlefield' });
    const v = viewFor(g, 'b') as unknown as Record<string, unknown>;
    expect(v.triggerQueue).toBeUndefined();
    expect(v.events).toBeUndefined();
  });
});
