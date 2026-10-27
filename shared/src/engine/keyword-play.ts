/**
 * Runtime side of keyword-granted abilities (see keywords.ts for how they are synthesized):
 * activation zone / timing checks, Crew and Ninjutsu costs, the custom effect APIs (Unattach, Crew,
 * Ninjutsu), Ward triggers / "becomes the target" events and level-up helpers.
 */
import { cardName, effectivePT, faceOf, hasKeyword, isCreature } from '../game/rules.ts';
import { type Ctx, emit, log, moveCard, player, randomId } from '../game/state.ts';
import type { CardInstance, GameState, StackItem } from '../game/types.ts';
import { levelStats, type LevelStats } from './keywords.ts';
import { faceDownWard } from './facedown.ts';
import { plotAction, saddle, station, warpExile } from './newmech.ts';
import { getScript, parseParams, scriptFaceOf } from './script.ts';
import { canPayMana, payMana } from './paycost.ts';
import { type AutoInfo, type ParsedAbility, type Pending, SYNTH_BASE, type TargetRef } from './types.ts';

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
      const what = p.Saddle === 'True' ? 'Saddle' : 'Crew';
      if (total < need) return `${what} ${need}: you need ${what === 'Saddle' ? 'other ' : ''}untapped creatures with total power ${need} or more`;
      break;
    }
    case '_Station':
      if (!crewCandidates(state, ctx, pid, c.iid).length) return 'Station: you need another untapped creature';
      break;
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
/**
 * Special actions activated like abilities but not using the stack (foretell). undefined = not one; else an error or null.
 * The card's name isn't logged (a foretold card stays hidden from the opponent).
 */
export function specialAction(state: GameState, ctx: Ctx, pid: string, c: CardInstance, ab: ParsedAbility): string | null | undefined {
  if (ab.api === '_Unlock') return unlockDoor(state, ctx, pid, c, ab);
  if (ab.api === '_Plot') return plotAction(state, ctx, pid, c, ab); // engine/newmech.ts
  if (ab.api !== '_Foretell') return undefined;
  if (state.activePlayer !== pid) return 'You can foretell only during your turn';
  if (c.zone !== 'hand' || c.owner !== pid) return 'Foretell: the card must be in your hand';
  if (!canPayMana(state, pid, '{2}', 0, ctx.lookup)) return 'Foretell: you need {2}';
  payMana(state, ctx, pid, '{2}');
  moveCard(state, ctx, c.iid, 'exile', { faceDown: true });
  (state.remembered ??= {})[`foretold|${c.iid}`] = [String(state.turn)];
  log(state, ctx, pid, `${pname(state, pid)} pays {2} and foretells a card (exiled face down).`);
  return null;
}

