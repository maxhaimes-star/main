/** Workstream A2 card bugs (strict mode, real cube scripts). */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  activatedAbilitiesOf, applyAction, createGame, type Ctx, type GameAction, type GameState, manaOptionsFor, moveCard,
} from '../src/index.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[], fill = 'basic_mountain') => [...extra, ...Array(40 - extra.length).fill(fill)];

function setup(a: string[] = [], b: string[] = [], seed = 7, fillA = 'basic_mountain', fillB = 'basic_mountain') {
  const ctx: Ctx = { rng: seeded(seed), lookup: getCard, now: 0 };
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
  if (err) throw new Error(`${action.t}: ${err}`);
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

const P = (g: GameState, pid: string) => g.players.find((p) => p.pid === pid)!;
const logText = (g: GameState) => g.log.map((l) => l.text).join('\n');

describe('A2.1: Jack-in-the-Mox (RollDice result sub-abilities)', () => {
  for (let seed = 1; seed <= 12; seed++) {
    it(`seed ${seed}: the rolled result's effect happens`, () => {
      const { g, ctx } = setup(['jack_in_the_mox'], [], seed);
      const jack = put(g, ctx, 'a', 'jack_in_the_mox');
      const life = P(g, 'a').life;
      const opts = manaOptionsFor(g, jack, getCard);
      if (opts.length) act(g, ctx, 'a', { t: 'activateMana', iid: jack, option: opts[0].id });
      else act(g, ctx, 'a', { t: 'activate', iid: jack, text: '', ability: activatedAbilitiesOf('jack_in_the_mox', 0)[0]?.index ?? 0 });
      drain(g, ctx);
      const m = /rolls a (\d)/.exec(logText(g));
      expect(m, logText(g) + JSON.stringify(manaOptionsFor(g, jack, getCard)) + JSON.stringify(P(g, "a").manaPool)).toBeTruthy();
      const n = Number(m![1]);
      if (n === 1) {
        expect(g.cards[jack].zone).toBe('graveyard');
        expect(P(g, 'a').life).toBe(life - 5);
      } else {
        const color = ['W', 'U', 'B', 'R', 'G'][n - 2];
        expect((P(g, 'a').manaPool as Record<string, number>)[color], logText(g)).toBe(1);
      }
    });
  }
});
