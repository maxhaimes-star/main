/**
 * Chain audit: runs every multi-step ability of every cube card (spell, activated abilities, triggered abilities'
 * Execute$ chains, each mode of a modal ability) in a prepared game and checks that the chain doesn't stop partway:
 * every step that is reached must reach its SubAbility$, and a Branch / RollDice / GenericChoice / FlipCoin / Repeat
 * step must reach one of its result chains.
 *
 *   npx tsx scripts/chain-audit.ts [--cards=id,id] [--verbose]
 *
 * Exit code 1 when a chain stops partway.
 */
import { pathToFileURL } from 'node:url';
import { CUBE, getCard } from '../shared/src/cube.ts';
import {
  applyAction, createGame, type Ctx, type GameAction, type GameState, isValidTarget, moveCard, type Pending, type StackItem, type TargetRef, type TargetSpec,
} from '../shared/src/index.ts';
import { activatedAbilitiesOf, getScript, parseAbility, targetSpecs } from '../shared/src/engine/script.ts';
import { chainProbe } from '../shared/src/engine/resolve.ts';
import type { AutoInfo, ParsedAbility } from '../shared/src/engine/types.ts';

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

export const keyOf = (step: ParsedAbility) => `${step.api}|${JSON.stringify(step.params)}`;
const isChainLine = (l: string | undefined) => !!l && /^\s*(DB|AB|SP)\$/.test(l);

/** The svars a step continues with: [kind, names]. 'all' = each must be reached; 'one' = at least one. */
function continuations(step: ParsedAbility, svars: Record<string, string>): { all: string[]; one: string[] } {
  const p = step.params;
  const all: string[] = [];
  const one: string[] = [];
  if (p.SubAbility && isChainLine(svars[p.SubAbility])) all.push(p.SubAbility);
  const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim().replace(/^[^:]*:/, '')).filter((s) => isChainLine(svars[s]));
  switch (step.api) {
    case 'Branch': one.push(...list(p.TrueSubAbility), ...list(p.FalseSubAbility)); break;
    case 'RollDice': one.push(...list(p.ResultSubAbilities)); break;
    case 'GenericChoice': one.push(...list(p.Choices)); break;
    case 'FlipCoin': one.push(...list(p.WinSubAbility), ...list(p.LoseSubAbility), ...list(p.HeadsSubAbility), ...list(p.TailsSubAbility)); break;
    case 'Repeat': case 'RepeatEach': all.push(...list(p.RepeatSubAbility)); break;
    // A reflexive trigger with targets is removed when there are none: only untargeted ones must run.
    case 'ImmediateTrigger': all.push(...list(p.Execute).filter((sv) => !/ValidTgts\$/.test(svars[sv]))); break;
    // Vote / TwoPiles run their result chains inline (engine/unique.ts), not as steps.
  }
  return { all, one };
}

export interface ChainTrack { item: StackItem; reached: Map<string, ParsedAbility>; skipped?: Set<string> }

/** Steps of a resolved chain that were reached but didn't reach their continuation. */
export function chainBreaks(c: ChainTrack): string[] {
  const out: string[] = [];
  for (const step of c.reached.values()) {
    const svars = step.svars ?? {};
    // A triggered ability's optional cost ("you may pay ... if you do") that was declined.
    if (step.kind === 'AB' && step.params.Cost && c.item.kind === 'trigger') continue;
    const cont = continuations(step, svars);
    // A skipped "when you do" (its condition was false / nothing was done) has no Execute$ to reach; its SubAbility$ still runs.
    if (step.api === 'ImmediateTrigger' && c.skipped?.has(keyOf(step))) cont.all = cont.all.filter((sv) => sv === step.params.SubAbility);
    const hit = (sv: string) => { const ab = parseAbility(svars[sv], svars, ''); return !!ab && c.reached.has(keyOf(ab)); };
    for (const sv of cont.all) if (!hit(sv)) out.push(`${step.api} -> ${sv} never ran`);
    if (cont.one.length && !cont.one.some(hit)) out.push(`${step.api} -> none of ${cont.one.join(', ')} ran`);
  }
  return out;
}

