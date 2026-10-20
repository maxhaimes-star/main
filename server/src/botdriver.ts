/**
 * Plays the bot seats of matches: whenever a bot holds priority, has a question to answer, a mulligan to decide or an
 * undo / fix-mode request to answer (and between games: "ready for the next game"), it gets one action after a short
 * delay so the human can follow. Actions go through Rooms.handle like a player's message, so the reducer validates
 * them and match bookkeeping (wins, sideboarding) is the same.
 *
 * - The bot only sees its seat's view (viewFor), see shared/src/ai/player.ts.
 * - One action per timer tick: a decision costs a few milliseconds, the event loop is never held for a whole turn.
 * - Undo: the bot answers requests (accepts a few per turn); after an undo it simply decides again from the new state.
 * - Disconnects: the bot never acts for the human, so a game with an absent human just waits. Rooms loaded after a
 *   restart are picked up by the periodic sweep (kickAll).
 * - Stalls: a bot that can't find any legal action, or acts hundreds of times without the game moving on, concedes.
 */
import { botNeedsToAct, botStep, type BotLevel, type BotMemory, type Match, newBotMemory, viewFor } from '@ojb/shared';
import type { RoomRecord, Rooms } from './rooms.ts';

export interface BotDriverOptions {
  /** Milliseconds before each bot action (default 300–600 random). */
  delay?: () => number;
  /** Called after the bot changed a room (broadcast it). */
  onChange?: (roomId: string) => void;
  /** Bot actions without the game moving to another step before the bot concedes (default 400). */
  stallLimit?: number;
}

interface Progress { key: string; n: number }

export class BotDriver {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private memories = new Map<string, BotMemory>();
  private progress = new Map<string, Progress>();
  private delay: () => number;
  private onChange: (roomId: string) => void;
  private stallLimit: number;

  constructor(private rooms: Rooms, opts: BotDriverOptions = {}) {
    this.delay = opts.delay ?? (() => 300 + Math.floor(Math.random() * 300));
    this.onChange = opts.onChange ?? (() => {});
    this.stallLimit = opts.stallLimit ?? 400;
  }

  /** Bot players of a match that have something to do now. */
  botsToAct(rec: RoomRecord, match: Match): string[] {
    if (match.winner) return [];
    const bots = match.players.filter((pid) => this.isBot(rec, pid));
    if (!bots.length) return [];
    if (match.sideboarding) return bots.filter((pid) => !match.readyForNext.includes(pid));
    const g = match.game;
    if (!g || g.phase === 'over') return [];
    return bots.filter((pid) => botNeedsToAct(g, pid));
  }

  private isBot(rec: RoomRecord, pid: string): boolean {
    const p = rec.state.players.find((x) => x.id === pid);
    return !!p?.isBot && !p.away;
  }

  private level(rec: RoomRecord, pid: string): BotLevel {
    return rec.state.players.find((x) => x.id === pid)?.botLevel ?? 'normal';
  }

  private memory(match: Match, pid: string): BotMemory {
    const key = `${match.id}|${pid}`;
    let m = this.memories.get(key);
    if (!m) { m = newBotMemory(Math.floor(Math.random() * 2 ** 31)); this.memories.set(key, m); }
    return m;
  }

  /**
   * One bot action in this match (synchronous; tests call it directly). Returns true when something changed.
   */
  step(rec: RoomRecord, match: Match): boolean {
    const pid = this.botsToAct(rec, match)[0];
    if (!pid) return false;
    if (match.sideboarding) return !this.rooms.handle(rec, pid, { t: 'readyNext', matchId: match.id });
    const g = match.game!;
    const mem = this.memory(match, pid);
    // Stall guard: too many bot actions without the game reaching another step / turn.
    const pkey = `${match.id}|${match.gameNumber}`;
    const where = `${g.turn}|${g.step}|${g.phase}`;
    const pr = this.progress.get(pkey);
    if (!pr || pr.key !== where) this.progress.set(pkey, { key: where, n: 1 });
    else if (++pr.n > this.stallLimit) return this.giveUp(rec, match, pid, 'stuck in a loop');
    const r = botStep(
      () => viewFor(match.game!, pid),
      pid, mem,
      (a) => (match.game === g ? this.rooms.handle(rec, pid, { t: 'game', matchId: match.id, action: a }) : 'The game changed'),
      { level: this.level(rec, pid) },
    );
    if (r.stuck) return this.giveUp(rec, match, pid, 'found no legal action');
    return !!r.action;
  }

  private giveUp(rec: RoomRecord, match: Match, pid: string, why: string): boolean {
    const name = rec.state.players.find((p) => p.id === pid)?.name ?? 'The bot';
    console.warn(`bot ${pid} in room ${rec.state.id} concedes: ${why}`);
    rec.state.chat.push({ pid, name, text: `I'm stuck (${why}) — I concede this game.`, at: Date.now() });
    return !this.rooms.handle(rec, pid, { t: 'game', matchId: match.id, action: { t: 'concede' } });
  }

  /** Schedule bot actions for every match of this room that waits on a bot. */
  kick(roomId: string) {
    const rec = this.rooms.rooms.get(roomId);
    if (!rec) return;
    for (const match of rec.state.matches) {
      if (this.timers.has(match.id) || !this.botsToAct(rec, match).length) continue;
      const t = setTimeout(() => {
        this.timers.delete(match.id);
        const cur = this.rooms.rooms.get(roomId);
        const m = cur?.state.matches.find((x) => x.id === match.id);
        if (!cur || !m) return; // room gone / back to the lobby
        let changed = false;
        try {
          changed = this.step(cur, m);
        } catch (e) {
          console.error('bot step failed', e);
        }
        if (changed) this.onChange(roomId);
        this.kick(roomId);
      }, this.delay());
      this.timers.set(match.id, t);
    }
    this.cleanup(rec);
  }

  /** Periodic sweep: rooms with bot matches (also picks up rooms loaded from disk). */
  kickAll() {
    for (const [rid, rec] of this.rooms.rooms) if (rec.state.matches.some((m) => !m.winner && m.players.some((p) => this.isBot(rec, p)))) this.kick(rid);
  }

  /** Forget memories of matches that are over. */
  private cleanup(rec: RoomRecord) {
    for (const key of this.memories.keys()) {
      const [mid] = key.split('|');
      const m = rec.state.matches.find((x) => x.id === mid);
      if (m?.winner) this.memories.delete(key);
    }
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
