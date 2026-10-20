/**
 * Bot playtester: two random *legal* agents play full games with random two-color 40-card cube decks and the
 * engine is checked for problems along the way.
 *
 *   npx tsx scripts/playtest.ts [games=100] [firstSeed=1] [--turns=30] [--json=out.json] [--quiet]
 *                               [--pool=cube|standard|set:CODE[+CODE...]] [--force=card_id,card_id] [--ai[=easy|normal]]
 *                               [--side=N]
 *
 * --pool draws the random decks from the card database (data/carddb, server/src/carddb.ts) instead of the cube:
 * Standard-legal cards, or the cards of one or more sets. --force puts these cards into every deck (when their
 * colors fit), to exercise specific cards.
 *
 * --side=N gives each deck a sideboard of N other random cards of the pool (at least a few instants / sorceries), so
 * "before the game" choices from the sideboard (Arcane Savant, engine/pregame.ts) are exercised.
 *
 * --ai: both seats are played by the computer opponent (shared/src/ai/player.ts) instead of the random agents, so the
 * same checks run on the bot that people play against.
 *
 * The agents only use legal actions: play one land per turn, cast spells they can pay for (tapping their mana
 * sources first; in strict mode the server's auto-pay does it) with random legal targets / modes / X, activate
 * abilities, attack / block at random, answer every engine question (Pending) with a random legal option and pass
 * priority. Detected problems:
 *   - exception   applyAction threw
 *   - stall       no turn progress after many actions (e.g. an unanswerable question)
 *   - manual      a log entry asks the players to do something by hand ("by hand", "Not automated", "manual" ...)
 *   - invariant   card conservation, a card in two zones / the wrong zone, negative counters / mana / damage
 *   - leak        viewFor() shows a hidden card (opponent's hand / library, face-down) or another player's options
 * The report groups the problems by card name (cards named in the message, else the card being played).
 * Works with or without the strict-mode engine (`state.strict`).
 */
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { CUBE, getCard } from '../shared/src/cube.ts';
import {
  abilitiesOfInstance, activatedAbilitiesOf, adjustCost, applyAction, castOptions, type CardData, type Color, createGame, type Ctx,
  effectivePT, faceOf, landPlaysAllowed, landPlaysLeft, mayPlayFrom, topCardVisible, type GameAction, type GameState, hasKeyword, isCreature, isHidden, isValidTarget, manaOptionsFor, parseCost,
  parseManaSymbols, type Pending, castSpellAbility, type TargetRef, type TargetSpec, targetSpecs, viewFor,
  type BotLevel, type BotMemory, botNeedsToAct, botStep, newBotMemory,
} from '../shared/src/index.ts';

// ------------------------------------------------------------------ rng

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <T>(rng: Rng, xs: T[]): T => xs[Math.floor(rng() * xs.length)];
function shuffled<T>(rng: Rng, xs: T[]): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ------------------------------------------------------------------ decks

const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];
const BASIC_ID: Record<Color, string> = { W: 'basic_plains', U: 'basic_island', B: 'basic_swamp', R: 'basic_mountain', G: 'basic_forest' };

/** A random 40-card deck: two colors, 23 spells of those colors (or colorless), up to 7 fitting nonbasic lands, basics. */
export function randomDeck(rng: Rng, pool: CardData[] = CUBE.cards, force: CardData[] = []): { deck: string[]; colors: Color[] } {
  const colors = shuffled(rng, COLORS).slice(0, 2);
  const fits = (c: CardData) => c.colors.every((x) => colors.includes(x));
  const forced = force.filter((c) => !c.types.includes('Land') && fits(c));
  const spells = [...forced, ...shuffled(rng, pool.filter((c) => !c.types.includes('Land') && fits(c) && !forced.includes(c))).slice(0, 23 - forced.length)];
  // Forced lands (Triomes ...) always go in, whatever their colors.
  const forcedLands = force.filter((c) => c.types.includes('Land'));
  const lands = [...forcedLands, ...shuffled(rng, pool.filter((c) => c.types.includes('Land') && !forcedLands.includes(c)
    && (c.producedMana.length ? c.producedMana.some((m) => colors.includes(m as Color)) && c.producedMana.every((m) => colors.includes(m as Color) || m === 'C') : rng() < 0.3)))]
    .slice(0, Math.max(7, forcedLands.length));
  const deck = [...spells, ...lands].map((c) => c.id);
  while (deck.length < 40) deck.push(BASIC_ID[colors[deck.length % 2]]);
  return { deck, colors };
}

// ------------------------------------------------------------------ issues

export type IssueKind = 'exception' | 'stall' | 'manual' | 'invariant' | 'leak';
export interface Issue { kind: IssueKind; card: string; text: string; seed: number; turn: number }

export const MANUAL_RE = /by hand|not automated|check by hand|manual|reminder|handle it|do it yourself/i;

let NAMES: string[] = [];
/** Card names the report attributes issues to (the cube's, plus a database pool's). */
function addNames(cards: CardData[]) {
  const s = new Set<string>(NAMES);
  for (const c of cards) {
    s.add(c.name);
    for (const f of c.faces ?? []) if (f.name.length > 3) s.add(f.name);
  }
  NAMES = [...s].sort((a, b) => b.length - a.length);
}
addNames(CUBE.cards);

