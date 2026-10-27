/**
 * "Power up" (lobby option): the room's cube list gets the Power Nine plus Sol Ring, Mana Vault and Mana Crypt, skipping
 * any it already has. Cards outside the built-in cube come from the card database (server/src/roomcards.ts), like
 * an imported cube's.
 */
export const POWER_CARDS = [
  'black_lotus', 'mox_pearl', 'mox_sapphire', 'mox_jet', 'mox_ruby', 'mox_emerald',
  'ancestral_recall', 'time_walk', 'timetwister', 'mana_vault', 'sol_ring', 'mana_crypt',
] as const;

/** `list` plus the power cards it doesn't have (`available`: only cards this server can load). */
export function withPower(list: string[], available: (id: string) => boolean = () => true): string[] {
  const have = new Set(list);
  const add = POWER_CARDS.filter((id) => !have.has(id) && available(id));
  return add.length ? [...list, ...add] : list;
}
