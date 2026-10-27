/**
 * Win rate of the current game bot (shared/src/ai/player.ts) against the previous one (scripts/fixtures/player-v1.ts).
 *
 *   npx tsx scripts/bot-winrate.ts [games=100] [firstSeed=1]
 *
 * Each game: two 40-card decks built by the draft bots' deckbuilder from random 90-card cube pools, a rules-enforced
 * (strict) game like the server's. The pair of decks is played twice with the seats swapped (new bot on deck A, then
 * on deck B) and the starting player alternates, so deck and play/draw luck cancel out. Games that reach turn 40
 * or stall count as draws.
 */
import { applyAction, botDeck, createGame, type Ctx, type GameAction, type GameState, viewFor, type Color } from '../shared/src/index.ts';
import { CUBE, getCard } from '../shared/src/cube.ts';
import * as cur from '../shared/src/ai/player.ts';
import * as old from './fixtures/player-v1.ts';

type Bot = { botStep: typeof cur.botStep; botNeedsToAct: typeof cur.botNeedsToAct; newBotMemory: typeof cur.newBotMemory };

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASIC: Record<Color, string> = { W: 'basic_plains', U: 'basic_island', B: 'basic_swamp', R: 'basic_mountain', G: 'basic_forest' };

function deckFor(rng: () => number): string[] {
  const pool = CUBE.list.map((c) => ({ c, r: rng() })).sort((x, y) => x.r - y.r).slice(0, 90).map((x) => x.c);
  const d = botDeck(pool, getCard);
  const basics = (Object.entries(d.basics) as [Color, number][]).flatMap(([c, n]) => Array(n).fill(BASIC[c]));
  return [...d.main, ...basics];
}

/** Plays one game; returns 'new' | 'old' | 'draw'. */
function play(seed: number, decks: [string[], string[]], newSeat: 0 | 1, starter: 0 | 1): 'new' | 'old' | 'draw' {
  const ctx: Ctx = { rng: seeded(seed), lookup: getCard, now: 0 };
  const pids = ['p1', 'p2'];
  const g: GameState = createGame(`wr${seed}`, [
    { pid: 'p1', name: 'A', deck: decks[0], side: [] }, { pid: 'p2', name: 'B', deck: decks[1], side: [] },
  ], pids[starter], ctx, { strict: true });
  const bots: Record<string, Bot> = { [pids[newSeat]]: cur, [pids[1 - newSeat]]: old as unknown as Bot };
  const mems = Object.fromEntries(pids.map((p, i) => [p, bots[p].newBotMemory(seed * 31 + i)]));
  let lastKey = '', still = 0;
  for (let n = 0; n < 30000; n++) {
    ctx.now = n;
    if (g.phase === 'over') break;
    if (g.turn > 40) return 'draw';
    const key = `${g.turn}|${g.step}`;
    if (key !== lastKey) { lastKey = key; still = 0; } else if (++still > 600) return 'draw';
    const actor = pids.find((p) => bots[p].botNeedsToAct(g, p));
    if (!actor) return 'draw';
    if (process.env.DIFF && bots[actor] === cur) {
      const v = viewFor(g, actor);
      const a1 = cur.decideBotAction(v, actor, structuredClone(mems[actor]));
      const a2 = (old as unknown as typeof cur).decideBotAction(v, actor, structuredClone(mems[actor]));
      diffs.total++;
      if (JSON.stringify(a1) !== JSON.stringify(a2)) { diffs.differ++; diffs.kinds[`${g.step}:${a1?.t}/${a2?.t}`] = (diffs.kinds[`${g.step}:${a1?.t}/${a2?.t}`] ?? 0) + 1; }
    }
    const r = bots[actor].botStep(() => viewFor(g, actor), actor, mems[actor], (a: GameAction) => {
      try { return applyAction(g, actor, a, ctx); } catch (e) { return (e as Error).message; }
    });
    if (r.stuck) applyAction(g, actor, { t: 'concede' }, ctx);
  }
  if (g.phase !== 'over' || !g.winner) return 'draw';
  return g.winner === pids[newSeat] ? 'new' : 'old';
}

const diffs = { total: 0, differ: 0, kinds: {} as Record<string, number> };
const games = parseInt(process.argv[2] ?? '100', 10);
const first = parseInt(process.argv[3] ?? '1', 10);
const tally = { new: 0, old: 0, draw: 0 };
const t0 = Date.now();
for (let i = 0; i < games; i++) {
  const pair = Math.floor(i / 2);
  const rng = seeded((first + pair) * 104729);
  const decks: [string[], string[]] = [deckFor(rng), deckFor(rng)];
  const r = play(first + i, decks, (i % 2) as 0 | 1, (pair % 2) as 0 | 1);
  tally[r]++;
  if ((i + 1) % 10 === 0) console.log(`${i + 1} games: new ${tally.new}, old ${tally.old}, draws ${tally.draw}`);
}
const decided = tally.new + tally.old;
if (process.env.DIFF) console.log('decisions', diffs.total, 'differ', diffs.differ, JSON.stringify(diffs.kinds));
console.log(`\nNew bot vs old bot over ${games} games: ${tally.new} wins, ${tally.old} losses, ${tally.draw} draws.`);
console.log(`Win rate (decided games): ${decided ? ((100 * tally.new) / decided).toFixed(1) : '-'}% · (all games, draws as half): ${((100 * (tally.new + tally.draw / 2)) / games).toFixed(1)}% · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