/** The first cube card named in a text. */
function cardIn(text: string): string | undefined {
  for (const n of NAMES) if (text.includes(n)) return n;
  return undefined;
}

// ------------------------------------------------------------------ mana planning (non-strict engine)

interface Source { iid: string; options: { id: string; produces: string }[] }

function manaSources(g: GameState, pid: string, exclude?: string): Source[] {
  const out: Source[] = [];
  for (const iid of g.battlefield) {
    const c = g.cards[iid];
    if (c.controller !== pid || c.tapped || iid === exclude) continue;
    if (isCreature(c, getCard, g) && c.summoningSick && !hasKeyword(c, getCard, 'Haste', g)) continue;
    const opts = manaOptionsFor(g, iid, getCard).filter((o) => o.produces && o.sideEffects.every((s) => !/Pay |Sacrifice|Discard|life|damage|Spend only|by hand/i.test(s)));
    if (opts.length) out.push({ iid, options: opts.map((o) => ({ id: o.id, produces: o.produces })) });
  }
  return out;
}

/** Choose mana sources to pay `cost` (with X = x) on top of the pool. null = can't. */
function planMana(cost: string, x: number, pool: Record<string, number>, sources: Source[]): { iid: string; option: string }[] | null {
  const p = { ...pool };
  const colored: string[] = [];
  const hybrids: string[][] = [];
  let generic = 0;
  for (const s of parseManaSymbols(cost)) {
    if (/^\d+$/.test(s)) generic += parseInt(s, 10);
    else if (s === 'X') generic += x;
    else if (/^[WUBRGC]$/.test(s)) colored.push(s);
    else if (/^[WUBRG]\/P$/.test(s)) colored.push(s[0]); // pay phyrexian with mana when planning
    else if (s.includes('/')) hybrids.push(s.split('/'));
    else if (s === 'S') generic += 1;
  }
  const left = sources.slice().sort((a, b) => a.options.length - b.options.length);
  const used: { iid: string; option: string }[] = [];
  const take = (color: string): boolean => {
    if ((p[color] ?? 0) > 0) { p[color]--; return true; }
    const k = left.findIndex((s) => s.options.some((o) => o.produces.includes(color)));
    if (k < 0) return false;
    const src = left.splice(k, 1)[0];
    const o = src.options.find((op) => op.produces.includes(color))!;
    used.push({ iid: src.iid, option: o.id });
    for (const ch of o.produces) p[ch] = (p[ch] ?? 0) + 1;
    p[color]--;
    return true;
  };
  for (const c of colored) if (!take(c)) return null;
  for (const h of hybrids) {
    const ok = h.some((c) => /^[WUBRG]$/.test(c) && take(c));
    if (!ok) { if (h[0] === '2') generic += 2; else return null; }
  }
  while (generic > 0) {
    const have = Object.keys(p).find((k) => p[k] > 0);
    if (have) { p[have]--; generic--; continue; }
    const src = left.shift();
    if (!src) return null;
    const o = src.options.slice().sort((a, b) => b.produces.length - a.produces.length)[0];
    used.push({ iid: src.iid, option: o.id });
    for (const ch of o.produces) p[ch] = (p[ch] ?? 0) + 1;
  }
  return used;
}

function availableMana(g: GameState, pid: string, exclude?: string): number {
  const me = g.players.find((p) => p.pid === pid)!;
  return Object.values(me.manaPool).reduce((a, b) => a + b, 0) + manaSources(g, pid, exclude).reduce((n, s) => n + Math.max(...s.options.map((o) => o.produces.length)), 0);
}

// ------------------------------------------------------------------ targets

function candidates(g: GameState, spec: TargetSpec, controller: string, src: string | undefined): TargetRef[] {
  const refs: TargetRef[] = [];
  if (spec.players) for (const p of g.players) refs.push({ kind: 'player', pid: p.pid });
  if (spec.zone === 'stack') for (const s of g.stack) refs.push({ kind: 'stack', id: s.id });
  else if (spec.cards) for (const iid of Object.keys(g.cards)) refs.push({ kind: 'card', iid });
  return refs.filter((r) => { try { return isValidTarget(g, spec, r, controller, src, getCard); } catch { return false; } });
}

/** Random legal targets for each spec, or null when a spec can't be satisfied. */
function chooseTargets(rng: Rng, g: GameState, specs: TargetSpec[], controller: string, src: string | undefined): TargetRef[][] | null {
  const out: TargetRef[][] = [];
  for (const spec of specs) {
    const cands = shuffled(rng, candidates(g, spec, controller, src));
    if (cands.length < spec.min) return null;
    const hi = Math.min(spec.max, cands.length);
    const lo = Math.min(hi, Math.max(spec.min, 1));
    const n = lo + Math.floor(rng() * (hi - lo + 1));
    out.push(cands.slice(0, n));
  }
  return out;
}

// ------------------------------------------------------------------ the agent

interface Game { g: GameState; ctx: Ctx; rng: Rng; seed: number; issues: Issue[]; context: string; strict: boolean; activations: number; activationTurn: number; trail: string[] }

