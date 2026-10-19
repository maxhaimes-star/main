/**
 * Cards outside the cube (Standard / recent sets) found by the playtester with a database pool
 * (scripts/playtest.ts --pool=standard|set:CODE). The cards and their Forge scripts are real (fixtures/noncube-cards.ts).
 */
import { describe, expect, it } from 'vitest';
import { getCard, registerCards } from '../src/cube.ts';
import { abilitiesOfInstance, applyAction, castOptions, createGame, type CardData, type Ctx, evalCount, type GameAction, type GameState, effectivePT, moveCard } from '../src/index.ts';
import { registerScripts } from '../src/engine/script.ts';
import { seeded } from './helpers.ts';
import { REAL, REAL_TOKENS } from './fixtures/noncube-cards.ts';

registerCards(Object.values(REAL).map((r) => ({ tokens: [], keywords: [], producedMana: [], colorIdentity: [], supertypes: [], subtypes: [], image: '', rank: 9999, ...r.card }) as unknown as CardData));
registerScripts(Object.fromEntries(Object.entries(REAL).map(([id, r]) => [id, r.script])) as never, REAL_TOKENS as never);

const deck = (extra: string[], fill = 'basic_forest') => [...extra, ...Array(40 - extra.length).fill(fill)];
function setup(a: string[], b: string[] = []) {
  const ctx: Ctx = { rng: seeded(9), lookup: getCard, now: 0 };
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
  if (err) throw new Error(err);
}
function find(g: GameState, pid: string, cardId: string): string {
  const p = g.players.find((x) => x.pid === pid)!;
  const iid = [...p.zones.hand, ...p.zones.library].find((i) => g.cards[i].cardId === cardId);
  if (!iid) throw new Error(`no ${cardId}`);
  return iid;
}
function toHand(g: GameState, ctx: Ctx, cardId: string, pid = 'a'): string {
  const iid = find(g, pid, cardId);
  if (g.cards[iid].zone !== 'hand') moveCard(g, ctx, iid, 'hand');
  return iid;
}
function put(g: GameState, ctx: Ctx, cardId: string, pid = 'a'): string {
  const iid = find(g, pid, cardId);
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  g.events = []; g.triggerQueue = [];
  return iid;
}
/** Resolve the stack, answering questions with the option matching `pick` (else the first). */
function resolveAll(g: GameState, ctx: Ctx, pick?: (labels: string[]) => number) {
  for (let i = 0; i < 60 && (g.stack.length || g.pending.length); i++) {
    const q = g.pending[0];
    if (q?.options.length) act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options[Math.max(0, pick ? pick(q.options.map((o) => o.label)) : 0)].value });
    else if (q) throw new Error(`unanswerable: ${q.prompt}`);
    else act(g, ctx, g.priority, { t: 'pass' });
  }
}
const logText = (g: GameState) => g.log.map((l) => l.text).join('\n');
const MANUAL = /by hand|Not automated/;
const pool = (g: GameState, pid: string, mana: Record<string, number>) => Object.assign(g.players.find((p) => p.pid === pid)!.manaPool, mana);

