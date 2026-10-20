/**
 * Card overrides (shared/data/overrides.json): Burning Inquiry renamed "Burning Sensation" (draw 7, discard 7 at random,
 * same art), and the Zirda / Forensic Gadgeteer house rules (cost reductions for activated abilities that go down to
 * {0}, Zirda's including mana abilities).
 */
import { describe, expect, it } from 'vitest';
import { CUBE, getCard, registerCards } from '../src/cube.ts';
import {
  abilityUsability, applyAction, applyCardOverride, castability, createGame, cubeToText, type CardData, type Ctx, type GameAction, type GameState,
  manaOptionsFor, moveCard, overrideNames, planAutoPay,
} from '../src/index.ts';
import { getScript, registerScripts } from '../src/engine/script.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[], fill = 'basic_mountain') => [...extra, ...Array(40 - extra.length).fill(fill)];

function setup(a: string[] = [], b: string[] = [], seed = 7) {
  const ctx: Ctx = { rng: seeded(seed), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(a), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(b), side: [] },
  ], 'a', ctx);
  act(g, ctx, 'a', { t: 'keep' });
  act(g, ctx, 'b', { t: 'keep' });
  return { g, ctx };
}
function act(g: GameState, ctx: Ctx, pid: string, action: GameAction) {
  const err = applyAction(g, pid, action, ctx);
  if (err) throw new Error(`${action.t}: ${err}`);
}
const P = (g: GameState, pid: string) => g.players.find((p) => p.pid === pid)!;
function find(g: GameState, pid: string, cardId: string): string {
  const p = P(g, pid);
  const iid = [...p.zones.hand, ...p.zones.library, ...p.zones.graveyard].find((i) => g.cards[i].cardId === cardId);
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}
function put(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId);
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  g.cards[iid].tapped = false;
  return iid;
}
function toHand(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId);
  if (g.cards[iid].zone !== 'hand') moveCard(g, ctx, iid, 'hand');
  return iid;
}
/** No lands on the battlefield, empty pools. */
function clearLands(g: GameState, ctx: Ctx) {
  for (const iid of [...g.battlefield]) if (g.cards[iid].cardId?.startsWith('basic_')) moveCard(g, ctx, iid, 'library');
}
const pool = (g: GameState, pid: string) => Object.values(P(g, pid).manaPool).reduce((a, b) => a + b, 0);
const abilityIndex = (cardId: string, re: RegExp) => getScript(cardId)![0].abilities.findIndex((l) => re.test(l));
const logText = (g: GameState) => g.log.map((l) => l.text).join('\n');

