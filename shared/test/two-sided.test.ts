/** Two-sided and modal cards (workstream A1): adventures, MDFCs, split cards / Rooms, transform, modal spells. Real cube scripts, strict mode. */
import { describe, expect, it } from 'vitest';
import { CUBE, getCard } from '../src/cube.ts';
import {
  applyAction, castability, castableFaces, castOptions, createGame, type Ctx, type GameAction, type GameState, handClick, moveCard,
} from '../src/index.ts';
import { faceOf } from '../src/game/rules.ts';
import { castSpellAbility, targetSpecs } from '../src/engine/script.ts';
import { isValidTarget } from '../src/engine/targets.ts';
import type { TargetRef } from '../src/engine/types.ts';
import { seeded } from './helpers.ts';

const deck = (extra: string[], fill = 'basic_mountain') => [...extra, ...Array(40 - extra.length).fill(fill)];

function setup(a: string[] = [], b: string[] = [], fillA = 'basic_mountain', fillB = 'basic_mountain') {
  const ctx: Ctx = { rng: seeded(7), lookup: getCard, now: 0 };
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
  if (err) throw new Error(err);
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

type Q = GameState['pending'][number];

function answer(g: GameState, ctx: Ctx, pick?: (q: Q) => string) {
  for (let i = 0; i < 20 && g.pending.length; i++) {
    const q = g.pending[0];
    if (q.targets) {
      const t = q.targets;
      const targets = t.specs.map((spec) => {
        const refs: TargetRef[] = [...g.players.map((p) => ({ kind: 'player' as const, pid: p.pid === 'a' ? 'b' : 'a' })), ...Object.keys(g.cards).map((iid) => ({ kind: 'card' as const, iid }))];
        return refs.filter((r) => isValidTarget(g, spec, r, t.controller, t.sourceIid, getCard)).slice(0, Math.max(spec.min, 1));
      });
      act(g, ctx, q.pid, { t: 'chooseTargets', id: q.id, targets });
      continue;
    }
    act(g, ctx, q.pid, { t: 'choose', id: q.id, value: pick ? pick(q) : q.options[0].value });
  }
}

function drain(g: GameState, ctx: Ctx, pick?: (q: Q) => string) {
  for (let i = 0; i < 40 && (g.stack.length || g.pending.length); i++) {
    if (g.pending.length) { answer(g, ctx, pick); continue; }
    act(g, ctx, g.priority, { t: 'pass' });
  }
}

function passTo(g: GameState, ctx: Ctx, step: string, pid: string, active?: string) {
  for (let i = 0; i < 120; i++) {
    if (g.step === step && g.priority === pid && !g.pending.length && (!active || g.activePlayer === active)) return;
    if (g.pending.length && /maximum hand size/.test(g.pending[0].prompt)) { answer(g, ctx); continue; }
    if (g.pending.length) throw new Error(`pending: ${g.pending[0].prompt}`);
    act(g, ctx, g.priority, { t: 'pass' });
  }
  throw new Error(`never reached ${step} for ${pid} (at ${g.step}, prio ${g.priority}, active ${g.activePlayer}, pending ${g.pending.map((q) => q.prompt)})\n${logTail(g)}`);
}

const card = (iid: string) => [[{ kind: 'card' as const, iid }]];
const logTail = (g: GameState, n = 8) => g.log.slice(-n).map((l) => l.text).join('\n');
const untapped = (g: GameState, pid: string) => g.battlefield.filter((i) => g.cards[i].controller === pid && !g.cards[i].tapped).length;
const lands = (g: GameState, ctx: Ctx, pid: string, id: string, n: number) => { for (let k = 0; k < n; k++) put(g, ctx, pid, id); };

describe('A1.1: Brazen Borrower', () => {
  it('Petty Theft bounces an opponent\'s nonland permanent, then Borrower goes on an adventure; later cast from exile', () => {
    const { g, ctx } = setup(['brazen_borrower'], ['giver_of_runes'], 'basic_island');
    lands(g, ctx, 'a', 'basic_island', 5);
    const ring = put(g, ctx, 'b', 'giver_of_runes');
    const bb = toZone(g, ctx, 'a', 'brazen_borrower', 'hand');
    expect(handClick(g, 'a', bb)).toBe('menu');
    expect(castability(g, 'a', bb, getCard, 1)).toEqual({ ok: true });
    expect(castOptions(g, bb, 1).find((o) => o.id === 'normal')?.cost).toBe('{1}{U}');
    act(g, ctx, 'a', { t: 'cast', iid: bb, face: 1, targets: card(ring) });
    expect(g.cards[bb].zone).toBe('stack');
    expect(faceOf(g.cards[bb], getCard).name).toBe('Petty Theft');
    expect(untapped(g, 'a')).toBe(3); // paid {1}{U}
    drain(g, ctx);
    expect(g.cards[ring].zone, logTail(g)).toBe('hand');
    expect(g.cards[bb].zone, logTail(g)).toBe('exile');
    expect(g.cards[bb].castAs).toBe('Petty Theft');
    // From exile: only the creature can be cast.
    expect(castability(g, 'a', bb, getCard, 0)).toEqual({ ok: true });
    expect(castability(g, 'a', bb, getCard, 1).ok).toBe(false);
    expect(castability(g, 'a', bb)).toEqual({ ok: true });
    expect(applyAction(g, 'a', { t: 'cast', iid: bb, face: 1, targets: card(ring) }, ctx)).toBeTruthy();
    // Flash: during the opponent's turn too. Cast it with face undefined (as a click on the exiled card does).
    act(g, ctx, 'a', { t: 'cast', iid: bb });
    expect(faceOf(g.cards[bb], getCard).name).toBe('Brazen Borrower');
    expect(untapped(g, 'a')).toBe(0); // {1}{U}{U}
    drain(g, ctx);
    expect(g.cards[bb].zone, logTail(g)).toBe('battlefield');
    const f = faceOf(g.cards[bb], getCard);
    expect(f.name).toBe('Brazen Borrower');
    expect(f.power).toBe('3');
    expect(g.cards[bb].castAs).toBeUndefined();
  });

  it('cast the creature directly from hand (flash, on the opponent\'s turn)', () => {
    const { g, ctx } = setup(['brazen_borrower'], [], 'basic_island');
    lands(g, ctx, 'a', 'basic_island', 3);
    const bb = toZone(g, ctx, 'a', 'brazen_borrower', 'hand');
    passTo(g, ctx, 'main1', 'b', 'b');
    g.priority = 'a'; g.passed = ['b']; // b passed in its main phase (a's stops are a client setting)
    expect(g.activePlayer).toBe('b');
    expect(g.priority, `${g.step} ${logTail(g)}`).toBe('a');
    expect(castability(g, 'a', bb, getCard, 0)).toEqual({ ok: true });
    act(g, ctx, 'a', { t: 'cast', iid: bb, face: 0 });
    drain(g, ctx);
    expect(g.cards[bb].zone, logTail(g)).toBe('battlefield');
    expect(faceOf(g.cards[bb], getCard).name).toBe('Brazen Borrower');
  });

  it('Petty Theft countered / fizzled: the card goes to the graveyard, not on an adventure', () => {
    const { g, ctx } = setup(['brazen_borrower'], ['giver_of_runes'], 'basic_island');
    lands(g, ctx, 'a', 'basic_island', 2);
    const ring = put(g, ctx, 'b', 'giver_of_runes');
    const bb = toZone(g, ctx, 'a', 'brazen_borrower', 'hand');
    act(g, ctx, 'a', { t: 'cast', iid: bb, face: 1, targets: card(ring) });
    moveCard(g, ctx, ring, 'hand'); // target gone
    drain(g, ctx);
    expect(g.cards[bb].zone, logTail(g)).toBe('graveyard');
  });

  it('Petty Theft cannot target your own permanents or lands', () => {
    const { g, ctx } = setup(['brazen_borrower', 'giver_of_runes'], [], 'basic_island');
    lands(g, ctx, 'a', 'basic_island', 2);
    const mine = put(g, ctx, 'a', 'giver_of_runes');
    const land = put(g, ctx, 'b', 'basic_mountain');
    const bb = toZone(g, ctx, 'a', 'brazen_borrower', 'hand');
    expect(applyAction(g, 'a', { t: 'cast', iid: bb, face: 1, targets: card(mine) }, ctx)).toBeTruthy();
    expect(applyAction(g, 'a', { t: 'cast', iid: bb, face: 1, targets: card(land) }, ctx)).toBeTruthy();
  });
});

const BASICS = ['basic_plains', 'basic_island', 'basic_swamp', 'basic_mountain', 'basic_forest'];
const MULTI = CUBE.cards.filter((c) => c.faces && c.layout !== 'normal');
/** Answer yes/no questions with "yes" (may abilities), anything else with the first option. */
const yes = (q: Q) => q.options.find((o) => o.value === 'yes')?.value ?? q.options[0].value;

/** 4 of each basic on the battlefield for a, a creature for each player, a creature card in a's graveyard. */
function richBoard(id: string) {
  const extra = [id, ...BASICS.flatMap((b) => Array(4).fill(b)), 'giver_of_runes', 'giver_of_runes'];
  const { g, ctx } = setup(extra, ['giver_of_runes', 'giver_of_runes', 'mind_stone'], 'basic_mountain', 'basic_island');
  for (const b of BASICS) lands(g, ctx, 'a', b, 4);
  const mine = put(g, ctx, 'a', 'giver_of_runes');
  const theirs = put(g, ctx, 'b', 'giver_of_runes');
  put(g, ctx, 'b', 'mind_stone');
  const dead = toZone(g, ctx, 'a', 'giver_of_runes', 'graveyard', [mine]);
  const iid = toZone(g, ctx, 'a', id, 'hand');
  return { g, ctx, iid, mine, theirs, dead };
}

/** Legal targets for a cast of `face`: the first legal choices of each spec (the opponent and their permanents first). */
function autoTargets(g: GameState, iid: string, face: number, modes?: string[]): TargetRef[][] | undefined {
  const sp = castSpellAbility(g.cards[iid].cardId!, face);
  if (!sp) return undefined;
  const specs = targetSpecs(sp.ability, modes);
  if (!specs.length) return undefined;
  return specs.map((spec) => {
    const refs: TargetRef[] = [{ kind: 'player', pid: 'b' }, { kind: 'player', pid: 'a' }, ...g.battlefield.filter((i) => g.cards[i].controller === 'b').map((i) => ({ kind: 'card' as const, iid: i })), ...Object.keys(g.cards).map((i) => ({ kind: 'card' as const, iid: i }))];
    const ok = refs.filter((r) => isValidTarget(g, spec, r, 'a', iid, getCard));
    return ok.slice(0, Math.max(spec.min, 1));
  });
}

const cmc = (cost: string) => (cost.match(/\{[^}]+\}/g) ?? []).reduce((n, s) => n + (/^\{\d+\}$/.test(s) ? parseInt(s.slice(1), 10) : 1), 0);

