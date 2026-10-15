/**
 * Runtime side of keyword-granted abilities (see keywords.ts for how they are synthesized):
 * activation zone / timing checks, Crew and Ninjutsu costs, the custom effect APIs (Unattach, Crew,
 * Ninjutsu), Ward reminders and level-up helpers.
 */
import { cardName, effectivePT, hasKeyword, isCreature } from '../game/rules.ts';
import { type Ctx, log, moveCard, player, randomId } from '../game/state.ts';
import type { CardInstance, GameState, StackItem } from '../game/types.ts';
import { levelStats, type LevelStats, wardCost } from './keywords.ts';
import { scriptFaceOf } from './script.ts';
import { type ParsedAbility, type Pending, SYNTH_BASE, type TargetRef } from './types.ts';

const ZONE_WORD: Record<string, string> = { hand: 'hand', graveyard: 'graveyard', exile: 'exile', battlefield: 'the battlefield' };

function pname(state: GameState, pid: string): string {
  return state.players.find((p) => p.pid === pid)?.name ?? 'someone';
}

function crewCandidates(state: GameState, ctx: Ctx, pid: string, vehicle: string): string[] {
  return state.battlefield.filter((id) => {
    const c = state.cards[id];
    return id !== vehicle && c.controller === pid && !c.tapped && isCreature(c, ctx.lookup);
  });
}

const powerOf = (state: GameState, ctx: Ctx, iid: string) => Math.max(0, effectivePT(state.cards[iid], ctx.lookup)[0]);

/**
 * Checks before an engine activation pays anything: the source is in its activation zone (ActivationZone$,
 * default battlefield), synthesized sorcery-speed keywords (Equip, Level up, Reconfigure) are at sorcery speed,
 * and keyword-specific requirements (Crew power, Ninjutsu timing). Returns an error or null.
 */
export function checkActivation(state: GameState, ctx: Ctx, pid: string, c: CardInstance, ab: ParsedAbility, index: number, targets: TargetRef[][]): string | null {
  const p = ab.params;
  const src = cardName(c, ctx.lookup);
  const zone = (p.ActivationZone ?? 'Battlefield').trim().toLowerCase();
  if (c.zone !== zone) return `${src}: this ability can only be activated while it's in ${zone === 'battlefield' ? 'play' : `your ${ZONE_WORD[zone] ?? zone}`}`;
  if (zone !== 'battlefield' && c.owner !== pid) return `${src} isn't yours`;
  if (index >= SYNTH_BASE && p.SorcerySpeed === 'True') {
    const main = state.step === 'main1' || state.step === 'main2';
    if (state.activePlayer !== pid || !main || state.stack.length) return `${p.Keyword ?? 'This ability'}: only as a sorcery (your main phase, empty stack)`;
  }
  switch (ab.api) {
    case 'Unattach':
      if (!c.attachedTo) return `${src} isn't attached to anything`;
      break;
    case 'Crew': {
      const need = parseInt(p.CrewPower ?? '1', 10) || 1;
      const total = crewCandidates(state, ctx, pid, c.iid).reduce((n, id) => n + powerOf(state, ctx, id), 0);
      if (total < need) return `Crew ${need}: you need untapped creatures with total power ${need} or more`;
      break;
    }
    case 'Ninjutsu': {
      if (!state.combat.blockersDeclared) return 'Ninjutsu: only after blockers are declared';
      const ref = targets[0]?.[0];
      const att = ref?.kind === 'card' ? state.cards[ref.iid] : undefined;
      if (!att || att.zone !== 'battlefield' || !att.attacking || att.controller !== pid) return 'Ninjutsu: choose an attacking creature you control';
      if (state.battlefield.some((id) => state.cards[id].blocking === att.iid)) return 'Ninjutsu: that creature is blocked';
      break;
    }
  }
  return null;
}

/** After the ability is on the stack: costs that need choices (Crew), Ninjutsu's return cost, Ward reminders. */
export function afterActivation(state: GameState, ctx: Ctx, pid: string, c: CardInstance, ab: ParsedAbility, item: StackItem) {
  const auto = item.auto;
  if (ab.api === 'Ninjutsu' && auto) {
    const ref = auto.targets[0]?.[0];
    const att = ref?.kind === 'card' ? state.cards[ref.iid] : undefined;
    if (att) {
      auto.extra = { ...(auto.extra ?? {}), attacking: att.attacking ?? '' };
      const nm = cardName(att, ctx.lookup);
      moveCard(state, ctx, att.iid, 'hand');
      log(state, ctx, pid, `${pname(state, pid)} returns ${nm} to hand (ninjutsu cost).`);
    }
    // The returned creature was a cost, not a target: nothing to check on resolution.
    auto.targets = [];
    auto.targetZones = {};
    return;
  }
  if (ab.api === 'Crew') {
    const need = parseInt(ab.params.CrewPower ?? '1', 10) || 1;
    crewPending(state, ctx, { kind: 'crew', pid, vehicle: c.iid, stackId: item.id, need, got: 0, tapped: [] });
    return;
  }
  if (auto) wardReminders(state, ctx, pid, auto.targets);
}

// ------------------------------------------------------------------ crew

interface CrewData { kind: 'crew'; pid: string; vehicle: string; stackId: string; need: number; got: number; tapped: string[] }