describe('variables: ParentTargeted$CardPower, /Twice math, Pump NumAtt$ Double', () => {
  it('Bite Down: my creature deals damage equal to its power to the other target', () => {
    const { g, ctx } = setup(['bite_down', 'grizzly_bears'], ['savannah_lions']);
    const bear = put(g, ctx, 'grizzly_bears');
    const lion = put(g, ctx, 'savannah_lions', 'b');
    pool(g, 'a', { G: 2 });
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'bite_down'), targets: [[{ kind: 'card', iid: bear }], [{ kind: 'card', iid: lion }]] });
    resolveAll(g, ctx);
    expect(g.cards[lion].zone).toBe('graveyard');
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Polliwallop: twice its power', () => {
    const { g, ctx } = setup(['polliwallop', 'grizzly_bears'], ['serra_angel']);
    const bear = put(g, ctx, 'grizzly_bears');
    const angel = put(g, ctx, 'serra_angel', 'b');
    pool(g, 'a', { G: 4 });
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'polliwallop'), targets: [[{ kind: 'card', iid: bear }], [{ kind: 'card', iid: angel }]] });
    resolveAll(g, ctx);
    expect(g.cards[angel].zone).toBe('graveyard'); // 4 damage to a 4/4
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Bulk Up doubles power', () => {
    const { g, ctx } = setup(['bulk_up', 'grizzly_bears']);
    const bear = put(g, ctx, 'grizzly_bears');
    pool(g, 'a', { R: 2 });
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'bulk_up'), targets: [[{ kind: 'card', iid: bear }]] });
    resolveAll(g, ctx);
    expect(effectivePT(g.cards[bear], getCard, g)).toEqual([4, 2]);
    expect(logText(g)).not.toMatch(MANUAL);
  });
});

describe('Count$ aggregates: $Colors (Vivid), ThisTurnCast_...$CardTypes', () => {
  it('Luminollusk: gain life equal to the number of colors among permanents you control', () => {
    const { g, ctx } = setup(['luminollusk', 'savannah_lions']);
    put(g, ctx, 'savannah_lions');
    pool(g, 'a', { G: 4 });
    const life = g.players[0].life;
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'luminollusk') });
    resolveAll(g, ctx);
    expect(g.players[0].life).toBe(life + 2); // green + white
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it("April O'Neil counts card types among spells you've cast this turn", () => {
    const { g, ctx } = setup(['april_oneil_hacktivist', 'lightning_bolt', 'grizzly_bears', 'savannah_lions']);
    pool(g, 'a', { R: 1, G: 2, W: 1 });
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'lightning_bolt'), targets: [[{ kind: 'player', pid: 'b' }]] });
    resolveAll(g, ctx);
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'grizzly_bears') });
    resolveAll(g, ctx);
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'savannah_lions') });
    resolveAll(g, ctx);
    const env = { state: g, lookup: getCard, controller: 'a' };
    expect(evalCount('Count$ThisTurnCast_Card.YouCtrl$CardTypes', env)).toBe(2);
    expect(evalCount('Count$ThisTurnCast_Card.YouCtrl', env)).toBe(3);
    expect(evalCount('Count$ThisTurnCast_Card.YouCtrl$GreatestCardManaCost', env)).toBe(2);
    expect(evalCount('Count$Valid Creature.YouCtrl$CardPower', env)).toBe(4); // 2/2 + 2/1
    expect(evalCount('Count$Valid Creature.YouCtrl$Colors', env)).toBe(2);
  });
});

