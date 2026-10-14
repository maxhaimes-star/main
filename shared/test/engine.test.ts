import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  activatedAbilitiesOf, applyAction, createGame, type Ctx, type GameAction, type GameState, hasKeyword, isAutomatable,
  moveCard, spellAbility, targetSpecs, viewFor,
} from '../src/index.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[]) => [...extra, ...Array(40 - extra.length).fill('basic_mountain')];

function setup(aCards: string[], bCards: string[] = []) {
  const ctx: Ctx = { rng: seeded(7), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(aCards), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(bCards), side: [] },
  ], 'a', ctx);
  act(g, ctx, 'a', { t: 'keep' });
  act(g, ctx, 'b', { t: 'keep' });
  return { g, ctx };
}

function act(g: GameState, ctx: Ctx, pid: string, action: GameAction) {
  const err = applyAction(g, pid, action, ctx);
  if (err) throw new Error(err);
}

const P = (g: GameState, pid: string) => g.players.find((p) => p.pid === pid)!;

function find(g: GameState, pid: string, cardId: string): string {
  const p = P(g, pid);
  const zones = [p.zones.library, p.zones.hand, p.zones.graveyard, p.zones.exile];
  return zones.flat().find((i) => g.cards[i].cardId === cardId)!;
}

function tutor(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId);
  if (g.cards[iid].zone !== 'hand') moveCard(g, ctx, iid, 'hand');
  return iid;
}

function put(g: GameState, ctx: Ctx, pid: string, cardId: string): string {
  const iid = find(g, pid, cardId);
  moveCard(g, ctx, iid, 'battlefield', { controller: pid });
  g.cards[iid].summoningSick = false;
  return iid;
}

const player = (pid: string) => ({ kind: 'player' as const, pid });
const cardRef = (iid: string) => ({ kind: 'card' as const, iid });
const lastLog = (g: GameState, n = 8) => g.log.slice(-n).map((l) => l.text).join('\n');

describe('engine parsing', () => {
  it('parses chains, descriptions and targets', () => {
    const sp = spellAbility('swords_to_plowshares', 0)!;
    expect(sp.ability.api).toBe('ChangeZone');
    expect(sp.ability.sub?.api).toBe('GainLife');
    expect(targetSpecs(sp.ability)).toMatchObject([{ step: 0, min: 1, max: 1, zone: 'battlefield', cards: true, players: false }]);
    expect(spellAbility('lightning_bolt', 0)!.ability.description).toBe('Lightning Bolt deals 3 damage to any target.');
    expect(targetSpecs(spellAbility('counterspell', 0)!.ability)[0].zone).toBe('stack');
    expect(targetSpecs(spellAbility('reanimate', 0)!.ability)[0].zone).toBe('graveyard');
    expect(isAutomatable(spellAbility('lightning_bolt', 0)!.ability)).toEqual({ ok: true, unsupported: [] });
    expect(spellAbility('goblin_guide', 0)).toBeUndefined();
    const jace = activatedAbilitiesOf('jace_the_mind_sculptor', 0);
    expect(jace.map((a) => a.loyalty)).toEqual([2, 0, -1, -12]);
    expect(jace[2].index).toBe(2);
    // auras get a synthesized spell ability
    expect(spellAbility('wild_growth', 0)).toMatchObject({ index: -1, ability: { api: 'Attach' } });
  });
});