function act(G: Game, pid: string, a: GameAction): string | null {
  const ctxCard = G.context;
  try {
    // Mindslaver: the controlling player acts for the controlled one.
    const cb = G.g.controlledBy;
    const routed = cb?.active && cb.pid === pid && a.t !== 'concede' && a.t !== 'keep' ? { actor: cb.by, action: { ...a, as: pid } as GameAction } : { actor: pid, action: a };
    const err = applyAction(G.g, routed.actor, routed.action, G.ctx);
    G.trail.push(`${pid} ${JSON.stringify(a).slice(0, 160)}${err ? ` -> ${err}` : ''}`);
    if (G.trail.length > 40) G.trail.shift();
    return err;
  } catch (e) {
    const err = e as Error;
    if (process.env.PT_STACK) console.error(err.stack);
    G.issues.push({ kind: 'exception', card: cardIn(err.message) ?? ctxCard, text: `${a.t}: ${err.message} @ ${(err.stack ?? '').split('\n').slice(1, 3).map((s) => s.trim()).join(' | ')}`, seed: G.seed, turn: G.g.turn });
    return 'exception';
  }
}

function nameOf(G: Game, iid: string): string {
  const c = G.g.cards[iid];
  return c ? faceOf(c, getCard).name : '?';
}

/** Answer the first pending question. Returns false when nothing worked. */
function answerPending(G: Game, q: Pending): boolean {
  const { g, rng } = G;
  if (q.targets) {
    for (let tries = 0; tries < 4; tries++) {
      const t = chooseTargets(rng, g, q.targets.specs, q.targets.controller, q.targets.sourceIid);
      if (!t) break;
      if (!act(G, q.pid, { t: 'chooseTargets', id: q.id, targets: t })) return true;
    }
  }
  for (const o of shuffled(rng, q.options)) {
    if (!act(G, q.pid, { t: 'choose', id: q.id, value: o.value })) return true;
  }
  return false;
}

function resolvePeek(G: Game, pid: string): boolean {
  const { g, rng } = G;
  const me = g.players.find((p) => p.pid === pid)!;
  const peek = me.peek!;
  const ids = peek.iids.filter((i) => g.cards[i]?.zone === 'library');
  const r = { top: [] as string[], bottom: [] as string[], graveyard: [] as string[], hand: [] as string[], battlefield: [] as string[], exile: [] as string[], shuffle: false };
  for (const iid of shuffled(rng, ids)) {
    if (peek.mode === 'scry') (rng() < 0.5 ? r.top : r.bottom).push(iid);
    else if (peek.mode === 'surveil') (rng() < 0.5 ? r.top : r.graveyard).push(iid);
    else if (peek.mode === 'search') { /* searches without a destination: find nothing */ }
    else r.top.push(iid);
  }
  return !act(G, pid, { t: 'resolvePeek', ...r });
}

interface Play { label: string; card: string; run: () => boolean }

function payThenDo(G: Game, pid: string, cost: string, x: number, exclude: string | undefined, then: () => string | null): boolean {
  if (!G.strict) {
    const me = G.g.players.find((p) => p.pid === pid)!;
    const plan = planMana(cost, x, me.manaPool, manaSources(G.g, pid, exclude));
    if (!plan) return false;
    for (const u of plan) if (act(G, pid, { t: 'activateMana', iid: u.iid, option: u.option })) return false;
  }
  return !then();
}

function castPlays(G: Game, pid: string): Play[] {
  const { g, rng } = G;
  const me = g.players.find((p) => p.pid === pid)!;
  const out: Play[] = [];
  const zones = [...me.zones.hand, ...me.zones.graveyard, ...me.zones.exile, ...g.players.filter((p) => p.pid !== pid).flatMap((p) => p.zones.exile)];
  for (const iid of zones) {
    const c = g.cards[iid];
    if (!c?.cardId) continue;
    const data = getCard(c.cardId);
    if (!data) continue;
    if (data.types.includes('Land') && !(data.layout === 'modal_dfc')) continue;
    if (c.zone !== 'hand' && c.faceDown) continue;
    const faces = data.faces && ['modal_dfc', 'adventure', 'split'].includes(data.layout) ? [0, 1] : [undefined];
    for (const face of faces) {
      const typeLine = face != null && data.faces ? data.faces[face].typeLine : data.typeLine;
      if (/\bLand\b/.test(typeLine)) continue;
      let opts;
      try { opts = castOptions(g, iid, face, getCard); } catch (e) { G.issues.push({ kind: 'exception', card: data.name, text: `castOptions: ${(e as Error).message}`, seed: G.seed, turn: g.turn }); continue; }
      for (const o of opts) {
        if (o.unavailable) continue; // e.g. casting from a graveyard / exile without a permission
        out.push({
          label: `cast ${data.name}${face ? ` (face ${face})` : ''} [${o.id}]`, card: data.name,
          run: () => {
            const sp = castSpellAbility(c.cardId!, face ?? 0, o.id);
            let modes: string[] | undefined;
            if (sp?.ability.choices?.length) {
              const lo = sp.ability.charmMin ?? 1, hi = Math.min(sp.ability.charmMax ?? 1, sp.ability.choices.length);
              const n = lo + Math.floor(rng() * (hi - lo + 1));
              modes = shuffled(rng, sp.ability.choices.map((ch) => ch.name)).slice(0, n);
            }
            const specs = sp ? targetSpecs(sp.ability, modes) : [];
            const targets = specs.length ? chooseTargets(rng, g, specs, pid, iid) : [];
            if (!targets) return false;
            let cost = o.cost;
            try { cost = adjustCost(g, c, pid, o.cost, 'Spell', getCard).cost; } catch { /* keep */ }
            let x = 0;
            if (/\{X\}/.test(cost)) {
              const spare = availableMana(g, pid) - parseManaSymbols(cost).filter((s) => s !== 'X').length;
              if (spare < 0) return false;
              x = Math.floor(rng() * (spare + 1));
            }
            G.context = data.name;
            const a: GameAction = { t: 'cast', iid, targets, ...(face != null ? { face } : {}), ...(modes ? { modes } : {}), ...(x ? { x } : {}), ...(o.id !== 'normal' ? { costOption: o.id } : {}) };
            return payThenDo(G, pid, cost, x, undefined, () => act(G, pid, a));
          },
        });
      }
    }
  }
  return out;
}

