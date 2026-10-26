/** Initiative / Undercity: room abilities go on the stack and resolve. */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import { applyAction, createGame, type Ctx, type GameAction, type GameState, moveCard } from '../src/index.ts';
import { processTriggers } from '../src/engine/triggers.ts';
import { takeInitiative, venture } from '../src/engine/designations.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[], fill = 'basic_plains') => [...extra, ...Array(40 - extra.length).fill(fill)];

function setup(a: string[] = [], fill = 'basic_plains') {
  const ctx: Ctx = { rng: seeded(7), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(a, fill), side: [] },
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
function put(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const p = g.players.find((x) => x.pid === pid)!;
  const iid = [...p.zones.hand, ...p.zones.library].find((i) => g.cards[i].cardId === cardId && g.cards[i].zone !== 'battlefield')!;
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  return iid;
}
/** Answer questions (targets: the given creature) and pass priority until the stack is empty. */
function drain(g: GameState, ctx: Ctx, creature?: string) {
  for (let i = 0; i < 40 && (g.stack.length || g.pending.length); i++) {
    if (g.pending.length) {
      const q = g.pending[0];
      if (q.targets) act(g, ctx, q.pid, { t: 'chooseTargets', id: q.id, targets: q.targets.specs.map(() => [creature ? { kind: 'card' as const, iid: creature } : { kind: 'player' as const, pid: 'b' }]) } as GameAction);
      else act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options[0].value });
      continue;
    }
    act(g, ctx, g.priority, { t: 'pass' });
  }
}
const pl = (g: GameState, pid = 'a') => g.players.find((p) => p.pid === pid)!;

describe('initiative', () => {
  it('taking the initiative puts the first room (Secret Entrance) on the stack, and it resolves', () => {
    const { g, ctx } = setup();
    const hand = pl(g).zones.hand.length;
    takeInitiative(g, ctx, 'a');
    expect(pl(g).designations).toContain('Initiative');
    expect(processTriggers(g, ctx)).toBe(true);
    expect(g.stack).toHaveLength(1);
    drain(g, ctx);
    expect(pl(g).zones.hand.length).toBe(hand + 1);
  });

  it('Undermountain Adventurer: ETB takes the initiative and ventures', () => {
    const { g, ctx } = setup(['undermountain_adventurer'], 'basic_forest');
    for (let i = 0; i < 6; i++) put(g, ctx, 'a', 'basic_forest');
    const iid = [...pl(g).zones.hand, ...pl(g).zones.library].find((i) => g.cards[i].cardId === 'undermountain_adventurer')!;
    moveCard(g, ctx, iid, 'hand');
    act(g, ctx, 'a', { t: 'cast', iid });
    drain(g, ctx);
    expect(pl(g).designations).toContain('Initiative');
    expect(pl(g).counters.undercity).toBe(1);
  });

  it('combat damage to the initiative holder steals it and ventures for the new holder', () => {
    const { g, ctx } = setup();
    takeInitiative(g, ctx, 'b');
    processTriggers(g, ctx);
    drain(g, ctx);
    g.events = [];
    const atk = put(g, ctx, 'a', 'basic_plains');
    g.events = [{ t: 'damage', source: atk, target: 'b', amount: 2, combat: true } as never];
    processTriggers(g, ctx);
    expect(pl(g).designations).toContain('Initiative');
    expect(pl(g, 'b').designations).not.toContain('Initiative');
    expect(g.stack.length + g.pending.length).toBeGreaterThan(0);
    drain(g, ctx);
    expect(pl(g).counters.undercity).toBe(1);
  });

  it('upkeep venture goes on the stack', () => {
    const { g, ctx } = setup();
    pl(g).designations.push('Initiative');
    g.events = [{ t: 'phase', step: 'upkeep', active: 'a' } as never];
    processTriggers(g, ctx);
    expect(g.stack.length).toBe(1);
    expect(pl(g).counters.undercity).toBe(1);
  });
});