describe('engine: damage & removal', () => {
  it('Lightning Bolt to the face', () => {
    const { g, ctx } = setup(['lightning_bolt']);
    const bolt = tutor(g, ctx, 'a', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: [[player('b')]] });
    expect(g.stack[0].auto).toBeDefined();
    act(g, ctx, 'b', { t: 'pass' });
    expect(P(g, 'b').life).toBe(17);
    expect(g.cards[bolt].zone).toBe('graveyard');
    expect(g.stack).toHaveLength(0);
  });

  it('Lightning Bolt kills a creature (state-based actions)', () => {
    const { g, ctx } = setup(['lightning_bolt'], ['goblin_guide']);
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const bolt = tutor(g, ctx, 'a', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: [[cardRef(gg)]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[gg].zone).toBe('graveyard');
    expect(lastLog(g)).toMatch(/Goblin Guide dies/);
  });

  it('Swords to Plowshares exiles and gives life equal to power', () => {
    const { g, ctx } = setup(['swords_to_plowshares'], ['questing_beast']);
    const qb = put(g, ctx, 'b', 'questing_beast');
    const stp = tutor(g, ctx, 'a', 'swords_to_plowshares');
    act(g, ctx, 'a', { t: 'cast', iid: stp, targets: [[cardRef(qb)]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[qb].zone).toBe('exile');
    expect(P(g, 'b').life).toBe(24);
    expect(P(g, 'a').life).toBe(20);
  });

  it('Fatal Push destroys a cheap creature', () => {
    const { g, ctx } = setup(['fatal_push'], ['goblin_guide']);
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const fp = tutor(g, ctx, 'a', 'fatal_push');
    act(g, ctx, 'a', { t: 'cast', iid: fp, targets: [[cardRef(gg)]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[gg].zone).toBe('graveyard');
  });

  it('Wrath of God destroys all creatures', () => {
    const { g, ctx } = setup(['wrath_of_god', 'thalia_guardian_of_thraben'], ['goblin_guide', 'questing_beast']);
    const t = put(g, ctx, 'a', 'thalia_guardian_of_thraben');
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const qb = put(g, ctx, 'b', 'questing_beast');
    const w = tutor(g, ctx, 'a', 'wrath_of_god');
    act(g, ctx, 'a', { t: 'cast', iid: w });
    act(g, ctx, 'b', { t: 'pass' });
    for (const iid of [t, gg, qb]) expect(g.cards[iid].zone).toBe('graveyard');
    expect(g.battlefield.every((i) => g.cards[i].cardId === 'basic_mountain')).toBe(true);
  });

  it('Dismember (-5/-5 pump) kills via toughness 0', () => {
    const { g, ctx } = setup(['dismember'], ['questing_beast']);
    const qb = put(g, ctx, 'b', 'questing_beast');
    const d = tutor(g, ctx, 'a', 'dismember');
    act(g, ctx, 'a', { t: 'cast', iid: d, targets: [[cardRef(qb)]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[qb].zone).toBe('graveyard');
  });

  it('fizzles when the only target is gone', () => {
    const { g, ctx } = setup(['lightning_bolt'], ['goblin_guide']);
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const bolt = tutor(g, ctx, 'a', 'lightning_bolt');
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: [[cardRef(gg)]] });
    act(g, ctx, 'b', { t: 'move', iid: gg, to: 'hand' });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[bolt].zone).toBe('graveyard');
    expect(g.cards[gg].zone).toBe('hand');
    expect(lastLog(g)).toMatch(/fizzles/);
  });

  it('rejects hexproof opponents\' permanents but allows your own', () => {
    const { g, ctx } = setup(['lightning_bolt', 'geist_of_saint_traft'], ['geist_of_saint_traft']);
    const theirs = put(g, ctx, 'b', 'geist_of_saint_traft');
    const mine = put(g, ctx, 'a', 'geist_of_saint_traft');
    const bolt = tutor(g, ctx, 'a', 'lightning_bolt');
    expect(applyAction(g, 'a', { t: 'cast', iid: bolt, targets: [[cardRef(theirs)]] }, ctx)).toMatch(/illegal target/);
    expect(g.cards[bolt].zone).toBe('hand');
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: [[cardRef(mine)]] });
    expect(g.stack).toHaveLength(1);
  });

  it('requires the right number of targets', () => {
    const { g, ctx } = setup(['lightning_bolt']);
    const bolt = tutor(g, ctx, 'a', 'lightning_bolt');
    expect(applyAction(g, 'a', { t: 'cast', iid: bolt, targets: [[]] }, ctx)).toMatch(/choose 1 target/);
    expect(applyAction(g, 'a', { t: 'cast', iid: bolt, targets: [[player('a'), player('b')]] }, ctx)).toMatch(/too many/);
    // no targets at all = manual cast (old behaviour)
    act(g, ctx, 'a', { t: 'cast', iid: bolt });
    expect(g.stack[0].auto).toBeUndefined();
  });
});

describe('engine: counterspells', () => {
  function onStack(counter: string) {
    const { g, ctx } = setup(['goblin_guide'], [counter]);
    const gg = tutor(g, ctx, 'a', 'goblin_guide');
    act(g, ctx, 'a', { t: 'cast', iid: gg });
    const c = tutor(g, ctx, 'b', counter);
    const spell = g.stack[0];
    return { g, ctx, gg, c, spell };
  }

  it('Counterspell counters a spell on the stack', () => {
    const { g, ctx, gg, c, spell } = onStack('counterspell');
    act(g, ctx, 'b', { t: 'cast', iid: c, targets: [[{ kind: 'stack', id: spell.id }]] });
    expect(g.priority).toBe('a');
    act(g, ctx, 'a', { t: 'pass' });
    expect(g.cards[gg].zone).toBe('graveyard');
    expect(g.cards[c].zone).toBe('graveyard');
    expect(g.stack).toHaveLength(0);
  });

  it('Mana Leak: decline → countered', () => {
    const { g, ctx, gg, c, spell } = onStack('mana_leak');
    act(g, ctx, 'b', { t: 'cast', iid: c, targets: [[cardRef(gg)]] }); // card ref to a spell is accepted
    act(g, ctx, 'a', { t: 'pass' });
    expect(g.pending).toHaveLength(1);
    const q = g.pending[0];
    expect(q.pid).toBe('a');
    expect(g.stack.map((s) => s.id)).toEqual([spell.id]);
    expect(applyAction(g, 'a', { t: 'pass' }, ctx)).toMatch(/Waiting/);
    expect(applyAction(g, 'b', { t: 'choose', id: q.id, value: 'decline' }, ctx)).toMatch(/another player/);
    expect(viewFor(g, 'b').pending[0].options).toEqual([]);
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: 'decline' });
    expect(g.pending).toHaveLength(0);
    expect(g.cards[gg].zone).toBe('graveyard');
    expect(g.stack).toHaveLength(0);
  });

  it('Mana Leak: pay → spell stays and resolves', () => {
    const { g, ctx, gg, c } = onStack('mana_leak');
    act(g, ctx, 'b', { t: 'cast', iid: c, targets: [[cardRef(gg)]] });
    act(g, ctx, 'a', { t: 'addMana', mana: 'R', n: 3 });
    act(g, ctx, 'a', { t: 'pass' });
    act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: 'pay' });
    expect(P(g, 'a').manaPool.R).toBe(0);
    expect(g.stack).toHaveLength(1);
    act(g, ctx, 'a', { t: 'pass' });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[gg].zone).toBe('battlefield');
  });
});