describe('Blight (Lorwyn Eclipsed): -1/-1 counters on a creature you control', () => {
  it("Dream Seizer: 'you may blight 1. If you do, each opponent discards a card' (optional trigger cost)", () => {
    const { g, ctx } = setup(['dream_seizer', 'serra_angel'], ['grizzly_bears']);
    const angel = put(g, ctx, 'serra_angel');
    toHand(g, ctx, 'grizzly_bears', 'b');
    const oppHand = g.players[1].zones.hand.length;
    pool(g, 'a', { B: 4 });
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'dream_seizer') });
    resolveAll(g, ctx, (labels) => { const i = labels.findIndex((l) => /^(Pay|Yes)|Serra Angel/i.test(l)); return i; });
    expect(g.cards[angel].counters['-1/-1']).toBe(1);
    expect(g.players[1].zones.hand.length).toBe(oppHand - 1);
    expect(logText(g)).toMatch(/blights 1/);
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Gristle Glutton: {T}, Blight 1 as an activated-ability cost', () => {
    const { g, ctx } = setup(['gristle_glutton', 'serra_angel', 'grizzly_bears']);
    const glutton = put(g, ctx, 'gristle_glutton');
    const angel = put(g, ctx, 'serra_angel');
    toHand(g, ctx, 'grizzly_bears');
    const ab = abilitiesOfInstance(g.cards[glutton], g, getCard).find((e) => e.ability.api === 'Discard')!;
    act(g, ctx, 'a', { t: 'activate', iid: glutton, ability: ab.index, text: '' });
    resolveAll(g, ctx, (labels) => labels.findIndex((l) => /Serra Angel|Grizzly Bears/.test(l)));
    expect(g.cards[angel].counters['-1/-1']).toBe(1);
    expect(g.cards[glutton].tapped).toBe(true);
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it("Bogslither's Embrace: blight 1 or pay {3} as the additional cost", () => {
    const { g, ctx } = setup(['bogslithers_embrace', 'grizzly_bears'], ['serra_angel']);
    const bear = put(g, ctx, 'grizzly_bears');
    const angel = put(g, ctx, 'serra_angel', 'b');
    const iid = toHand(g, ctx, 'bogslithers_embrace');
    const opts = castOptions(g, iid);
    expect(opts.map((o) => o.label).join('|')).toMatch(/Blight 1/);
    pool(g, 'a', { B: 2 });
    act(g, ctx, 'a', { t: 'cast', iid, targets: [[{ kind: 'card', iid: angel }]] });
    resolveAll(g, ctx);
    expect(g.cards[angel].zone).toBe('exile');
    expect(g.cards[bear].counters['-1/-1']).toBe(1); // blighted to pay
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('High Perfect Morcant: each opponent blights 1 (effect, the opponent chooses)', () => {
    const { g, ctx } = setup(['high_perfect_morcant'], ['serra_angel', 'grizzly_bears']);
    const angel = put(g, ctx, 'serra_angel', 'b');
    const bear = put(g, ctx, 'grizzly_bears', 'b');
    pool(g, 'a', { B: 2, G: 2 });
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'high_perfect_morcant') });
    resolveAll(g, ctx, (labels) => labels.findIndex((l) => /Serra Angel/.test(l)));
    expect(g.cards[angel].counters['-1/-1']).toBe(1);
    expect(g.cards[bear].counters['-1/-1'] ?? 0).toBe(0);
    expect(logText(g)).not.toMatch(MANUAL);
  });
});