function abilityPlays(G: Game, pid: string): Play[] {
  const { g, rng } = G;
  const me = g.players.find((p) => p.pid === pid)!;
  const out: Play[] = [];
  const consider = (iid: string, entries: ReturnType<typeof activatedAbilitiesOf>) => {
    const c = g.cards[iid];
    for (const e of entries) {
      const toks = e.cost.match(/\S+<[^>]*>|\S+/g) ?? [];
      const tap = toks.includes('T');
      if (tap && (c.tapped || (c.zone === 'battlefield' && isCreature(c, getCard, g) && c.summoningSick && !hasKeyword(c, getCard, 'Haste', g)))) continue;
      if (toks.includes('Q') && !c.tapped) continue;
      const name = faceOf(c, getCard).name;
      out.push({
        label: `activate ${name} #${e.index}`, card: name,
        run: () => {
          const specs = targetSpecs(e.ability);
          const targets = specs.length ? chooseTargets(rng, g, specs, pid, iid) : [];
          if (!targets) return false;
          const mana = parseCost(e.cost).mana;
          let x = 0;
          if (/\{X\}/.test(mana)) {
            const spare = availableMana(g, pid, tap ? iid : undefined) - parseManaSymbols(mana).filter((s) => s !== 'X').length;
            if (spare < 0) return false;
            x = Math.floor(rng() * (spare + 1));
          }
          G.context = name;
          return payThenDo(G, pid, mana, x, tap ? iid : undefined, () => act(G, pid, { t: 'activate', iid, text: e.ability.description, ability: e.index, targets, ...(x ? { x } : {}) }));
        },
      });
    }
  };
  for (const iid of g.battlefield) {
    const c = g.cards[iid];
    if (c.controller !== pid || c.faceDown) continue;
    consider(iid, abilitiesOfInstance(c, g, getCard));
  }
  for (const iid of [...me.zones.hand, ...me.zones.graveyard]) {
    const c = g.cards[iid];
    if (!c?.cardId) continue;
    const z = c.zone;
    consider(iid, activatedAbilitiesOf(c.cardId, 0).filter((e) => e.zone === z));
  }
  return out;
}

function landPlays(G: Game, pid: string): Play[] {
  const { g } = G;
  const me = g.players.find((p) => p.pid === pid)!;
  if (G.strict ? landPlaysLeft(g, pid, getCard) <= 0 : me.landsPlayed >= landPlaysAllowed(g, pid, getCard)) return [];
  const fromElsewhere = [...me.zones.graveyard, ...me.zones.exile, ...me.zones.library.slice(0, 1)].filter((iid) => mayPlayFrom(g, pid, iid, getCard));
  return [...me.zones.hand, ...fromElsewhere].filter((iid) => {
    const d = g.cards[iid]?.cardId ? getCard(g.cards[iid].cardId!) : undefined;
    return !!d && (d.types.includes('Land') || (d.layout === 'modal_dfc' && !!d.faces?.some((f) => /\bLand\b/.test(f.typeLine))));
  }).map((iid) => ({
    label: `play ${nameOf(G, iid)}`, card: nameOf(G, iid),
    run: () => {
      G.context = nameOf(G, iid);
      const d = getCard(g.cards[iid].cardId!)!;
      if (!d.types.includes('Land')) {
        // MDFC with a land back: play it transformed (the reducer has no face option: move + transform).
        return false;
      }
      return !act(G, pid, { t: 'playLand', iid });
    },
  }));
}

function declareAttackers(G: Game, pid: string) {
  const { g, rng } = G;
  const opp = g.players.find((p) => p.pid !== pid && !p.conceded);
  if (!opp) return;
  const walkers = g.battlefield.filter((iid) => g.cards[iid].controller === opp.pid && faceOf(g.cards[iid], getCard).types.includes('Planeswalker'));
  for (const iid of g.battlefield) {
    const c = g.cards[iid];
    if (c.controller !== pid || c.tapped || !isCreature(c, getCard, g)) continue;
    if (c.summoningSick && !hasKeyword(c, getCard, 'Haste', g)) continue;
    if (rng() < 0.55) act(G, pid, { t: 'declareAttacker', iid, target: walkers.length && rng() < 0.3 ? pick(rng, walkers) : opp.pid });
  }
}

function declareBlockers(G: Game, pid: string) {
  const { g, rng } = G;
  const attackers = g.battlefield.filter((iid) => g.cards[iid].attacking);
  if (!attackers.length) return;
  for (const iid of g.battlefield) {
    const c = g.cards[iid];
    if (c.controller !== pid || c.tapped || !isCreature(c, getCard, g)) continue;
    if (rng() < 0.4) act(G, pid, { t: 'declareBlocker', iid, attacker: pick(rng, attackers) });
  }
}