/** Rooms: unlock a door (a special action at sorcery speed: pay the door's mana cost). "When you unlock this door" triggers. */
function unlockDoor(state: GameState, ctx: Ctx, pid: string, c: CardInstance, ab: ParsedAbility): string | null {
  const door = parseInt(ab.params.Door ?? '-1', 10);
  if (!c.unlocked || c.zone !== 'battlefield' || c.controller !== pid) return 'Not a Room you control';
  if (c.unlocked.includes(door) || !c.cardId) return 'That door is already unlocked';
  const data = ctx.lookup(c.cardId);
  const cost = data?.faces?.[door]?.manaCost ?? '';
  if (!canPayMana(state, pid, cost, 0, ctx.lookup)) return `Unlock: you need ${cost}`;
  payMana(state, ctx, pid, cost);
  c.unlocked = [...c.unlocked, door].sort();
  const faces = getScript(c.cardId);
  const doorName = faces?.[door]?.name ?? 'a door';
  log(state, ctx, pid, `${pname(state, pid)} pays ${cost} and unlocks ${doorName}.`);
  // "When you unlock this door" (Mode$ UnlockDoor | ThisDoor$ True): queued, put on the stack after this action.
  faces?.[door]?.triggers.forEach((line, index) => {
    const p = parseParams(line).params;
    if (p.Mode !== 'UnlockDoor' || !p.Execute) return;
    const desc = (p.TriggerDescription ?? 'When you unlock this door').replace(/CARDNAME/g, doorName);
    (state.triggerQueue ??= []).push({
      id: randomId(ctx.rng), controller: pid, sourceIid: c.iid, sourceName: doorName, text: `${doorName}: ${desc}`,
      auto: { cardId: c.cardId!, face: door, source: 'trigger', index, svar: p.Execute, targets: [], trigger: { mode: 'UnlockDoor', card: c.iid, player: pid } },
    });
  });
  return null;
}

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
  if (ab.api === 'Crew' || ab.api === '_Station') {
    const need = ab.api === '_Station' ? 1 : parseInt(ab.params.CrewPower ?? '1', 10) || 1;
    const mode = ab.api === '_Station' ? 'station' as const : ab.params.Saddle === 'True' ? 'saddle' as const : undefined;
    crewPending(state, ctx, { kind: 'crew', pid, vehicle: c.iid, stackId: item.id, need, got: 0, tapped: [], ...(mode ? { mode } : {}) });
    return;
  }
  if (auto) wardReminders(state, ctx, pid, auto.targets);
}

// ------------------------------------------------------------------ crew

/** Crew, Saddle (mode 'saddle') and Station (mode 'station': one creature, any power). */
interface CrewData { kind: 'crew'; pid: string; vehicle: string; stackId: string; need: number; got: number; tapped: string[]; mode?: 'saddle' | 'station' }

const CREW_WORD = { saddle: 'Saddle', station: 'Station' } as const;

