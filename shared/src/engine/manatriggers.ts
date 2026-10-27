/**
 * Mana-ability triggers (Forge T: Mode$ TapsForMana with Static$ True): High Tide, Mana Flare, Heartbeat of Spring,
 * Mirari's Wake, Nissa, Utopia Sprawl, Wild Growth, Fertile Ground, Badgermole Cub. They resolve immediately (no
 * stack), as the permanent is tapped for mana: mana.ts activateMana() calls manaTapped(). Also emits the 'tapped'
 * event for "whenever ... becomes tapped" triggers (Magda).
 */
import { cardName, faceOf } from '../game/rules.ts';
import { type Ctx, emit, log, randomId } from '../game/state.ts';
import type { CardInstance, GameState } from '../game/types.ts';
import { getScript, parseAbility, parseParams, scriptFaceOf } from './script.ts';
import { matchCard, matchPlayer, type MatchEnv } from './targets.ts';

const COLOR: Record<string, string> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G', W: 'W', U: 'U', B: 'B', R: 'R', G: 'G' };

interface Host { iid: string; controller: string; name: string; attachedTo?: string; chosenColor?: string; svars: Record<string, string>; line: string }

function hosts(state: GameState): Host[] {
  const out: Host[] = [];
  for (const iid of state.battlefield) {
    const c = state.cards[iid];
    if (!c || c.faceDown) continue;
    const f = scriptFaceOf(c);
    for (const line of f?.triggers ?? []) {
      if (/Mode\$ TapsForMana/.test(line) && /Static\$ True/.test(line)) out.push({ iid, controller: c.controller, name: f!.name, attachedTo: c.attachedTo, chosenColor: c.chosen?.color, svars: f!.svars, line });
    }
  }
  for (const e of state.effects ?? []) {
    if (e.kind !== 'effect' || !e.triggers.length) continue;
    const f = getScript(e.cardId)?.[e.face];
    for (const name of e.triggers) {
      const line = f?.svars[name];
      if (line && /Mode\$ TapsForMana/.test(line)) out.push({ iid: `effect:${e.id}`, controller: e.controller, name: e.name, svars: f!.svars, line });
    }
  }
  return out;
}

function addMana(state: GameState, pid: string, sym: string, n: number) {
  const p = state.players.find((x) => x.pid === pid);
  if (p) p.manaPool[sym] = (p.manaPool[sym] ?? 0) + n;
}

/** A permanent `iid` was just tapped for mana by `pid`, producing `produced` ("G", "CC"). */
export function manaTapped(state: GameState, ctx: Ctx, pid: string, iid: string, produced: string) {
  const c: CardInstance | undefined = state.cards[iid];
  if (!c) return;
  emit(state, { t: 'tapped', iid, forMana: produced, pid });
  for (const h of hosts(state)) {
    const p = parseParams(h.line).params;
    const env: MatchEnv = { controller: h.controller, sourceIid: h.iid, lookup: ctx.lookup, attachedTo: h.attachedTo ?? '' };
    if (p.ValidCard && matchCard(c, p.ValidCard, env) !== true) continue;
    if (p.Activator && matchPlayer(pid, p.Activator, env) !== true) continue;
    const chainLine = p.Execute ? h.svars[p.Execute] : undefined;
    const ab = chainLine ? parseAbility(chainLine, h.svars, h.name) : undefined;
    if (!ab) continue;
    const q = ab.params;
    const who = q.Defined === 'TriggeredCardController' ? c.controller : q.Defined === 'You' ? h.controller : pid;
    const n = parseInt(q.Amount ?? '1', 10) || 1;
    let sym: string | undefined;
    if (ab.api === 'ManaReflected') {
      const kinds = [...new Set(produced.split(''))];
      if (kinds.length === 1) sym = kinds[0];
      else { askColor(state, ctx, who, n, kinds, h.name); continue; }
    } else if (ab.api === 'Mana') {
      const pr = (q.Produced ?? '').trim();
      if (pr === 'Chosen') sym = COLOR[h.chosenColor ?? ''] ?? undefined;
      else if (pr === 'Any') { askColor(state, ctx, who, n, ['W', 'U', 'B', 'R', 'G'], h.name); continue; }
      else if (/^[WUBRGC]$/.test(pr)) sym = pr;
    }
    if (!sym) continue;
    addMana(state, who, sym, n);
    log(state, ctx, who, `${state.players.find((x) => x.pid === who)?.name ?? 'Someone'} adds an additional ${`{${sym}}`.repeat(n)} (${h.name}, ${cardName(c, ctx.lookup)} tapped for mana).`);
  }
}

/** "One mana of any color": the player picks (answered by resolve.ts's 'color' question). */
function askColor(state: GameState, ctx: Ctx, pid: string, n: number, colors: string[], source: string) {
  state.pending.push({
    id: randomId(ctx.rng), pid, prompt: `${source}: add ${n} additional mana of any ${colors.length === 5 ? 'color' : 'type that land produced'}`,
    options: colors.map((s) => ({ value: s, label: `{${s}}` })), data: { kind: 'color', n } as unknown as Record<string, unknown>,
  });
}

/** Creatures that became tapped attacking (Magda's "whenever a Dwarf you control becomes tapped"). */
export function noteTapped(state: GameState, iid: string, pid: string) {
  emit(state, { t: 'tapped', iid, pid });
  void faceOf;
}