interface Entry { cardId: string; face: number; label: string; auto: Omit<AutoInfo, 'targets'>; head: ParsedAbility; root: ParsedAbility; kind: StackItem['kind']; modes?: string[][] }

function entriesOf(cardId: string): Entry[] {
  const out: Entry[] = [];
  (getScript(cardId) ?? []).forEach((f, face) => {
    const add = (e: Entry) => {
      // Modal: each mode on its own.
      if (e.head.api === 'Charm' && e.head.choices?.length) {
        for (const ch of e.head.choices) out.push({ ...e, label: `${e.label} [${ch.name}]`, auto: { ...e.auto, modes: [ch.name] }, head: ch.ability, root: e.head });
      } else out.push(e);
    };
    f.abilities.forEach((line, index) => {
      if (/^\s*SP\$/.test(line)) {
        const head = parseAbility(line, f.svars, f.name);
        if (head) add({ cardId, face, label: `spell ${index}`, auto: { cardId, face, source: 'spell', index }, head, root: head, kind: 'spell' });
      }
    });
    for (const a of activatedAbilitiesOf(cardId, face)) {
      if (a.keyword) continue;
      add({ cardId, face, label: `ability ${a.index}`, auto: { cardId, face, source: 'ability', index: a.index }, head: a.ability, root: a.ability, kind: 'ability' });
    }
    f.triggers.forEach((line, index) => {
      const svar = /Execute\$\s*(\w+)/.exec(line)?.[1];
      if (!svar || !isChainLine(f.svars[svar])) return;
      const head = parseAbility(f.svars[svar], f.svars, f.name);
      if (head) add({ cardId, face, label: `trigger ${index}`, auto: { cardId, face, source: 'trigger', index, svar }, head, root: head, kind: 'trigger' });
    });
  });
  return out;
}

/** Does the chain have more than one step (anything to audit)? */
function multiStep(e: Entry, svars: Record<string, string>): boolean {
  const c = continuations(e.head, svars);
  return !!(c.all.length || c.one.length || e.head.sub || e.head.choices?.length);
}

const pick = <T>(rng: () => number, xs: T[]): T => xs[Math.floor(rng() * xs.length)];
function shuffled<T>(rng: () => number, xs: T[]): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function candidates(g: GameState, spec: TargetSpec, controller: string, src: string | undefined): TargetRef[] {
  const refs: TargetRef[] = [];
  if (spec.players) for (const p of g.players) refs.push({ kind: 'player', pid: p.pid });
  if (spec.zone === 'stack') for (const s of g.stack) refs.push({ kind: 'stack', id: s.id });
  else if (spec.cards) for (const iid of Object.keys(g.cards)) refs.push({ kind: 'card', iid });
  return refs.filter((r) => { try { return isValidTarget(g, spec, r, controller, src, getCard); } catch { return false; } });
}

function chooseTargets(rng: () => number, g: GameState, specs: TargetSpec[], controller: string, src: string | undefined): TargetRef[][] | null {
  const out: TargetRef[][] = [];
  for (const spec of specs) {
    // Prefer the opponent's things (harmful effects) half the time, else random.
    const cands = shuffled(rng, candidates(g, spec, controller, src));
    if (cands.length < spec.min) return null;
    const n = Math.min(Math.max(spec.min, 1), cands.length);
    out.push(cands.slice(0, n));
  }
  return out;
}

const byType = (t: string, n: number, not: string[] = []) => CUBE.cards.filter((c) => c.types.includes(t) && !not.some((x) => c.types.includes(x)) && getScript(c.id)).slice(0, n).map((c) => c.id);