/** One decision for the player with priority. */
function priorityAction(G: Game, pid: string) {
  const { g, rng } = G;
  if (G.activationTurn !== g.turn) { G.activationTurn = g.turn; G.activations = 0; }
  const mine = g.activePlayer === pid;
  const main = (g.step === 'main1' || g.step === 'main2') && g.stack.length === 0 && mine;
  if (g.step === 'attackers' && mine && !g.combat.attackersDeclared) declareAttackers(G, pid);
  if (g.step === 'blockers' && !mine && !g.combat.blockersDeclared) declareBlockers(G, pid);
  const plays: Play[] = [];
  if (main) plays.push(...landPlays(G, pid));
  const wantSpell = main ? rng() < 0.8 : rng() < 0.15;
  if (wantSpell) plays.push(...castPlays(G, pid));
  if (G.activations < 8 && rng() < (main ? 0.5 : 0.1)) plays.push(...abilityPlays(G, pid));
  for (const p of shuffled(rng, plays)) {
    if (p.run()) { if (p.label.startsWith('activate')) G.activations++; return; }
    if (g.priority !== pid || g.pending.length) return; // something changed (e.g. a cost question)
  }
  G.context = g.stack.length ? stackCard(G) : G.context;
  const err = act(G, pid, { t: 'pass' });
  // An illegal block (menace, "can't be blocked except by ...") is refused when blocks are confirmed: take the blocks back.
  if (err && g.step === 'blockers' && !mine) {
    for (const iid of g.battlefield) if (g.cards[iid].controller === pid && g.cards[iid].blocking) act(G, pid, { t: 'declareBlocker', iid, attacker: null });
    act(G, pid, { t: 'pass' });
  }
}

function stackCard(G: Game): string {
  const top = G.g.stack[G.g.stack.length - 1];
  if (!top) return G.context;
  const iid = top.iid ?? top.sourceIid;
  return (iid && G.g.cards[iid] ? nameOf(G, iid) : cardIn(top.text)) ?? G.context;
}

// ------------------------------------------------------------------ invariants

function checkInvariants(G: Game, realCards: number) {
  const { g } = G;
  const bad = (kind: IssueKind, card: string, text: string) => G.issues.push({ kind, card, text, seed: G.seed, turn: g.turn });
  const where = new Map<string, string[]>();
  const put = (iid: string, z: string) => { const l = where.get(iid) ?? []; l.push(z); where.set(iid, l); };
  g.battlefield.forEach((i) => put(i, 'battlefield'));
  for (const s of g.stack) if (s.iid) put(s.iid, 'stack');
  for (const p of g.players) for (const [z, l] of Object.entries(p.zones)) for (const i of l) {
    put(i, z);
    if (g.cards[i] && g.cards[i].owner !== p.pid) bad('invariant', nameOf(G, i), `${nameOf(G, i)} is in ${p.name}'s ${z} but owned by ${g.cards[i].owner}`);
  }
  let real = 0;
  for (const [iid, c] of Object.entries(g.cards)) {
    if (!c.token) real++;
    if (c.iid !== iid) bad('invariant', nameOf(G, iid), `card key ${iid} != iid ${c.iid}`);
    const zs = where.get(iid) ?? [];
    const nm = nameOf(G, iid);
    if (zs.length > 1) bad('invariant', nm, `${nm} is in several zones: ${zs.join(', ')}`);
    else if (zs.length === 1 && zs[0] !== c.zone) bad('invariant', nm, `${nm} is listed in ${zs[0]} but its zone is ${c.zone}`);
    else if (zs.length === 0 && c.zone !== 'stack') bad('invariant', nm, `${nm} (zone ${c.zone}) is in no zone list`);
    if (c.token && c.zone !== 'battlefield' && c.zone !== 'stack') bad('invariant', nm, `token ${nm} exists in ${c.zone}`);
    for (const [k, v] of Object.entries(c.counters)) if (v < 0 || Number.isNaN(v)) bad('invariant', nm, `${nm} has ${v} ${k} counters`);
    if (c.damage < 0 || Number.isNaN(c.damage)) bad('invariant', nm, `${nm} has ${c.damage} damage`);
  }
  for (const iid of where.keys()) if (!g.cards[iid]) bad('invariant', G.context, `zone list holds unknown card ${iid}`);
  if (real !== realCards) bad('invariant', G.context, `card count changed: ${realCards} -> ${real}`);
  for (const p of g.players) {
    for (const [k, v] of Object.entries(p.manaPool)) if (v < 0 || Number.isNaN(v)) bad('invariant', G.context, `${p.name} has ${v} ${k} mana`);
    for (const [k, v] of Object.entries(p.counters)) if (v < 0 || Number.isNaN(v)) bad('invariant', G.context, `${p.name} has ${v} ${k} counters`);
    if (Number.isNaN(p.life)) bad('invariant', G.context, `${p.name} has NaN life`);
  }
  return real;
}

