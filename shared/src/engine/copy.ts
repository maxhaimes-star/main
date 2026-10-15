/**
 * Copy effects and "as it enters, choose ..." (Forge CopyPermanent, Clone, ChooseType, ChooseColor, NameCard,
 * ChoosePlayer, and the K:ETBReplacement keyword that runs them as the permanent enters).
 *
 * - Token copies (Kiki-Jiki, Splinter Twin, Fable's Reflection, Pack Rat ...): a token with the copied card's id (or
 *   the copied token's data) plus copyExtra exceptions (haste, extra types, set P/T). Copiable values only: the
 *   source's own copy effect is copied, its animations are not.
 * - "Enters as a copy" / "becomes a copy" (Phyrexian Metamorph, Saheeli, Thespian-like): copyOf / copyToken /
 *   copyFace / copyExtra on the instance; faceOf() shows the copied face and scriptRef() makes the engine use the
 *   copied card's abilities, triggers and statics. Cleared when it leaves the battlefield.
 * - Choices are stored on the permanent (CardInstance.chosen) and read by statics (ChosenType, NamedCard ...).
 *
 * ETB replacements are asked as Pending questions after the permanent is on the battlefield; its "enters the
 * battlefield" event is held back until the answer, so ETB triggers see the copied card.
 */
import cubeJson from '../../data/cube.json' with { type: 'json' };
import type { CardData, Color, TokenData } from '../cards.ts';
import { cardName, faceOf } from '../game/rules.ts';
import { type Ctx, emit, log, moveHooks, randomId } from '../game/state.ts';
import type { CardInstance, GameEvent, GameState, StackItem, Zone } from '../game/types.ts';
import type { StepApi } from './ext.ts';
import './replacements.ts'; // installs moveHooks.before first; the ETB-replacement hook below wraps it
import { createTokenInstance, resumeAuto } from './resolve.ts';
import { tokenMultiplier } from './replacements.ts';
import { amountSupported, getScript, SUPPORTED_DEFINED } from './script.ts';
import { MORE_DEFINED } from './more-support.ts';
import { matchCard } from './targets.ts';
import type { AutoCont, CopyExtra, ParsedAbility, Pending } from './types.ts';

const CUBE_CARDS = (cubeJson as unknown as { cards: CardData[] }).cards;
const COLORS = ['White', 'Blue', 'Black', 'Red', 'Green'];

const list = (v: string | undefined, sep: string | RegExp = /[,&]/) => (v ? v.split(sep).map((x) => x.trim()).filter(Boolean) : []);

// ------------------------------------------------------------------ support

const COPY_PERMANENT_KEYS = new Set([
  'Defined', 'ValidTgts', 'TgtPrompt', 'TgtZone', 'TargetMin', 'TargetMax', 'AddKeywords', 'AddTypes', 'AtEOT', 'NumCopies', 'Controller', 'SetPower', 'SetToughness',
  'NonLegendary', 'SpellDescription', 'StackDescription', 'Cost', 'SubAbility', 'AILogic', 'Planeswalker', 'Ultimate', 'Condition', 'ConditionPresent',
  'ConditionCompare', 'ConditionDefined', 'ConditionCheckSVar', 'ConditionSVarCompare', 'ConditionDescription', 'ActivationLimit', 'SorcerySpeed',
  'UnlessCost', 'UnlessPayer', 'UnlessSwitched', 'UnlessResolveSubs', 'RememberLKI',
]);
const CLONE_KEYS = new Set([
  'Choices', 'ChoiceZone', 'ChoiceTitle', 'AddTypes', 'SetPower', 'SetToughness', 'NewName', 'AddKeywords', 'CloneTarget', 'Defined', 'ValidTgts', 'TgtPrompt',
  'Duration', 'SpellDescription', 'StackDescription', 'Cost', 'SubAbility', 'AILogic', 'Optional', 'ConditionPresent', 'ConditionCompare', 'ConditionDefined',
  'RememberCloneOrigin', 'Planeswalker', 'Ultimate',
]);
const NAME_VALID = new Set(['Card', 'Card.nonLand', 'Creature', 'Card.Creature', 'Artifact', 'Card.Artifact']);

function definedOk(v: string): boolean {
  return SUPPORTED_DEFINED.has(v) || MORE_DEFINED.has(v) || /^Valid [A-Za-z.+,!]+$/.test(v) || /^Targeted\.[!A-Za-z.+]+$/.test(v);
}

