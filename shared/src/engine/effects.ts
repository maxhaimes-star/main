/**
 * Forge "Effect": creates an effect object in the command zone (an EffectRecord in state.effects) with static
 * abilities (StaticAbilities$, applied by statics.ts like a permanent's), triggered abilities (Triggers$, detected by
 * triggers.ts like a permanent's) and remembered objects (RememberObjects$). Emblems (Name$ "Emblem — ...") are
 * permanent effects; others last until end of turn / your next turn / as long as the host or remembered card stays.
 *
 * "You may play that card" (MayPlay statics: impulse draw, Ragavan, Hostage Taker ...) is a permission: the table
 * already lets players cast from exile, so the effect is recorded and shown, and the cast itself is by the player.
 * Replacement effects (ReplacementEffects$) are not automated.
 */
import { cardName } from '../game/rules.ts';
import { type Ctx, log, randomId } from '../game/state.ts';
import type { CardInstance, GameState, Zone } from '../game/types.ts';
import type { StepApi } from './ext.ts';
import { getScript, grantedLines, parseParams, SUPPORTED_DEFINED } from './script.ts';
import { parseStatic, staticGaps } from './statics.ts';
import { SUPPORTED_MODES } from './triggers.ts';
import type { EffectDuration, EffectRecord, ParsedAbility } from './types.ts';

const DURATIONS: Record<string, EffectDuration> = {
  UntilEndOfTurn: 'eot', Permanent: 'permanent', UntilHostLeavesPlay: 'hostLeaves', UntilYourNextTurn: 'yourNextTurn', UntilEndOfCombat: 'endOfCombat',
  UntilYourNextEndStep: 'yourNextEndStep', UntilTheEndOfYourNextTurn: 'endOfYourNextTurn', AsLongAsInPlay: 'permanent',
};
const ZONES: Record<string, Zone> = { Battlefield: 'battlefield', Exile: 'exile', Graveyard: 'graveyard', Hand: 'hand', Library: 'library' };

/** "You may play / cast that card" statics (MayPlay$ True): a permission the players use by hand. */
const isPermission = (params: Record<string, string>) => params.MayPlay === 'True';
/** RememberObjects$ values beyond SUPPORTED_DEFINED. */
const REMEMBER_ALIASES: Record<string, string> = { RememberedCard: 'Remembered', RememberedLKI: 'Remembered' };

const list = (v: string | undefined, sep: string | RegExp = ',') => (v ? v.split(sep).map((x) => x.trim()).filter(Boolean) : []);

/** Why this Effect step can't be automated (null = it can). */
export function effectUnsupported(step: ParsedAbility): string | null {
  const p = step.params;
  const sv = step.svars ?? {};
  if (p.ReplacementEffects) return 'Effect (replacement)';
  if (p.Duration && !DURATIONS[p.Duration]) return `Effect (Duration$ ${p.Duration})`;
  for (const v of list(p.RememberObjects, '&')) if (!SUPPORTED_DEFINED.has(v) && v !== 'Self' && !REMEMBER_ALIASES[v] && v !== 'RememberedOwner') return `Effect (RememberObjects$ ${v})`;
  if (p.ForgetOnMoved && !ZONES[p.ForgetOnMoved]) return 'Effect (ForgetOnMoved)';
  if (p.ExileOnMoved && !ZONES[p.ExileOnMoved]) return 'Effect (ExileOnMoved)';
  const statics = list(p.StaticAbilities);
  const triggers = list(p.Triggers);
  if (!statics.length && !triggers.length) return 'Effect';
  for (const name of statics) {
    const line = sv[name];
    if (!line) return `Effect (missing SVar ${name})`;
    const st = parseStatic(line, sv);
    if (isPermission(st.params)) continue;
    // Remembered objects are known for effects; everything else must be fully handled by statics.ts.
    const gaps = staticGaps(st).filter((g) => !(/^Affected\$/.test(g) && /Remembered/.test(g)) && !/^Protection\/Ward/.test(g));
    if (gaps.length) return `Effect (static ${st.modes.join(',') || '?'}: ${gaps[0]})`;
  }
  for (const name of triggers) {
    const line = sv[name];
    if (!line) return `Effect (missing SVar ${name})`;
    const mode = parseParams(line).params.Mode;
    if (!SUPPORTED_MODES.has(mode)) return `Effect (trigger ${mode})`;
  }
  return null;
}

