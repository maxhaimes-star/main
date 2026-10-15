import { useCallback, useEffect, useRef, useState } from 'react';
import { faceOf, isHidden, type GameAction, type GameView, type Step } from '@ojb/shared';
import * as Shared from '@ojb/shared';
import { getCard } from '../cards.tsx';
import { castability, isStrict, safeActivated } from './engine.ts';

// ------------------------------------------------------------ persisted settings (Arena-style auto-pass / full control / auto-yield)

export interface AutoSettings { autoPass: boolean; fullControl: boolean; yields: string[]; sidePanel: boolean }
const KEY = 'ojb:autoSettings';
const DEFAULTS: AutoSettings = { autoPass: false, fullControl: false, yields: [], sidePanel: true };

function load(): AutoSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && typeof raw === 'object') return { ...DEFAULTS, ...raw, yields: Array.isArray(raw.yields) ? raw.yields.filter((x: unknown) => typeof x === 'string') : [] };
  } catch { /* ignore */ }
  return DEFAULTS;
}

export function useAutoSettings() {
  const [s, setS] = useState<AutoSettings>(load);
  const update = useCallback((patch: Partial<AutoSettings> | ((s: AutoSettings) => Partial<AutoSettings>)) => {
    setS((cur) => {
      const next = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  return [s, update] as const;
}

// ------------------------------------------------------------ "can I do anything?"

const shared = Shared as unknown as Record<string, unknown>;

/** True when I might have a meaningful response (castable card / usable ability). Unknown counts as "yes". */
export function canRespond(g: GameView, me: string): boolean {
  try {
    const p = g.players.find((x) => x.pid === me);
    if (!p) return true;
    for (const iid of p.zones.hand) {
      const c = g.cards[iid];
      if (!c || isHidden(c)) continue;
      const types = faceOf(c, getCard).types;
      const u = castability(g, me, iid);
      if (u) { if (u.ok && !types.includes('Land')) return true; continue; }
      if (!types.includes('Land')) return true; // not strict: cannot tell
    }
    const usable = shared.abilityUsability as ((...a: unknown[]) => { ok: boolean }) | undefined;
    for (const iid of g.battlefield) {
      const c = g.cards[iid];
      if (!c || isHidden(c) || c.controller !== me || c.faceDown || !c.cardId) continue;
      for (const e of safeActivated(c.cardId, c.transformed ? 1 : 0)) {
        if (!isStrict(g) || !usable) return true;
        const r = usable(g, me, iid, e.index, getCard);
        if (r?.ok) return true;
      }
    }
    return false;
  } catch { return true; }
}

export function sourceName(g: GameView, s: GameView['stack'][number]): string | undefined {
  const iid = s.sourceIid ?? s.iid;
  const c = iid ? g.cards[iid] : undefined;
  return c && !isHidden(c) ? faceOf(c, getCard).name : undefined;
}

/** Source name of the trigger/ability on top of the stack (for auto-yield). */
export function topYieldName(g: GameView): string | undefined {
  const top = g.stack[g.stack.length - 1];
  if (!top || top.kind === 'spell') return undefined;
  return sourceName(g, top);
}

const QUIET_STEPS: Step[] = ['upkeep', 'draw', 'beginCombat', 'endCombat', 'end'];

/** Sends 'pass' for me when Arena would skip the stop. At most once per (seq, priority). */
export function useAutoPass(opts: {
  g: GameView; me: string | null; act: (a: GameAction) => Promise<string | null>; settings: AutoSettings; busy: boolean; controlled: boolean;
}) {
  const { g, me, act, settings, busy, controlled } = opts;
  const last = useRef('');
  useEffect(() => {
    if (!me || busy || controlled || settings.fullControl) return;
    if (g.phase !== 'playing' || g.priority !== me) return;
    if (g.pending?.length) return;
    const key = `${g.seq}:${g.priority}`;
    if (last.current === key) return;
    let why = '';
    const top = g.stack[g.stack.length - 1];
    if (top) {
      const yn = topYieldName(g);
      if (yn && settings.yields.includes(yn)) why = 'yield';
      else if (settings.autoPass && top.controller !== me && !canRespond(g, me)) why = 'nothing to respond with';
    } else if (settings.autoPass && QUIET_STEPS.includes(g.step) && !canRespond(g, me)) why = 'quiet step';
    if (!why) return;
    const t = setTimeout(() => { last.current = key; void act({ t: 'pass' }); }, 200);
    return () => clearTimeout(t);
  }, [g, me, act, settings, busy, controlled]);
}