/** Why a copy / choose step can't be automated (null = it can). */
export function copyUnsupported(step: ParsedAbility): string | null {
  const p = step.params;
  const sv = step.svars;
  switch (step.api) {
    case 'CopyPermanent': {
      const extra = Object.keys(p).find((k) => !COPY_PERMANENT_KEYS.has(k));
      if (extra) return `CopyPermanent (${extra})`;
      if (p.AtEOT && !['Sacrifice', 'Exile'].includes(p.AtEOT)) return 'CopyPermanent (AtEOT)';
      if (p.Defined && !definedOk(p.Defined)) return `CopyPermanent (Defined$ ${p.Defined})`;
      if (p.Controller && !definedOk(p.Controller)) return `CopyPermanent (Controller$ ${p.Controller})`;
      for (const k of ['NumCopies', 'SetPower', 'SetToughness']) if (!amountSupported(p[k], sv)) return `CopyPermanent (${k}$ ${p[k]})`;
      return null;
    }
    case 'Clone': {
      const extra = Object.keys(p).find((k) => !CLONE_KEYS.has(k));
      if (extra) return `Clone (${extra})`;
      if (p.ChoiceZone && !['Battlefield', 'Graveyard'].includes(p.ChoiceZone)) return 'Clone (ChoiceZone)';
      if (p.Duration && p.Duration !== 'UntilEndOfTurn') return `Clone (Duration$ ${p.Duration})`;
      if (p.CloneTarget && !['Self', 'ParentTarget', 'Targeted', 'Remembered'].includes(p.CloneTarget)) return `Clone (CloneTarget$ ${p.CloneTarget})`;
      if (!p.Choices && !p.ValidTgts && !(p.Defined && definedOk(p.Defined))) return 'Clone (what to copy)';
      for (const k of ['SetPower', 'SetToughness']) if (!amountSupported(p[k], sv)) return `Clone (${k}$ ${p[k]})`;
      return null;
    }
    case 'ChooseType': return p.Type === 'Creature' && (!p.Defined || p.Defined === 'You') ? null : `ChooseType (${p.Type ?? '?'})`;
    case 'ChooseColor': return !p.Defined || p.Defined === 'You' ? null : 'ChooseColor (Defined)';
    case 'NameCard': return (!p.Defined || p.Defined === 'You') && (!p.ValidCards || NAME_VALID.has(p.ValidCards)) && !p.Draft && !p.ChooseFromList ? null : 'NameCard';
    case 'ChoosePlayer': return (!p.Defined || p.Defined === 'You') && ['Player', 'Player.Opponent', undefined].includes(p.Choices) ? null : 'ChoosePlayer';
  }
  return step.api;
}

// ------------------------------------------------------------------ copiable values

function mergeExtra(a: CopyExtra | undefined, b: CopyExtra): CopyExtra | undefined {
  const out: CopyExtra = { ...(a ?? {}) };
  delete out.until;
  if (b.name) out.name = b.name;
  if (b.addTypes?.length) out.addTypes = [...new Set([...(out.addTypes ?? []), ...b.addTypes])];
  if (b.keywords?.length) out.keywords = [...new Set([...(out.keywords ?? []), ...b.keywords])];
  if (b.power != null) out.power = b.power;
  if (b.toughness != null) out.toughness = b.toughness;
  if (b.nonLegendary) out.nonLegendary = true;
  if (b.until) out.until = b.until;
  return Object.keys(out).length ? out : undefined;
}

function extraOf(p: Record<string, string>, api: StepApi): CopyExtra {
  const x: CopyExtra = {};
  const types = list(p.AddTypes);
  if (types.length) x.addTypes = types;
  const kws = list(p.AddKeywords, '&');
  if (kws.length) x.keywords = kws;
  if (p.SetPower != null) { const n = api.amount(p.SetPower, 0); if (n != null) x.power = n; }
  if (p.SetToughness != null) { const n = api.amount(p.SetToughness, 0); if (n != null) x.toughness = n; }
  if (p.NewName) x.name = p.NewName;
  if (p.NonLegendary === 'True') x.nonLegendary = true;
  return x;
}