/** Create the effect. */
export function execEffect(state: GameState, ctx: Ctx, step: ParsedAbility, api: StepApi) {
  const p = step.params;
  const auto = api.auto;
  const f = getScript(auto.cardId)?.[auto.face];
  const owner = p.EffectOwner ? api.defined(p.EffectOwner)?.players[0] ?? api.controller : api.controller;
  const until = DURATIONS[p.Duration ?? 'UntilEndOfTurn'] ?? 'eot';
  const remembered: string[] = [];
  for (const v of list(p.RememberObjects, '&')) {
    if (v === 'RememberedOwner') { for (const x of api.remembered()) { const o = state.cards[x]?.owner; if (o) remembered.push(o); } continue; }
    const d = v === 'Self' ? { cards: api.sourceIid ? [api.sourceIid] : [], players: [] } : api.defined(REMEMBER_ALIASES[v] ?? v);
    if (d) remembered.push(...d.cards, ...d.players);
  }
  const name = p.Name ?? f?.name ?? api.sourceName;
  const emblem = /^Emblem\b/.test(name);
  if (p.Stackable === 'False' && (state.effects ?? []).some((e) => e.kind === 'effect' && e.name === name && e.controller === owner)) {
    log(state, ctx, owner, `${name}: already in effect.`);
    return;
  }
  const watch = p.ForgetOnMoved ?? p.ExileOnMoved ?? (p.Duration === 'AsLongAsInPlay' ? 'Battlefield' : undefined);
  const text = (step.description && step.description !== 'Effect' ? step.description : '') || name;
  const rec: EffectRecord = {
    kind: 'effect', id: randomId(ctx.rng), controller: owner, until, cardId: auto.cardId, face: auto.face, name, text,
    statics: list(p.StaticAbilities), triggers: list(p.Triggers), remembered: [...new Set(remembered)], turn: state.turn,
  };
  if (emblem) rec.emblem = true;
  if (p.Image) rec.image = p.Image;
  if (watch && ZONES[watch]) rec.watchZone = ZONES[watch];
  if (until === 'hostLeaves') {
    if (!api.sourceIid || state.cards[api.sourceIid]?.zone !== 'battlefield') { log(state, ctx, owner, `${api.sourceName} already left the battlefield — the effect ends at once.`); return; }
    rec.hostIid = api.sourceIid;
  }
  if (rec.watchZone) {
    const cards = rec.remembered.filter((x) => !state.players.some((pl) => pl.pid === x));
    if (cards.length && !cards.some((x) => state.cards[x]?.zone === rec.watchZone)) { log(state, ctx, owner, `${name}: the card is gone — no effect.`); return; }
  }
  (state.effects ??= []).push(rec);
  const who = state.players.find((x) => x.pid === owner)?.name ?? 'Someone';
  const span = until === 'eot' ? ' (this turn)' : until === 'yourNextTurn' ? ' (until your next turn)' : until === 'hostLeaves' ? ` (while ${api.sourceName} remains)` : '';
  if (emblem) log(state, ctx, owner, `${who} gets an emblem: ${name}${text !== name ? ` — ${text}` : ''}.`);
  else log(state, ctx, owner, `${api.sourceName}: ${text}${span}.`);
  const mayPlay = rec.statics.some((s) => f?.svars[s] && isPermission(parseStatic(f.svars[s]).params));
  if (mayPlay) {
    const cards = rec.remembered.filter((x) => state.cards[x]);
    log(state, ctx, owner, `${who} may play ${cards.length ? cards.map((x) => cardName(state.cards[x], ctx.lookup)).join(', ') : 'those cards'} — cast / play ${cards.length === 1 ? 'it' : 'them'} from ${cards[0] ? state.cards[cards[0]].zone : 'exile'} (any special cost terms by hand).`);
  }
}