function crewPending(state: GameState, ctx: Ctx, d: CrewData): boolean {
  const cands = crewCandidates(state, ctx, d.pid, d.vehicle);
  if (!cands.length) return false;
  const vname = state.cards[d.vehicle] ? cardName(state.cards[d.vehicle], ctx.lookup) : 'the Vehicle';
  const pending: Pending = {
    id: randomId(ctx.rng), pid: d.pid,
    prompt: d.mode === 'station' ? `Station — tap another creature to put charge counters equal to its power on ${vname}`
      : `${d.mode ? CREW_WORD[d.mode] : 'Crew'} ${d.need} — tap a creature to ${d.mode === 'saddle' ? 'saddle' : 'crew'} ${vname}${d.got ? ` (power so far: ${d.got})` : ''}`,
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
  log(state, ctx, d.pid, `${pname(state, d.pid)} doesn't ${d.mode ?? 'crew'} — the ability is removed.`);
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
  if (d.mode) {
    // Saddle / Station: remember who paid (SaddledThisTurn) / the tapped creature's power on the stack item.
    const item = state.stack.find((s) => s.id === d.stackId);
    if (d.mode === 'station' && item?.auto) {
      item.auto.extra = { ...(item.auto.extra ?? {}), power: String(next.got) };
      log(state, ctx, d.pid, `${pname(state, d.pid)} taps ${cardName(c, ctx.lookup)} (station, power ${next.got}).`);
      return null;
    }
    if (next.got >= next.need) {
      if (item?.auto) item.auto.extra = { ...(item.auto.extra ?? {}), saddlers: next.tapped.join(',') };
      const v = state.cards[d.vehicle];
      log(state, ctx, d.pid, `${pname(state, d.pid)} saddles ${v ? cardName(v, ctx.lookup) : 'the Mount'} with ${next.tapped.map((i) => cardName(state.cards[i], ctx.lookup)).join(', ')}.`);
      return null;
    }
  }
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
      if (step.params.Saddle === 'True') { saddle(state, ctx, r.controller, src, (r.item.auto?.extra?.saddlers ?? '').split(',').filter(Boolean)); return; }
      src.tempKeywords = [...new Set([...(src.tempKeywords ?? []), 'Crewed'])];
      const [pw, t] = effectivePT(src, ctx.lookup);
      log(state, ctx, r.controller, `${r.sourceName} becomes an artifact creature until end of turn (${pw}/${t}).`);
      return;
    }
    case '_Station': {
      if (!src || src.zone !== 'battlefield') return;
      station(state, ctx, r.controller, src, parseInt(r.item.auto?.extra?.power ?? '0', 10) || 0);
      return;
    }
    case '_WarpExile': warpExile(state, ctx, r.controller, r.sourceIid); return;
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

/** A permanent's ward cost as a Forge cost ("2", "PayLife<2>"), from its K:Ward line or a static granting it (Lavaspur Boots). */
export function wardForgeCost(state: GameState, c: CardInstance, lookup: Ctx['lookup']): string | undefined {
  if (c.faceDown) return faceDownWard(c) ? '2' : undefined; // disguise / cloak (engine/facedown.ts)
  const own = scriptFaceOf(c)?.keywords.find((k) => /^Ward:/.test(k));
  if (own) return own.slice(5).trim();
  if (!hasKeyword(c, lookup, 'Ward', state)) return undefined;
  for (const iid of state.battlefield) {
    const h = state.cards[iid];
    for (const line of scriptFaceOf(h)?.statics ?? []) {
      const m = /AddKeyword\$[^|]*Ward:([^&|]+)/.exec(line);
      if (!m) continue;
      if ((/AffectedDefined\$ Equipped|AffectedDefined\$ Enchanted/.test(line) && h.attachedTo === c.iid) || /AffectedDefined\$ Self/.test(line) && h.iid === c.iid) return m[1].trim();
    }
  }
  const m = /Ward[ —-]+\{(\d+)\}/.exec(faceOf(c, lookup).oracle);
  return m ? m[1] : '2';
}

/**
 * A spell / ability (the top stack item) controlled by `pid` was put on the stack with these targets: emit "becomes the
 * target" events (Bonecrusher Giant, Leovold ...) and queue Ward triggers ("counter it unless that player pays").
 */
export function wardReminders(state: GameState, ctx: Ctx, pid: string, targets: TargetRef[][]) {
  const item = [...state.stack].reverse().find((s) => s.controller === pid && s.auto?.targets === targets) ?? state.stack[state.stack.length - 1];
  if (!item) return;
  const seen = new Set<string>();
  for (const ref of targets.flat()) {
    const key = ref.kind === 'card' ? ref.iid : ref.kind === 'player' ? ref.pid : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    emit(state, { t: 'targeted', target: key, item: item.id, sourceIid: item.iid ?? item.sourceIid, spell: item.kind === 'spell', pid });
    if (ref.kind !== 'card') continue;
    const c = state.cards[ref.iid];
    if (!c || c.zone !== 'battlefield' || c.controller === pid || (c.faceDown && !faceDownWard(c))) continue;
    const cost = wardForgeCost(state, c, ctx.lookup);
    if (!cost) continue;
    const name = cardName(c, ctx.lookup);
    const text = /^\d+$/.test(cost) ? `{${cost}}` : cost.replace(/PayLife<(\d+)>/, '$1 life');
    const auto: AutoInfo = {
      cardId: c.cardId ?? '', face: c.transformed ? 1 : 0, source: 'trigger', index: -1, targets: [],
      line: `DB$ Counter | Defined$ TriggeredStackItem | UnlessCost$ ${cost} | UnlessPayer$ TriggeredActivator | SpellDescription$ Ward — counter it unless that player pays ${text}.`,
      trigger: { mode: 'BecomesTarget', card: c.iid, source: item.id, player: pid },
    };
    (state.triggerQueue ??= []).push({ id: randomId(ctx.rng), controller: c.controller, sourceIid: c.iid, sourceName: name, text: `${name}: Ward ${text} — counter ${item.text} unless ${pname(state, pid)} pays ${text}.`, auto, targetsChosen: true });
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