/** Make `target` a copy of `src` (copiable values: printed card / token + src's own copy effect) plus `extra`. */
export function becomeCopy(target: CardInstance, src: CardInstance, extra: CopyExtra, lookup: Parameters<typeof faceOf>[1]) {
  const onBf = src.zone === 'battlefield';
  if (onBf && src.copyToken) { target.copyToken = src.copyToken; target.copyOf = undefined; }
  else if (onBf && src.copyOf) { target.copyOf = src.copyOf; target.copyToken = undefined; }
  else if (!src.cardId && src.token) { target.copyToken = src.token; target.copyOf = undefined; }
  else { target.copyOf = src.cardId; target.copyToken = undefined; }
  target.copyFace = onBf ? (src.copyOf ? src.copyFace : src.transformed ? 1 : undefined) : undefined;
  if (target.copyFace == null) delete target.copyFace;
  target.copyExtra = mergeExtra(onBf ? src.copyExtra : undefined, extra);
  if (!target.copyExtra) delete target.copyExtra;
  const f = faceOf(target, lookup);
  if (f.loyalty && target.counters.loyalty == null) target.counters.loyalty = parseInt(f.loyalty, 10) || 0;
}

/** Create a token that's a copy of `src` (any zone: printed values; battlefield: its copiable values). */
export function tokenCopy(state: GameState, ctx: Ctx, owner: string, src: CardInstance, extra: CopyExtra): CardInstance {
  const onBf = src.zone === 'battlefield';
  const base: CardInstance = { ...src, animations: undefined, copyExtra: onBf ? src.copyExtra : undefined, copyOf: onBf ? src.copyOf : undefined, copyToken: onBf ? src.copyToken : undefined };
  const f = faceOf(base, ctx.lookup);
  const tokenOnly = onBf && src.copyToken ? src.copyToken : !src.cardId && src.token ? src.token : undefined;
  const cardId = tokenOnly ? undefined : (onBf ? src.copyOf : undefined) ?? src.cardId;
  const data: TokenData = tokenOnly ?? { name: f.name, typeLine: f.typeLine, colors: (f.colors ?? []) as Color[], oracle: f.oracle, keywords: f.keywords, power: f.power, toughness: f.toughness };
  const inst = createTokenInstance(state, ctx, owner, data, false, cardId);
  inst.transformed = cardId ? (onBf && src.copyOf ? src.copyFace === 1 : src.transformed) : false;
  const x = mergeExtra(onBf ? src.copyExtra : undefined, extra);
  if (x) inst.copyExtra = x;
  const lf = faceOf(inst, ctx.lookup);
  if (lf.loyalty) inst.counters.loyalty = parseInt(lf.loyalty, 10) || 0;
  return inst;
}

/** It left the battlefield: copy effects and choices end. */
export function copyLeft(inst: CardInstance) {
  delete inst.copyOf; delete inst.copyToken; delete inst.copyFace; delete inst.copyExtra; delete inst.chosen;
}

/** Cleanup: "becomes a copy until end of turn" (Saheeli) ends. */
export function copyAtCleanup(state: GameState) {
  for (const iid of state.battlefield) { const c = state.cards[iid]; if (c?.copyExtra?.until === 'eot') copyLeft(c); }
}

// ------------------------------------------------------------------ steps

interface ChooseData { kind: 'ext'; sub: 'clone' | 'type' | 'color' | 'name' | 'player'; holder: string; extra?: CopyExtra; cont: AutoCont; label: string }

function ask(state: GameState, ctx: Ctx, pid: string, prompt: string, options: { value: string; label: string }[], data: ChooseData) {
  const pend: Pending = { id: randomId(ctx.rng), pid, prompt, options, data: data as unknown as Record<string, unknown> };
  state.pending.push(pend);
}

