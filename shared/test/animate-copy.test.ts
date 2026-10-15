import { describe, expect, it } from 'vitest';
import { getCard } from '../src/cube.ts';
import {
  activeStatics, applyAction, blockRestriction, createGame, type Ctx, effectivePT, faceOf, type GameAction, type GameState, hasKeyword, isCreature,
  moveCard, viewFor,
} from '../src/index.ts';
import { abilitiesOfInstance, activeEffects, GRANT_BASE, isAutomatable, matchCard, scriptRef, spellAbility } from '../src/engine/index.ts';
import { activatedAbilitiesOf } from '../src/engine/script.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[]) => [...extra, ...Array(40 - extra.length).fill('basic_mountain')];

function setup(aCards: string[], bCards: string[] = []) {
  const ctx: Ctx = { rng: seeded(11), lookup: getCard, now: 0 };
  const g = createGame('g', [
    { pid: 'a', name: 'Alice', deck: deck(aCards), side: [] },
    { pid: 'b', name: 'Bob', deck: deck(bCards), side: [] },
  ], 'a', ctx, { strict: false });
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
  return [p.zones.library, p.zones.hand, p.zones.graveyard, p.zones.exile].flat().find((i) => g.cards[i].cardId === cardId)!;
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
  g.cards[iid].tapped = false;
  return iid;
}
const cardRef = (iid: string) => ({ kind: 'card' as const, iid });
const pt = (g: GameState, iid: string) => effectivePT(g.cards[iid], getCard, g);
const abilityIndex = (cardId: string, api: string, face = 0) => activatedAbilitiesOf(cardId, face).find((e) => e.ability.api === api)!.index;
/** Pass priority until the stack is empty (answering nothing). */
const resolveAll = (g: GameState, ctx: Ctx) => {
  for (let k = 0; k < 20 && g.stack.length && !g.pending.length; k++) act(g, ctx, g.priority, { t: 'pass' });
};
const answer = (g: GameState, ctx: Ctx, value: string) => {
  const q = g.pending[0];
  expect(q, 'a pending question').toBeTruthy();
  act(g, ctx, q.pid, { t: 'choose', id: q.id, value });
};