/** A game in Alice's first main phase with a full board, hands, graveyards and libraries for both players. */
function board(seed: number, cardId: string) {
  const creatures = byType('Creature', 6, ['Land']);
  const spells = [...byType('Instant', 3), ...byType('Sorcery', 3)];
  const arts = byType('Artifact', 2, ['Creature', 'Land']);
  const ench = byType('Enchantment', 2, ['Creature', 'Land']);
  const pws = byType('Planeswalker', 1);
  const lands = ['basic_plains', 'basic_island', 'basic_swamp', 'basic_mountain', 'basic_forest'];
  const mix = [...creatures, ...spells, ...arts, ...ench, ...pws];
  const deck = (extra: string[]) => { const d = [...extra, ...mix]; while (d.length < 40) d.push(lands[d.length % 5]); return d; };
  const ctx: Ctx = { rng: seeded(seed), lookup: getCard, now: 0 };
  const g = createGame('audit', [
    { pid: 'a', name: 'Alice', deck: deck([cardId]), side: [] },
    { pid: 'b', name: 'Bob', deck: deck([]), side: [] },
  ], 'a', ctx);
  applyAction(g, 'a', { t: 'keep' }, ctx);
  applyAction(g, 'b', { t: 'keep' }, ctx);
  for (const p of g.players) {
    const lib = () => p.zones.library;
    const take = (pred: (id: string) => boolean, zone: 'battlefield' | 'graveyard' | 'hand' | 'exile', n: number) => {
      for (let k = 0; k < n; k++) {
        const iid = lib().find((i) => g.cards[i].cardId !== cardId && pred(g.cards[i].cardId!));
        if (!iid) return;
        moveCard(g, ctx, iid, zone, zone === 'battlefield' ? { controller: p.pid } : {});
        if (zone === 'battlefield') { g.cards[iid].summoningSick = false; g.cards[iid].tapped = false; }
      }
    };
    take((id) => creatures.includes(id), 'battlefield', 2);
    take((id) => arts.includes(id), 'battlefield', 1);
    take((id) => ench.includes(id), 'battlefield', 1);
    take((id) => id.startsWith('basic_'), 'battlefield', 5);
    take((id) => creatures.includes(id) || spells.includes(id), 'graveyard', 3);
    take((id) => id.startsWith('basic_'), 'graveyard', 1);
    take((id) => !id.startsWith('basic_'), 'hand', 3);
    take(() => true, 'exile', 1);
    for (const c of 'WUBRGC') p.manaPool[c] = 5;
    p.life = 20;
  }
  g.log = [];
  return { g, ctx };
}

export interface Miss { cardId: string; entry: string; step: string; missing: string; log: string }