describe('A1.2: every adventure, modal DFC, split and transforming card in the cube', () => {
  it("the cube's multi-face cards are the ones audited here, and every castable face has a name, type and cost", () => {
    expect(MULTI.map((c) => c.id).sort()).toEqual([
      'ajani_nacatl_pariah', 'bonecrusher_giant', 'brazen_borrower', 'cecil_dark_knight', 'concealing_curtains', 'cosima_god_of_the_voyage', 'embereth_shieldbreaker',
      'emeritus_of_ideation', 'emeritus_of_truce', 'fable_of_the_mirror_breaker', 'jennifer_walters', 'kytheon_hero_of_akros', 'life_death', 'skycoach_conductor',
      'tamiyo_inquisitive_student', 'valki_god_of_lies', 'walk_in_closet_forgotten_cellar',
    ]);
    for (const c of MULTI) for (const f of [0, 1]) {
      expect(c.faces![f].name, `${c.id} face ${f}`).toBeTruthy();
      expect(c.faces![f].typeLine, `${c.id} face ${f}`).toBeTruthy();
      if (castableFaces(c).includes(f)) expect(c.faces![f].manaCost, `${c.id} face ${f}`).toMatch(/\{/);
    }
  });

  for (const c of MULTI) {
    for (const face of castableFaces(c)) {
      const f = c.faces![face];
      it(`${c.id}: cast ${f.name} from hand for ${f.manaCost}; it ends up in the right zone as the right face`, () => {
        const { g, ctx, iid } = richBoard(c.id);
        expect(castOptions(g, iid, face).find((o) => o.id === 'normal')?.cost).toBe(f.manaCost);
        expect(castability(g, 'a', iid, getCard, face), f.name).toEqual({ ok: true });
        const before = untapped(g, 'a');
        act(g, ctx, 'a', { t: 'cast', iid, face, targets: autoTargets(g, iid, face) });
        expect(faceOf(g.cards[iid], getCard).name).toBe(f.name);
        expect(before - untapped(g, 'a')).toBe(cmc(f.manaCost));
        drain(g, ctx, yes);
        const permanent = /Creature|Artifact|Enchantment|Planeswalker|Land|Battle/.test(f.typeLine);
        const where = g.cards[iid].zone;
        if (c.layout === 'adventure' && face === 1) {
          expect(where, logTail(g)).toBe('exile');
          expect(castability(g, 'a', iid, getCard, 0), 'the creature is castable from exile').toEqual({ ok: true });
          expect(castability(g, 'a', iid, getCard, 1).ok, 'the adventure is not castable from exile').toBe(false);
          act(g, ctx, 'a', { t: 'cast', iid });
          drain(g, ctx, yes);
          expect(g.cards[iid].zone, logTail(g)).toBe('battlefield');
          expect(faceOf(g.cards[iid], getCard).name).toBe(c.faces![0].name);
        } else if (permanent) {
          expect(where, logTail(g)).toBe('battlefield');
          if (c.layout === 'split') expect(faceOf(g.cards[iid], getCard).name).toContain(f.name); // a Room has both doors' names
          else {
            expect(faceOf(g.cards[iid], getCard).name, logTail(g)).toBe(f.name);
            expect(faceOf(g.cards[iid], getCard).typeLine).toBe(f.typeLine);
          }
          if (f.loyalty) expect(g.cards[iid].counters.loyalty).toBe(parseInt(f.loyalty, 10));
        } else expect(where, logTail(g)).toBe('graveyard');
      });
    }
  }

  for (const c of MULTI.filter((x) => x.layout === 'transform')) {
    it(`${c.id}: only the front face can be cast; the back face is refused`, () => {
      const { g, ctx, iid } = richBoard(c.id);
      expect(castableFaces(c)).toEqual([0]);
      expect(applyAction(g, 'a', { t: 'cast', iid, face: 1 }, ctx)).toBeTruthy();
      expect(handClick(g, 'a', iid)).toBe('cast');
    });
  }
});

describe('A1.2: Prepare cards (cast a copy of the spell while prepared)', () => {
  it('the spell face of a Prepare card cannot be cast from hand', () => {
    for (const id of ['skycoach_conductor', 'emeritus_of_truce', 'emeritus_of_ideation']) {
      expect(getCard(id)?.layout, id).toBe('prepare');
      expect(castableFaces(getCard(id)), id).toEqual([0]);
      const { g, ctx, iid } = richBoard(id);
      expect(applyAction(g, 'a', { t: 'cast', iid, face: 1, targets: autoTargets(g, iid, 1) }, ctx), id).toBeTruthy();
      expect(handClick(g, 'a', iid), id).toBe('cast');
    }
  });

  it('Skycoach Conductor enters prepared; casting a copy of All Aboard flickers a non-Pilot creature and unprepares it', () => {
    const { g, ctx, iid, mine } = richBoard('skycoach_conductor');
    act(g, ctx, 'a', { t: 'cast', iid });
    drain(g, ctx, yes);
    expect(g.cards[iid].zone, logTail(g)).toBe('battlefield');
    expect(g.cards[iid].counters.prepared, logTail(g)).toBe(1);
    expect(castability(g, 'a', iid, getCard, 1)).toEqual({ ok: true });
    expect(castOptions(g, iid, 1).find((o) => o.id === 'normal')?.cost).toBe('{U}');
    // Not the Conductor itself (a Pilot).
    expect(applyAction(g, 'a', { t: 'cast', iid, face: 1, targets: card(iid) }, ctx)).toBeTruthy();
    const before = untapped(g, 'a');
    act(g, ctx, 'a', { t: 'cast', iid, face: 1, targets: card(mine) });
    expect(before - untapped(g, 'a')).toBe(1);
    expect(g.cards[iid].zone).toBe('battlefield');
    expect(g.cards[iid].counters.prepared).toBeUndefined();
    const copy = g.stack.at(-1)!.iid!;
    expect(copy).not.toBe(iid);
    expect(faceOf(g.cards[copy], getCard).name).toBe('All Aboard');
    drain(g, ctx, yes);
    expect(g.cards[copy], 'the copy ceases to exist').toBeUndefined();
    expect(g.cards[mine].zone, logTail(g)).toBe('battlefield');
    // Unprepared: no second copy.
    expect(castability(g, 'a', iid, getCard, 1).ok).toBe(false);
    expect(applyAction(g, 'a', { t: 'cast', iid, face: 1, targets: card(mine) }, ctx)).toBeTruthy();
  });

  it("only the prepared permanent's controller may cast the copy", () => {
    const { g, ctx, iid, theirs } = richBoard('skycoach_conductor');
    act(g, ctx, 'a', { t: 'cast', iid });
    drain(g, ctx, yes);
    g.priority = 'b';
    expect(applyAction(g, 'b', { t: 'cast', iid, face: 1, targets: card(theirs) }, ctx)).toBeTruthy();
    expect(g.cards[iid].counters.prepared).toBe(1);
  });

  it('Emeritus of Truce: target player gets an Inkling; prepared when an opponent controls more creatures; the copy is Swords to Plowshares', () => {
    const { g, ctx, iid } = richBoard('emeritus_of_truce');
    act(g, ctx, 'a', { t: 'cast', iid });
    drain(g, ctx); // the Inkling goes to the opponent (first legal target)
    expect(g.battlefield.filter((i) => g.cards[i].controller === 'b' && g.cards[i].token?.name === 'Inkling')).toHaveLength(1);
    // a: Giver + Emeritus = 2; b: Giver + Inkling = 2: not prepared.
    expect(g.cards[iid].counters.prepared, logTail(g)).toBeUndefined();
    const { g: g2, ctx: ctx2, iid: iid2, theirs: theirs2 } = richBoard('emeritus_of_truce');
    put(g2, ctx2, 'b', 'giver_of_runes');
    act(g2, ctx2, 'a', { t: 'cast', iid: iid2 });
    drain(g2, ctx2);
    expect(g2.cards[iid2].counters.prepared, logTail(g2)).toBe(1);
    const life = g2.players[1].life;
    act(g2, ctx2, 'a', { t: 'cast', iid: iid2, face: 1, targets: card(theirs2) });
    expect(faceOf(g2.cards[g2.stack.at(-1)!.iid!], getCard).name).toBe('Swords to Plowshares');
    drain(g2, ctx2);
    expect(g2.cards[theirs2].zone, logTail(g2)).toBe('exile');
    expect(g2.players[1].life).toBe(life + 1); // Giver of Runes is a 1/2
    expect(g2.cards[iid2].counters.prepared).toBeUndefined();
    expect(g2.cards[iid2].zone).toBe('battlefield');
  });

  it('Emeritus of Ideation enters prepared; the copy is Ancestral Recall', () => {
    const { g, ctx, iid } = richBoard('emeritus_of_ideation');
    act(g, ctx, 'a', { t: 'cast', iid });
    drain(g, ctx, yes);
    expect(g.cards[iid].counters.prepared, logTail(g)).toBe(1);
    const hand = g.players[0].zones.hand.length;
    act(g, ctx, 'a', { t: 'cast', iid, face: 1, targets: [[{ kind: 'player', pid: 'a' }]] });
    drain(g, ctx);
    expect(g.players[0].zones.hand.length, logTail(g)).toBe(hand + 3);
    expect(g.cards[iid].counters.prepared).toBeUndefined();
  });
});

/** Pass priority until a question comes up for `pid` (or `n` passes). */
function passUntilAsked(g: GameState, ctx: Ctx, pid: string, re: RegExp, n = 150) {
  for (let i = 0; i < n; i++) {
    const q = g.pending[0];
    if (q && q.pid === pid && re.test(q.prompt)) return q;
    if (q) { answer(g, ctx); continue; }
    act(g, ctx, g.priority, { t: 'pass' });
  }
  throw new Error(`never asked ${re} (at ${g.step}, turn ${g.turn})\n${logTail(g, 12)}`);
}

const choose = (g: GameState, ctx: Ctx, q: Q, re: RegExp) => {
  const o = q.options.find((x) => re.test(x.label) || re.test(x.value));
  if (!o) throw new Error(`no option ${re} in ${JSON.stringify(q.options)} (${q.prompt})`);
  act(g, ctx, q.pid, { t: 'choose', id: q.id, value: o.value });
};

describe('A1.3: Cosima, God of the Voyage', () => {
  function cosimaGame() {
    const { g, ctx } = setup(['cosima_god_of_the_voyage', ...Array(6).fill('basic_island')], [], 'basic_island', 'basic_mountain');
    const cos = put(g, ctx, 'a', 'cosima_god_of_the_voyage');
    // Lands to play on later turns: keep islands in hand.
    for (let k = 0; k < 4; k++) toZone(g, ctx, 'a', 'basic_island', 'hand', g.players[0].zones.hand.slice());
    return { g, ctx, cos };
  }

  /** Go to a's next main phase (answering questions with `pick`). */
  function toMyMain(g: GameState, ctx: Ctx, pick: (q: Q) => string) {
    for (let i = 0; i < 200; i++) {
      if (g.pending.length) { const q = g.pending[0]; if (q.targets) answer(g, ctx); else act(g, ctx, q.pid, { t: 'choose', id: q.id, value: pick(q) }); continue; }
      if (g.activePlayer === 'a' && g.step === 'main1' && g.priority === 'a' && !g.stack.length && i > 0) return;
      act(g, ctx, g.priority, { t: 'pass' });
    }
    throw new Error(`never reached a's main phase\n${logTail(g, 12)}`);
  }

  it('upkeep: may exile her; each land that enters adds a voyage counter; declining returns her with X +1/+1 counters and draws X', () => {
    const { g, ctx, cos } = cosimaGame();
    act(g, ctx, 'a', { t: 'nextTurn' });
    const q = passUntilAsked(g, ctx, 'a', /Cosima|exile/i);
    choose(g, ctx, q, /^(yes|Yes)/);
    drain(g, ctx, yes);
    expect(g.cards[cos].zone, logTail(g)).toBe('exile');
    toMyMain(g, ctx, yes);
    expect(g.cards[cos].zone).toBe('exile');
    // A land enters: put a voyage counter on her.
    const land1 = g.players[0].zones.hand.find((i) => g.cards[i].cardId === 'basic_island')!;
    act(g, ctx, 'a', { t: 'playLand', iid: land1 });
    const q1 = passUntilAsked(g, ctx, 'a', /voyage|Cosima/i, 10);
    choose(g, ctx, q1, /^(yes|Yes|Put)/);
    drain(g, ctx, yes);
    expect(g.cards[cos].zone, logTail(g)).toBe('exile');
    expect(g.cards[cos].counters.voyage ?? g.cards[cos].counters.VOYAGE, logTail(g)).toBe(1);
    // Next turn: another land, another counter (no new upkeep exile: she's in exile).
    toMyMain(g, ctx, yes);
    const land2 = g.players[0].zones.hand.find((i) => g.cards[i].cardId === 'basic_island')!;
    act(g, ctx, 'a', { t: 'playLand', iid: land2 });
    choose(g, ctx, passUntilAsked(g, ctx, 'a', /voyage|Cosima/i, 10), /^(yes|Yes|Put)/);
    drain(g, ctx, yes);
    expect(g.cards[cos].counters.voyage ?? g.cards[cos].counters.VOYAGE, logTail(g)).toBe(2);
    // Next turn: decline — she returns with 2 +1/+1 counters and a draws 2.
    toMyMain(g, ctx, yes);
    const land3 = g.players[0].zones.hand.find((i) => g.cards[i].cardId === 'basic_island')!;
    act(g, ctx, 'a', { t: 'playLand', iid: land3 });
    const hand = g.players[0].zones.hand.length;
    choose(g, ctx, passUntilAsked(g, ctx, 'a', /voyage|Cosima/i, 10), /^(no|No|Don)/);
    drain(g, ctx, yes);
    expect(g.cards[cos].zone, logTail(g)).toBe('battlefield');
    expect(g.cards[cos].counters['+1/+1'], logTail(g)).toBe(2);
    expect(g.cards[cos].counters.voyage ?? g.cards[cos].counters.VOYAGE).toBeFalsy();
    expect(g.players[0].zones.hand.length, logTail(g)).toBe(hand + 2);
    expect(faceOf(g.cards[cos], getCard).name).toBe('Cosima, God of the Voyage');
  });

  it('declining the upkeep exile keeps her on the battlefield', () => {
    const { g, ctx, cos } = cosimaGame();
    act(g, ctx, 'a', { t: 'nextTurn' });
    choose(g, ctx, passUntilAsked(g, ctx, 'a', /Cosima|exile/i), /^(no|No|Don)/);
    drain(g, ctx, yes);
    expect(g.cards[cos].zone).toBe('battlefield');
  });

  it("an opponent's land entering does not trigger her", () => {
    const { g, ctx, cos } = cosimaGame();
    act(g, ctx, 'a', { t: 'nextTurn' });
    choose(g, ctx, passUntilAsked(g, ctx, 'a', /Cosima|exile/i), /^(yes|Yes)/);
    drain(g, ctx, yes);
    expect(g.cards[cos].zone).toBe('exile');
    const opp = toZone(g, ctx, 'b', 'basic_mountain', 'hand', g.players[1].zones.hand.slice());
    moveCard(g, ctx, opp, 'battlefield', { controller: 'b' });
    expect(g.pending.filter((q) => /voyage/i.test(q.prompt))).toHaveLength(0);
    expect(g.stack.filter((s) => /Cosima|voyage/i.test(s.text))).toHaveLength(0);
  });
});