describe('override layer', () => {
  it('Burning Inquiry is "Burning Sensation" everywhere, with Burning Inquiry\'s art', () => {
    const c = getCard('burning_inquiry')!;
    expect(c.name).toBe('Burning Sensation');
    expect(c.oracle).toBe('Each player draws seven cards, then discards seven cards at random.');
    expect(c.image).toContain('exact=Burning%20Inquiry');
    expect(c.localImage).toBeTruthy();
    expect(CUBE.cards.find((x) => x.id === 'burning_inquiry')!.name).toBe('Burning Sensation');
    expect(getScript('burning_inquiry')![0].name).toBe('Burning Sensation');
    expect(getScript('burning_inquiry')![0].abilities[0]).toMatch(/NumCards\$ 7/);
    // both names resolve (deck lists, cube lists), and the cube list exports the new name
    expect(overrideNames()['burning inquiry']).toBe('burning_inquiry');
    expect(overrideNames()['burning sensation']).toBe('burning_inquiry');
    expect(cubeToText(['burning_inquiry'], getCard)).toContain('Burning Sensation');
  });

  it('applies to cards and scripts registered later (card database, client payloads), idempotently', () => {
    const raw: CardData = { ...getCard('burning_inquiry')!, name: 'Burning Inquiry', oracle: 'Each player draws three cards, then discards three cards at random.' };
    expect(applyCardOverride(raw).name).toBe('Burning Sensation');
    expect(applyCardOverride(applyCardOverride(raw))).toEqual(applyCardOverride(raw));
    registerCards([raw]);
    expect(getCard('burning_inquiry')!.name).toBe('Burning Sensation');
    registerScripts({ burning_inquiry: [{ name: 'Burning Inquiry', abilities: ['SP$ Draw | Defined$ Player | NumCards$ 3'], triggers: [], statics: [], replacements: [], keywords: [], svars: {} }] });
    expect(getScript('burning_inquiry')![0].abilities[0]).toMatch(/NumCards\$ 7/);
  });

  it('Burning Sensation: each player draws seven, then discards seven at random; the game shows the new name', () => {
    const { g, ctx } = setup(['burning_inquiry']);
    const bs = toHand(g, ctx, 'a', 'burning_inquiry');
    put(g, ctx, 'a', 'basic_mountain');
    const handA = P(g, 'a').zones.hand.length - 1;
    const handB = P(g, 'b').zones.hand.length;
    const gyA = P(g, 'a').zones.graveyard.length;
    const gyB = P(g, 'b').zones.graveyard.length;
    act(g, ctx, 'a', { t: 'cast', iid: bs });
    expect(g.stack[0].text).toMatch(/Burning Sensation/);
    for (let i = 0; i < 6 && (g.stack.length || g.pending.length); i++) {
      if (g.pending.length) throw new Error(`asked: ${g.pending[0].prompt}`);
      act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(P(g, 'a').zones.hand).toHaveLength(handA);
    expect(P(g, 'b').zones.hand).toHaveLength(handB);
    expect(P(g, 'a').zones.graveyard).toHaveLength(gyA + 8);
    expect(P(g, 'b').zones.graveyard).toHaveLength(gyB + 7);
    expect(logText(g)).toMatch(/Burning Sensation/);
    expect(logText(g)).not.toMatch(/Burning Inquiry/);
    expect(logText(g)).not.toMatch(/by hand|Not automated/i);
  });
});

describe('Zirda, the Dawnwaker (house rule): activated abilities you activate cost {2} less, down to {0}, mana abilities included', () => {
  it('has the house-rule text', () => {
    expect(getCard('zirda_the_dawnwaker')!.oracle).toMatch(/Activated abilities you activate cost \{2\} less to activate\. This effect can reduce the amount of mana an ability costs to activate to zero\./);
    expect(getCard('zirda_the_dawnwaker')!.oracle).toMatch(/\{1\}, \{T\}: Target creature can't block this turn\./);
  });

  it("non-mana abilities: Sensei's Divining Top {1} is free", () => {
    const { g, ctx } = setup(['zirda_the_dawnwaker', 'senseis_divining_top', 'walking_ballista']);
    clearLands(g, ctx);
    put(g, ctx, 'a', 'zirda_the_dawnwaker');
    const top = put(g, ctx, 'a', 'senseis_divining_top');
    const topAb = abilityIndex('senseis_divining_top', /RearrangeTopOfLibrary/);
    expect(abilityUsability(g, 'a', top, topAb).ok).toBe(true);
    act(g, ctx, 'a', { t: 'activate', iid: top, text: '', ability: topAb });
    expect(g.stack).toHaveLength(1);
  });

  it('Walking Ballista {4} costs {2}', () => {
    const { g, ctx } = setup(['zirda_the_dawnwaker', 'walking_ballista', 'basic_mountain', 'basic_mountain']);
    clearLands(g, ctx);
    put(g, ctx, 'a', 'zirda_the_dawnwaker');
    const bal = put(g, ctx, 'a', 'walking_ballista');
    const balAb = abilityIndex('walking_ballista', /PutCounter/);
    const m1 = put(g, ctx, 'a', 'basic_mountain');
    expect(abilityUsability(g, 'a', bal, balAb).ok).toBe(false);
    const m2 = put(g, ctx, 'a', 'basic_mountain');
    expect(abilityUsability(g, 'a', bal, balAb).ok).toBe(true);
    act(g, ctx, 'a', { t: 'activate', iid: bal, text: '', ability: balAb });
    expect(g.cards[m1].tapped && g.cards[m2].tapped).toBe(true);
    expect(pool(g, 'a')).toBe(0);
  });

  it('mana abilities: an Izzet Signet taps for {U}{R} with no mana; auto-pay and castability use it', () => {
    const { g, ctx } = setup(['zirda_the_dawnwaker', 'izzet_signet', 'counterspell', 'fire_ice']);
    clearLands(g, ctx);
    const signet = put(g, ctx, 'a', 'izzet_signet');
    const cs = toHand(g, ctx, 'a', 'counterspell');
    // without Zirda the Signet needs {1}
    expect(manaOptionsFor(g, signet, getCard)[0].sideEffects).toContain('Pay {1}');
    expect(planAutoPay(g, 'a', '{U}{R}', 0)).toBeNull();
    put(g, ctx, 'a', 'zirda_the_dawnwaker');
    expect(manaOptionsFor(g, signet, getCard)[0].sideEffects).not.toContain('Pay {1}');
    expect(planAutoPay(g, 'a', '{U}{R}', 0)?.picks.map((p) => p.key)).toEqual([signet]);
    expect(planAutoPay(g, 'a', '{1}{R}', 0)).not.toBeNull();
    expect(castability(g, 'a', cs).ok).toBe(false); // {U}{U}
    act(g, ctx, 'a', { t: 'activateMana', iid: signet, option: manaOptionsFor(g, signet, getCard)[0].id });
    expect(P(g, 'a').manaPool).toMatchObject({ U: 1, R: 1 });
    expect(g.cards[signet].tapped).toBe(true);
  });

  it("only its controller's abilities", () => {
    const { g, ctx } = setup(['senseis_divining_top'], ['zirda_the_dawnwaker']);
    clearLands(g, ctx);
    put(g, ctx, 'b', 'zirda_the_dawnwaker');
    const top = put(g, ctx, 'a', 'senseis_divining_top');
    expect(abilityUsability(g, 'a', top, abilityIndex('senseis_divining_top', /RearrangeTopOfLibrary/)).ok).toBe(false);
  });
});

describe('Forensic Gadgeteer (house rule): artifact abilities cost {1} less, down to {0}', () => {
  it('has the house-rule text', () => {
    expect(getCard('forensic_gadgeteer')!.oracle).toMatch(/This effect can reduce the amount of mana an ability costs to activate to zero\./);
  });

  it("Sensei's Divining Top is free; a Signet taps for free; non-artifact abilities are not reduced", () => {
    const { g, ctx } = setup(['forensic_gadgeteer', 'senseis_divining_top', 'izzet_signet', 'kytheon_hero_of_akros']);
    clearLands(g, ctx);
    put(g, ctx, 'a', 'forensic_gadgeteer');
    const top = put(g, ctx, 'a', 'senseis_divining_top');
    const signet = put(g, ctx, 'a', 'izzet_signet');
    const ky = put(g, ctx, 'a', 'kytheon_hero_of_akros');
    expect(abilityUsability(g, 'a', top, abilityIndex('senseis_divining_top', /RearrangeTopOfLibrary/)).ok).toBe(true);
    expect(planAutoPay(g, 'a', '{U}{R}', 0)?.picks.map((p) => p.key)).toEqual([signet]);
    // Kytheon ({2}{W}) is a creature: no reduction (only the Signet's two mana: not enough)
    expect(abilityUsability(g, 'a', ky, abilityIndex('kytheon_hero_of_akros', /^AB\$/)).ok).toBe(false);
    act(g, ctx, 'a', { t: 'activate', iid: top, text: '', ability: abilityIndex('senseis_divining_top', /RearrangeTopOfLibrary/) });
    expect(g.stack).toHaveLength(1);
    expect(g.cards[signet].tapped).toBe(false); // the Top cost nothing
  });
});
