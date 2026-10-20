/** Workstream A2 card bugs (strict mode, real cube scripts). */
import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  abilityUsability, activatedAbilitiesOf, applyAction, castability, createGame, type Ctx, evalCount, type GameAction, type GameState, manaOptionsFor, matchCard, moveCard, viewFor,
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

describe('A2.4: tutors that say "reveal" reveal the found card', () => {
  function tutor(id: string, find: string, land = 'basic_island') {
    const { g, ctx } = setup([id, find], [], 7, land);
    for (let k = 0; k < 3; k++) put(g, ctx, 'a', land);
    const t = toZone(g, ctx, 'a', id, 'hand');
    act(g, ctx, 'a', { t: 'cast', iid: t });
    drain(g, ctx, (q) => q.options.find((o) => g.cards[o.value]?.cardId === find)?.value ?? q.options[0].value);
    return { g, found: P(g, 'a').zones.library[0] };
  }

  it('Mystical Tutor: the instant is revealed to the opponent, shown in the Revealed zone, and put on top', () => {
    const { g, found } = tutor('mystical_tutor', 'lightning_bolt');
    expect(g.cards[found].cardId).toBe('lightning_bolt');
    expect(g.cards[found].revealedTo).toContain('b');
    const rv = viewFor(g, 'b').reveals ?? [];
    expect(rv.some((r) => r.by === 'a' && r.cards.some((c) => c.cardId === 'lightning_bolt')), JSON.stringify(rv)).toBe(true);
    expect(logText(g)).toMatch(/reveals Lightning Bolt/);
  });

  it("Vampiric Tutor (no reveal) doesn't reveal the card", () => {
    const { g, found } = tutor('vampiric_tutor', 'lightning_bolt', 'basic_swamp');
    expect(g.cards[found].cardId).toBe('lightning_bolt');
    expect(g.cards[found].revealedTo).not.toContain('b');
    expect((viewFor(g, 'b').reveals ?? []).length).toBe(0);
  });
});

/** Pass priority (answering questions with the first option) until `pid`'s turn is at `step` with an empty stack. */
function advanceTo(g: GameState, ctx: Ctx, pid: string, step: string, minTurn = 0) {
  for (let i = 0; i < 400; i++) {
    if (g.pending.length) { answer(g, ctx); continue; }
    if (g.activePlayer === pid && g.step === step && g.turn >= minTurn && !g.stack.length) return;
    act(g, ctx, g.priority, { t: 'pass' });
  }
  throw new Error(`never reached ${step}`);
}