describe('Animate: creature lands', () => {
  it('Mutavault becomes a 2/2 with all creature types, attacks, and is a land again after cleanup', () => {
    const { g, ctx } = setup(['mutavault']);
    const mv = put(g, ctx, 'a', 'mutavault');
    expect(isCreature(g.cards[mv], getCard, g)).toBe(false);
    P(g, 'a').manaPool = { C: 1 };
    act(g, ctx, 'a', { t: 'activate', iid: mv, text: '', ability: abilityIndex('mutavault', 'Animate') });
    resolveAll(g, ctx);
    const c = g.cards[mv];
    expect(isCreature(c, getCard, g)).toBe(true);
    expect(pt(g, mv)).toEqual([2, 2]);
    expect(faceOf(c, getCard).types).toEqual(expect.arrayContaining(['Land', 'Creature']));
    expect(matchCard(c, 'Creature.Goblin', { controller: 'a', lookup: getCard })).toBe(true); // all creature types
    // the client view sees it too
    expect(isCreature(viewFor(g, 'b').cards[mv] as typeof c, getCard)).toBe(true);
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: mv, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    expect(g.cards[mv].attacking).toBe('b');
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(isCreature(g.cards[mv], getCard, g)).toBe(false);
    expect(g.cards[mv].animations).toBeUndefined();
    expect(pt(g, mv)).toEqual([0, 0]);
  });

  it('undo restores the animation state', () => {
    const { g, ctx } = setup(['mutavault']);
    const mv = put(g, ctx, 'a', 'mutavault');
    P(g, 'a').manaPool = { C: 1 };
    act(g, ctx, 'a', { t: 'activate', iid: mv, text: '', ability: abilityIndex('mutavault', 'Animate') });
    resolveAll(g, ctx);
    expect(isCreature(g.cards[mv], getCard, g)).toBe(true);
    const snapshot = JSON.parse(g.history[g.history.length - 1]) as GameState;
    expect(isCreature(snapshot.cards[mv], getCard, snapshot as never)).toBe(false);
  });

  it('Celestial Colonnade: 4/4 white-blue flying, vigilance', () => {
    const { g, ctx } = setup(['celestial_colonnade']);
    const cc = put(g, ctx, 'a', 'celestial_colonnade');
    P(g, 'a').manaPool = { W: 1, U: 1, C: 3 };
    act(g, ctx, 'a', { t: 'activate', iid: cc, text: '', ability: abilityIndex('celestial_colonnade', 'Animate') });
    resolveAll(g, ctx);
    const c = g.cards[cc];
    expect(pt(g, cc)).toEqual([4, 4]);
    expect(hasKeyword(c, getCard, 'Flying', g)).toBe(true);
    expect(hasKeyword(c, getCard, 'Vigilance', g)).toBe(true);
    expect(faceOf(c, getCard).colors).toEqual(['W', 'U']);
    expect(faceOf(c, getCard).typeLine).toBe('Land Creature — Elemental');
  });

  it('Raging Ravine: the granted attack trigger puts a +1/+1 counter on it', () => {
    const { g, ctx } = setup(['raging_ravine']);
    const rr = put(g, ctx, 'a', 'raging_ravine');
    P(g, 'a').manaPool = { R: 1, G: 1, C: 2 };
    act(g, ctx, 'a', { t: 'activate', iid: rr, text: '', ability: abilityIndex('raging_ravine', 'Animate') });
    resolveAll(g, ctx);
    expect(pt(g, rr)).toEqual([3, 3]);
    act(g, ctx, 'a', { t: 'gotoStep', step: 'attackers' });
    act(g, ctx, 'a', { t: 'declareAttacker', iid: rr, target: 'b' });
    act(g, ctx, 'a', { t: 'confirmAttackers' });
    expect(g.stack.some((s) => /attacks/.test(s.text))).toBe(true);
    resolveAll(g, ctx);
    expect(g.cards[rr].counters['+1/+1']).toBe(1);
    expect(pt(g, rr)).toEqual([4, 4]);
    // the counter stays, the animation doesn't
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(isCreature(g.cards[rr], getCard, g)).toBe(false);
  });

  it('Lavaclaw Reaches gains "{X}: +X/+0" while animated (granted ability index)', () => {
    const { g, ctx } = setup(['lavaclaw_reaches']);
    const lr = put(g, ctx, 'a', 'lavaclaw_reaches');
    expect(abilitiesOfInstance(g.cards[lr]).some((e) => e.index >= GRANT_BASE)).toBe(false);
    P(g, 'a').manaPool = { B: 1, R: 1, C: 1 };
    act(g, ctx, 'a', { t: 'activate', iid: lr, text: '', ability: abilityIndex('lavaclaw_reaches', 'Animate') });
    resolveAll(g, ctx);
    const pump = abilitiesOfInstance(g.cards[lr]).find((e) => e.index >= GRANT_BASE)!;
    expect(pump.ability.api).toBe('Pump');
    P(g, 'a').manaPool = { C: 2 };
    act(g, ctx, 'a', { t: 'activate', iid: lr, text: '', ability: pump.index, x: 2 });
    resolveAll(g, ctx);
    expect(pt(g, lr)).toEqual([4, 2]);
  });

  it('Creeping Tar Pit: animated and can\'t be blocked this turn (Effect with a remembered card)', () => {
    const { g, ctx } = setup(['creeping_tar_pit'], ['goblin_guide']);
    const tp = put(g, ctx, 'a', 'creeping_tar_pit');
    const gg = put(g, ctx, 'b', 'goblin_guide');
    P(g, 'a').manaPool = { U: 1, B: 1, C: 1 };
    act(g, ctx, 'a', { t: 'activate', iid: tp, text: '', ability: abilityIndex('creeping_tar_pit', 'Animate') });
    resolveAll(g, ctx);
    expect(pt(g, tp)).toEqual([3, 2]);
    expect(blockRestriction(g, gg, tp, getCard)).toMatch(/can't be blocked|can't block/);
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(activeEffects(g)).toHaveLength(0);
  });

  it('Life // Death: Life makes your lands 1/1 creatures until end of turn', () => {
    const { g, ctx } = setup(['life_death', 'mutavault']);
    expect(isAutomatable(spellAbility('life_death', 0)!.ability).ok).toBe(true);
    const lands = [put(g, ctx, 'a', 'basic_mountain'), put(g, ctx, 'a', 'mutavault')];
    const theirs = put(g, ctx, 'b', 'basic_mountain');
    const life = tutor(g, ctx, 'a', 'life_death');
    P(g, 'a').manaPool = { G: 1 };
    act(g, ctx, 'a', { t: 'cast', iid: life, face: 0 });
    resolveAll(g, ctx);
    for (const l of lands) { expect(isCreature(g.cards[l], getCard, g)).toBe(true); expect(pt(g, l)).toEqual([1, 1]); }
    expect(isCreature(g.cards[theirs], getCard, g)).toBe(false);
    act(g, ctx, 'a', { t: 'nextTurn' });
    for (const l of lands) expect(isCreature(g.cards[l], getCard, g)).toBe(false);
  });
});