describe('Behold as an additional cost (AlternateAdditionalCost:Behold<1/Goblin>:2)', () => {
  it('Mudbutton Cursetosser: behold a Goblin from the battlefield or the hand, or pay {2}', () => {
    const { g, ctx } = setup(['mudbutton_cursetosser', 'goblin_guide']);
    const guide = toHand(g, ctx, 'goblin_guide');
    const iid = toHand(g, ctx, 'mudbutton_cursetosser');
    const labels = castOptions(g, iid).map((o) => o.label);
    expect(labels.join('|')).toMatch(/Behold a Goblin/);
    pool(g, 'a', { B: 1 });
    act(g, ctx, 'a', { t: 'cast', iid });
    resolveAll(g, ctx);
    expect(g.cards[iid].zone).toBe('battlefield');
    expect(g.cards[guide].zone).toBe('hand');
    expect(logText(g)).toMatch(/beholds Goblin Guide \(revealed from hand\)/);
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('without a Goblin the behold option is unpayable', () => {
    const { g, ctx } = setup(['mudbutton_cursetosser']);
    const iid = toHand(g, ctx, 'mudbutton_cursetosser');
    const o = castOptions(g, iid).find((x) => /Behold/.test(x.label))!;
    expect(o.unavailable ?? (o as { error?: string }).error ?? '').toMatch(/not enough/);
  });
});

describe('remove counters as an activated-ability cost', () => {
  it('Gnarlbark Elm: RemoveAnyCounter<2/Any/CARDNAME> — removes its -1/-1 counters', () => {
    const { g, ctx } = setup(['gnarlbark_elm'], ['grizzly_bears']);
    const elm = put(g, ctx, 'gnarlbark_elm');
    g.cards[elm].counters['-1/-1'] = 2;
    const bear = put(g, ctx, 'grizzly_bears', 'b');
    pool(g, 'a', { B: 3 });
    const ab = abilitiesOfInstance(g.cards[elm], g, getCard).find((e) => e.ability.api === 'Pump')!;
    act(g, ctx, 'a', { t: 'activate', iid: elm, ability: ab.index, text: '', targets: [[{ kind: 'card', iid: bear }]] });
    resolveAll(g, ctx);
    expect(g.cards[elm].counters['-1/-1'] ?? 0).toBe(0);
    expect(g.cards[bear].zone).toBe('graveyard');
    expect(logText(g)).not.toMatch(MANUAL);
    // No counters left: can't activate again.
    pool(g, 'a', { B: 3 });
    expect(applyAction(g, 'a', { t: 'activate', iid: elm, ability: ab.index, text: '', targets: [[{ kind: 'card', iid: elm }]] }, ctx)).toMatch(/counter/);
  });

  it('Ray Fillet: SubCounter<1/P1P1/Creature.YouCtrl> — a +1/+1 counter from a creature you control', () => {
    const { g, ctx } = setup(['ray_fillet_man_ray', 'grizzly_bears', 'serra_angel']);
    const ray = put(g, ctx, 'ray_fillet_man_ray');
    const bear = put(g, ctx, 'grizzly_bears');
    const angel = put(g, ctx, 'serra_angel');
    g.cards[bear].counters['+1/+1'] = 1;
    g.cards[angel].counters['+1/+1'] = 2;
    const hand = g.players[0].zones.hand.length;
    pool(g, 'a', { U: 2 });
    const ab = abilitiesOfInstance(g.cards[ray], g, getCard).find((e) => e.ability.api === 'Draw')!;
    act(g, ctx, 'a', { t: 'activate', iid: ray, ability: ab.index, text: '' });
    resolveAll(g, ctx, (labels) => labels.findIndex((l) => /Serra Angel/.test(l)));
    expect(g.cards[angel].counters['+1/+1']).toBe(1);
    expect(g.cards[bear].counters['+1/+1']).toBe(1);
    expect(g.players[0].zones.hand.length).toBe(hand + 1);
    expect(logText(g)).not.toMatch(MANUAL);
  });
});

describe('trigger conditions: Revolt$ (disappear), OpponentTurn$, ChosenType in trigger filters', () => {
  it('Foot Mystic: the ninja only if a permanent left the battlefield under your control this turn', () => {
    const { g, ctx } = setup(['foot_mystic', 'foot_mystic', 'grizzly_bears']);
    pool(g, 'a', { B: 4 });
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'foot_mystic') });
    resolveAll(g, ctx);
    const ninjas = () => g.battlefield.filter((i) => g.cards[i].token?.name === 'Ninja').length;
    expect(ninjas()).toBe(0);
    const bear = put(g, ctx, 'grizzly_bears');
    moveCard(g, ctx, bear, 'graveyard');
    pool(g, 'a', { B: 4 });
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'foot_mystic') });
    resolveAll(g, ctx);
    expect(ninjas()).toBe(1);
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it("Brineborn Cutthroat: only spells cast during an opponent's turn", () => {
    const { g, ctx } = setup(['brineborn_cutthroat', 'lightning_bolt', 'lightning_bolt']);
    const cut = put(g, ctx, 'brineborn_cutthroat');
    pool(g, 'a', { R: 1 });
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'lightning_bolt'), targets: [[{ kind: 'player', pid: 'b' }]] });
    resolveAll(g, ctx);
    expect(g.cards[cut].counters['+1/+1'] ?? 0).toBe(0);
    g.activePlayer = 'b';
    pool(g, 'a', { R: 1 });
    g.priority = 'a';
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'lightning_bolt'), targets: [[{ kind: 'player', pid: 'b' }]] });
    resolveAll(g, ctx);
    expect(g.cards[cut].counters['+1/+1']).toBe(1);
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Dawn-Blessed Pennant: a permanent of the chosen type entering gains 1 life (no "check by hand")', () => {
    const { g, ctx } = setup(['dawn_blessed_pennant', 'llanowar_elves', 'grizzly_bears']);
    const pen = put(g, ctx, 'dawn_blessed_pennant');
    g.pending = [];
    g.cards[pen].chosen = { type: 'Elf' };
    const life = g.players[0].life;
    pool(g, 'a', { G: 3 });
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'grizzly_bears') });
    resolveAll(g, ctx);
    expect(g.players[0].life).toBe(life);
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'llanowar_elves') });
    resolveAll(g, ctx);
    expect(g.players[0].life).toBe(life + 1);
    expect(logText(g)).not.toMatch(MANUAL);
  });
});