function checkLeaks(G: Game) {
  const { g } = G;
  for (const viewer of g.players) {
    const v = viewFor(g, viewer.pid);
    const controlsOther = (owner: string) => !!g.controlledBy?.active && g.controlledBy.by === viewer.pid && g.controlledBy.pid === owner;
    for (const [iid, vc] of Object.entries(v.cards)) {
      if (isHidden(vc)) continue;
      const c = g.cards[iid];
      if (!c || c.owner === viewer.pid || c.revealedTo.includes(viewer.pid) || controlsOther(c.owner)) continue;
      const nm = nameOf(G, iid);
      if (c.zone === 'hand' && viewer.viewingHandOf !== c.owner) G.issues.push({ kind: 'leak', card: nm, text: `${viewer.name} sees ${nm} in an opponent's hand`, seed: G.seed, turn: g.turn });
      if (c.zone === 'library' && !topCardVisible(g, viewer.pid, iid, getCard)) G.issues.push({ kind: 'leak', card: nm, text: `${viewer.name} sees ${nm} in an opponent's library`, seed: G.seed, turn: g.turn });
      if (c.faceDown && c.controller !== viewer.pid) G.issues.push({ kind: 'leak', card: nm, text: `${viewer.name} sees face-down ${nm}`, seed: G.seed, turn: g.turn });
    }
    for (const q of v.pending) {
      if (q.pid !== viewer.pid && !controlsOther(q.pid) && q.options.length) G.issues.push({ kind: 'leak', card: G.context, text: `${viewer.name} sees the options of ${q.pid}'s question "${q.prompt}"`, seed: G.seed, turn: g.turn });
    }
    for (const p of v.players) if (p.pid !== viewer.pid && !controlsOther(p.pid) && p.peek?.iids.length) G.issues.push({ kind: 'leak', card: G.context, text: `${viewer.name} sees ${p.name}'s peek`, seed: G.seed, turn: g.turn });
  }
}

// ------------------------------------------------------------------ one game

export interface GameResult { seed: number; turns: number; actions: number; winner: string | null; end: 'win' | 'turns' | 'stall' | 'actions'; issues: Issue[]; decks: string[][] }

/** A random sideboard of `n` pool cards not in `deck` (half instants / sorceries when there are enough). Own rng: decks don't change. */
export function randomSide(seed: number, deck: string[], n: number, pool: CardData[] = CUBE.cards): string[] {
  if (n <= 0) return [];
  const rng = seeded(seed * 104729 + 7);
  const inDeck = new Set(deck);
  const rest = shuffled(rng, pool.filter((c) => !inDeck.has(c.id) && !c.types.includes('Land')));
  const spells = rest.filter((c) => c.types.includes('Instant') || c.types.includes('Sorcery')).slice(0, Math.ceil(n / 2));
  const others = rest.filter((c) => !spells.includes(c)).slice(0, n - spells.length);
  return [...spells, ...others].map((c) => c.id);
}