describe('A2.5: Shrines count only the Shrine subtype', () => {
  const OTHERS = ['spirited_companion', 'parallax_wave', 'aangs_iceberg', 'godless_shrine', 'sanctum_weaver'];

  it('Sanctum of Stone Fangs: X = Shrines you control, not enchantments', () => {
    const { g, ctx } = setup(['sanctum_of_stone_fangs', 'honden_of_seeing_winds', ...OTHERS]);
    for (const id of ['sanctum_of_stone_fangs', 'honden_of_seeing_winds', ...OTHERS]) put(g, ctx, 'a', id);
    const life = P(g, 'b').life;
    advanceTo(g, ctx, 'a', 'main1', 3);
    expect(P(g, 'b').life, logText(g)).toBe(life - 2);
  });

  it('a permanent with all creature types (animated Mutavault) is not a Shrine', () => {
    const { g, ctx } = setup(['sanctum_of_stone_fangs', 'mutavault']);
    put(g, ctx, 'a', 'sanctum_of_stone_fangs');
    const mv = put(g, ctx, 'a', 'mutavault');
    put(g, ctx, 'a', 'basic_mountain');
    const ab = activatedAbilitiesOf('mutavault', 0).find((e) => e.ability.api === 'Animate')!;
    act(g, ctx, 'a', { t: 'activate', iid: mv, text: '', ability: ab.index });
    drain(g, ctx);
    expect(matchCard(g.cards[mv], 'Goblin', { controller: 'a', lookup: getCard })).toBe(true);
    expect(matchCard(g.cards[mv], 'Shrine.YouCtrl', { controller: 'a', lookup: getCard })).toBe(false);
    expect(evalCount('Count$Valid Shrine.YouCtrl', { state: g, lookup: getCard, controller: 'a' })).toBe(1);
  });

  it('Honden of Seeing Winds draws one card per Shrine', () => {
    const { g, ctx } = setup(['honden_of_seeing_winds', 'sanctum_of_calm_waters', ...OTHERS]);
    for (const id of ['honden_of_seeing_winds', 'sanctum_of_calm_waters', ...OTHERS]) put(g, ctx, 'a', id);
    advanceTo(g, ctx, 'a', 'upkeep', 3);
    expect(logText(g)).toMatch(/Alice draws 2 cards/);
  });

  it('Sanctum of All finds only Shrine cards', () => {
    const { g, ctx } = setup(['sanctum_of_all', 'honden_of_infinite_rage', 'parallax_wave', 'sanctum_weaver']);
    put(g, ctx, 'a', 'sanctum_of_all');
    toZone(g, ctx, 'a', 'parallax_wave', 'graveyard');
    toZone(g, ctx, 'a', 'sanctum_weaver', 'graveyard');
    const offered: string[] = [];
    for (let i = 0; i < 400 && !(g.turn >= 3 && g.step === 'main1'); i++) {
      if (g.pending.length) {
        const q = g.pending[0];
        for (const o of q.options) if (g.cards[o.value]) offered.push(g.cards[o.value].cardId!);
        act(g, ctx, q.pid, { t: 'choose', id: q.id, value: q.options[0].value });
        continue;
      }
      act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(offered).toContain('honden_of_infinite_rage');
    expect(offered).not.toContain('parallax_wave');
    expect(offered).not.toContain('sanctum_weaver');
  });
});

describe('A2.6: Chrome Mox (imprint, then mana of an imprinted color)', () => {
  function castMox(imprint: string | null, hand: string[]) {
    const { g, ctx } = setup(['chrome_mox', ...hand], [], 7, 'basic_island');
    const mox = toZone(g, ctx, 'a', 'chrome_mox', 'hand');
    for (const h of hand) toZone(g, ctx, 'a', h, 'hand', P(g, 'a').zones.hand.slice());
    act(g, ctx, 'a', { t: 'cast', iid: mox });
    drain(g, ctx, (q) => {
      if (imprint === null) return q.options.find((o) => /no|don't|decline|none|skip/i.test(o.label) || o.value === 'none' || o.value === 'no')?.value ?? q.options[q.options.length - 1].value;
      return q.options.find((o) => g.cards[o.value]?.cardId === imprint)?.value ?? q.options.find((o) => /yes/i.test(o.label) || o.value === 'yes')?.value ?? q.options[0].value;
    });
    return { g, ctx, mox };
  }

  it('imprints a nonartifact, nonland card and taps for its color', () => {
    const { g, ctx, mox } = castMox('lightning_bolt', ['lightning_bolt', 'counterspell']);
    expect(g.battlefield).toContain(mox);
    const bolt = P(g, 'a').zones.exile.find((i) => g.cards[i].cardId === 'lightning_bolt');
    expect(bolt, logText(g)).toBeTruthy();
    const opts = manaOptionsFor(g, mox, getCard);
    expect(opts.map((o) => o.produces)).toEqual(['R']);
    act(g, ctx, 'a', { t: 'activateMana', iid: mox, option: opts[0].id });
    expect(P(g, 'a').manaPool.R).toBe(1);
  });

  it('only nonartifact, nonland cards can be imprinted', () => {
    const { g } = setup(['chrome_mox', 'lightning_bolt', 'mox_diamond'], [], 7, 'basic_island');
    const ctx: Ctx = { rng: seeded(7), lookup: getCard, now: 0 };
    const mox = toZone(g, ctx, 'a', 'chrome_mox', 'hand');
    toZone(g, ctx, 'a', 'lightning_bolt', 'hand');
    toZone(g, ctx, 'a', 'mox_diamond', 'hand');
    act(g, ctx, 'a', { t: 'cast', iid: mox });
    const offered: string[] = [];
    drain(g, ctx, (q) => { for (const o of q.options) if (g.cards[o.value]) offered.push(g.cards[o.value].cardId!); return q.options[0].value; });
    expect(offered).toContain('lightning_bolt');
    expect(offered).not.toContain('mox_diamond');
    expect(offered).not.toContain('basic_island');
  });

  it('without an imprinted card it adds nothing', () => {
    const { g, mox } = castMox(null, ['lightning_bolt']);
    expect(g.battlefield).toContain(mox);
    expect(manaOptionsFor(g, mox, getCard)).toEqual([]);
  });

  it('auto-pay uses the Chrome Mox mana', () => {
    const { g, ctx, mox } = castMox('lightning_bolt', ['lightning_bolt', 'lightning_bolt']);
    const bolt = P(g, 'a').zones.hand.find((i) => g.cards[i].cardId === 'lightning_bolt')!;
    expect(g.battlefield.filter((i) => g.cards[i].controller === 'a')).toEqual([mox]);
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: [[{ kind: 'player', pid: 'b' }]] });
    expect(g.cards[mox].tapped).toBe(true);
    drain(g, ctx);
    expect(P(g, 'b').life).toBe(17);
  });

  it('leaving the battlefield forgets the imprint', () => {
    const { g, ctx, mox } = castMox('lightning_bolt', ['lightning_bolt']);
    moveCard(g, ctx, mox, 'hand');
    expect(g.cards[mox].imprinted ?? []).toEqual([]);
  });
});

