/** Auto-pass / hold priority / summoning-sick badge (client/src/game/auto.ts, engine.ts) on real game views. */
import { describe, expect, it } from 'vitest';
import { applyAction, createGame, type Ctx, type GameAction, type GameState, moveCard, viewFor } from '@ojb/shared';
import { getCard } from '@ojb/shared/src/cube.ts';
import { autoPassReason, combatDecision, holdClick, noteHoldClick, withHold, type AutoSettings } from '../src/game/auto.ts';
import { showsSummoningSick } from '../src/game/engine.ts';

function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const deck = (extra: string[]) => [...extra, ...Array(40 - extra.length).fill('basic_mountain')];
function setup(a: string[], b: string[]) {
  const ctx: Ctx = { rng: seeded(7), lookup: getCard, now: 0 };
  const g = createGame('g', [{ pid: 'a', name: 'A', deck: deck(a), side: [] }, { pid: 'b', name: 'B', deck: deck(b), side: [] }], 'a', ctx);
  act(g, ctx, 'a', { t: 'keep' });
  act(g, ctx, 'b', { t: 'keep' });
  return { g, ctx };
}
function act(g: GameState, ctx: Ctx, pid: string, a: GameAction) { const e = applyAction(g, pid, a, ctx); if (e) throw new Error(e); }
function put(g: GameState, ctx: Ctx, pid: string, id: string, sick = false) {
  const p = g.players.find((x) => x.pid === pid)!;
  const iid = [...p.zones.hand, ...p.zones.library].find((i) => g.cards[i].cardId === id)!;
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = sick;
  return iid;
}
const ON: AutoSettings = { autoPass: true, fullControl: false, yields: ['Some Source'], sidePanel: true, hold: false };

describe('auto-pass never skips a decision', () => {
  it('declare blockers with a creature that can block: no auto-pass, even with a spell on the stack', () => {
    const { g, ctx } = setup(['embereth_shieldbreaker'], ['embereth_shieldbreaker']);
    const atk = put(g, ctx, 'a', 'embereth_shieldbreaker');
    put(g, ctx, 'b', 'embereth_shieldbreaker');
    act(g, ctx, 'a', { t: 'pass' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: atk, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    expect(g.step).toBe('blockers');
    let v = viewFor(g, 'b');
    expect(combatDecision(v, 'b')).toBe(true);
    expect(autoPassReason(v, 'b', ON, () => false)).toBe('');
    g.stack.push({ id: 'x', kind: 'trigger', controller: 'a', text: 'x' });
    v = viewFor(g, 'b');
    expect(autoPassReason(v, 'b', ON, () => false)).toBe('');
  });

  it('a quiet step with nothing to do is still auto-passed', () => {
    const { g } = setup([], []);
    const v = { ...viewFor(g, 'a'), step: 'upkeep' as const };
    expect(autoPassReason(v, 'a', ON, () => false)).toBe('quiet step');
  });
});

describe('hold priority', () => {
  it('the toggle or a Ctrl/Cmd-click adds hold to the next cast / activate only', () => {
    const cast: GameAction = { t: 'cast', iid: 'x' };
    expect(withHold(cast, { hold: true })).toMatchObject({ hold: true });
    expect(withHold(cast, { hold: false })).not.toHaveProperty('hold');
    noteHoldClick({ ctrlKey: true });
    expect(withHold({ t: 'pass' }, { hold: false })).toEqual({ t: 'pass' }); // not consumed by other actions
    expect(withHold(cast, { hold: false })).toMatchObject({ hold: true });
    expect(holdClick.once).toBe(false);
    noteHoldClick({ metaKey: true });
    noteHoldClick({}); // a plain click cancels it
    expect(withHold(cast, { hold: false })).not.toHaveProperty('hold');
  });
});

describe('summoning-sick badge', () => {
  it('only creatures look summoning sick, never lands', () => {
    const { g, ctx } = setup(['embereth_shieldbreaker'], []);
    const land = put(g, ctx, 'a', 'basic_mountain', true);
    const bear = put(g, ctx, 'a', 'embereth_shieldbreaker', true);
    const v = viewFor(g, 'a');
    expect(showsSummoningSick(v, v.cards[land])).toBe(false);
    expect(showsSummoningSick(null, v.cards[land])).toBe(false);
    expect(showsSummoningSick(v, v.cards[bear])).toBe(true);
  });
});
