/**
 * Extension effects (one dispatch point from resolve.ts / script.ts / durations.ts):
 *  - Animate / AnimateAll ............ engine/animate.ts
 *  - Effect (emblems, "this turn" rules, "you may play that card") ... engine/effects.ts
 *  - CopyPermanent / Clone, ChooseType / ChooseColor / NameCard / ChoosePlayer, ETB replacements ... engine/copy.ts
 */
import type { Ctx } from '../game/state.ts';
import type { CardInstance, GameState, StackItem, Step, Zone } from '../game/types.ts';
import { animateAtCleanup, animateAtTurnStart, animateLeft, animateUnsupported, execAnimate } from './animate.ts';
import { answerCopyPending, copyAtCleanup, copyLeft, copyUnsupported, execCopyStep } from './copy.ts';
import { effectsAtCleanup, effectsAtTurnStart, effectsAfterMove, effectUnsupported, execEffect } from './effects.ts';
import type { MatchEnv } from './targets.ts';
import type { AutoCont, AutoInfo, ParsedAbility, Pending } from './types.ts';

export const EXT_APIS = new Set(['Animate', 'AnimateAll', 'Effect', 'CopyPermanent', 'Clone', 'ChooseType', 'ChooseColor', 'NameCard', 'ChoosePlayer']);

/** What an extension step can use from the running resolution (built by resolve.ts). */
export interface StepApi {
  controller: string;
  sourceIid?: string;
  sourceName: string;
  item: StackItem;
  auto: AutoInfo;
  /** The step's own targets, else Defined$, else the default. */
  objects(dflt: 'You' | 'Self'): { cards: string[]; players: string[] } | undefined;
  /** A Defined$-style value ("You", "Targeted", "TriggeredCard", "Valid Creature.YouCtrl" ...). */
  defined(value: string | undefined): { cards: string[]; players: string[] } | undefined;
  amount(raw: string | undefined, dflt: number): number | undefined;
  /** Remember these objects when the step has Remember* params. */
  remember(iids: string[]): void;
  /** Objects the resolution remembered so far. */
  remembered(): string[];
  /** Continuation: resume at the next step. */
  cont(): AutoCont;
  /** "At the beginning of the next end step, <line>" for these cards (DelayTriggerRemembered). */
  delayed(at: Step, line: string, iids: string[], text: string): void;
  env: MatchEnv;
  /** Log "Not automated: ..." for this step. */
  manual(): void;
}

/** Why an extension step can't be automated (null = it can). */
export function extUnsupported(step: ParsedAbility): string | null {
  switch (step.api) {
    case 'Animate': case 'AnimateAll': return animateUnsupported(step);
    case 'Effect': return effectUnsupported(step);
    default: return copyUnsupported(step);
  }
}

/** Defined$ values extension steps understand beyond SUPPORTED_DEFINED. */
export function extDefinedOk(v: string): boolean {
  return /^Valid [A-Za-z.+,!]+$/.test(v) || v === 'TriggeredCardLKICopy' || v === 'Remembered' || v === 'Self';
}

/** Execute an extension step: 'wait' when it asked a question (Pending) and resumes later. */
export function execExtStep(state: GameState, ctx: Ctx, step: ParsedAbility, api: StepApi): 'ok' | 'wait' {
  switch (step.api) {
    case 'Animate': case 'AnimateAll': execAnimate(state, ctx, step, api); return 'ok';
    case 'Effect': execEffect(state, ctx, step, api); return 'ok';
    default: return execCopyStep(state, ctx, step, api);
  }
}

/** Answer an extension Pending (Clone / choose type / color / name / player). undefined = not ours. */
export function answerExtPending(state: GameState, ctx: Ctx, pend: Pending, value: string): string | null | undefined {
  return answerCopyPending(state, ctx, pend, value);
}

// ------------------------------------------------------------------ duration hooks (durations.ts)

/** Cleanup step: "until end of turn" animations / copies / effects end. */
export function extAtCleanup(state: GameState, ctx: Ctx) {
  animateAtCleanup(state, ctx);
  copyAtCleanup(state);
  effectsAtCleanup(state, ctx);
}

/** Start of `pid`'s turn: their "until your next turn" animations / effects end. */
export function extAtTurnStart(state: GameState, ctx: Ctx, pid: string) {
  animateAtTurnStart(state, ctx, pid);
  effectsAtTurnStart(state, ctx, pid);
}

/** After a card moved (moveCard). */
export function extAfterMove(state: GameState, ctx: Ctx, inst: CardInstance, from: Zone, to: Zone) {
  if (from === 'battlefield' && to !== 'battlefield') {
    copyLeft(inst);
    animateLeft(state, ctx, inst);
  }
  effectsAfterMove(state, ctx, inst, from, to);
}