/** Effect records in the command zone (emblems first), for the UI. */
export function activeEffects(state: { effects?: import('./types.ts').TimedEffect[] }): EffectRecord[] {
  const list = (state.effects ?? []).filter((e): e is EffectRecord => e.kind === 'effect');
  return [...list.filter((e) => e.emblem), ...list.filter((e) => !e.emblem)];
}

// ------------------------------------------------------------------ triggers (triggers.ts)

/** Effect objects with triggered abilities, as trigger hosts. */
export function extraTriggerHosts(state: GameState): { c: CardInstance; face: number; id: string; lki: false; effect: { name: string; triggers: { index: number; params: Record<string, string> }[] } }[] {
  const out = [];
  for (const e of state.effects ?? []) {
    if (e.kind !== 'effect' || !e.triggers.length) continue;
    const f = getScript(e.cardId)?.[e.face];
    if (!f) continue;
    const triggers = e.triggers.filter((n) => f.svars[n]).map((n, k) => ({ index: 900 + k, params: parseParams(f.svars[n]).params }));
    const c: CardInstance = {
      iid: `effect:${e.id}`, cardId: e.cardId, owner: e.controller, controller: e.controller, zone: 'command', tapped: false, faceDown: false,
      transformed: e.face === 1, counters: {}, damage: 0, tempPT: [0, 0], permPT: [0, 0], summoningSick: false, noUntap: false, revealedTo: [],
    };
    out.push({ c, face: e.face, id: e.cardId, lki: false as const, effect: { name: e.name, triggers } });
  }
  return out;
}

/** Triggered abilities granted to a permanent by animate effects (Raging Ravine's attack trigger). */
export function grantedTriggers(c: CardInstance): { index: number; params: Record<string, string>; ref: { cardId: string; face: number } }[] {
  return grantedLines(c, 'triggers').map((g, k) => ({ index: 500 + k, params: parseParams(g.line).params, ref: { cardId: g.cardId, face: g.face } }));
}

// ------------------------------------------------------------------ durations

function end(state: GameState, ctx: Ctx, gone: (e: EffectRecord) => boolean) {
  if (!state.effects?.length) return;
  const ended: EffectRecord[] = [];
  state.effects = state.effects.filter((e) => {
    if (e.kind !== 'effect' || !gone(e)) return true;
    ended.push(e);
    return false;
  });
  for (const e of ended) if (e.until !== 'eot') log(state, ctx, null, `Effect ends: ${e.name}${e.text !== e.name ? ` (${e.text})` : ''}.`);
}

export function effectsAtCleanup(state: GameState, ctx: Ctx) {
  end(state, ctx, (e) => e.until === 'eot' || e.until === 'endOfCombat'
    || (e.until === 'yourNextEndStep' && state.activePlayer === e.controller)
    || (e.until === 'endOfYourNextTurn' && state.activePlayer === e.controller && state.turn > e.turn));
}

export function effectsAtTurnStart(state: GameState, ctx: Ctx, pid: string) {
  end(state, ctx, (e) => e.until === 'yourNextTurn' && e.controller === pid && state.turn > e.turn);
}

/** Host left the battlefield / a remembered card left the zone the effect watches. */
export function effectsAfterMove(state: GameState, ctx: Ctx, inst: CardInstance, from: Zone, to: Zone) {
  if (!state.effects?.length || from === to) return;
  const lost = new Set<string>();
  for (const e of state.effects) {
    if (e.kind !== 'effect' || !e.watchZone || from !== e.watchZone || !e.remembered.includes(inst.iid)) continue;
    e.remembered = e.remembered.filter((x) => x !== inst.iid);
    lost.add(e.id);
  }
  const isPlayer = (x: string) => state.players.some((p) => p.pid === x);
  end(state, ctx, (e) => (e.until === 'hostLeaves' && e.hostIid === inst.iid && from === 'battlefield')
    || (lost.has(e.id) && e.remembered.every(isPlayer)));
}
