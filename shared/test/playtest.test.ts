import { describe, expect, it } from 'vitest';
import { formatReport, playtest } from '../../scripts/playtest.ts';

// A small fixed-seed sample of the bot playtester (scripts/playtest.ts; run 300+ games from the CLI).
// Bots take only legal actions under strict rules; any exception, stall, invariant violation or hidden-info leak fails.
describe('bot playtester (fixed seeds)', () => {
  it('plays 6 random-deck games without exceptions, stalls, invariant violations or leaks', () => {
    const s = playtest(6, 1, { maxTurns: 25 });
    const bad = s.results.flatMap((r) => r.issues).filter((i) => i.kind !== 'manual');
    expect(bad, formatReport(s)).toEqual([]);
    expect(s.results.every((r) => r.actions > 0)).toBe(true);
  }, 120_000);
});