export function execCopyStep(state: GameState, ctx: Ctx, step: ParsedAbility, api: StepApi): 'ok' | 'wait' {
  const p = step.params;
  switch (step.api) {
    case 'CopyPermanent': {
      const o = api.objects('Self');
      const n = api.amount(p.NumCopies, 1);
      const owners = p.Controller ? api.defined(p.Controller)?.players ?? [] : [api.controller];
      if (!o || n == null || !owners.length) { if (!o || n == null) api.manual(); return 'ok'; }
      const extra = extraOf(p, api);
      const made: string[] = [];
      for (const iid of o.cards) {
        const src = state.cards[iid];
        if (!src || src.faceDown) continue;
        for (const owner of owners) {
          const count = n * tokenMultiplier(state, ctx, owner);
          for (let k = 0; k < count; k++) made.push(tokenCopy(state, ctx, owner, src, extra).iid);
          const bits = [extra.keywords?.length ? `with ${extra.keywords.join(', ').toLowerCase()}` : '', extra.addTypes?.length ? `(also ${extra.addTypes.join(' ')})` : ''].filter(Boolean).join(' ');
          const who = state.players.find((x) => x.pid === owner)?.name ?? 'Someone';
          log(state, ctx, owner, `${who} creates ${count === 1 ? 'a token copy' : `${count} token copies`} of ${cardName(src, ctx.lookup)}${bits ? ` ${bits}` : ''}.`);
        }
      }
      api.remember(made);
      if (p.AtEOT && made.length) {
        const dest = p.AtEOT === 'Sacrifice' ? 'Graveyard' : 'Exile';
        const verb = p.AtEOT === 'Sacrifice' ? 'sacrifice' : 'exile';
        api.delayed('end', `DB$ ChangeZone | Defined$ DelayTriggerRemembered | Origin$ Battlefield | Destination$ ${dest} | SpellDescription$ ${verb === 'sacrifice' ? 'Sacrifice' : 'Exile'} the token${made.length === 1 ? '' : 's'}.`, made, `${verb} the token${made.length === 1 ? '' : 's'} at the beginning of the next end step`);
      }
      return 'ok';
    }
    case 'Clone': {
      const holder = p.CloneTarget ? api.defined(p.CloneTarget)?.cards[0] : api.sourceIid;
      const target = holder ? state.cards[holder] : undefined;
      if (!target || target.zone !== 'battlefield') { log(state, ctx, api.controller, `${api.sourceName}: nothing becomes a copy.`); return 'ok'; }
      const extra = extraOf(p, api);
      if (p.Duration === 'UntilEndOfTurn') extra.until = 'eot';
      if (p.Choices) {
        const zone = (p.ChoiceZone ?? 'Battlefield').toLowerCase() as Zone;
        const pool = zone === 'battlefield' ? state.battlefield : state.players.flatMap((pl) => pl.zones[zone as 'graveyard'] ?? []);
        const env = { ...api.env, sourceIid: target.iid };
        const cands = pool.filter((x) => x !== target.iid && state.cards[x] && matchCard(state.cards[x], p.Choices, env) === true);
        const optional = p.Optional === 'True' || api.auto.extra?.optional === '1';
        if (!cands.length) { log(state, ctx, api.controller, `${api.sourceName}: nothing to copy.`); return 'ok'; }
        const options = cands.map((x) => ({ value: x, label: cardName(state.cards[x], ctx.lookup) }));
        if (optional) options.push({ value: 'none', label: "Don't copy" });
        const entering = api.auto.extra?.etb === '1';
        ask(state, ctx, api.controller, `${api.sourceName}: ${entering ? 'enter as a copy of' : 'become a copy of'} which permanent?`, options, { kind: 'ext', sub: 'clone', holder: target.iid, extra, cont: api.cont(), label: api.sourceName });
        return 'wait';
      }
      const o = p.ValidTgts ? api.objects('Self') : api.defined(p.Defined);
      const src = o?.cards.map((x) => state.cards[x]).find((c) => c && c.iid !== target.iid);
      if (!src) { log(state, ctx, api.controller, `${api.sourceName}: nothing to copy.`); return 'ok'; }
      const before = cardName(target, ctx.lookup);
      becomeCopy(target, src, extra, ctx.lookup);
      log(state, ctx, api.controller, `${before} becomes a copy of ${cardName(src, ctx.lookup)}${extra.until ? ' until end of turn' : ''}.`);
      return 'ok';
    }
    case 'ChooseType': case 'ChooseColor': case 'NameCard': case 'ChoosePlayer': {
      const holder = api.sourceIid && state.cards[api.sourceIid] ? api.sourceIid : undefined;
      if (!holder) { api.manual(); return 'ok'; }
      const base = { kind: 'ext' as const, holder, cont: api.cont(), label: api.sourceName };
      if (step.api === 'ChooseType') {
        ask(state, ctx, api.controller, `${api.sourceName}: choose a creature type`, creatureTypeOptions(state, api.controller, ctx), { ...base, sub: 'type' });
        return 'wait';
      }
      if (step.api === 'ChooseColor') {
        const allowed = p.Choices ? list(p.Choices).filter((c) => COLORS.includes(c)) : COLORS;
        ask(state, ctx, api.controller, `${api.sourceName}: choose a color`, allowed.map((c) => ({ value: c, label: c })), { ...base, sub: 'color' });
        return 'wait';
      }
      if (step.api === 'NameCard') {
        ask(state, ctx, api.controller, `${api.sourceName}: choose a ${p.ValidDescription ? `${p.ValidDescription} ` : ''}card name`, nameOptions(state, ctx, api.controller, p.ValidCards), { ...base, sub: 'name' });
        return 'wait';
      }
      const players = state.players.filter((pl) => !pl.conceded && (p.Choices !== 'Player.Opponent' || pl.pid !== api.controller));
      if (!players.length) return 'ok';
      if (p.Random === 'True') {
        const pick = players[Math.floor(ctx.rng() * players.length)];
        setChosen(state, ctx, holder, 'player', pick.pid, api.controller);
        return 'ok';
      }
      ask(state, ctx, api.controller, `${api.sourceName}: choose ${p.Choices === 'Player.Opponent' ? 'an opponent' : 'a player'}`, players.map((pl) => ({ value: pl.pid, label: pl.name })), { ...base, sub: 'player' });
      return 'wait';
    }
  }
  api.manual();
  return 'ok';
}

