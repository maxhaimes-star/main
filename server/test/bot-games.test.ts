/**
 * Computer opponents through the server's room path: bots join a sealed event (addBot builds their decks), the host
 * pairs them and the BotDriver plays every action through Rooms.handle, exactly as for a bot-vs-human match.
 * Checks: every game finishes with a winner, nothing throws, no bot gives up (stuck / loop guard), no stalls.
 */
import { describe, expect, it } from 'vitest';
import { Rooms } from '../src/rooms.ts';
import { BotDriver } from '../src/botdriver.ts';
import { getCard } from '@ojb/shared/src/cube.ts';

const GAMES = Number(process.env.BOT_GAMES ?? 52);

describe('bot vs bot through the room path', () => {
  it(`plays ${GAMES} complete games without errors or stalls`, async () => {
    const rooms = new Rooms();
    const host = rooms.create('Bots', 'Host');
    const rec = rooms.rooms.get(host.roomId)!;
    expect(rooms.handle(rec, host.pid, { t: 'updateSettings', settings: { mode: 'sealed', seats: 2, fillWithBots: true, sealedPacks: 6 } })).toBeNull();
    expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
    expect(rec.state.phase).toBe('deckbuilding');
    // More opponents: addBot gives each a pool and a deck.
    for (const level of ['normal', 'easy', 'normal', 'easy', 'normal'] as const) expect(rooms.handle(rec, host.pid, { t: 'addBot', level })).toBeNull();
    const bots = rec.state.players.filter((p) => p.isBot);
    expect(bots.length).toBe(6);
    for (const b of bots) expect(rec.state.decks[b.id]!.main.length + Object.values(rec.state.decks[b.id]!.basics).reduce((a, n) => a + n, 0)).toBe(40);

    const driver = new BotDriver(rooms);
    const results: { turns: number; steps: number }[] = [];
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let k = 0; k < GAMES; k++) {
      await new Promise((r) => setImmediate(r)); // let the test runner breathe between games
      const a = bots[rnd(bots.length)];
      let b = bots[rnd(bots.length)];
      if (b === a) b = bots[(bots.indexOf(a) + 1) % bots.length];
      expect(rooms.handle(rec, host.pid, { t: 'createMatch', players: [a.id, b.id], bestOf: 1 })).toBeNull();
      const match = rec.state.matches[rec.state.matches.length - 1];
      let steps = 0;
      while (!match.winner && steps < 6000) {
        const did = driver.step(rec, match);
        steps++;
        if (!did) break; // nobody had anything to do: a stall
      }
      expect(match.winner, `game ${k} (${a.name} vs ${b.name}) ended without a winner after ${steps} steps, turn ${match.game?.turn} step ${match.game?.step}`).toBeTruthy();
      results.push({ turns: match.game!.turn, steps });
    }
    const stuck = rec.state.chat.filter((c) => /stuck/.test(c.text));
    expect(stuck.map((c) => `${c.name}: ${c.text} ${JSON.stringify(results.length)}`)).toEqual([]);
    const avgTurns = results.reduce((n, r) => n + r.turns, 0) / results.length;
    // Games are decided by play, not by decking (40-card decks run out around turn 66).
    expect(avgTurns).toBeLessThan(40);
  }, 600_000);

  it('a human vs bot match: the bot mulligans, plays lands and answers undo requests', () => {
    const rooms = new Rooms();
    const host = rooms.create('Vs bot', 'Max');
    const rec = rooms.rooms.get(host.roomId)!;
    rooms.handle(rec, host.pid, { t: 'updateSettings', settings: { mode: 'sealed', seats: 1, fillWithBots: false, sealedPacks: 6, vsBot: 'normal' } });
    expect(rec.state.settings.vsBot).toBe('normal');
    expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
    const bot = rec.state.players.find((p) => p.isBot)!;
    expect(bot.botLevel).toBe('normal');
    expect(rec.state.decks[bot.id]?.ready).toBe(true);
    const pool = rec.state.pools[host.pid];
    rooms.handle(rec, host.pid, { t: 'saveDeck', deck: { main: pool.slice(0, 23), side: [], basics: { W: 4, U: 4, B: 3, R: 3, G: 3 } }, ready: true });
    expect(rooms.handle(rec, host.pid, { t: 'createMatch', players: [host.pid, bot.id], bestOf: 3 })).toBeNull();
    const match = rec.state.matches[0];
    const g = () => match.game!;
    expect(g().players.find((p) => p.pid === bot.id)!.bot).toBe(true);
    const driver = new BotDriver(rooms);
    // A random sealed pool may hold Arcane Savant with sideboard instants: the human declines its pre-game question.
    for (let i = 0; i < 40 && g().pregame; i++) {
      const q = g().pending.find((x) => x.pid === host.pid);
      if (q) rooms.handle(rec, host.pid, { t: 'game', matchId: match.id, action: { t: 'choose', id: q.id, value: 'no' } });
      else driver.step(rec, match);
    }
    rooms.handle(rec, host.pid, { t: 'game', matchId: match.id, action: { t: 'keep' } });
    for (let i = 0; i < 10 && driver.step(rec, match); i++) { /* bot mulligans / keeps */ }
    expect(g().phase).toBe('playing');
    // The human passes priority whenever they have it; the bot plays its turns.
    let botLands = 0;
    for (let i = 0; i < 400 && g().turn < 8 && g().phase === 'playing'; i++) {
      if (driver.step(rec, match)) continue;
      const human = g().players.find((p) => p.pid === host.pid)!;
      if (g().pending.some((q) => q.pid === host.pid)) {
        const q = g().pending.find((x) => x.pid === host.pid)!;
        rooms.handle(rec, host.pid, { t: 'game', matchId: match.id, action: { t: 'choose', id: q.id, value: q.options[0]?.value ?? '' } });
      } else if (human.peek) {
        rooms.handle(rec, host.pid, { t: 'game', matchId: match.id, action: { t: 'resolvePeek', top: human.peek.iids, bottom: [], graveyard: [], hand: [], battlefield: [], exile: [], shuffle: false } });
      } else if (g().priority === host.pid) {
        rooms.handle(rec, host.pid, { t: 'game', matchId: match.id, action: { t: 'pass' } });
      }
      botLands = g().battlefield.filter((iid) => g().cards[iid].controller === bot.id && !!getCard(g().cards[iid].cardId ?? '')?.types.includes('Land')).length;
    }
    expect(g().turn).toBeGreaterThanOrEqual(6);
    expect(g().log.some((l) => l.pid === bot.id && / plays /.test(l.text))).toBe(true);
    expect(botLands).toBeGreaterThan(0);
    // Undo: the human asks, the bot answers.
    if (g().phase === 'playing' && g().history.length) {
      expect(rooms.handle(rec, host.pid, { t: 'game', matchId: match.id, action: { t: 'requestUndo' } })).toBeNull();
      expect(driver.botsToAct(rec, match)).toEqual([bot.id]);
      driver.step(rec, match);
      expect(g().undoRequest).toBeNull();
    }
  }, 120_000);

  it('Freeform constructed: the bot plays a saved deck, or a cube deck by default', () => {
    const rooms = new Rooms();
    const host = rooms.create('Freeform', 'Max');
    const rec = rooms.rooms.get(host.roomId)!;
    rooms.handle(rec, host.pid, { t: 'updateSettings', settings: { mode: 'constructed', format: 'Freeform', vsBot: 'easy' } });
    expect(rooms.handle(rec, host.pid, { t: 'start' })).toBeNull();
    const cubeBot = rec.state.players.find((p) => p.isBot)!;
    expect(cubeBot.botLevel).toBe('easy');
    expect(rec.state.decks[cubeBot.id]!.ready).toBe(true);
    const saved = { main: Array(20).fill('lightning_bolt'), side: [], basics: { W: 0, U: 0, B: 0, R: 20, G: 0 } };
    expect(rooms.handle(rec, host.pid, { t: 'addBot', level: 'normal', deck: saved })).toBeNull();
    const deckBot = rec.state.players.filter((p) => p.isBot)[1];
    expect(rec.state.decks[deckBot.id]!.main).toEqual(saved.main);
    expect(rec.state.decks[deckBot.id]!.basics.R).toBe(20);
    expect(rooms.handle(rec, host.pid, { t: 'addBot', deck: { main: ['no_such_card'], side: [], basics: saved.basics } })).toMatch(/Unknown card/);
    expect(rooms.handle(rec, host.pid, { t: 'submitSavedDeck', deck: saved })).toBeNull();
    expect(rooms.handle(rec, host.pid, { t: 'createMatch', players: [host.pid, deckBot.id], bestOf: 1 })).toBeNull();
    const g = rec.state.matches[0].game!;
    const botCards = Object.values(g.cards).filter((c) => c.owner === deckBot.id);
    expect(botCards.filter((c) => c.cardId === 'lightning_bolt')).toHaveLength(20);
  });
});