describe('tokens / animate / mana / remove counters details', () => {
  it('Harried Dronesmith: the Thopter gains haste and is sacrificed at the beginning of your next end step', () => {
    const { g, ctx } = setup(['harried_dronesmith']);
    put(g, ctx, 'harried_dronesmith');
    const thopterNow = () => g.battlefield.find((i) => g.cards[i].token?.name === 'Thopter');
    for (let i = 0; i < 40 && !thopterNow(); i++) { if (g.pending.length) resolveAll(g, ctx); else act(g, ctx, g.priority, { t: 'pass' }); }
    const thopter = thopterNow();
    expect(thopter).toBeTruthy();
    expect(g.cards[thopter!].tempKeywords).toContain('Haste');
    expect(g.delayedTriggers?.some((d) => d.pid === 'a' && d.step === 'end')).toBe(true);
    for (let i = 0; i < 40 && g.turn === 1; i++) { if (g.pending.length || g.stack.length) resolveAll(g, ctx); else act(g, ctx, g.priority, { t: 'pass' }); }
    expect(g.cards[thopter!]?.zone ?? 'gone').not.toBe('battlefield');
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it("Puca's Eye: becomes the chosen color", () => {
    const { g, ctx } = setup(['pucas_eye']);
    pool(g, 'a', { C: 2 });
    const eye = toHand(g, ctx, 'pucas_eye');
    act(g, ctx, 'a', { t: 'cast', iid: eye });
    resolveAll(g, ctx, (labels) => labels.indexOf('Red'));
    expect(g.cards[eye].animations?.some((a) => a.colors?.includes('R') && a.overwriteColors)).toBe(true);
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it('Foraging Wickermaw: adds one mana of the chosen color', () => {
    const { g, ctx } = setup(['foraging_wickermaw']);
    const w = put(g, ctx, 'foraging_wickermaw');
    pool(g, 'a', { C: 1 });
    const ab = abilitiesOfInstance(g.cards[w], g, getCard).find((e) => e.ability.api === 'ChooseColor')!;
    act(g, ctx, 'a', { t: 'activate', iid: w, ability: ab.index, text: '' });
    resolveAll(g, ctx, (labels) => labels.indexOf('Blue'));
    expect(g.players[0].manaPool.U).toBe(1);
    expect(logText(g)).not.toMatch(MANUAL);
  });

  it("Heartless Act: remove up to three counters — an opponent's +1/+1 counters", () => {
    const { g, ctx } = setup(['heartless_act'], ['grizzly_bears']);
    const bear = put(g, ctx, 'grizzly_bears', 'b');
    g.cards[bear].counters['+1/+1'] = 4;
    pool(g, 'a', { B: 2 });
    act(g, ctx, 'a', { t: 'cast', iid: toHand(g, ctx, 'heartless_act'), modes: ['Remove'], targets: [[{ kind: 'card', iid: bear }]] });
    resolveAll(g, ctx);
    expect(g.cards[bear].counters['+1/+1']).toBe(1);
    expect(logText(g)).not.toMatch(MANUAL);
  });
});