/** Creature types: those on the battlefield (opponents' first), then every type in the cube. */
function creatureTypeOptions(state: GameState, me: string, ctx: Ctx): { value: string; label: string }[] {
  const seen: string[] = [];
  const add = (t: string) => { if (/^[A-Z][a-z'-]+$/.test(t) && !seen.includes(t)) seen.push(t); };
  const fromLine = (line: string) => { const [left, right] = line.split(/\s+[—-]\s+/); if (right && /Creature|Kindred|Tribal/.test(left)) right.split(/\s+/).forEach(add); };
  const bf = [...state.battlefield].sort((a, b) => Number(state.cards[a].controller === me) - Number(state.cards[b].controller === me));
  for (const iid of bf) { const c = state.cards[iid]; if (!c.faceDown) fromLine(faceOf(c, ctx.lookup).typeLine); }
  const rest: string[] = [];
  for (const card of CUBE_CARDS) if (card.types.includes('Creature') || card.types.includes('Kindred') || card.types.includes('Tribal')) for (const s of card.subtypes) if (!seen.includes(s) && !rest.includes(s)) rest.push(s);
  for (const t of ['Human', 'Elf', 'Goblin', 'Zombie', 'Spirit', 'Soldier', 'Wizard', 'Warrior', 'Knight', 'Dragon', 'Angel', 'Elemental', 'Merfolk', 'Vampire', 'Beast', 'Construct', 'Faerie', 'Saproling', 'Thopter', 'Treefolk', 'Sliver', 'Rat', 'Squirrel', 'Bird', 'Cat', 'Dog', 'Insect', 'Phyrexian', 'Eldrazi', 'Rogue', 'Cleric', 'Shaman', 'Druid', 'Pirate', 'Dinosaur', 'Ninja', 'Samurai', 'Giant', 'Demon', 'Horror', 'Wall', 'Golem', 'Myr', 'Servo', 'Illusion']) if (!seen.includes(t) && !rest.includes(t)) rest.push(t);
  return [...seen, ...rest.sort()].map((t) => ({ value: t, label: t }));
}

/** Card names: opponents' permanents first, then every cube card matching `valid`. */
function nameOptions(state: GameState, ctx: Ctx, me: string, valid: string | undefined): { value: string; label: string }[] {
  const ok = (types: string[]) => {
    if (!valid || valid === 'Card') return true;
    if (valid === 'Card.nonLand') return !types.includes('Land');
    if (/Creature/.test(valid)) return types.includes('Creature');
    if (/Artifact/.test(valid)) return types.includes('Artifact');
    return true;
  };
  const seen: string[] = [];
  for (const iid of state.battlefield) {
    const c = state.cards[iid];
    if (c.faceDown || c.controller === me) continue;
    const f = faceOf(c, ctx.lookup);
    if (ok(f.types) && !seen.includes(f.name)) seen.push(f.name);
  }
  const rest = CUBE_CARDS.filter((c) => ok(c.types) && !seen.includes(c.name)).map((c) => c.name).sort();
  return [...seen, ...[...new Set(rest)]].map((n) => ({ value: n, label: n }));
}

function setChosen(state: GameState, ctx: Ctx, holder: string, what: 'type' | 'color' | 'name' | 'player', value: string, pid: string) {
  const c = state.cards[holder];
  if (!c) return;
  c.chosen = { ...(c.chosen ?? {}), [what]: value };
  const shown = what === 'player' ? state.players.find((p) => p.pid === value)?.name ?? value : value;
  const who = state.players.find((p) => p.pid === pid)?.name ?? 'Someone';
  log(state, ctx, pid, `${who} chooses ${shown} for ${cardName(c, ctx.lookup)}.`);
}

/** Answer a copy / choose Pending. undefined = not ours. */
export function answerCopyPending(state: GameState, ctx: Ctx, pend: Pending, value: string): string | null | undefined {
  const d = pend.data as unknown as ChooseData;
  if (d.kind !== 'ext') return undefined;
  if (d.sub === 'clone') {
    const target = state.cards[d.holder];
    const src = state.cards[value];
    if (value === 'none' || !src) log(state, ctx, pend.pid, `${d.label}: no copy.`);
    else if (target?.zone === 'battlefield') {
      const before = cardName(target, ctx.lookup);
      becomeCopy(target, src, d.extra ?? {}, ctx.lookup);
      const entering = d.cont.item.auto?.extra?.etb === '1';
      log(state, ctx, pend.pid, `${before} ${entering ? 'enters as' : 'becomes'} a copy of ${cardName(src, ctx.lookup)}${d.extra?.until ? ' until end of turn' : ''}.`);
    }
  } else setChosen(state, ctx, d.holder, d.sub, value, pend.pid);
  resumeAuto(state, ctx, d.cont);
  releaseEtbEvent(state, d.cont.item);
  return null;
}

// ------------------------------------------------------------------ "as it enters" (K:ETBReplacement)

/** K:ETBReplacement:Copy|Other:<SVar>[:Optional] of a card about to enter. */
function etbReplacementsOf(c: CardInstance): { svar: string; optional: boolean }[] {
  if (!c.cardId || c.faceDown) return [];
  const f = getScript(c.cardId)?.[c.transformed ? 1 : 0];
  const out: { svar: string; optional: boolean }[] = [];
  for (const k of f?.keywords ?? []) {
    const m = /^ETBReplacement:(Copy|Other):(\w+)(:Optional)?/.exec(k);
    if (m && f!.svars[m[2]]) out.push({ svar: m[2], optional: !!m[3] });
  }
  return out;
}

/** Put back the held "enters the battlefield" event (for trigger detection) once the choice is made. */
function releaseEtbEvent(state: GameState, item: StackItem) {
  const json = item.auto?.extra?.etbEvent;
  if (!json || state.pending.some((p) => (p.data as unknown as ChooseData).kind === 'ext' && (p.data as unknown as ChooseData).cont?.item.id === item.id)) return;
  emit(state, JSON.parse(json) as GameEvent);
}

function runEtb(state: GameState, ctx: Ctx, iid: string, controller: string, r: { svar: string; optional: boolean }) {
  const inst = state.cards[iid];
  if (!inst?.cardId || inst.zone !== 'battlefield') return;
  const evs = state.events ?? [];
  let k = -1;
  for (let j = evs.length - 1; j >= 0; j--) { const e = evs[j]; if (e.t === 'zone' && e.iid === iid && e.to === 'battlefield') { k = j; break; } }
  const extra: Record<string, string> = { etb: '1' };
  if (r.optional) extra.optional = '1';
  if (k >= 0) extra.etbEvent = JSON.stringify(evs.splice(k, 1)[0]);
  const item: StackItem = {
    id: randomId(ctx.rng), kind: 'trigger', sourceIid: iid, controller, text: `${cardName(inst, ctx.lookup)}: as it enters`,
    auto: { cardId: inst.cardId, face: inst.transformed ? 1 : 0, source: 'trigger', index: -1, svar: r.svar, targets: [], extra },
  };
  resumeAuto(state, ctx, { item, next: 0, targets: [], lki: {}, remembered: [] });
  releaseEtbEvent(state, item);
}

const previousBefore = moveHooks.before;
moveHooks.before = (state, ctx, iid, to, opts) => {
  const r = previousBefore?.(state, ctx, iid, to, opts);
  const c = state.cards[iid];
  if (!c || to !== 'battlefield' || c.zone === 'battlefield' || (r && r.to !== 'battlefield') || opts.faceDown) return r;
  const etb = etbReplacementsOf(c);
  if (!etb.length) return r;
  const o = r?.opts ?? opts;
  const controller = o.controller ?? c.controller;
  return {
    to: 'battlefield', opts: o,
    after: () => {
      r?.after?.();
      runEtb(state, ctx, iid, controller, etb[0]);
      if (etb.length > 1) log(state, ctx, controller, `${cardName(c, ctx.lookup)}: another "as it enters" choice — handle it by hand.`);
    },
  };
};