export function playGame(seed: number, opts: { maxTurns?: number; stallAfter?: number; leakEvery?: number; trace?: boolean; pool?: CardData[]; force?: CardData[]; ai?: BotLevel; side?: number } = {}): GameResult {
  const rng = seeded(seed * 7919 + 13);
  const maxTurns = opts.maxTurns ?? 30;
  const stallAfter = opts.stallAfter ?? 400;
  const d1 = randomDeck(rng, opts.pool, opts.force), d2 = randomDeck(rng, opts.pool, opts.force);
  const ctx: Ctx = { rng: seeded(seed), lookup: getCard, now: 0 };
  const s1 = randomSide(seed * 2, d1.deck, opts.side ?? 0, opts.pool), s2 = randomSide(seed * 2 + 1, d2.deck, opts.side ?? 0, opts.pool);
  const g = createGame(`pt${seed}`, [{ pid: 'p1', name: 'Bot1', deck: d1.deck, side: s1 }, { pid: 'p2', name: 'Bot2', deck: d2.deck, side: s2 }], rng() < 0.5 ? 'p1' : 'p2', ctx);
  const G: Game = { g, ctx, rng, seed, issues: [], context: '(game)', strict: 'strict' in g && !!(g as { strict?: boolean }).strict, activations: 0, activationTurn: 0, trail: [] };
  const seen = new WeakSet<object>();
  for (const l of g.log) seen.add(l);
  const realCards = Object.values(g.cards).filter((c) => !c.token).length;
  let actions = 0, sinceProgress = 0, lastTurn = -1, lastStep = '';
  let end: GameResult['end'] = 'actions';
  const mems: Record<string, BotMemory> = Object.fromEntries(g.players.map((p, i) => [p.pid, newBotMemory(seed * 31 + i)]));
  if (!opts.ai && !g.pregame) for (const p of g.players) act(G, p.pid, { t: 'keep' });
  while (actions < 20000) {
    actions++;
    ctx.now = actions;
    if (g.phase === 'over') { end = 'win'; break; }
    if (g.turn > maxTurns) { end = 'turns'; break; }
    // State-based "you lose" (in case the engine doesn't end the game itself).
    const loser = g.players.find((p) => !p.conceded && (p.life <= 0 || (p.counters.poison ?? 0) >= 10));
    if (loser) { act(G, loser.pid, { t: 'concede' }); continue; }
    const progress = `${g.turn}|${g.step}`;
    if (g.turn !== lastTurn || progress !== lastStep) { lastTurn = g.turn; lastStep = progress; sinceProgress = 0; }
    if (++sinceProgress > stallAfter) {
      const q = g.pending[0];
      const what = q ? `question "${q.prompt}" (for ${q.pid}, ${q.options.length} options${q.targets ? ', targets' : ''})` : g.players.find((p) => p.peek) ? 'a peek window' : `step ${g.step}, stack: ${g.stack.map((s) => s.text).join(' / ') || 'empty'}, priority ${g.priority}`;
      G.issues.push({ kind: 'stall', card: (q ? cardIn(q.prompt) : undefined) ?? stackCard(G), text: `no progress after ${stallAfter} actions — ${what}`, seed, turn: g.turn });
      if (opts.trace) console.log(`seed ${seed} stalled:\n  ${G.trail.join('\n  ')}\n  log: ${g.log.slice(-15).map((l) => l.text).join('\n  ')}`);
      end = 'stall';
      break;
    }
    if (opts.ai) {
      // The computer opponent plays both seats, seeing only its own view.
      const actor = g.players.find((p) => botNeedsToAct(g, p.pid));
      if (!actor) {
        G.issues.push({ kind: 'stall', card: G.context, text: `nobody has anything to do (phase ${g.phase}, step ${g.step}, priority ${g.priority}, pending ${g.pending.length})`, seed, turn: g.turn });
        end = 'stall';
        break;
      }
      const q = g.pending.find((x) => x.pid === actor.pid);
      if (q) G.context = cardIn(q.prompt) ?? G.context;
      else if (g.stack.length) G.context = stackCard(G);
      const r = botStep(() => viewFor(g, actor.pid), actor.pid, mems[actor.pid], (a) => {
        if (a.t === 'cast' || a.t === 'activate' || a.t === 'playLand') G.context = nameOf(G, a.iid);
        return act(G, actor.pid, a);
      }, { level: opts.ai });
      if (r.stuck) {
        G.issues.push({ kind: 'stall', card: G.context, text: `the bot found no legal action (${q ? `question "${q.prompt}"` : `step ${g.step}`})`, seed, turn: g.turn });
        end = 'stall';
        break;
      }
    } else if (g.pending.length) {
      const q = g.pending[0];
      G.context = cardIn(q.prompt) ?? G.context;
      if (!answerPending(G, q)) {
        G.issues.push({ kind: 'stall', card: cardIn(q.prompt) ?? G.context, text: `no legal answer to "${q.prompt}" (${q.options.map((o) => o.label).join(', ') || 'no options'}${q.targets ? '; targets' : ''})`, seed, turn: g.turn });
        end = 'stall';
        break;
      }
    } else if (g.players.some((p) => p.peek)) {
      const p = g.players.find((x) => x.peek)!;
      // Engine-opened look windows other than scry / surveil are cards the player has to sort by hand.
      if (p.peek!.mode !== 'scry' && p.peek!.mode !== 'surveil') G.issues.push({ kind: 'manual', card: cardIn(p.peek!.label ?? '') ?? G.context, text: `look-at-the-top window (${p.peek!.mode}): ${p.peek!.label ?? '?'}`, seed, turn: g.turn });
      if (!resolvePeek(G, p.pid)) { p.peek = null; }
    } else if (g.phase === 'mulligan') {
      // After the pre-game choices (Arcane Savant): keep.
      for (const p of g.players) if (!p.kept) act(G, p.pid, { t: 'keep' });
    } else if (g.phase === 'playing') {
      // Empty library draw = loss (rule 704.5b) when the engine doesn't handle it.
      priorityAction(G, g.priority);
    } else break;
    for (const l of g.log) {
      if (seen.has(l)) continue;
      seen.add(l);
      if (MANUAL_RE.test(l.text)) G.issues.push({ kind: 'manual', card: cardIn(l.text) ?? G.context, text: l.text, seed, turn: g.turn });
      if (/can't draw — library is empty/.test(l.text) && l.pid) act(G, l.pid, { t: 'concede' });
    }
    checkInvariants(G, realCards);
    if (actions % (opts.leakEvery ?? 3) === 0) checkLeaks(G);
  }
  // De-duplicate repeated invariant / leak reports of one game.
  const uniq = new Map<string, Issue>();
  for (const i of G.issues) { const k = `${i.kind}|${i.card}|${i.text.replace(/\d+/g, '#')}`; if (!uniq.has(k)) uniq.set(k, i); }
  return { seed, turns: g.turn, actions, winner: g.winner, end, issues: [...uniq.values()], decks: [d1.deck, d2.deck] };
}

// ------------------------------------------------------------------ many games + report

export interface PlaytestSummary { games: number; results: GameResult[]; byKind: Record<IssueKind, number>; gamesWithIssues: number; cardsPlayed: Map<string, number> }

export function playtest(n: number, firstSeed = 1, opts: Parameters<typeof playGame>[1] = {}): PlaytestSummary {
  const results: GameResult[] = [];
  if (opts.pool) addNames(opts.pool);
  for (let k = 0; k < n; k++) {
    try { results.push(playGame(firstSeed + k, opts)); } catch (e) {
      // a crash outside applyAction (deck building, invariants ...): report it, keep going
      results.push({ seed: firstSeed + k, turns: 0, actions: 0, winner: null, end: 'stall', decks: [], issues: [{ kind: 'exception', card: '(game)', text: `playGame: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`, seed: firstSeed + k, turns: 0 } as unknown as Issue] });
    }
  }
  const byKind = { exception: 0, stall: 0, manual: 0, invariant: 0, leak: 0 } as Record<IssueKind, number>;
  for (const r of results) for (const i of r.issues) byKind[i.kind]++;
  const cardsPlayed = new Map<string, number>();
  for (const r of results) for (const id of new Set(r.decks.flat())) cardsPlayed.set(id, (cardsPlayed.get(id) ?? 0) + 1);
  return { games: n, results, byKind, gamesWithIssues: results.filter((r) => r.issues.length).length, cardsPlayed };
}

export function formatReport(s: PlaytestSummary, top = 40): string {
  const lines: string[] = [];
  const ends: Record<string, number> = {};
  for (const r of s.results) ends[r.end] = (ends[r.end] ?? 0) + 1;
  const turns = s.results.reduce((a, r) => a + r.turns, 0) / Math.max(1, s.results.length);
  const actions = s.results.reduce((a, r) => a + r.actions, 0);
  lines.push(`Games: ${s.games} (${Object.entries(ends).map(([k, v]) => `${k} ${v}`).join(', ')}), avg ${turns.toFixed(1)} turns, ${actions} actions`);
  lines.push(`Games with issues: ${s.gamesWithIssues}/${s.games}`);
  lines.push(`Issues: ${Object.entries(s.byKind).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const byCard = new Map<string, { n: number; games: Set<number>; kinds: Record<string, number>; samples: Map<string, number> }>();
  for (const r of s.results) for (const i of r.issues) {
    const e = byCard.get(i.card) ?? { n: 0, games: new Set<number>(), kinds: {}, samples: new Map<string, number>() };
    e.n++; e.games.add(r.seed); e.kinds[i.kind] = (e.kinds[i.kind] ?? 0) + 1;
    const key = `[${i.kind}] ${i.text.slice(0, 200)}`;
    e.samples.set(key, (e.samples.get(key) ?? 0) + 1);
    byCard.set(i.card, e);
  }
  const sorted = [...byCard].sort((a, b) => b[1].games.size - a[1].games.size || b[1].n - a[1].n);
  lines.push(`Cards with issues: ${sorted.length}`);
  for (const [card, e] of sorted.slice(0, top)) {
    lines.push(`- ${card}: ${e.n} issue(s) in ${e.games.size} game(s) [${Object.entries(e.kinds).map(([k, v]) => `${k} ${v}`).join(', ')}] e.g. seed ${[...e.games][0]}`);
    for (const [t, n] of [...e.samples].sort((a, b) => b[1] - a[1]).slice(0, 3)) lines.push(`    ${n}x ${t}`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ card database pools

/**
 * Cards for --pool: 'standard' (Standard-legal sets minus bans) or 'set:CODE[+CODE]', from data/carddb via
 * server/src/carddb.ts. Their rules scripts are registered for the engine; basic lands are left out (decks add them).
 */
export async function databasePool(spec: string): Promise<CardData[]> {
  const db = await import('../server/src/carddb.ts');
  const rc = await import('../server/src/roomcards.ts');
  if (!rc.installCardDb()) throw new Error('No card database (copy data/carddb first)');
  let ids: string[] = [];
  if (spec === 'standard') {
    const f = db.getFormat('Standard');
    if (!f) throw new Error('No Standard format in formats.json');
    const banned = new Set(f.banned);
    for (const code of f.sets) for (const p of db.getSet(code)?.cards ?? []) if (!banned.has(p[0])) ids.push(p[0]);
  } else if (spec.startsWith('set:')) {
    for (const code of spec.slice(4).split('+')) {
      const s = db.getSet(code);
      if (!s) throw new Error(`Unknown set ${code}`);
      ids.push(...s.cards.map((p) => p[0]));
    }
  } else throw new Error(`Unknown pool ${spec}`);
  ids = [...new Set(ids)];
  rc.ensureCards(ids);
  return ids.map((id) => getCard(id)).filter((c): c is CardData => !!c && !/\bBasic\b/.test(c.typeLine) && c.layout !== 'token' && !/\b(Conspiracy|Scheme|Plane|Phenomenon|Vanguard|Dungeon)\b/.test(c.typeLine));
}

// ------------------------------------------------------------------ CLI

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  const n = parseInt(pos[0] ?? '100', 10);
  const seed = parseInt(pos[1] ?? '1', 10);
  const t0 = Date.now();
  const poolSpec = flag('pool') ?? 'cube';
  const pool = poolSpec === 'cube' ? undefined : await databasePool(poolSpec);
  if (pool) console.log(`Pool ${poolSpec}: ${pool.length} cards`);
  const force = (flag('force') ?? '').split(',').filter(Boolean).map((id) => getCard(id)).filter((c): c is CardData => !!c);
  const aiFlag = args.find((a) => a === '--ai' || a.startsWith('--ai='));
  const ai = aiFlag ? ((aiFlag.split('=')[1] ?? 'normal') as BotLevel) : undefined;
  const s = playtest(n, seed, { maxTurns: parseInt(flag('turns') ?? '30', 10), trace: args.includes('--trace'), ...(pool ? { pool } : {}), ...(force.length ? { force } : {}), ...(ai ? { ai } : {}), ...(flag('side') ? { side: parseInt(flag('side')!, 10) } : {}) });
  console.log(formatReport(s, parseInt(flag('top') ?? '40', 10)));
  console.log(`(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  const out = flag('json');
  if (out) writeFileSync(out, JSON.stringify({ byKind: s.byKind, gamesWithIssues: s.gamesWithIssues, results: s.results.map((r) => ({ ...r, decks: undefined })) }, null, 1));
  void effectivePT;
}
