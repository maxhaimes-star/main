/**
 * Multi-mana sources ("It doesn't understand Mana Crypt"): Mana Crypt, Sol Ring, Mana Vault, Worn Powerstone, Hedron
 * Archive (real database cards and scripts, fixtures/mana-rocks.ts) and the cube's Grim / Basalt Monolith, Thran Dynamo,
 * Ancient Tomb, City of Traitors. Casting them, tapping them by click, auto-pay with both / all their mana, castability,
 * Mana Crypt's upkeep coin flip and the bot.
 */
import { describe, expect, it } from 'vitest';
import { getCard, registerCards } from '../src/cube.ts';
import {
  applyAction, autoPayPreview, castability, createGame, type CardData, type Ctx, decideBotAction, type GameAction, type GameState, manaOptionsFor,
  moveCard, newBotMemory, planAutoPay, viewFor,
} from '../src/index.ts';
import { registerScripts } from '../src/engine/script.ts';
import { seeded } from './helpers.ts';
import { ROCKS } from './fixtures/mana-rocks.ts';

registerCards(Object.values(ROCKS).map((r) => ({ tokens: [], keywords: [], producedMana: [], colorIdentity: [], supertypes: [], subtypes: [], image: '', rank: 9999, ...r.card }) as unknown as CardData));
registerScripts(Object.fromEntries(Object.entries(ROCKS).map(([id, r]) => [id, r.script])) as never);

const deck = (extra: string[], fill = 'basic_island') => [...extra, ...Array(40 - extra.length).fill(fill)];

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

function find(g: GameState, pid: string, cardId: string, skip: string[] = []): string {
  const p = g.players.find((x) => x.pid === pid)!;
  const iid = [...p.zones.hand, ...p.zones.library, ...p.zones.graveyard].find((i) => g.cards[i].cardId === cardId && !skip.includes(i));
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}

function put(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId, g.battlefield.slice());
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  g.cards[iid].tapped = false;
  return iid;
}

/** Make `pid`'s hand exactly these cards (from the library). */
function setHand(g: GameState, ctx: Ctx, pid: string, ids: string[]): string[] {
  const p = g.players.find((x) => x.pid === pid)!;
  for (const iid of [...p.zones.hand]) moveCard(g, ctx, iid, 'library');
  const out: string[] = [];
  for (const id of ids) {
    const iid = p.zones.library.find((i) => g.cards[i].cardId === id && !out.includes(i))!;
    out.push(iid);
    moveCard(g, ctx, iid, 'hand');
  }
  return out;
}

/** Remove every land from the battlefield and hand that the test didn't put there. */
function clearLands(g: GameState, ctx: Ctx) {
  for (const iid of [...g.battlefield]) if (g.cards[iid].cardId?.startsWith('basic_')) moveCard(g, ctx, iid, 'library');
}

const P = (g: GameState, pid: string) => g.players.find((p) => p.pid === pid)!;
const logText = (g: GameState) => g.log.map((l) => l.text).join('\n');
const MANUAL = /by hand|Not automated|manual/i;

/** Pass priority until `pid` has it in `step` (or a question is pending). */
function passTo(g: GameState, ctx: Ctx, step: string, pid: string) {
  for (let i = 0; i < 80; i++) {
    if (g.step === step && g.priority === pid && !g.pending.length) return;
    if (g.pending.length) throw new Error(`pending: ${g.pending[0].prompt}`);
    act(g, ctx, g.priority, { t: 'pass' });
  }
  throw new Error(`never reached ${step} for ${pid} (at ${g.step})`);
}