describe('engine: cards & libraries', () => {
  it('Lingering Souls makes two flying Spirits', () => {
    const { g, ctx } = setup(['lingering_souls']);
    const ls = tutor(g, ctx, 'a', 'lingering_souls');
    act(g, ctx, 'a', { t: 'cast', iid: ls });
    act(g, ctx, 'b', { t: 'pass' });
    const spirits = g.battlefield.map((i) => g.cards[i]).filter((c) => c.token?.name === 'Spirit');
    expect(spirits).toHaveLength(2);
    expect(spirits.every((s) => s.controller === 'a' && hasKeyword(s, getCard, 'Flying'))).toBe(true);
  });

  it('Entreat the Angels with X=3', () => {
    const { g, ctx } = setup(['entreat_the_angels']);
    const e = tutor(g, ctx, 'a', 'entreat_the_angels');
    act(g, ctx, 'a', { t: 'cast', iid: e, x: 3 });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.battlefield.filter((i) => g.cards[i].token?.name === 'Angel')).toHaveLength(3);
  });

  it('Thoughtseize: lose 2, look at the hand, choose a nonland card', () => {
    const { g, ctx } = setup(['thoughtseize'], ['questing_beast']);
    const qb = tutor(g, ctx, 'b', 'questing_beast');
    const ts = tutor(g, ctx, 'a', 'thoughtseize');
    act(g, ctx, 'a', { t: 'cast', iid: ts, targets: [[player('b')]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(P(g, 'a').viewingHandOf).toBe('b');
    const q = g.pending[0];
    expect(q.pid).toBe('a');
    expect(q.options.map((o) => o.value)).toEqual([qb]); // lands are not offered
    act(g, ctx, 'a', { t: 'choose', id: q.id, value: qb });
    expect(g.cards[qb].zone).toBe('graveyard');
    expect(P(g, 'a').life).toBe(18); // the rest of the spell resumes after the choice
  });

  it('Mind Twist X=2 discards two at random', () => {
    const { g, ctx } = setup(['mind_twist']);
    const mt = tutor(g, ctx, 'a', 'mind_twist');
    act(g, ctx, 'a', { t: 'cast', iid: mt, x: 2, targets: [[player('b')]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(P(g, 'b').zones.hand).toHaveLength(5);
    expect(P(g, 'b').zones.graveyard).toHaveLength(2);
  });

  it('Brainstorm draws 3 then puts 2 back', () => {
    const { g, ctx } = setup(['brainstorm']);
    const bs = tutor(g, ctx, 'a', 'brainstorm');
    const before = P(g, 'a').zones.hand.length; // includes Brainstorm
    act(g, ctx, 'a', { t: 'cast', iid: bs });
    act(g, ctx, 'b', { t: 'pass' });
    expect(P(g, 'a').zones.hand).toHaveLength(before - 1 + 3);
    const [x, y] = P(g, 'a').zones.hand;
    act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: x });
    act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: y });
    expect(g.pending).toHaveLength(0);
    expect(P(g, 'a').zones.hand).toHaveLength(before);
    expect(P(g, 'a').zones.library.slice(0, 2)).toEqual([y, x]);
  });

  it('Demonic Tutor opens a library search', () => {
    const { g, ctx } = setup(['demonic_tutor', 'goblin_guide']);
    const dt = tutor(g, ctx, 'a', 'demonic_tutor');
    act(g, ctx, 'a', { t: 'cast', iid: dt });
    act(g, ctx, 'b', { t: 'pass' });
    const me = P(g, 'a');
    expect(me.peek?.mode).toBe('search');
    expect(me.peek?.iids).toHaveLength(me.zones.library.length);
    expect(g.cards[dt].zone).toBe('graveyard');
    const pick = me.zones.library.find((i) => g.cards[i].cardId === 'goblin_guide')!;
    act(g, ctx, 'a', { t: 'resolvePeek', top: [], bottom: [], graveyard: [], hand: [pick], battlefield: [], exile: [], shuffle: true });
    expect(g.cards[pick].zone).toBe('hand');
  });

  it('Ponder looks at 3, then draws after the cards are put back', () => {
    const { g, ctx } = setup(['ponder']);
    const pd = tutor(g, ctx, 'a', 'ponder');
    const hand = P(g, 'a').zones.hand.length;
    act(g, ctx, 'a', { t: 'cast', iid: pd });
    act(g, ctx, 'b', { t: 'pass' });
    const me = P(g, 'a');
    expect(me.peek?.mode).toBe('look');
    expect(me.peek?.iids).toHaveLength(3);
    expect(me.zones.hand).toHaveLength(hand - 1);
    const [x, y, z] = me.peek!.iids;
    act(g, ctx, 'a', { t: 'resolvePeek', top: [z, y, x], bottom: [], graveyard: [], hand: [], battlefield: [], exile: [], shuffle: false });
    expect(me.zones.hand).toHaveLength(hand);
    expect(me.zones.hand.at(-1)).toBe(z);
  });

  it('Preordain scries 2 then draws', () => {
    const { g, ctx } = setup(['preordain']);
    const pr = tutor(g, ctx, 'a', 'preordain');
    act(g, ctx, 'a', { t: 'cast', iid: pr });
    act(g, ctx, 'b', { t: 'pass' });
    const me = P(g, 'a');
    expect(me.peek?.mode).toBe('scry');
    const [x, y] = me.peek!.iids;
    act(g, ctx, 'a', { t: 'resolvePeek', top: [y], bottom: [x], graveyard: [], hand: [], battlefield: [], exile: [], shuffle: false });
    expect(me.zones.hand.at(-1)).toBe(y);
    expect(me.zones.library.at(-1)).toBe(x);
  });

  it('Reanimate returns a creature under your control and costs life = MV', () => {
    const { g, ctx } = setup(['reanimate'], ['questing_beast']);
    const qb = find(g, 'b', 'questing_beast');
    moveCard(g, ctx, qb, 'graveyard');
    const re = tutor(g, ctx, 'a', 'reanimate');
    act(g, ctx, 'a', { t: 'cast', iid: re, targets: [[cardRef(qb)]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[qb].zone).toBe('battlefield');
    expect(g.cards[qb].controller).toBe('a');
    expect(P(g, 'a').life).toBe(16);
  });

  it('Kolaghan\'s Command with chosen modes', () => {
    const { g, ctx } = setup(['kolaghans_command'], ['goblin_guide']);
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const kc = tutor(g, ctx, 'a', 'kolaghans_command');
    const ab = spellAbility('kolaghans_command', 0)!.ability;
    const specs = targetSpecs(ab, ['DBDiscard', 'DBDamage']);
    expect(specs.map((s) => s.valid)).toEqual(['Player', 'Any']);
    expect(applyAction(g, 'a', { t: 'cast', iid: kc, modes: ['DBDamage'], targets: [[cardRef(gg)]] }, ctx)).toMatch(/mode/);
    act(g, ctx, 'a', { t: 'cast', iid: kc, modes: ['DBDiscard', 'DBDamage'], targets: [[player('b')], [cardRef(gg)]] });
    act(g, ctx, 'b', { t: 'pass' });
    const q = g.pending[0];
    expect(q.pid).toBe('b');
    act(g, ctx, 'b', { t: 'choose', id: q.id, value: q.options[0].value });
    expect(g.cards[gg].zone).toBe('graveyard');
    expect(P(g, 'b').zones.graveyard).toHaveLength(2);
  });

  it('auras target and attach on resolution', () => {
    const { g, ctx } = setup(['wild_growth']);
    const land = put(g, ctx, 'a', 'basic_mountain');
    const wg = tutor(g, ctx, 'a', 'wild_growth');
    act(g, ctx, 'a', { t: 'cast', iid: wg, targets: [[cardRef(land)]] });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[wg].zone).toBe('battlefield');
    expect(g.cards[wg].attachedTo).toBe(land);
  });
});

describe('engine: activated abilities', () => {
  it('Jace, the Mind Sculptor -1 bounces a creature', () => {
    const { g, ctx } = setup(['jace_the_mind_sculptor'], ['goblin_guide']);
    const jace = put(g, ctx, 'a', 'jace_the_mind_sculptor');
    const gg = put(g, ctx, 'b', 'goblin_guide');
    expect(g.cards[jace].counters.loyalty).toBe(3);
    act(g, ctx, 'a', { t: 'activate', iid: jace, text: '', ability: 2, targets: [[cardRef(gg)]] });
    expect(g.cards[jace].counters.loyalty).toBe(2);
    expect(g.stack[0].kind).toBe('ability');
    expect(g.priority).toBe('b');
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.cards[gg].zone).toBe('hand');
    expect(P(g, 'b').zones.hand).toContain(gg);
  });

  it('Kytheon pump grants a temporary keyword, cleared at cleanup', () => {
    const { g, ctx } = setup(['kytheon_hero_of_akros']);
    const k = put(g, ctx, 'a', 'kytheon_hero_of_akros');
    act(g, ctx, 'a', { t: 'addMana', mana: 'R', n: 2 });
    act(g, ctx, 'a', { t: 'addMana', mana: 'W', n: 1 });
    act(g, ctx, 'a', { t: 'activate', iid: k, text: '', ability: 0 });
    expect(P(g, 'a').manaPool).toEqual({ R: 0, W: 0 });
    act(g, ctx, 'b', { t: 'pass' });
    expect(hasKeyword(g.cards[k], getCard, 'Indestructible')).toBe(true);
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(hasKeyword(g.cards[k], getCard, 'Indestructible')).toBe(false);
  });

  it('tap costs are enforced', () => {
    const { g, ctx } = setup(['jace_the_mind_sculptor']);
    const jace = put(g, ctx, 'a', 'jace_the_mind_sculptor');
    // -12 needs 12 loyalty
    expect(applyAction(g, 'a', { t: 'activate', iid: jace, text: '', ability: 3, targets: [[player('b')]] }, ctx)).toMatch(/enough loyalty/);
  });

  it('undo restores state including pending questions', () => {
    const { g, ctx } = setup(['brainstorm']);
    const bs = tutor(g, ctx, 'a', 'brainstorm');
    act(g, ctx, 'a', { t: 'cast', iid: bs });
    act(g, ctx, 'b', { t: 'pass' });
    expect(g.pending).toHaveLength(1);
    const x = P(g, 'a').zones.hand[0];
    act(g, ctx, 'a', { t: 'choose', id: g.pending[0].id, value: x });
    act(g, ctx, 'a', { t: 'requestUndo' });
    act(g, ctx, 'b', { t: 'answerUndo', accept: true });
    expect(g.pending).toHaveLength(1);
    expect(g.pending[0].options.some((o) => o.value === x)).toBe(true);
  });
});