function runEntry(e: Entry, seed: number, strategy: 'first' | 'random'): { misses: Miss[]; note?: string; noops?: string[] } {
  const { g, ctx } = board(seed, e.cardId);
  const rng = seeded(seed * 31 + 7);
  const me = g.players[0];
  const iid = [...me.zones.library, ...me.zones.hand, ...me.zones.graveyard, ...me.zones.exile].find((i) => g.cards[i].cardId === e.cardId);
  if (!iid) return { misses: [], note: 'card not found' };
  const face = getScript(e.cardId)![e.face];
  if (e.kind === 'spell') {
    moveCard(g, ctx, iid, 'stack');
  } else {
    moveCard(g, ctx, iid, 'battlefield', { controller: 'a' });
    g.cards[iid].summoningSick = false;
    g.cards[iid].tapped = false;
    if (e.face && g.cards[iid]) (g.cards[iid] as { face?: number }).face = e.face;
    if (/Planeswalker/.test(String(getCard(e.cardId)?.types))) g.cards[iid].counters.loyalty = 5;
  }
  const src = iid;
  // Something on the stack to target (counterspells): an opponent's instant.
  const bobSpell = g.players[1].zones.library.find((i) => getCard(g.cards[i].cardId!)?.types.includes('Instant'));
  if (bobSpell) { moveCard(g, ctx, bobSpell, 'stack'); g.stack.push({ id: 'audit-bob', kind: 'spell', iid: bobSpell, controller: 'b', text: 'a spell' }); }
  // An attacking creature (Condemn ...).
  const bobAtt = g.battlefield.find((i) => g.cards[i].controller === 'b' && getCard(g.cards[i].cardId!)?.types.includes('Creature'));
  if (bobAtt && e.head.params.ValidTgts?.includes('attacking')) { g.cards[bobAtt].attacking = 'a'; }
  const specs = targetSpecs(e.root, e.auto.modes);
  const targets = chooseTargets(rng, g, specs, 'a', src);
  if (!targets) return { misses: [], note: 'no legal targets' };
  const reached = new Set<string>();
  const reachedSteps: ParsedAbility[] = [];
  // Did a step change anything? (the state when the next step starts, or at the end, vs. when it started)
  const snap = () => JSON.stringify([g.cards, g.players, g.battlefield, g.stack.length, (g as { effects?: unknown }).effects, g.delayedTriggers, g.pending.length]);
  let prev: { step: ParsedAbility; at: string; logs: number } | undefined;
  const noop: ParsedAbility[] = [];
  const effective = new Set<string>();
  let waited = false;
  const close = () => {
    if (!prev) return;
    const changed = snap() !== prev.at || g.log.length !== prev.logs || waited;
    if (changed) effective.add(keyOf(prev.step)); else noop.push(prev.step);
    prev = undefined;
    waited = false;
  };
  const skipped = new Set<string>();
  chainProbe.onSkip = (item, step) => { if (item.auto?.cardId === e.cardId) skipped.add(keyOf(step)); };
  chainProbe.onStep = (item, step) => {
    if (item.auto?.cardId !== e.cardId) return;
    close();
    prev = { step, at: snap(), logs: g.log.length };
    const k = keyOf(step);
    if (!reached.has(k)) { reached.add(k); reachedSteps.push(step); }
  };
  const auto: AutoInfo = { ...e.auto, targets, x: 2 };
  if (e.kind === 'trigger') auto.trigger = { mode: 'ChangesZone', card: src, player: 'a', source: src, target: 'b', lki: {} } as AutoInfo['trigger'];
  const item: StackItem = { id: `audit-${e.label}`, kind: e.kind, controller: 'a', text: `${face.name}: ${e.head.description}`, auto, x: 2, ...(e.kind === 'spell' ? { iid: src } : { sourceIid: src }) };
  g.stack.push(item);
  g.priority = 'a';
  const act = (pid: string, a: GameAction) => { try { return applyAction(g, pid, a, ctx); } catch (err) { return `exception ${(err as Error).message}`; } };
  let exception: string | undefined;
  for (let k = 0; k < 120; k++) {
    if (g.winner || g.players.some((p) => p.conceded)) break;
    const q: Pending | undefined = g.pending[0];
    if (q || g.players.some((p) => p.peek)) waited = true;
    if (q) {
      let done = false;
      if (q.targets) {
        for (let t = 0; t < 4 && !done; t++) {
          const tg = chooseTargets(rng, g, q.targets.specs, q.targets.controller, q.targets.sourceIid);
          if (tg && !act(q.pid, { t: 'chooseTargets', id: q.id, targets: tg })) done = true;
        }
      }
      const opts = strategy === 'first' ? q.options : shuffled(rng, q.options);
      for (const o of opts) { if (done) break; const err = act(q.pid, { t: 'choose', id: q.id, value: o.value }); if (!err) done = true; else if (err.startsWith('exception')) exception = err; }
      if (!done) break;
      continue;
    }
    const peeker = g.players.find((p) => p.peek);
    if (peeker) {
      const pk = peeker.peek!;
      const ids = pk.iids.filter((i) => g.cards[i]?.zone === 'library');
      const r = { top: [] as string[], bottom: [] as string[], graveyard: [] as string[], hand: [] as string[], battlefield: [] as string[], exile: [] as string[], shuffle: false };
      if (pk.mode === 'search' && ids.length) r.hand.push(ids[0]);
      else for (const x of ids) (pk.mode === 'surveil' ? r.graveyard : r.top).push(x);
      const err = act(peeker.pid, { t: 'resolvePeek', ...r });
      if (err) { if (pk.mode === 'search') { const e2 = act(peeker.pid, { t: 'resolvePeek', top: [], bottom: [], graveyard: [], hand: [], battlefield: [], exile: [], shuffle: true }); if (e2) break; } else break; }
      continue;
    }
    if (!g.stack.some((s) => s.auto?.cardId === e.cardId)) break;
    const err = act(g.priority, { t: 'pass' });
    if (err) { if (err.startsWith('exception')) exception = err; break; }
  }
  close();
  chainProbe.onStep = undefined;
  chainProbe.onSkip = undefined;
  const logTail = g.log.slice(-12).map((l) => l.text).join(' / ');
  const misses: Miss[] = [];
  if (exception) misses.push({ cardId: e.cardId, entry: e.label, step: '-', missing: exception, log: logTail });
  if (!reached.has(keyOf(e.head)) && !g.winner) {
    const fizzled = /fizzles|countered/.test(logTail);
    if (!fizzled) misses.push({ cardId: e.cardId, entry: e.label, step: '(head)', missing: e.head.api, log: logTail });
  }
  if (g.pending.length || g.players.some((p) => p.peek)) return { misses, note: 'left a question unanswered' };
  if (g.winner) return { misses };
  for (const step of reachedSteps) {
    // A triggered ability's optional cost ("you may pay ... if you do") that was declined.
    if (step.kind === 'AB' && step.params.Cost && e.kind === 'trigger' && /doesn't|can't .* nothing happens/.test(logTail)) continue;
    const svars = step.svars ?? face.svars;
    const c = continuations(step, svars);
    if (step.api === 'ImmediateTrigger' && skipped.has(keyOf(step))) c.all = c.all.filter((sv) => sv === step.params.SubAbility);
    const reachedSvar = (sv: string) => { const ab = parseAbility(svars[sv], svars, face.name); return !!ab && reached.has(keyOf(ab)); };
    for (const sv of c.all) if (!reachedSvar(sv)) misses.push({ cardId: e.cardId, entry: e.label, step: step.api, missing: sv, log: logTail });
    if (c.one.length && !c.one.some(reachedSvar) && !/condition not met|rolls|by hand/.test(logTail)) {
      misses.push({ cardId: e.cardId, entry: e.label, step: step.api, missing: c.one.join('|'), log: logTail });
    }
  }
  // Steps that did nothing in every run are reported by chainAudit (noops).
  return { misses, noops: noop.filter((st) => !effective.has(keyOf(st))).map(keyOf) };
}