describe('Animate: permanent effects', () => {
  it('Oko turns a creature into a 3/3 green Elk with no abilities (permanently)', () => {
    const { g, ctx } = setup(['oko_thief_of_crowns'], ['goblin_guide']);
    const oko = put(g, ctx, 'a', 'oko_thief_of_crowns');
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const elk = activatedAbilitiesOf('oko_thief_of_crowns', 0).find((e) => e.ability.api === 'Animate')!.index;
    act(g, ctx, 'a', { t: 'activate', iid: oko, text: '', ability: elk, targets: [[cardRef(gg)]] });
    resolveAll(g, ctx);
    const f = faceOf(g.cards[gg], getCard);
    expect(f.typeLine).toBe('Creature — Elk');
    expect(f.colors).toEqual(['G']);
    expect(pt(g, gg)).toEqual([3, 3]);
    expect(hasKeyword(g.cards[gg], getCard, 'Haste', g)).toBe(false);
    expect(scriptRef(g.cards[gg])).toBeUndefined(); // no triggered abilities any more
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(pt(g, gg)).toEqual([3, 3]);
  });

  it('Figure of Destiny levels up through its type-conditioned abilities', () => {
    const { g, ctx } = setup(['figure_of_destiny']);
    const fd = put(g, ctx, 'a', 'figure_of_destiny');
    const [spirit, warrior] = activatedAbilitiesOf('figure_of_destiny', 0).filter((e) => e.ability.api === 'Animate');
    P(g, 'a').manaPool = { R: 1 };
    act(g, ctx, 'a', { t: 'activate', iid: fd, text: '', ability: spirit.index });
    resolveAll(g, ctx);
    expect(pt(g, fd)).toEqual([2, 2]);
    expect(faceOf(g.cards[fd], getCard).typeLine).toBe('Creature — Kithkin Spirit');
    P(g, 'a').manaPool = { R: 3 };
    act(g, ctx, 'a', { t: 'activate', iid: fd, text: '', ability: warrior.index });
    resolveAll(g, ctx);
    expect(pt(g, fd)).toEqual([4, 4]);
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(pt(g, fd)).toEqual([4, 4]); // Duration$ Permanent
  });
});