describe('Mana Crypt', () => {
  it('is castable for {0} and resolves onto the battlefield', () => {
    const { g, ctx } = setup(['mana_crypt']);
    clearLands(g, ctx);
    const [crypt] = setHand(g, ctx, 'a', ['mana_crypt']);
    expect(castability(g, 'a', crypt).ok).toBe(true);
    act(g, ctx, 'a', { t: 'cast', iid: crypt });
    for (let i = 0; i < 4 && g.stack.length; i++) act(g, ctx, g.priority, { t: 'pass' });
    expect(g.cards[crypt].zone).toBe('battlefield');
  });

  it('clicking it adds {C}{C} (one scripted mana option)', () => {
    const { g, ctx } = setup(['mana_crypt']);
    const crypt = put(g, ctx, 'a', 'mana_crypt');
    const opts = manaOptionsFor(g, crypt, getCard);
    expect(opts).toHaveLength(1);
    expect(opts[0]).toMatchObject({ produces: 'CC', label: 'Add {C}{C}' });
    act(g, ctx, 'a', { t: 'activateMana', iid: crypt, option: opts[0].id });
    expect(P(g, 'a').manaPool.C).toBe(2);
    expect(g.cards[crypt].tapped).toBe(true);
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('auto-pay: Crypt + Island pays {2}{U}; Crypt alone pays {2}, {C}{C}, or {1} with one {C} floating', () => {
    const { g, ctx } = setup(['mana_crypt', 'counterspell', 'sol_ring']);
    clearLands(g, ctx);
    const crypt = put(g, ctx, 'a', 'mana_crypt');
    const island = put(g, ctx, 'a', 'basic_island');
    const p23 = planAutoPay(g, 'a', '{2}{U}', 0);
    expect(p23?.picks.map((p) => p.key).sort()).toEqual([crypt, island].sort());
    expect(planAutoPay(g, 'a', '{3}{U}', 0)).toBeNull();
    // {C}-specific costs
    expect(planAutoPay(g, 'a', '{C}{C}', 0)?.picks.map((p) => p.key)).toEqual([crypt]);
    expect(planAutoPay(g, 'a', '{1}{C}', 0)?.picks.map((p) => p.key)).toEqual([crypt]);
    // {1}: taps the Crypt, one {C} floats
    moveCard(g, ctx, island, 'library');
    const ring = setHand(g, ctx, 'a', ['sol_ring'])[0];
    expect(castability(g, 'a', ring).ok).toBe(true);
    act(g, ctx, 'a', { t: 'cast', iid: ring });
    expect(g.cards[crypt].tapped).toBe(true);
    expect(P(g, 'a').manaPool.C).toBe(1);
    for (let i = 0; i < 4 && g.stack.length; i++) act(g, ctx, g.priority, { t: 'pass' });
    expect(g.cards[ring].zone).toBe('battlefield');
  });

  it('castability counts the Crypt as 2 mana (with an Island: a 3-drop, not a 4-drop)', () => {
    const { g, ctx } = setup(['mana_crypt', 'counterspell', 'thran_dynamo', 'grim_monolith']);
    clearLands(g, ctx);
    put(g, ctx, 'a', 'mana_crypt');
    put(g, ctx, 'a', 'basic_island');
    const [dynamo, cs, grim] = setHand(g, ctx, 'a', ['thran_dynamo', 'counterspell', 'grim_monolith']);
    expect(castability(g, 'a', grim).ok).toBe(true); // {2}
    expect(castability(g, 'a', cs).ok).toBe(false); // {U}{U}
    expect(castability(g, 'a', dynamo).ok).toBe(false); // {4}
    const pv = autoPayPreview(g, 'a', grim);
    expect(pv.ok).toBe(true);
    expect(pv.taps).toHaveLength(1);
    expect(pv.taps[0].mana).toBe('CC');
  });

  it('the upkeep coin flip is automatic: a random flip, logged, 3 damage on a loss, nothing by hand', () => {
    let won = 0; let lost = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { g, ctx } = setup(['mana_crypt'], [], seed);
      put(g, ctx, 'a', 'mana_crypt');
      setHand(g, ctx, 'a', []); setHand(g, ctx, 'b', []);
      // to Alice's next upkeep, with the trigger on the stack
      for (let i = 0; i < 80 && !(g.turn === 3 && g.step === 'upkeep'); i++) {
        if (g.pending.length) throw new Error(`asked: ${g.pending[0].prompt}`);
        act(g, ctx, g.priority, { t: 'pass' });
      }
      expect(g.activePlayer).toBe('a');
      expect(g.step).toBe('upkeep');
      const life = P(g, 'a').life;
      for (let i = 0; i < 10 && (g.stack.length || g.pending.length); i++) {
        if (g.pending.length) throw new Error(`asked: ${g.pending[0].prompt}`);
        act(g, ctx, g.priority, { t: 'pass' });
      }
      const text = logText(g);
      expect(text).not.toMatch(MANUAL);
      if (/flips a coin \(Mana Crypt\): (heads|tails) — Alice loses the flip/.test(text)) { lost++; expect(P(g, 'a').life).toBe(life - 3); }
      else { expect(text).toMatch(/flips a coin \(Mana Crypt\): (heads|tails) — Alice wins the flip/); won++; expect(P(g, 'a').life).toBe(life); }
    }
    expect(won).toBeGreaterThan(0);
    expect(lost).toBeGreaterThan(0);
  });

  it('the bot casts the Crypt and uses its mana for a 3-drop with one land', () => {
    const { g, ctx } = setup(['mana_crypt', 'thran_dynamo', 'grim_monolith']);
    clearLands(g, ctx);
    put(g, ctx, 'a', 'basic_island');
    const [, grim] = setHand(g, ctx, 'a', ['mana_crypt', 'grim_monolith']);
    const mem = newBotMemory(1);
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      if (g.priority !== 'a' || g.step !== 'main1') break;
      const a = decideBotAction(viewFor(g, 'a'), 'a', mem);
      if (!a || a.t === 'pass') break;
      seen.push(a.t === 'cast' ? g.cards[a.iid].cardId! : a.t);
      act(g, ctx, 'a', a);
      for (let j = 0; j < 4 && g.stack.length; j++) act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(seen).toContain('mana_crypt');
    expect(seen).toContain('grim_monolith');
    expect(g.cards[grim].zone).toBe('battlefield');
  });
});

describe('auto-pay with multi-mana sources: both mana from one tap, no wasted taps', () => {
  const keys = (g: GameState, cost: string) => (planAutoPay(g, 'a', cost, 0)?.picks ?? []).filter((p) => !p.pool).map((p) => g.cards[p.key].cardId).sort();

  it('Mana Crypt pays {2} alone instead of tapping two lands; {1} with a land; {3} with Crypt + a land', () => {
    const { g, ctx } = setup(['mana_crypt']);
    clearLands(g, ctx);
    put(g, ctx, 'a', 'mana_crypt');
    put(g, ctx, 'a', 'basic_island'); put(g, ctx, 'a', 'basic_island'); put(g, ctx, 'a', 'basic_island');
    expect(keys(g, '{2}')).toEqual(['mana_crypt']);
    expect(keys(g, '{C}{C}')).toEqual(['mana_crypt']);
    expect(keys(g, '{1}')).toEqual(['basic_island']);
    expect(keys(g, '{3}')).toEqual(['basic_island', 'mana_crypt']);
    expect(keys(g, '{2}{U}')).toEqual(['basic_island', 'mana_crypt']);
    expect(keys(g, '{2}{U}{U}')).toEqual(['basic_island', 'basic_island', 'mana_crypt']);
    expect(keys(g, '{4}{U}')).toEqual(['basic_island', 'basic_island', 'basic_island', 'mana_crypt']);
  });

  it('a land making {C}{C} and the Crypt: {C}{C}, {1}{C} and {2} come from one of them alone', () => {
    const { g, ctx } = setup(['mana_crypt', 'city_of_traitors']);
    clearLands(g, ctx);
    put(g, ctx, 'a', 'mana_crypt');
    put(g, ctx, 'a', 'city_of_traitors');
    put(g, ctx, 'a', 'basic_island');
    // one {C}{C} source alone (the land first), never both
    expect(keys(g, '{C}{C}')).toEqual(['city_of_traitors']);
    expect(keys(g, '{1}{C}')).toEqual(['city_of_traitors']);
    expect(keys(g, '{2}')).toEqual(['city_of_traitors']);
    expect(keys(g, '{C}{U}')).toHaveLength(2);
    expect(keys(g, '{C}{C}{C}{C}')).toEqual(['city_of_traitors', 'mana_crypt']);
  });

  it('Sol Ring pays {2} alone; Ancient Tomb is only tapped when needed (it hurts)', () => {
    const { g, ctx } = setup(['sol_ring', 'ancient_tomb']);
    clearLands(g, ctx);
    put(g, ctx, 'a', 'sol_ring');
    put(g, ctx, 'a', 'ancient_tomb');
    put(g, ctx, 'a', 'basic_island'); put(g, ctx, 'a', 'basic_island');
    expect(keys(g, '{2}')).toEqual(['sol_ring']);
    expect(keys(g, '{4}')).toEqual(['basic_island', 'basic_island', 'sol_ring']);
    expect(keys(g, '{5}')).toEqual(['ancient_tomb', 'basic_island', 'sol_ring']);
  });

  it('Thran Dynamo pays {3} alone; Grim Monolith + Island pay {3}{U}', () => {
    const { g, ctx } = setup(['thran_dynamo']);
    clearLands(g, ctx);
    put(g, ctx, 'a', 'thran_dynamo');
    put(g, ctx, 'a', 'basic_island'); put(g, ctx, 'a', 'basic_island'); put(g, ctx, 'a', 'basic_island');
    expect(keys(g, '{3}')).toEqual(['thran_dynamo']);
    const { g: g2, ctx: c2 } = setup(['grim_monolith']);
    clearLands(g2, c2);
    put(g2, c2, 'a', 'grim_monolith');
    put(g2, c2, 'a', 'basic_island');
    expect(keys(g2, '{3}{U}')).toEqual(['basic_island', 'grim_monolith']);
  });

  it("Grim Monolith (doesn't untap) isn't wasted on a cost the lands pay as well, but pays {3} alone", () => {
    const { g, ctx } = setup(['grim_monolith']);
    clearLands(g, ctx);
    put(g, ctx, 'a', 'grim_monolith');
    put(g, ctx, 'a', 'basic_island'); put(g, ctx, 'a', 'basic_island'); put(g, ctx, 'a', 'basic_island');
    expect(keys(g, '{2}')).toEqual(['basic_island', 'basic_island']);
    expect(keys(g, '{3}')).toEqual(['grim_monolith']);
    expect(keys(g, '{5}')).toEqual(['basic_island', 'basic_island', 'grim_monolith']);
  });

  it('casting with the Crypt taps it once and pays the whole cost from its mana', () => {
    const { g, ctx } = setup(['mana_crypt', 'grim_monolith']);
    clearLands(g, ctx);
    const crypt = put(g, ctx, 'a', 'mana_crypt');
    const isl = put(g, ctx, 'a', 'basic_island');
    const [grim] = setHand(g, ctx, 'a', ['grim_monolith']);
    act(g, ctx, 'a', { t: 'cast', iid: grim });
    expect(g.cards[crypt].tapped).toBe(true);
    expect(g.cards[isl].tapped).toBe(false);
    expect(P(g, 'a').manaPool.C ?? 0).toBe(0);
  });
});

describe('other multi-mana rocks', () => {
  it('Sol Ring: cast for {1}, then taps for {C}{C}', () => {
    const { g, ctx } = setup(['sol_ring', 'thran_dynamo']);
    clearLands(g, ctx);
    put(g, ctx, 'a', 'basic_island');
    const [ring, dynamo] = setHand(g, ctx, 'a', ['sol_ring', 'thran_dynamo']);
    expect(castability(g, 'a', ring).ok).toBe(true);
    expect(castability(g, 'a', dynamo).ok).toBe(false);
    act(g, ctx, 'a', { t: 'cast', iid: ring });
    for (let i = 0; i < 4 && g.stack.length; i++) act(g, ctx, g.priority, { t: 'pass' });
    expect(g.cards[ring].zone).toBe('battlefield');
    expect(manaOptionsFor(g, ring, getCard)).toEqual([expect.objectContaining({ produces: 'CC' })]);
  });

  it('Worn Powerstone enters tapped and then taps for {C}{C}', () => {
    const { g, ctx } = setup(['worn_powerstone']);
    clearLands(g, ctx);
    for (let i = 0; i < 3; i++) put(g, ctx, 'a', 'basic_island');
    const [ps] = setHand(g, ctx, 'a', ['worn_powerstone']);
    act(g, ctx, 'a', { t: 'cast', iid: ps });
    for (let i = 0; i < 4 && g.stack.length; i++) act(g, ctx, g.priority, { t: 'pass' });
    expect(g.cards[ps].zone).toBe('battlefield');
    expect(g.cards[ps].tapped).toBe(true);
    expect(manaOptionsFor(g, ps, getCard)[0].produces).toBe('CC');
  });

  it('Mana Vault: taps for {C}{C}{C} and may be untapped for {4} in upkeep (then no draw-step damage)', () => {
    const { g, ctx } = setup(['mana_vault']);
    clearLands(g, ctx);
    const vault = put(g, ctx, 'a', 'mana_vault');
    for (let i = 0; i < 4; i++) put(g, ctx, 'a', 'basic_island');
    setHand(g, ctx, 'a', []); setHand(g, ctx, 'b', []);
    act(g, ctx, 'a', { t: 'activateMana', iid: vault, option: manaOptionsFor(g, vault, getCard)[0].id });
    expect(P(g, 'a').manaPool.C).toBe(3);
    let asked = false;
    for (let i = 0; i < 120 && !(g.turn === 3 && g.step === 'main1'); i++) {
      const q = g.pending[0];
      if (q) {
        asked = true;
        const yes = q.options.find((o) => /yes|pay|untap/i.test(o.label)) ?? q.options[0];
        act(g, ctx, q.pid, { t: 'choose', id: q.id, value: yes.value });
      } else act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(asked).toBe(true);
    expect(g.cards[vault].tapped).toBe(false);
    expect(P(g, 'a').life).toBe(20);
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Mana Vault left tapped deals 1 damage at the beginning of the draw step', () => {
    const { g, ctx } = setup(['mana_vault']);
    clearLands(g, ctx);
    const vault = put(g, ctx, 'a', 'mana_vault');
    setHand(g, ctx, 'a', []); setHand(g, ctx, 'b', []);
    g.cards[vault].tapped = true;
    for (let i = 0; i < 120 && !(g.turn === 3 && g.step === 'main1'); i++) {
      const q = g.pending[0];
      if (q) act(g, ctx, q.pid, { t: 'choose', id: q.id, value: (q.options.find((o) => /^(no|decline|don't)/i.test(o.label)) ?? q.options[q.options.length - 1]).value });
      else act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(g.cards[vault].tapped).toBe(true);
    expect(P(g, 'a').life).toBe(19);
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Grim Monolith: {4}: untap it, paid by auto-pay from lands', () => {
    const { g, ctx } = setup(['grim_monolith']);
    clearLands(g, ctx);
    const grim = put(g, ctx, 'a', 'grim_monolith');
    for (let i = 0; i < 4; i++) put(g, ctx, 'a', 'basic_island');
    act(g, ctx, 'a', { t: 'activateMana', iid: grim, option: manaOptionsFor(g, grim, getCard)[0].id });
    expect(P(g, 'a').manaPool.C).toBe(3);
    P(g, 'a').manaPool.C = 0;
    act(g, ctx, 'a', { t: 'activate', iid: grim, text: '', ability: 1 });
    for (let i = 0; i < 4 && g.stack.length; i++) act(g, ctx, g.priority, { t: 'pass' });
    expect(g.cards[grim].tapped).toBe(false);
  });
});

describe('the bot with multi-mana sources', () => {
  it('counts each rock at its full amount for X: Crypt + two Grim Monoliths + {W} cast Jacked Rabbit ({X}{1}{W}) for X = 7', () => {
    const { g, ctx } = setup(['mana_crypt', 'grim_monolith', 'grim_monolith', 'jacked_rabbit']);
    clearLands(g, ctx);
    put(g, ctx, 'a', 'mana_crypt'); put(g, ctx, 'a', 'grim_monolith'); put(g, ctx, 'a', 'grim_monolith');
    P(g, 'a').manaPool.W = 1;
    const [rabbit] = setHand(g, ctx, 'a', ['jacked_rabbit']);
    const a = decideBotAction(viewFor(g, 'a'), 'a', newBotMemory(1));
    expect(a).toMatchObject({ t: 'cast', iid: rabbit, x: 7 });
  });
});