describe('real turn flow', () => {
  it('the initiative holder ventures at their own upkeep (no manual processTriggers) and the room resolves', () => {
    const { g, ctx } = setup(['undermountain_adventurer']);
    const c = put(g, ctx, 'a', 'undermountain_adventurer');
    pl(g).designations.push('Initiative');
    pl(g).counters.undercity = 1; // in Secret Entrance: next is Forge or Lost Well
    // Pass priority around until it is Alice's next upkeep.
    const startTurn = g.turn;
    for (let i = 0; i < 80 && !(g.turn > startTurn && g.activePlayer === 'a' && (g.stack.length || g.pending.length)); i++) {
      if (g.pending.length) {
        const q = g.pending[0];
        act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.data.kind === 'venture' ? '1' : q.options[0].value });
        continue;
      }
      act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(g.turn).toBeGreaterThan(startTurn);
    expect(g.stack.length + g.pending.length).toBeGreaterThan(0);
    drain(g, ctx, c);
    expect(pl(g).counters.undercity).toBe(2);
    expect(g.cards[c].counters?.['+1/+1']).toBe(2);
  });

  it('real combat damage to the initiative holder: the attacker takes it, ventures and Secret Entrance resolves', () => {
    const { g, ctx } = setup(['undermountain_adventurer']);
    const c = put(g, ctx, 'a', 'undermountain_adventurer');
    pl(g, 'b').designations.push('Initiative');
    const hand = pl(g).zones.hand.length;
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: c, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    for (let i = 0; i < 40 && g.step !== 'main2'; i++) {
      if (g.pending.length) { act(g, ctx, g.pending[0].pid, { t: 'choose', id: g.pending[0].id, value: g.pending[0].options[0].value }); continue; }
      act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(pl(g).designations).toContain('Initiative');
    expect(pl(g).counters.undercity).toBe(1);
    expect(pl(g).zones.hand.length).toBe(hand + 1); // the basic land from Secret Entrance
  });

  it('taking the initiative from the player menu (designation action) ventures and the room resolves', () => {
    const { g, ctx } = setup();
    const hand = pl(g).zones.hand.length;
    g.fixMode = { on: true, requestedBy: 'a' };
    act(g, ctx, 'a', { t: 'designation', name: 'Initiative', on: true });
    expect(pl(g).designations).toContain('Initiative');
    expect(pl(g).counters.undercity).toBe(1);
    drain(g, ctx);
    expect(pl(g).zones.hand.length).toBe(hand + 1);
  });

  it('answering the room choice puts the chosen room on the stack immediately', () => {
    const { g, ctx } = setup(['undermountain_adventurer']);
    const c = put(g, ctx, 'a', 'undermountain_adventurer');
    pl(g).counters.undercity = 1;
    venture(g, ctx, 'a');
    expect(g.pending).toHaveLength(1);
    act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: '1' });
    expect(g.stack.length + g.pending.length).toBe(1); // Forge on the stack (or its target question)
    drain(g, ctx, c);
    expect(g.cards[c].counters?.['+1/+1']).toBe(2);
  });
});

describe('Undercity rooms resolve', () => {
  const enter = (g: GameState, ctx: Ctx, room: number) => {
    const prev: Record<number, number> = { 1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 3, 7: 4, 8: 6 };
    if (room === 0) delete pl(g).counters.undercity; else pl(g).counters.undercity = prev[room] + 1;
    venture(g, ctx, 'a');
    if (g.pending.length) act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: String(room) });
    processTriggers(g, ctx);
  };

  it('Forge: two +1/+1 counters on target creature', () => {
    const { g, ctx } = setup(['undermountain_adventurer']);
    const c = put(g, ctx, 'a', 'undermountain_adventurer');
    enter(g, ctx, 1);
    drain(g, ctx, c);
    expect(g.cards[c].counters?.['+1/+1']).toBe(2);
  });
  it('Lost Well: scry 2', () => {
    const { g, ctx } = setup();
    enter(g, ctx, 2);
    drain(g, ctx);
    expect(g.stack).toHaveLength(0);
  });
  it('Trap!: target player loses 5', () => {
    const { g, ctx } = setup();
    enter(g, ctx, 3);
    expect(g.stack.length + g.pending.length).toBe(1);
    drain(g, ctx);
    expect(pl(g, 'b').life).toBe(15);
  });
  it('Arena: goad target creature', () => {
    const { g, ctx } = setup(['undermountain_adventurer']);
    const c = put(g, ctx, 'a', 'undermountain_adventurer');
    enter(g, ctx, 4);
    drain(g, ctx, c);
    expect(g.stack).toHaveLength(0);
  });
  it('Stash: Treasure', () => {
    const { g, ctx } = setup();
    const before = g.battlefield.length;
    enter(g, ctx, 5);
    drain(g, ctx);
    expect(g.battlefield.length).toBe(before + 1);
  });
  it('Archives: draw', () => {
    const { g, ctx } = setup();
    const hand = pl(g).zones.hand.length;
    enter(g, ctx, 6);
    drain(g, ctx);
    expect(pl(g).zones.hand.length).toBe(hand + 1);
  });
  it('Catacombs: 4/1 Skeleton', () => {
    const { g, ctx } = setup();
    const before = g.battlefield.length;
    enter(g, ctx, 7);
    drain(g, ctx);
    expect(g.battlefield.length).toBe(before + 1);
  });
  it('Throne of the Dead Three: creature with three counters', () => {
    const { g, ctx } = setup(['undermountain_adventurer']);
    const before = g.battlefield.length;
    const top = pl(g).zones.library.find((i) => g.cards[i].cardId === 'undermountain_adventurer')!;
    pl(g).zones.library = [top, ...pl(g).zones.library.filter((i) => i !== top)];
    enter(g, ctx, 8);
    drain(g, ctx);
    expect(g.battlefield.length).toBe(before + 1);
    expect(g.cards[g.battlefield[g.battlefield.length - 1]].counters?.['+1/+1']).toBe(3);
  });
});