describe('Copies', () => {
  it('Phyrexian Metamorph enters as a copy of a creature (and is an artifact); its ETB triggers are the copy\'s', () => {
    const { g, ctx } = setup(['phyrexian_metamorph', 'thraben_inspector']);
    const ti = put(g, ctx, 'a', 'thraben_inspector');
    resolveAll(g, ctx);
    const clues = () => g.battlefield.filter((i) => g.cards[i].token?.name === 'Clue').length;
    const before = clues();
    const pm = put(g, ctx, 'a', 'phyrexian_metamorph');
    expect(g.pending[0]?.options.map((o) => o.value)).toEqual(expect.arrayContaining([ti, 'none']));
    answer(g, ctx, ti);
    const c = g.cards[pm];
    expect(c.copyOf).toBe('thraben_inspector');
    const f = faceOf(c, getCard);
    expect(f.name).toBe('Thraben Inspector');
    expect(f.types).toEqual(expect.arrayContaining(['Artifact', 'Creature']));
    expect(pt(g, pm)).toEqual([1, 2]);
    expect(scriptRef(c)?.cardId).toBe('thraben_inspector');
    resolveAll(g, ctx);
    expect(clues()).toBe(before + 1); // the copied "investigate" ETB trigger
    // leaves the battlefield: back to Phyrexian Metamorph
    moveCard(g, ctx, pm, 'graveyard');
    expect(g.cards[pm].copyOf).toBeUndefined();
    expect(faceOf(g.cards[pm], getCard).name).toBe('Phyrexian Metamorph');
  });

  it('Phyrexian Metamorph may decline to copy', () => {
    const { g, ctx } = setup(['phyrexian_metamorph', 'thraben_inspector']);
    put(g, ctx, 'a', 'thraben_inspector');
    resolveAll(g, ctx);
    const pm = put(g, ctx, 'a', 'phyrexian_metamorph');
    answer(g, ctx, 'none');
    expect(g.cards[pm].copyOf).toBeUndefined();
    expect(faceOf(g.cards[pm], getCard).name).toBe('Phyrexian Metamorph');
  });

  it('Kiki-Jiki: token copy with haste, sacrificed at the next end step; copies of tokens copy the token', () => {
    const { g, ctx } = setup(['kiki_jiki_mirror_breaker', 'goblin_guide']);
    const kj = put(g, ctx, 'a', 'kiki_jiki_mirror_breaker');
    const gg = put(g, ctx, 'a', 'goblin_guide');
    act(g, ctx, 'a', { t: 'activate', iid: kj, text: '', ability: abilityIndex('kiki_jiki_mirror_breaker', 'CopyPermanent'), targets: [[cardRef(gg)]] });
    resolveAll(g, ctx);
    const copy = g.battlefield.find((i) => i !== gg && g.cards[i].token && faceOf(g.cards[i], getCard).name === 'Goblin Guide')!;
    expect(copy).toBeTruthy();
    expect(g.cards[copy].cardId).toBe('goblin_guide');
    expect(hasKeyword(g.cards[copy], getCard, 'Haste', g)).toBe(true);
    expect(pt(g, copy)).toEqual([2, 2]);
    // manual copy of the token: token data and the haste exception are copiable
    act(g, ctx, 'a', { t: 'copyCard', iid: copy });
    expect(g.battlefield.filter((i) => g.cards[i].token && faceOf(g.cards[i], getCard).name === 'Goblin Guide')).toHaveLength(2);
    // end step: the Kiki token is sacrificed
    act(g, ctx, 'a', { t: 'gotoStep', step: 'end' });
    resolveAll(g, ctx);
    expect(g.cards[copy]).toBeUndefined();
  });

  it('Fable of the Mirror-Breaker // Reflection of Kiki-Jiki copies another nonlegendary creature', () => {
    const { g, ctx } = setup(['fable_of_the_mirror_breaker', 'goblin_guide']);
    const fable = put(g, ctx, 'a', 'fable_of_the_mirror_breaker');
    g.cards[fable].transformed = true;
    const gg = put(g, ctx, 'a', 'goblin_guide');
    P(g, 'a').manaPool = { C: 1 };
    act(g, ctx, 'a', { t: 'activate', iid: fable, text: '', ability: abilityIndex('fable_of_the_mirror_breaker', 'CopyPermanent', 1), targets: [[cardRef(gg)]] });
    resolveAll(g, ctx);
    expect(g.battlefield.filter((i) => faceOf(g.cards[i], getCard).name === 'Goblin Guide')).toHaveLength(2);
  });
});