export function chainAudit(cardIds: string[] = CUBE.cards.map((c) => c.id), verbose = false): { entries: number; misses: Miss[]; notes: string[]; noops: string[] } {
  const misses: Miss[] = [];
  const notes: string[] = [];
  const noopList: string[] = [];
  let entries = 0;
  for (const id of cardIds) {
    const face0 = getScript(id);
    if (!face0) continue;
    for (const e of entriesOf(id)) {
      if (!multiStep(e, face0[e.face].svars)) continue;
      entries++;
      // Several runs (seeds / answer strategies): a miss in any run is reported once.
      const seen = new Set<string>();
      let noops: Set<string> | undefined;
      for (const [seed, strat] of [[1, 'first'], [2, 'random'], [3, 'random']] as const) {
        const res = runEntry(e, seed, strat);
        if (res.note && verbose) notes.push(`${id} ${e.label}: ${res.note}`);
        for (const m of res.misses) { const k = `${m.entry}|${m.step}|${m.missing}`; if (!seen.has(k)) { seen.add(k); misses.push(m); } }
        if (res.noops) noops = noops ? new Set(res.noops.filter((x) => noops!.has(x))) : new Set(res.noops);
      }
      for (const k of noops ?? []) if (!/^(Cleanup|_Remember|Effect|Pump|ChooseCard|StoreSVar|ChooseType|ChooseColor|ChoosePlayer)\|/.test(k)) noopList.push(`${id} ${e.label}: ${k.slice(0, 220)}`);
    }
  }
  return { entries, misses, notes, noops: noopList };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const verbose = process.argv.includes('--verbose');
  const ids = arg('cards')?.split(',');
  const { entries, misses, notes, noops } = chainAudit(ids, verbose);
  for (const n of notes) console.log(`note: ${n}`);
  if (verbose) for (const n of noops) console.log(`noop: ${n}`);
  for (const m of misses) console.log(`MISS ${m.cardId} ${m.entry}: ${m.step} -> ${m.missing}\n     ${m.log.slice(0, 600)}`);
  console.log(`Chains audited: ${entries}; stopped partway: ${misses.length}`);
  process.exit(misses.length ? 1 : 0);
}