describe('Ragavan, Nimble Pilferer', () => {
  function hit() {
    const { g, ctx } = setup(['ragavan_nimble_pilferer'], ['brainstorm']);
    const rag = put(g, ctx, 'a', 'ragavan_nimble_pilferer');
    moveCard(g, ctx, find(g, 'b', 'brainstorm'), 'library', { position: 'top' });
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: rag, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    for (let i = 0; i < 40 && g.step !== 'main2'; i++) {
      if (g.pending.length) { answer(g, ctx); continue; }
      act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(g.step).toBe('main2');
    return { g, ctx, rag, bs: P(g, 'b').zones.exile.find((i) => g.cards[i].cardId === 'brainstorm') };
  }

  it('combat damage: a Treasure, and the top card of their library is exiled', () => {
    const { g, bs } = hit();
    expect(P(g, 'b').life).toBe(18);
    expect(g.battlefield.some((i) => g.cards[i].token?.name === 'Treasure' && g.cards[i].controller === 'a'), logText(g)).toBe(true);
    expect(bs, logText(g)).toBeTruthy();
    expect(P(g, 'b').zones.library).not.toContain(bs);
  });

  it('the exiled card can be cast this turn, paying with mana of any type (a Mountain for {U})', () => {
    const { g, ctx, bs } = hit();
    for (const i of [...g.battlefield]) if (g.cards[i].token?.name === 'Treasure') moveCard(g, ctx, i, 'graveyard');
    put(g, ctx, 'a', 'basic_mountain');
    const hand = P(g, 'a').zones.hand.length;
    expect(castability(g, 'a', bs!, getCard)).toEqual({ ok: true });
    expect(castability(viewFor(g, 'a') as never, 'a', bs!, getCard).ok).toBe(true);
    act(g, ctx, 'a', { t: 'cast', iid: bs! });
    drain(g, ctx, (q) => q.options[q.options.length - 1].value);
    expect(logText(g)).toMatch(/Brainstorm resolves/);
    expect(P(g, 'a').zones.hand.length).toBe(hand + 3 - 2);
    expect(g.cards[bs!].owner).toBe('b');
  });

  it("can't be cast after this turn", () => {
    const { g, ctx, bs } = hit();
    advanceTo(g, ctx, 'b', 'main1');
    expect([g.cards[bs!].zone, g.cards[bs!].owner, g.cards[bs!].cardId]).toEqual(['exile', 'b', 'brainstorm']);
    advanceTo(g, ctx, 'a', 'main1');
    put(g, ctx, 'a', 'basic_mountain');
    expect(g.cards[bs!].zone, logText(g)).toBe('exile');
    expect(applyAction(g, 'a', { t: 'cast', iid: bs! }, ctx)).toBeTruthy();
    expect(g.cards[bs!].zone).toBe('exile');
  });

  it('Dash: cast for {1}{R}, it has haste, and returns to hand at the end step', () => {
    const { g, ctx } = setup(['ragavan_nimble_pilferer']);
    const rag = toZone(g, ctx, 'a', 'ragavan_nimble_pilferer', 'hand');
    put(g, ctx, 'a', 'basic_mountain');
    put(g, ctx, 'a', 'basic_mountain');
    act(g, ctx, 'a', { t: 'cast', iid: rag, costOption: 'dash' });
    drain(g, ctx);
    expect(g.cards[rag].zone).toBe('battlefield');
    expect(g.battlefield.filter((i) => g.cards[i].cardId === 'basic_mountain' && g.cards[i].tapped)).toHaveLength(2);
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: rag, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    expect(logText(g)).toMatch(/Alice attacks with Ragavan/);
    advanceTo(g, ctx, 'b', 'main1');
    expect(g.cards[rag].zone, logText(g)).toBe('hand');
  });
});

describe('Undermountain Adventurer: its mana ability adds mana', () => {
  it('adds {G}{G}, or six {G} once you completed a dungeon; auto-pay can use it', () => {
    const { g, ctx } = setup(['undermountain_adventurer']);
    const ua = put(g, ctx, 'a', 'undermountain_adventurer');
    const opts = manaOptionsFor(g, ua, getCard);
    expect(opts.map((o) => o.produces)).toEqual(['GG']);
    act(g, ctx, 'a', { t: 'activateMana', iid: ua, option: opts[0].id });
    expect(P(g, 'a').manaPool.G).toBe(2);
    g.cards[ua].tapped = false;
    P(g, 'a').counters.dungeons = 1;
    expect(manaOptionsFor(g, ua, getCard).map((o) => o.produces)).toEqual(['GGGGGG']);
  });
});

describe('A2.3: Ninjutsu', () => {
  function attackUnblocked(extra: string[] = []) {
    const { g, ctx } = setup(['fallen_shinobi', 'goblin_guide', ...extra], [], 7, 'basic_island');
    const gg = put(g, ctx, 'a', 'goblin_guide');
    const fs = toZone(g, ctx, 'a', 'fallen_shinobi', 'hand');
    for (const l of ['basic_island', 'basic_island', 'basic_island']) put(g, ctx, 'a', l);
    put(g, ctx, 'a', 'basic_swamp');
    const idx = activatedAbilitiesOf('fallen_shinobi', 0).find((e) => e.keyword === 'Ninjutsu')!.index;
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: gg, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    return { g, ctx, gg, fs, idx };
  }

  it('the attacker gets priority in the declare blockers step and can ninjutsu (auto-paid from lands)', () => {
    const { g, ctx, gg, fs, idx } = attackUnblocked(['basic_swamp']);
    // Ninjutsu isn't possible before blockers are declared.
    expect(abilityUsability(g, 'a', fs, idx, getCard).ok).toBe(false);
    for (let k = 0; k < 30 && !(g.step === 'blockers' && g.combat.blockersDeclared && g.priority === 'a'); k++) {
      if (g.pending.length) { answer(g, ctx); continue; }
      if (g.step === 'blockers' && !g.combat.blockersDeclared) { act(g, ctx, 'b', { t: 'confirmBlockers' }); continue; }
      act(g, ctx, g.priority, { t: 'pass' });
    }
    expect([g.step, g.combat.blockersDeclared, g.priority]).toEqual(['blockers', true, 'a']);
    expect(abilityUsability(g, 'a', fs, idx, getCard).ok).toBe(true);
    expect(abilityUsability(viewFor(g, 'a') as never, 'a', fs, idx, getCard).ok).toBe(true);
    act(g, ctx, 'a', { t: 'activate', iid: fs, text: '', ability: idx, targets: [[{ kind: 'card', iid: gg }]] });
    expect(g.cards[gg].zone).toBe('hand');
    drain(g, ctx);
    expect(g.cards[fs].zone).toBe('battlefield');
    expect(g.cards[fs].tapped).toBe(true);
    expect(logText(g)).toMatch(/Fallen Shinobi enters tapped and attacking/);
    // Combat damage: the ninja hits, its combat-damage trigger exiles the top two cards of Bob's library.
    for (let k = 0; k < 30 && g.step !== 'main2'; k++) {
      if (g.pending.length) { answer(g, ctx); continue; }
      act(g, ctx, g.priority, { t: 'pass' });
    }
    expect(P(g, 'b').life, logText(g)).toBe(15);
    expect(logText(g)).toMatch(/Fallen Shinobi: \w+, \w+ → exile/);
  });

  it("a blocked attacker can't be returned", () => {
    const { g, ctx } = setup(['fallen_shinobi', 'goblin_guide'], ['goblin_guide'], 7, 'basic_island');
    const gg = put(g, ctx, 'a', 'goblin_guide');
    const bg = put(g, ctx, 'b', 'goblin_guide');
    const fs = toZone(g, ctx, 'a', 'fallen_shinobi', 'hand');
    const idx = activatedAbilitiesOf('fallen_shinobi', 0).find((e) => e.keyword === 'Ninjutsu')!.index;
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: gg, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    for (let k = 0; k < 30 && g.step !== 'blockers'; k++) { if (g.pending.length) { answer(g, ctx); continue; } act(g, ctx, g.priority, { t: 'pass' }); }
    act(g, ctx, 'b', { t: 'declareBlocker', iid: bg, attacker: gg });
    act(g, ctx, 'b', { t: 'confirmBlockers' });
    P(g, 'a').manaPool = { U: 1, B: 1, C: 2 };
    expect(applyAction(g, 'a', { t: 'activate', iid: fs, text: '', ability: idx, targets: [[{ kind: 'card', iid: gg }]] }, ctx)).toBeTruthy();
  });
});