describe('Effects and emblems', () => {
  it('Elspeth, Sun\'s Champion emblem: creatures you control get +2/+2 and flying', () => {
    const { g, ctx } = setup(['elspeth_suns_champion', 'goblin_guide'], ['goblin_guide']);
    const el = put(g, ctx, 'a', 'elspeth_suns_champion');
    g.cards[el].counters.loyalty = 7;
    const mine = put(g, ctx, 'a', 'goblin_guide');
    const theirs = put(g, ctx, 'b', 'goblin_guide');
    act(g, ctx, 'a', { t: 'activate', iid: el, text: '', ability: abilityIndex('elspeth_suns_champion', 'Effect') });
    resolveAll(g, ctx);
    const em = activeEffects(g);
    expect(em).toHaveLength(1);
    expect(em[0].emblem).toBe(true);
    expect(em[0].name).toMatch(/Emblem/);
    expect(pt(g, mine)).toEqual([4, 4]);
    expect(hasKeyword(g.cards[mine], getCard, 'Flying', g)).toBe(true);
    expect(pt(g, theirs)).toEqual([2, 2]);
    expect(activeStatics(g, getCard).some((s) => s.sourceName?.startsWith('Emblem') && s.support === 'full')).toBe(true);
    // permanent: survives turns and Elspeth leaving
    moveCard(g, ctx, el, 'graveyard');
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(pt(g, mine)).toEqual([4, 4]);
  });

  it('Chandra, Torch of Defiance emblem triggers on each spell you cast', () => {
    const { g, ctx } = setup(['chandra_torch_of_defiance', 'lightning_bolt']);
    const ch = put(g, ctx, 'a', 'chandra_torch_of_defiance');
    g.cards[ch].counters.loyalty = 7;
    act(g, ctx, 'a', { t: 'activate', iid: ch, text: '', ability: abilityIndex('chandra_torch_of_defiance', 'Effect') });
    resolveAll(g, ctx);
    const bolt = tutor(g, ctx, 'a', 'lightning_bolt');
    P(g, 'a').manaPool = { R: 1 };
    act(g, ctx, 'a', { t: 'cast', iid: bolt, targets: [[{ kind: 'player', pid: 'b' }]] });
    // the emblem's trigger asks for its target
    const q = g.pending[0];
    expect(q?.targets).toBeTruthy();
    act(g, ctx, 'a', { t: 'chooseTargets', id: q.id, targets: [[{ kind: 'player', pid: 'b' }]] });
    resolveAll(g, ctx);
    expect(P(g, 'b').life).toBe(20 - 5 - 3);
  });

  it('Ranger-Captain of Eos: opponents can\'t cast noncreature spells this turn', () => {
    const { g, ctx } = setup(['ranger_captain_of_eos'], ['lightning_bolt']);
    const rc = put(g, ctx, 'a', 'ranger_captain_of_eos');
    act(g, ctx, 'a', { t: 'activate', iid: rc, text: '', ability: abilityIndex('ranger_captain_of_eos', 'Effect') });
    resolveAll(g, ctx);
    expect(g.cards[rc].zone).toBe('graveyard');
    const bolt = tutor(g, ctx, 'b', 'lightning_bolt');
    P(g, 'b').manaPool = { R: 1 };
    expect(applyAction(g, 'b', { t: 'cast', iid: bolt, targets: [[{ kind: 'player', pid: 'a' }]] }, ctx)).toMatch(/can't cast/i);
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(activeEffects(g)).toHaveLength(0);
  });
});

describe('Choices as it enters', () => {
  it('Plague Engineer: the chosen creature type gets -1/-1 (opponents only)', () => {
    const { g, ctx } = setup(['plague_engineer', 'goblin_guide'], ['goblin_guide', 'thraben_inspector']);
    const mine = put(g, ctx, 'a', 'goblin_guide');
    const gg = put(g, ctx, 'b', 'goblin_guide');
    const ti = put(g, ctx, 'b', 'thraben_inspector');
    resolveAll(g, ctx);
    const pe = put(g, ctx, 'a', 'plague_engineer');
    const q = g.pending[0];
    expect(q.options[0].value).toBe('Goblin'); // types on opponents' permanents first
    answer(g, ctx, 'Goblin');
    expect(g.cards[pe].chosen?.type).toBe('Goblin');
    expect(pt(g, gg)).toEqual([1, 1]);
    expect(pt(g, ti)).toEqual([1, 2]);
    expect(pt(g, mine)).toEqual([2, 2]);
    moveCard(g, ctx, pe, 'graveyard');
    expect(g.cards[pe].chosen).toBeUndefined();
    expect(pt(g, gg)).toEqual([2, 2]);
  });

  it('Phyrexian Revoker: abilities of the named card can\'t be activated', () => {
    const { g, ctx } = setup(['phyrexian_revoker'], ['mutavault', 'kiki_jiki_mirror_breaker']);
    const mv = put(g, ctx, 'b', 'mutavault');
    put(g, ctx, 'a', 'phyrexian_revoker');
    const q = g.pending[0];
    expect(q.options.some((o) => o.value === 'Kiki-Jiki, Mirror Breaker')).toBe(true);
    expect(q.options.some((o) => o.value === 'Mutavault')).toBe(false); // nonland names only
    answer(g, ctx, 'Kiki-Jiki, Mirror Breaker');
    const kj = put(g, ctx, 'b', 'kiki_jiki_mirror_breaker');
    act(g, ctx, 'a', { t: 'gotoStep', step: 'main2' });
    act(g, ctx, 'a', { t: 'nextTurn' });
    expect(g.activePlayer).toBe('b');
    const err = applyAction(g, 'b', { t: 'activate', iid: kj, text: '', ability: abilityIndex('kiki_jiki_mirror_breaker', 'CopyPermanent'), targets: [[cardRef(kj)]] }, ctx);
    expect(err).toMatch(/Phyrexian Revoker/);
    // other cards are fine
    P(g, 'b').manaPool = { C: 1 };
    act(g, ctx, 'b', { t: 'activate', iid: mv, text: '', ability: abilityIndex('mutavault', 'Animate') });
  });
});

describe('support classification', () => {
  it('creature lands, emblems and copy abilities are automatable', () => {
    for (const [id, api] of [['mutavault', 'Animate'], ['celestial_colonnade', 'Animate'], ['raging_ravine', 'Animate'], ['elspeth_suns_champion', 'Effect'],
      ['kiki_jiki_mirror_breaker', 'CopyPermanent'], ['ranger_captain_of_eos', 'Effect']] as const) {
      const ab = activatedAbilitiesOf(id, 0).find((e) => e.ability.api === api)!.ability;
      expect(isAutomatable(ab), id).toEqual({ ok: true, unsupported: [] });
    }
  });
});
