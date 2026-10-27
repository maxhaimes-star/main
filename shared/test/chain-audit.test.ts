import { describe, expect, it } from 'vitest';
import { chainAudit } from '../../scripts/chain-audit.ts';

// Every multi-step ability of every cube card (spells, activated abilities, triggers, each mode) runs in a prepared
// game: a step that is reached must reach its SubAbility$ (or one of its result chains: RollDice, Branch ...).
describe('chain audit (scripts/chain-audit.ts)', () => {
  it('no cube ability chain stops partway', () => {
    const { entries, misses } = chainAudit();
    expect(entries).toBeGreaterThan(200);
    expect(misses.map((m) => `${m.cardId} ${m.entry}: ${m.step} -> ${m.missing} | ${m.log.slice(0, 200)}`)).toEqual([]);
  }, 300_000);
});