function crewPending(state: GameState, ctx: Ctx, d: CrewData): boolean {
  const cands = crewCandidates(state, ctx, d.pid, d.vehicle);
  if (!cands.length) return false;
  const vname = state.cards[d.vehicle] ? cardName(state.cards[d.vehicle], ctx.lookup) : 'the Vehicle';
  const pending: Pending = {
    id: randomId(ctx.rng), pid: d.pid,
    prompt: `Crew ${d.need} — tap a creature to crew ${vname}${d.got ? ` (power so far: ${d.got})` : ''}`,
    options: [
      ...cands.map((iid) => ({ value: iid, label: `${cardName(state.cards[iid], ctx.lookup)} (power ${powerOf(state, ctx, iid)})` })),
      { value: 'cancel', label: 'Cancel (untap them, remove the ability)' },
    ],
    data: d as unknown as Record<string, unknown>,
  };
  state.pending.push(pending);
  return true;
}

function cancelCrew(state: GameState, ctx: Ctx, d: CrewData) {
  for (const iid of d.tapped) if (state.cards[iid]?.zone === 'battlefield') state.cards[iid].tapped = false;
  state.stack = state.stack.filter((s) => s.id !== d.stackId);
  log(state, ctx, d.pid, `${pname(state, d.pid)} doesn't crew — the ability is removed.`);
}

/** Answer a keyword Pending (Crew). Returns undefined when the pending isn't one of ours. */
export function answerKeywordPending(state: GameState, ctx: Ctx, pend: Pending, value: string): string | null | undefined {
  const d = pend.data as unknown as CrewData;
  if (d.kind !== 'crew') return undefined;
  if (value === 'cancel') { cancelCrew(state, ctx, d); return null; }
  const c = state.cards[value];
  if (!c || c.zone !== 'battlefield' || c.tapped) { crewPending(state, ctx, d); return null; }
  c.tapped = true;
  const next: CrewData = { ...d, got: d.got + powerOf(state, ctx, value), tapped: [...d.tapped, value] };
  if (next.got >= next.need) {
    const v = state.cards[d.vehicle];
    log(state, ctx, d.pid, `${pname(state, d.pid)} crews ${v ? cardName(v, ctx.lookup) : 'the Vehicle'} with ${next.tapped.map((i) => cardName(state.cards[i], ctx.lookup)).join(', ')}.`);
    return null;
  }
  if (!crewPending(state, ctx, next)) cancelCrew(state, ctx, next);
  return null;
}

// ------------------------------------------------------------------ effects

interface RunInfo { controller: string; sourceIid?: string; sourceName: string; item: StackItem }

/** Execute a keyword-only effect step (KEYWORD_APIS). */
export function execKeywordStep(state: GameState, ctx: Ctx, step: ParsedAbility, r: RunInfo): void {
  const src = r.sourceIid ? state.cards[r.sourceIid] : undefined;
  switch (step.api) {
    case 'Unattach': {
      if (!src || src.zone !== 'battlefield') return;
      src.attachedTo = undefined;
      log(state, ctx, r.controller, `${r.sourceName} is unattached${isCreature(src, ctx.lookup) ? ' and is a creature again' : ''}.`);
      return;
    }
    case 'Crew': {
      if (!src || src.zone !== 'battlefield') return;
      src.tempKeywords = [...new Set([...(src.tempKeywords ?? []), 'Crewed'])];
      const [pw, t] = effectivePT(src, ctx.lookup);
      log(state, ctx, r.controller, `${r.sourceName} becomes an artifact creature until end of turn (${pw}/${t}).`);
      return;
    }
    case 'Ninjutsu': {
      if (!src || src.zone !== 'hand' || src.owner !== r.controller) { log(state, ctx, r.controller, `${r.sourceName}: no longer in hand — ninjutsu does nothing.`); return; }
      moveCard(state, ctx, src.iid, 'battlefield', { tapped: true, controller: r.controller });
      const target = r.item.auto?.extra?.attacking;
      const ok = !!target && (state.players.some((p) => p.pid === target && !p.conceded) || state.cards[target]?.zone === 'battlefield');
      const entered = state.cards[src.iid]?.zone === 'battlefield';
      if (ok && entered) src.attacking = target;
      log(state, ctx, r.controller, `${cardName(src, ctx.lookup)} enters tapped${ok ? ' and attacking' : ''} (ninjutsu).`);
      return;
    }
  }
}

// ------------------------------------------------------------------ ward

/** Log a Ward reminder for each opponent's permanent with ward that `pid` just targeted. */
export function wardReminders(state: GameState, ctx: Ctx, pid: string, targets: TargetRef[][]) {
  for (const ref of targets.flat()) {
    if (ref.kind !== 'card') continue;
    const c = state.cards[ref.iid];
    if (!c || c.zone !== 'battlefield' || c.controller === pid || c.faceDown) continue;
    const f = scriptFaceOf(c);
    const cost = f ? wardCost(f) : undefined;
    if (!cost && !hasKeyword(c, ctx.lookup, 'Ward')) continue;
    log(state, ctx, c.controller, `Ward — ${cardName(c, ctx.lookup)} was targeted: counter that spell or ability unless ${pname(state, pid)} pays ${cost ?? 'the ward cost'} (handle by hand).`);
  }
}

// ------------------------------------------------------------------ level up

export function levelOf(inst: CardInstance): number {
  return inst.counters.level ?? 0;
}

/** Level-dependent P/T and keywords of a leveler on the battlefield (undefined = base card / not a leveler). */
export function levelStatsOf(inst: CardInstance): LevelStats | undefined {
  if (inst.faceDown) return undefined;
  const f = scriptFaceOf(inst);
  if (!f || !f.keywords.some((k) => k.startsWith('Level up'))) return undefined;
  return levelStats(f, levelOf(inst));
}

