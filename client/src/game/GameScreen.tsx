import { BotBadge } from '../BotControls.tsx';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import {
  type GameAction, type GameView, isHidden, faceOf, type MatchView, STEP_LABELS, STEPS, type Step, type TargetRef, type TargetSpec, type ViewPlayer, type Zone,
} from '@ojb/shared';
import type { RoomProps } from '../Room.tsx';
import { backFaceOf, CardBack, CardImage, cardFace, getCard, HoverPreview, setHoverZoom, setPreview, useHoverZoom } from '../cards.tsx';
import { isTouch, useLayout, useLongPress } from '../touch.ts';
import { hideSheet, showSheet } from '../sheet.tsx';
import { type AutoSettings, noteHoldClick, sourceName, useAutoPass, useAutoSettings, withHold } from './auto.ts';
import { Ctx, ContextMenu, clampedStyle, placeBeside, useClamped, describe, type GameCtx, type MenuItem, type Mode, Prompt, TableCard, useGame, ModesModal, OptionsModal, DivideModal, RevealedZone, type PickOption } from './ui.tsx';
import { castWithX, defaultAction as defaultActionImpl, menuFor as menuForImpl } from './actions.ts';
import { attackAllCandidates, isStrict as isStrictGame, autoPayPreview, castability, fixModeOn, fixRequest, landPlaysLeft, manualOk, pendingRevealed, castStatus, AUTO_LABEL, costNote, legalTarget, optionText, safeCastOptions, safeStatics } from './engine.ts';
import { MulliganOverlay, PeekModal, ProposalPrompt, Sideboarding, TokenModal, ZoneViewer } from './Modals.tsx';
import { ATTACH_PEEK, COMBAT_SHIFT, fitBoard, STACK_UNITS, TAPPED_UNITS, type BoardSpec, type RowFit } from './boardLayout.ts';

/** Actions never performed on behalf of a controlled player (see engine/turns.ts NEVER_ROUTED); also allowed while controlled. */
const FREE_ACTIONS = new Set<GameAction['t']>(['chat', 'concede', 'requestUndo', 'answerUndo', 'lookAtHand', 'setStops', 'mulligan', 'keep', 'bottom', 'requestFreeMulligan', 'answerFreeMulligan', 'propose', 'answerProposal', 'cancelProposal']);

type PromptState = { label: string; initial: string; numeric: boolean; resolve: (v: string | null) => void } | null;

/** Phase pips shown in the slim bar (Arena groups them). */
const PHASE_STEPS: Step[] = ['upkeep', 'draw', 'main1', 'beginCombat', 'attackers', 'blockers', 'damage', 'endCombat', 'main2', 'end'];
const COMBAT_STEPS: Step[] = ['beginCombat', 'attackers', 'blockers', 'damage', 'endCombat'];
/** Begin combat through end of combat: both battlefields and the combat steps of the phase bar show it. */
const inCombat = (g: GameView) => g.phase === 'playing' && COMBAT_STEPS.includes(g.step);

export function GameScreen({ view, send, match, onLeave }: RoomProps & { match: MatchView; onLeave?: () => void }) {
  const g = match.game;
  const name = (pid: string) => view.players.find((p) => p.id === pid)?.name ?? '?';

  if (match.winner) {
    return (
      <div className="center-msg big">
        <h2>{name(match.winner)} wins the match {match.wins[match.winner]}–{match.wins[match.players.find((p) => p !== match.winner)!]}!</h2>
        <p className="muted">GG. Head back to build, rematch, or play someone else.</p>
        {onLeave && <button className="primary" onClick={onLeave}>Back</button>}
      </div>
    );
  }
  if (match.sideboarding && match.decks && match.players.includes(view.me)) {
    const d = match.decks[view.me];
    const lastWinner = g?.winner;
    return (
      <div className="between-games">
        <h2>Game {match.gameNumber}: {lastWinner ? `${name(lastWinner)} wins` : 'draw'} · Match {match.wins[match.players[0]]}–{match.wins[match.players[1]]}</h2>
        <Sideboarding main={d.main} side={d.side} ready={match.readyForNext.includes(view.me)}
          onSave={(main) => send({ t: 'sideboard', matchId: match.id, main, side: [] })}
          onReady={() => send({ t: 'readyNext', matchId: match.id })} />
      </div>
    );
  }
  if (match.sideboarding) return <div className="center-msg">Players are sideboarding for game {match.gameNumber + 1}… {onLeave && <button onClick={onLeave}>Stop watching</button>}</div>;
  if (!g) return <div className="loading">Starting game…</div>;
  return <Table view={view} send={send} match={match} g={g} onLeave={onLeave} />;
}

function Table({ send, match, g, onLeave }: Pick<RoomProps, 'view' | 'send'> & { match: MatchView; g: GameView; onLeave?: () => void }) {
  const realMe = g.me;
  const cb = g.controlledBy?.active ? g.controlledBy : null;
  const controlling = !!cb && !!realMe && cb.by === realMe; // Mindslaver: I make this player's decisions
  const controlled = !!cb && !!realMe && cb.pid === realMe; // my turn is being controlled
  const [actAsOn, setActAsOn] = useState(true);
  const actAs = controlling && actAsOn ? cb!.pid : null;
  const me = actAs ?? realMe;
  const self = me ?? g.players[0].pid;
  const opp = g.players.find((p) => p.pid !== self)!.pid;
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[]; title?: string } | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [prompt, setPrompt] = useState<PromptState>(null);
  const [modes, setModes] = useState<{ label: string; options: { value: string; label: string }[]; min: number; max: number; resolve: (v: string[] | null) => void } | null>(null);
  const pickModes = useCallback((label: string, options: { value: string; label: string }[], min: number, max: number) => new Promise<string[] | null>((resolve) => setModes({ label, options, min, max, resolve })), []);
  const [picker, setPicker] = useState<{ title: string; options: PickOption[]; resolve: (v: string | null) => void } | null>(null);
  const pickOption = useCallback((title: string, options: PickOption[]) => new Promise<string | null>((resolve) => setPicker({ title, options, resolve })), []);
  const [dividing, setDividing] = useState<{ title: string; total: number | undefined; targets: { key: string; label: string }[]; validate: (d: Record<string, number>) => string | null; resolve: (v: Record<string, number> | null) => void } | null>(null);
  const divide = useCallback((title: string, total: number | undefined, targets: { key: string; label: string }[], validate: (d: Record<string, number>) => string | null) => new Promise<Record<string, number> | null>((resolve) => setDividing({ title, total, targets, validate, resolve })), []);
  const [zone, setZone] = useState<{ pid: string; zone: 'graveyard' | 'exile' | 'sideboard' | 'command' | 'hand' } | null>(null);
  const [tokens, setTokens] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [hoverTargets, setHoverTargets] = useState<string[]>([]);
  const [payPreview, setPayPreview] = useState<string[]>([]);
  const [auto, setAuto] = useAutoSettings();
  const layout = useLayout();
  const phone = layout !== 'desktop';
  const [logOpen, setLogOpen] = useState(false);
  const lastTap = useRef<{ iid: string; t: number } | null>(null);
  const [hintGone, setHintGone] = useState(() => { try { return localStorage.getItem('ojb:rotateHint') === '0'; } catch { return false; } });
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toast = useCallback((msg: string) => { setToastMsg(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToastMsg(null), 2200); }, []);

  const [forceAsk, setForceAsk] = useState<{ error: string; resolve: (yes: boolean) => void } | null>(null);
  const holdRef = useRef(auto.hold);
  holdRef.current = auto.hold;
  const rawAct = useCallback(async (action: GameAction): Promise<string | null> => {
    if (controlled && !FREE_ACTIONS.has(action.t)) return `${g.players.find((p) => p.pid === cb!.by)?.name ?? 'Someone'} controls your turn`;
    const a = actAs && !FREE_ACTIONS.has(action.t) && !action.as ? { ...action, as: actAs } as GameAction : action;
    return send({ t: 'game', matchId: match.id, action: a }) as Promise<string | null>;
  }, [send, match.id, actAs, controlled, cb, g.players]);
  // Static restrictions (Teferi, Ensnaring Bridge ...) come back as errors mentioning "force": offer to override.
  const act = useCallback(async (action0: GameAction): Promise<string | null> => {
    const action = withHold(action0, { hold: holdRef.current }); // hold priority: toggle or Ctrl/Cmd-click
    const err = await rawAct(action);
    if (err && /force/i.test(err) && (action.t === 'cast' || action.t === 'activate' || action.t === 'declareAttacker' || action.t === 'declareBlocker') && !(action as { force?: boolean }).force) {
      const msg = err.replace(/\s*\((?:cast with|use) force to override\)\.?/i, '').replace(/[.\s]+$/, '');
      const yes = await new Promise<boolean>((resolve) => setForceAsk({ error: msg, resolve }));
      if (!yes) return err;
      return rawAct({ ...action, force: true } as GameAction);
    }
    return err;
  }, [rawAct]);
  const askText = useCallback((label: string, dflt = '') => new Promise<string | null>((resolve) => setPrompt({ label, initial: dflt, numeric: false, resolve })), []);
  const ask = useCallback((label: string, dflt = 1) => new Promise<number | null>((resolve) => setPrompt({
    label, initial: String(dflt), numeric: true, resolve: (v) => resolve(v == null || v === '' || Number.isNaN(Number(v)) ? null : Math.trunc(Number(v))),
  })), []);
  const openMenu = useCallback((x: number, y: number, items: MenuItem[], title?: string) => setMenu({ x, y, items, title }), []);

  const target = useCallback((label: string, specs: TargetSpec[], sourceIid?: string) => new Promise<TargetRef[][] | null>((resolve) => {
    if (!me) return resolve(null);
    setMode({ kind: 'target', label, specs, specIndex: 0, chosen: specs.map(() => []), controller: me, sourceIid, onDone: resolve });
  }), [me]);

  const isLegal = (ref: TargetRef): boolean | null => {
    if (mode?.kind !== 'target') return null;
    return legalTarget(g, mode.specs[mode.specIndex], ref, mode.controller, mode.sourceIid);
  };
  const advance = (m: Extract<NonNullable<Mode>, { kind: 'target' }>, chosen: TargetRef[][]) => {
    if (m.specIndex + 1 < m.specs.length) setMode({ ...m, chosen, specIndex: m.specIndex + 1 });
    else { setMode(null); m.onDone(chosen); }
  };
  const cancelTarget = () => { if (mode?.kind === 'target') { setMode(null); mode.onDone(null); } };
  const pickTarget = (ref: TargetRef) => {
    if (mode?.kind !== 'target') return;
    const spec = mode.specs[mode.specIndex];
    const cur = mode.chosen[mode.specIndex];
    const same = (r: TargetRef) => JSON.stringify(r) === JSON.stringify(ref);
    if (cur.some(same)) { // click again to deselect
      const chosen = mode.chosen.map((l, i) => (i === mode.specIndex ? l.filter((r) => !same(r)) : l));
      setMode({ ...mode, chosen });
      return;
    }
    if (!legalTarget(g, spec, ref, mode.controller, mode.sourceIid)) { toast('Not a legal target'); return; }
    const chosen = mode.chosen.map((l, i) => (i === mode.specIndex ? [...l, ref] : l));
    if (chosen[mode.specIndex].length >= spec.max) advance(mode, chosen);
    else setMode({ ...mode, chosen });
  };

  const base = { g, me, act, ask, askText, pickModes, pickOption, divide, setMode, opp, mode, target, toast };
  const menuFor = (iid: string) => menuForImpl(base, iid);
  const defaultAction = (iid: string) => defaultActionImpl(base, iid, menuFor, (items, title) => {
    const el = document.querySelector(`[data-iid="${iid}"]`)?.getBoundingClientRect();
    setMenu({ x: el ? el.left + el.width / 2 : innerWidth / 2, y: el ? el.top + 20 : innerHeight / 2, items, title });
  });

  /** Touch: bottom sheet with a big image and the same actions the context menu / default click would offer. */
  const showCardSheet = (iid: string) => {
    const c = g.cards[iid];
    if (!c || isHidden(c)) return;
    const face = faceOf(c, getCard);
    const card = c.cardId ? getCard(c.cardId) : undefined;
    const dl = defaultLabel(g, me, iid);
    showSheet({
      face,
      backFace: card ? backFaceOf(card) : undefined,
      extra: [c.faceDown ? 'Face down (only you can see this)' : '', describe(c)].filter(Boolean).join(' · ') || undefined,
      items: [...(dl ? [{ label: dl, primary: true, onClick: () => defaultAction(iid) }] : []), ...menuFor(iid).filter((it) => !dl || it.label.toLowerCase() !== dl.toLowerCase())],
    });
  };
  const tapCard = (iid: string) => {
    const now = Date.now();
    if (lastTap.current?.iid === iid && now - lastTap.current.t < 350) { lastTap.current = null; hideSheet(); defaultAction(iid); return; }
    lastTap.current = { iid, t: now };
    showCardSheet(iid);
  };

  // Undo first closes whatever is open (menus, prompts, pickers, targeting, viewers, the touch sheet), so it can be
  // pressed again and again: no stale popup is left waiting for an answer about a state that no longer exists.
  const popups = useRef({ prompt, modes, picker, dividing, forceAsk, mode });
  popups.current = { prompt, modes, picker, dividing, forceAsk, mode };
  const closeAll = useCallback(() => {
    const p = popups.current;
    setMenu(null);
    if (p.mode?.kind === 'target') p.mode.onDone(null);
    setMode(null);
    p.prompt?.resolve(null); setPrompt(null);
    p.modes?.resolve(null); setModes(null);
    p.picker?.resolve(null); setPicker(null);
    p.dividing?.resolve(null); setDividing(null);
    p.forceAsk?.resolve(false); setForceAsk(null);
    setZone(null); setTokens(false);
    hideSheet(); setPreview(null);
  }, []);
  const undo = useCallback(() => { closeAll(); void act({ t: 'requestUndo' }); }, [act, closeAll]);

  // Names -> card data for choices about cards the view keeps hidden (a library search lists names only).
  const myDeck = realMe ? match.decks?.[realMe] : undefined;
  const byName = useMemo(() => {
    const m = new Map<string, string>();
    const add = (id: string | undefined) => {
      const card = id ? getCard(id) : undefined;
      if (!card) return;
      for (const n of [card.name, ...(card.faces?.map((f) => f.name) ?? [])]) if (!m.has(n.toLowerCase())) m.set(n.toLowerCase(), card.id);
    };
    for (const id of [...(myDeck?.main ?? []), ...(myDeck?.side ?? [])]) add(id);
    for (const c of Object.values(g.cards)) if (!isHidden(c)) add(c.cardId);
    return m;
  }, [myDeck, g.cards]);
  const faceByName = useCallback((label: string) => {
    const id = byName.get(label.toLowerCase()) ?? byName.get(label.replace(/\s*\(.*\)\s*$/, '').toLowerCase());
    const card = id ? getCard(id) : undefined;
    return card ? cardFace(card) : undefined;
  }, [byName]);

  const ctx: GameCtx = {
    g, me, self, opp, act, openMenu, mode, setMode, ask, askText, pickModes, pickOption, divide, showCardSheet, tapCard,
    openZone: (pid, z) => setZone({ pid, zone: z }), openTokens: () => setTokens(true), menuFor, defaultAction,
    target, pickTarget, isLegal, cast: (iid, face) => { castWithX(base, iid, face); }, toast, hoverTargets, setHoverTargets, payPreview, setPayPreview,
    faceByName, undo,
  };

  useAutoPass({ g, me, act, settings: auto, busy: !!mode || !!menu || !!prompt || !!modes || !!picker || !!dividing || !!forceAsk, controlled });
  const autoRef = useRef<{ s: AutoSettings; set: typeof setAuto }>({ s: auto, set: setAuto });
  autoRef.current = { s: auto, set: setAuto };

  // Keyboard shortcuts
  const okRef = useRef<() => void>(() => {});
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const modeRef = useRef<Mode>(null);
  modeRef.current = mode;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      if (e.key === 'F2' || (e.key === ' ' && !e.ctrlKey && !e.repeat && t.tagName !== 'BUTTON')) { e.preventDefault(); okRef.current(); }
      if (e.key === 'F6' || (e.ctrlKey && e.code === 'Space')) { e.preventDefault(); act({ t: 'passUntilEOT' }); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undoRef.current(); }
      if (e.key === 'Escape') { if (modeRef.current?.kind === 'target') modeRef.current.onDone(null); setMode(null); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [act]);

  const mePlayer = g.players.find((p) => p.pid === me);
  // Targeting / attach / block prompt. On phones it lives in the phase bar so it never covers the cards you need to tap.
  const hint = mode && mode.kind !== 'attackPW' ? (mode.kind === 'target'
    ? <TargetBanner mode={mode} advance={advance} cancel={cancelTarget} />
    : (
      <div className="mode-hint">
        {mode.kind === 'attach' && (isTouch() ? 'Tap the card to attach to' : 'Click the card to attach to (Esc to cancel)')}
        {mode.kind === 'block' && (isTouch() ? 'Tap an attacking creature to block it (tap elsewhere to cancel)' : 'Click an attacking creature to block it (Esc to cancel)')}
      </div>
    )) : null;

  return (
    <Ctx.Provider value={ctx}>
      <div className={`table lay-${layout} ${mode ? `mode-${mode.kind}` : ''} ${phone ? (logOpen ? 'log-open' : 'log-closed') : auto.sidePanel ? 'side-open' : 'side-closed'}`} onClick={() => mode && mode.kind !== 'target' && setMode(null)}>
        <div className="table-main">
          <div className="table-core">
          {layout === 'portrait' && !hintGone && (
            <div className="rotate-hint">↻ Rotate your phone for a bigger board
              <button aria-label="Dismiss" onClick={() => { setHintGone(true); try { localStorage.setItem('ojb:rotateHint', '0'); } catch { /* ignore */ } }}>✕</button>
            </div>
          )}
          {controlling && cb && (
            <div className="control-banner">
              <b>You control {g.players.find((p) => p.pid === cb.pid)?.name}'s turn (Mindslaver)</b>
              <label><input type="checkbox" checked={actAsOn} onChange={(e) => setActAsOn(e.target.checked)} /> Acting as {g.players.find((p) => p.pid === cb.pid)?.name}</label>
              <span className="small">{actAsOn ? 'You see and play their hand and permanents.' : 'Showing your own side; actions are yours.'}</span>
            </div>
          )}
          {controlled && cb && (
            <div className="control-banner controlled">
              <b>Your turn is controlled by {g.players.find((p) => p.pid === cb.by)?.name}</b>
              <span className="small">You can only chat or concede.</span>
            </div>
          )}
          <FixModeBar />
          {g.phase === 'playing' && <ProposalPrompt />}
          <PlayerArea pid={opp} top />
          <CenterBar match={match} onLeave={onLeave} auto={auto} setAuto={setAuto} phone={phone} onLog={() => setLogOpen(true)}>
            {layout === 'portrait' && <div className="center-row2">{hint ?? <><Stack yields={auto.yields} setAuto={setAuto} /><PassButton okRef={okRef} /></>}</div>}
            {layout === 'landscape' && hint}
            {!phone && <button className="side-toggle" onClick={() => setAuto({ sidePanel: !auto.sidePanel })} title="Toggle log / active effects">{auto.sidePanel ? 'Log ›' : '‹ Log'}</button>}
          </CenterBar>
          <RevealedZone />
          <PlayerArea pid={self} />
          {me && <Hand pid={me} />}
          {layout !== 'portrait' && <PassButton okRef={okRef} />}
          </div>
          {layout !== 'portrait' && <Stack yields={auto.yields} setAuto={setAuto} />}
        </div>
        <div className="table-side">
          {phone && (
            <div className="side-head">
              <b>Game menu</b>
              <button className="side-close" onClick={() => setLogOpen(false)}>Close ✕</button>
            </div>
          )}
          {phone && me && g.phase === 'playing' && <AutoToggles auto={auto} setAuto={setAuto} inline />}
          {phone && mePlayer && <MyTools p={mePlayer} />}
          <ActiveEffects />
          <GameLog />
        </div>
        <HoverPreview />
        {g.phase === 'mulligan' && <div className="overlay"><MulliganOverlay /></div>}
        {g.phase === 'over' && (
          <div className="overlay"><div className="overlay-msg">
            <h2>{g.winner ? `${g.players.find((p) => p.pid === g.winner)?.name} wins!` : 'Game over'}</h2>
            <p className="muted">Next game starts after sideboarding.</p>
          </div></div>
        )}
        {mePlayer?.peek && mePlayer.peek.iids.length >= 0 && <PeekModal key={mePlayer.peek.iids.join()} />}
        {zone && <ZoneViewer pid={zone.pid} zone={zone.zone} onClose={() => setZone(null)} />}
        {tokens && <TokenModal onClose={() => setTokens(false)} />}
        {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
        {modes && <ModesModal {...modes} onDone={(v) => { modes.resolve(v); setModes(null); }} />}
        {picker && <OptionsModal {...picker} onDone={(v) => { picker.resolve(v); setPicker(null); }} />}
        {dividing && <DivideModal {...dividing} onDone={(v) => { dividing.resolve(v); setDividing(null); }} />}
        {prompt && <Prompt label={prompt.label} initial={prompt.initial} numeric={prompt.numeric} onDone={(v) => { prompt.resolve(v); setPrompt(null); }} />}
        {!phone && hint}
        {mode?.kind === 'target' && mode.specs[mode.specIndex].zone === 'graveyard' && <GraveyardPicker spec={mode.specs[mode.specIndex]} />}
        {forceAsk && (
          <div className="overlay"><div className="overlay-msg force-ask">
            <p>{forceAsk.error}. Do it anyway?</p>
            <button className="primary" onClick={() => { forceAsk.resolve(true); setForceAsk(null); }}>Yes, do it</button>
            <button onClick={() => { forceAsk.resolve(false); setForceAsk(null); }}>Cancel</button>
          </div></div>
        )}
        {toastMsg && <div className="toast">{toastMsg}</div>}
        <PendingChoices />
        {g.undoRequest && g.undoRequest === me && <div className="undo-req pending-wait">Waiting for your opponent to allow the undo…</div>}
        {g.undoRequest && g.undoRequest !== me && me && (
          <div className="undo-req">
            {g.players.find((p) => p.pid === g.undoRequest)?.name} wants to undo the last action.
            <button className="primary" onClick={() => act({ t: 'answerUndo', accept: true })}>Allow</button>
            <button onClick={() => act({ t: 'answerUndo', accept: false })}>Decline</button>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}

/** Label for what a plain tap / default action does to this card (touch bottom sheet's primary button). */
function defaultLabel(g: GameView, me: string | null, iid: string): string | null {
  const c = g.cards[iid];
  if (!c || isHidden(c) || !me) return null;
  const face = faceOf(c, getCard);
  const creature = face.types.includes('Creature');
  if (c.zone === 'hand' && c.owner === me) return face.types.includes('Land') ? 'Play land' : 'Cast';
  if (c.zone === 'battlefield' && c.controller === me) {
    if (g.step === 'attackers' && g.activePlayer === me && !g.combat.attackersDeclared && creature) return c.attacking ? 'Remove from attack' : 'Attack';
    if (g.step === 'blockers' && g.activePlayer !== me && !g.combat.blockersDeclared) return c.blocking ? 'Stop blocking' : 'Block…';
    if (c.tapped) return manualOk(g) ? 'Untap' : null;
    return face.types.includes('Land') ? 'Tap for mana' : manualOk(g) ? 'Tap' : null;
  }
  return null;
}

// ---------------------------------------------------------------- drop zones

function useDrop(onDrop: (iid: string) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('text/iid')) { e.preventDefault(); setOver(true); } },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => { e.preventDefault(); setOver(false); const iid = e.dataTransfer.getData('text/iid'); if (iid) onDrop(iid); },
    },
  };
}

function dropTo(ctx: GameCtx, iid: string, to: Zone, position?: 'top' | 'bottom') {
  const c = ctx.g.cards[iid];
  if (!c) return;
  const handToBf = to === 'battlefield' && c.zone === 'hand';
  if (!manualOk(ctx.g) && !handToBf) return;
  if (to === 'battlefield' && c.zone !== 'battlefield') {
    if (!isHidden(c)) {
      const f = faceOf(c, getCard);
      if (c.zone === 'hand' && f.types.includes('Land')) return ctx.act({ t: 'playLand', iid });
      if (c.zone === 'hand') return ctx.cast(iid);
    }
  }
  if (c.zone === to && to !== 'library') return;
  ctx.act({ t: 'move', iid, to, position });
}

// ---------------------------------------------------------------- player area

/** Card width bounds per layout (creatures; other permanents and lands) and the spacing of the battlefield rows. */
const BOARD_SIZES = {
  desktop: { front: [56, 150], back: [44, 120], gaps: { x: 8, y: 6 }, bandGap: 4, groupGap: 18 },
  portrait: { front: [40, 74], back: [32, 62], gaps: { x: 5, y: 3 }, bandGap: 2, groupGap: 10 },
  landscape: { front: [28, 58], back: [24, 48], gaps: { x: 4, y: 3 }, bandGap: 2, groupGap: 10 },
} as const;

/** One place on a battlefield row: a permanent with what is attached to it, or a stack of identical basic lands. */
interface BfSlot { ids: string[]; units: number; attachments: string[] }

/** Content-box size of an element, kept up to date with a ResizeObserver (measured before paint). */
function useBoxSize(ref: RefObject<HTMLElement>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const h = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      setSize((s) => (Math.abs(s.w - w) < 0.5 && Math.abs(s.h - h) < 0.5 ? s : { w, h }));
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, [ref]);
  return size;
}

function PlayerArea({ pid, top }: { pid: string; top?: boolean }) {
  const ctx = useGame();
  const { g } = ctx;
  const layout = useLayout();
  const p = g.players.find((x) => x.pid === pid)!;
  const mine = g.battlefield.filter((id) => g.cards[id]?.controller === pid);
  const attachedTo = (id: string) => mine.filter((x) => g.cards[x].attachedTo === id).concat(g.battlefield.filter((x) => g.cards[x].attachedTo === id && g.cards[x].controller !== pid));
  const roots = mine.filter((id) => { const a = g.cards[id].attachedTo; return !a || !g.cards[a] || g.cards[a].zone !== 'battlefield'; });
  const isLand = (id: string) => { const c = g.cards[id]; return !isHidden(c) && !c.faceDown && faceOf(c, getCard).types.includes('Land') && !faceOf(c, getCard).types.includes('Creature'); };
  const isCreature = (id: string) => { const c = g.cards[id]; return isHidden(c) || c.faceDown || faceOf(c, getCard).types.includes('Creature') || (c.counters.animated ?? 0) > 0; };
  const slot = (id: string): BfSlot => ({ ids: [id], units: g.cards[id].tapped ? TAPPED_UNITS : 1, attachments: attachedTo(id) });
  // Identical basic lands in the same state (nothing on them) share one stack with a count.
  const basicKey = (id: string) => {
    const c = g.cards[id];
    if (isHidden(c) || c.faceDown || c.token || !c.cardId || c.damage || c.note || c.noUntap || c.attacking || c.blocking || c.tempKeywords?.length) return null;
    if (Object.values(c.counters).some((v) => v) || attachedTo(id).length) return null;
    const f = faceOf(c, getCard);
    return /\bBasic\b/.test(f.typeLine ?? '') ? `${f.name}|${c.tapped ? 1 : 0}` : null;
  };
  const landSlots: BfSlot[] = [];
  const stacks = new Map<string, BfSlot>();
  for (const id of roots.filter(isLand)) {
    const k = basicKey(id);
    const st = k ? stacks.get(k) : undefined;
    if (st) { st.ids.push(id); continue; }
    const s = slot(id);
    if (k) stacks.set(k, s);
    landSlots.push(s);
  }
  for (const s of landSlots) if (s.ids.length > 1) s.units = g.cards[s.ids[0]].tapped ? TAPPED_UNITS : STACK_UNITS;
  const creatureSlots = roots.filter((id) => !isLand(id) && isCreature(id)).map(slot);
  const otherSlots = roots.filter((id) => !isLand(id) && !isCreature(id)).map(slot);
  const fighting = (ss: BfSlot[]) => ss.some((s) => g.cards[s.ids[0]].attacking || g.cards[s.ids[0]].blocking);

  const bfRef = useRef<HTMLDivElement>(null);
  const size = useBoxSize(bfRef);
  const sz = BOARD_SIZES[layout];
  const rowSpec = (ss: BfSlot[], [min, max]: readonly [number, number], reserve: number) => ({ slots: ss.map((s) => ({ units: s.units, attachments: s.attachments.length })), min, max, reserve });
  const spec: BoardSpec = {
    front: rowSpec(creatureSlots, sz.front, COMBAT_SHIFT),
    others: rowSpec(otherSlots, sz.back, fighting(otherSlots) ? COMBAT_SHIFT : 0),
    lands: rowSpec(landSlots, sz.back, fighting(landSlots) ? COMBAT_SHIFT : 0),
    gaps: sz.gaps, bandGap: sz.bandGap, groupGap: sz.groupGap,
  };
  const specKey = JSON.stringify(spec);
  const fit = useMemo(() => fitBoard(size.w, size.h, JSON.parse(specKey) as BoardSpec), [size.w, size.h, specKey]);

  const drop = useDrop((iid) => {
    const c = g.cards[iid];
    if (c?.zone === 'battlefield' && c.controller !== pid && ctx.me && manualOk(g)) ctx.act({ t: 'control', iid, pid });
    else dropTo(ctx, iid, 'battlefield');
  });
  const row = (ss: BfSlot[], f: RowFit, cls: string, reserve: number, width?: number) => ss.length > 0 && (
    <BfRow key={cls} cls={cls} slots={ss} fit={f} width={width} reserve={reserve} top={!!top} gap={sz.gaps.x} />
  );
  const bands = [
    creatureSlots.length > 0 && <div key="front" className="bf-front" style={{ height: fit.frontHeight }}>{row(creatureSlots, fit.front, 'creatures', spec.front.reserve)}</div>,
    landSlots.length + otherSlots.length > 0 && (
      <div key="back" className="bf-back" style={{ height: fit.backHeight }}>
        {row(otherSlots, fit.others, 'others', spec.others.reserve, fit.othersWidth)}
        {row(landSlots, fit.lands, 'lands', spec.lands.reserve, fit.landsWidth)}
      </div>
    ),
  ];
  return (
    <div className={`player-area ${top ? 'top' : 'bottom'} ${g.activePlayer === pid ? 'active' : ''} ${inCombat(g) ? `in-combat ${g.activePlayer === pid ? 'attacking-side' : 'defending-side'}` : ''}`}>
      <PlayerPanel p={p} />
      <div ref={bfRef} className={`battlefield ${drop.over ? 'drop-over' : ''}`} style={{ gap: sz.bandGap }} {...drop.props}>
        {top ? bands.slice().reverse() : bands}
      </div>
      <Zones p={p} />
    </div>
  );
}

/**
 * One battlefield row, laid out by fitBoard: explicit lines (so an overlapped line never starts left of the row),
 * fixed-width slots, and room on the opponent's side of each line for the combat shift.
 */
function BfRow({ cls, slots, fit, width, reserve, top, gap }: { cls: string; slots: BfSlot[]; fit: RowFit; width?: number; reserve: number; top: boolean; gap: number }) {
  const style = { '--cw': `${fit.cw}px`, '--rcw': `${fit.cw}px`, width } as CSSProperties;
  const pad = reserve * fit.cw;
  return (
    <div className={`bf-row ${cls}`} style={style} data-cw={fit.cw} data-lines={fit.lines.length} data-overlap={fit.overlap}>
      {fit.lines.map((line, li) => (
        <div key={li} className="bf-line" style={{ gap: fit.overlap ? 0 : gap, paddingTop: top ? 0 : pad, paddingBottom: top ? pad : 0 }}>
          {line.map((i, k) => {
            const s = slots[i];
            return (
              <div key={s.ids[0]} className={`bf-slot ${s.ids.length > 1 ? 'bf-stack' : ''}`}
                style={{ width: s.units * fit.cw, marginLeft: k > 0 && fit.overlap ? -fit.overlap : undefined, paddingTop: s.attachments.length * ATTACH_PEEK * fit.cw }}>
                <TableCard iid={s.ids[0]} attachments={s.attachments} stack={s.ids.length > 1 ? s.ids : undefined} />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function PlayerPanel({ p }: { p: ViewPlayer }) {
  const { g, me, act, ask, askText, openZone, mode, pickTarget, isLegal } = useGame();
  const isMe = p.pid === me;
  const targeting = mode?.kind === 'target';
  const legal = targeting ? isLegal({ kind: 'player', pid: p.pid }) : null;
  const chosen = mode?.kind === 'target' && mode.chosen.some((l) => l.some((r) => r.kind === 'player' && r.pid === p.pid));
  const life = (d: number) => act({ t: 'life', pid: p.pid, delta: d });
  const pool = Object.entries(p.manaPool).filter(([, n]) => n > 0);
  const viewing = g.players.find((x) => x.pid === me)?.viewingHandOf === p.pid;
  const manual = manualOk(g);
  const phone = useLayout() !== 'desktop';
  return (
    <div className={`player-panel ${g.priority === p.pid && g.phase === 'playing' ? 'has-priority' : ''} ${targeting ? (legal ? 'legal-target' : 'dim') : ''} ${chosen ? 'targeted' : ''}`}
      onClick={targeting ? (e) => { e.stopPropagation(); pickTarget({ kind: 'player', pid: p.pid }); } : undefined}>
      <div className="pp-name">
        <span className={`dot ${p.conceded ? '' : 'on'}`} />{p.name}
        {p.bot && <BotBadge />}
        {g.activePlayer === p.pid && <span className="turn-badge">turn</span>}
      </div>
      <div className="pp-counts" title="Hand · Library · Graveyard">
        <span title="Cards in hand">✋ {p.handCount ?? p.zones.hand.length}</span>
        <span title="Cards in library">▤ {p.libraryCount}</span>
        <span title="Cards in graveyard">☠ {p.zones.graveyard.length}</span>
      </div>
      <div className="life">
        {me && manual && <button onClick={() => life(-1)} onContextMenu={(e) => { e.preventDefault(); life(-5); }} title="−1 (right-click −5)">−</button>}
        <span className={`life-num ${p.life <= 5 ? 'low' : ''}`} onClick={async () => { if (!me || !manual) return; const n = await ask(`Set ${p.name}'s life to`, p.life); if (n != null) life(n - p.life); }}>{p.life}</span>
        {me && manual && <button onClick={() => life(1)} onContextMenu={(e) => { e.preventDefault(); life(5); }} title="+1 (right-click +5)">+</button>}
      </div>
      <div className="pcounters">
        {Object.entries(p.counters).filter(([, v]) => v > 0).map(([k, v]) => (
          <span key={k} className="pctr" title="click +1, right-click −1"
            onClick={() => me && manual && act({ t: 'playerCounter', pid: p.pid, kind: k, delta: 1 })}
            onContextMenu={(e) => { e.preventDefault(); if (me && manual) act({ t: 'playerCounter', pid: p.pid, kind: k, delta: -1 }); }}>{k} {v}</span>
        ))}
        {me && manual && <button className="tiny" title="Add a player counter (poison, energy, experience, rad…)" onClick={async () => { const k = await askText('Counter (poison, energy, experience, rad, tickets…)', 'poison'); if (k) act({ t: 'playerCounter', pid: p.pid, kind: k, delta: 1 }); }}>+ctr</button>}
      </div>
      {p.designations.length > 0 && <div className="designations">{p.designations.map((d) => <span key={d} className="desig" onClick={() => isMe && act({ t: 'designation', name: d, on: false })}>{d === 'Monarch' ? '👑' : d === 'Initiative' ? '🗺' : '✦'} {d}</span>)}</div>}
      {(pool.length > 0 || (isMe && manual)) && (
        <div className={`mana-pool ${pool.length ? 'floating' : ''}`} title={pool.length ? `${p.name}'s floating mana (empties at the end of the step)` : undefined}>
          {pool.length > 0 && <span className="mp-label">Mana</span>}
          <ManaPips pool={p.manaPool} onSpend={isMe && manual ? (m) => act({ t: 'addMana', mana: m, n: -1 }) : undefined} />
          {isMe && manual && <AddMana />}
        </div>
      )}
      {!isMe && me && manual && <button className="tiny" onClick={() => act({ t: 'lookAtHand', pid: viewing ? null : p.pid })}>{viewing ? 'Hide hand' : 'Look at hand'}</button>}
      {p.zones.command.length > 0 && <button className="tiny" onClick={() => openZone(p.pid, 'command')}>Command ({p.zones.command.length})</button>}
      {isMe && !phone && <MyTools p={p} />}
      {!isMe && p.zones.hand.some((iid) => !isHidden(g.cards[iid])) && <button className="tiny" onClick={() => openZone(p.pid, 'hand')}>See revealed</button>}
    </div>
  );
}

const POOL_ORDER = ['W', 'U', 'B', 'R', 'G', 'C'];
/** Floating mana as pips with counts ("R ×3"), in WUBRGC order. */
function ManaPips({ pool, onSpend }: { pool: Record<string, number>; onSpend?: (m: string) => void }) {
  const entries = Object.entries(pool).filter(([, n]) => n > 0).sort(([a], [b]) => (POOL_ORDER.indexOf(a) + 99) % 99 - (POOL_ORDER.indexOf(b) + 99) % 99);
  return (
    <>
      {entries.map(([m, n]) => (
        <span key={m} className={`pip pool-pip pip-${m.replace('/', '')}`} title={onSpend ? 'Click to spend 1' : `${n} ${m} floating`}
          onClick={onSpend ? () => onSpend(m) : undefined}>{m}{n > 1 && <b className="pool-n">×{n}</b>}</span>
      ))}
    </>
  );
}

function AddMana() {
  const { act, openMenu } = useGame();
  return (
    <button className="tiny" title="Add mana to your pool" onClick={(e) => openMenu(e.clientX, e.clientY, [
      ...['W', 'U', 'B', 'R', 'G', 'C'].map((m) => ({ label: `Add {${m}}`, onClick: () => act({ t: 'addMana', mana: m, n: 1 }) })),
      { label: 'Empty pool', onClick: () => act({ t: 'clearMana' }) },
    ], 'Mana pool')}>+mana</button>
  );
}

function Zones({ p }: { p: ViewPlayer }) {
  const ctx = useGame();
  const { g, me, act, ask, openZone, openMenu } = ctx;
  const isMe = p.pid === me;
  const topGy = p.zones.graveyard.at(-1);
  const topEx = p.zones.exile.at(-1);
  const libDrop = useDrop((iid) => dropTo(ctx, iid, 'library', 'top'));
  const gyDrop = useDrop((iid) => dropTo(ctx, iid, 'graveyard'));
  const exDrop = useDrop((iid) => dropTo(ctx, iid, 'exile'));
  const revealedTop = p.zones.library.filter((iid) => !isHidden(g.cards[iid]));

  const n = (label: string, f: (n: number) => GameAction, d = 1) => async () => { const v = await ask(label, d); if (v != null && v > 0) act(f(v)); };
  const libMenu = (e: React.MouseEvent) => openMenu(e.clientX, e.clientY, [
    { label: 'Draw a card', onClick: () => act({ t: 'draw', n: 1 }) },
    { label: 'Draw X…', onClick: n('Draw how many?', (v) => ({ t: 'draw', n: v }), 2) },
    { label: 'Scry X…', onClick: n('Scry how many?', (v) => ({ t: 'peek', mode: 'scry', n: v })) },
    { label: 'Surveil X…', onClick: n('Surveil how many?', (v) => ({ t: 'peek', mode: 'surveil', n: v })) },
    { label: 'Look at top X…', onClick: n('Look at how many?', (v) => ({ t: 'peek', mode: 'look', n: v }), 3) },
    { label: 'Search library', onClick: () => act({ t: 'peek', mode: 'search' }) },
    { label: 'Reveal top X…', onClick: n('Reveal how many?', (v) => ({ t: 'revealTop', n: v })) },
    { label: 'Mill X…', onClick: n('Mill how many?', (v) => ({ t: 'mill', n: v })) },
    { label: 'Play/cast the top card…', onClick: () => act({ t: 'peek', mode: 'look', n: 1 }) },
    { label: 'Shuffle', onClick: () => act({ t: 'shuffle' }) },
  ], 'Library');

  return (
    <div className="zones">
      <div className={`zone lib ${libDrop.over ? 'drop-over' : ''}`} {...libDrop.props} onClick={isMe && manualOk(g) ? libMenu : undefined} title={isMe && manualOk(g) ? 'Library — click for options (drop a card here to put it on top)' : 'Library'}>
        <CardBack label={String(p.libraryCount)} />
        <span className="zlabel">Lib {p.libraryCount}</span>
        {revealedTop.length > 0 && <div className="revealed-top" onMouseEnter={() => { const c = g.cards[revealedTop[0]]; if (!isHidden(c)) setPreview({ face: faceOf(c, getCard) }); }}>top: {revealedTop.map((i) => { const c = g.cards[i]; return isHidden(c) ? '?' : faceOf(c, getCard).name; }).join(', ')}</div>}
      </div>
      <div className={`zone gy ${gyDrop.over ? 'drop-over' : ''}`} {...gyDrop.props} onClick={() => openZone(p.pid, 'graveyard')} title="Graveyard"
        onMouseEnter={() => { const c = topGy ? g.cards[topGy] : undefined; if (c && !isHidden(c)) setPreview({ face: faceOf(c, getCard) }); }}>
        {topGy && !isHidden(g.cards[topGy]) ? <CardImage face={faceOf(g.cards[topGy] as never, getCard)} /> : <div className="empty-zone">GY</div>}
        <span className="zone-count">{p.zones.graveyard.length}</span>
        <span className="zlabel">GY {p.zones.graveyard.length}</span>
      </div>
      <div className={`zone ex ${exDrop.over ? 'drop-over' : ''}`} {...exDrop.props} onClick={() => openZone(p.pid, 'exile')} title="Exile"
        onMouseEnter={() => { const c = topEx ? g.cards[topEx] : undefined; if (c && !isHidden(c) && !c.faceDown) setPreview({ face: faceOf(c, getCard) }); }}>
        {topEx && !isHidden(g.cards[topEx]) && !g.cards[topEx].faceDown ? <CardImage face={faceOf(g.cards[topEx] as never, getCard)} /> : <div className="empty-zone">Exile</div>}
        <span className="zone-count">{p.zones.exile.length}</span>
        <span className="zlabel">Ex {p.zones.exile.length}</span>
      </div>
    </div>
  );
}

function MyTools({ p }: { p: ViewPlayer }) {
  const ctx = useGame();
  const { act, openZone, openMenu, openTokens } = ctx;
  const manual = manualOk(ctx.g);
  return (
    <div className="my-tools">
      <button className="tiny" onClick={() => openZone(p.pid, 'sideboard')}>Sideboard</button>
      {manual && <button className="tiny" onClick={openTokens}>Tokens</button>}
      <button className="tiny" onClick={(e) => openMenu(e.clientX, e.clientY, [
        ...(manual ? [{ label: 'Untap all my permanents', onClick: () => act({ t: 'untapAll' }) }, { label: 'Reveal my hand', onClick: () => act({ t: 'revealHand' }) }] : []),
        { label: `Automatic triggers: ${(p as { autoTriggers?: boolean }).autoTriggers === false ? 'off (click to turn on)' : 'on (click to turn off)'}`, onClick: () => act({ t: 'setAutoTriggers', on: (p as { autoTriggers?: boolean }).autoTriggers === false } as never) },
        ...(manual ? ['Monarch', 'Initiative', "City's blessing", 'Day', 'Night'] : []).map((d) => ({ label: `${p.designations.includes(d) ? 'Lose' : 'Take'} ${d}`, onClick: () => act({ t: 'designation', name: d, on: !p.designations.includes(d) }) })),
        ...(manual ? [{ label: 'Put a free trigger/effect on the stack…', onClick: async () => { const t = await ctx.askText('Text'); if (t) act({ t: 'trigger', text: t }); } }] : []),
        { label: 'Concede game', onClick: () => { if (confirm('Concede this game?')) act({ t: 'concede' }); } },
      ], 'More')}>More…</button>
    </div>
  );
}

function FixModeBar() {
  const { g, me, act } = useGame();
  const name = (pid: string) => g.players.find((p) => p.pid === pid)?.name ?? '?';
  const req = fixRequest(g);
  if (fixModeOn(g)) {
    return (
      <div className="fix-banner">
        <span>Fix mode: manual tools are on for both players</span>
        {me && <button className="tiny" title="Draw a card (also: click your library for more tools)" onClick={() => act({ t: 'draw', n: 1 })}>Draw a card</button>}
        {me && <button className="tiny" onClick={() => act({ t: 'endFixMode' } as never)}>Done fixing</button>}
      </div>
    );
  }
  if (!req || !me) return null;
  if (req === me) return <div className="undo-req pending-wait">Waiting for your opponent to allow fixing the board…</div>;
  return (
    <div className="undo-req">
      {name(req)} wants to fix the board.
      <button className="primary" onClick={() => act({ t: 'answerFixMode', accept: true } as never)}>Allow</button>
      <button onClick={() => act({ t: 'answerFixMode', accept: false } as never)}>Decline</button>
    </div>
  );
}

// ---------------------------------------------------------------- hand

function Hand({ pid }: { pid: string }) {
  const ctx = useGame();
  const { g } = ctx;
  const p = g.players.find((x) => x.pid === pid)!;
  const drop = useDrop((iid) => dropTo(ctx, iid, 'hand'));
  const left = landPlaysLeft(g, pid);
  const played = (p as { landsPlayed?: number }).landsPlayed ?? 0;
  const n = p.zones.hand.length;
  return (
    <div className={`hand ${drop.over ? 'drop-over' : ''}`} style={handStyle(n)} {...drop.props}>
      {left != null && <span className={`land-plays ${left === 0 ? 'none' : ''}`} title="Land drops this turn">Lands: {played}/{played + left} played</span>}
      {p.zones.hand.map((iid, i) => <HandCard key={iid} iid={iid} i={i} n={p.zones.hand.length} />)}
      {p.zones.hand.length === 0 && <span className="muted">Your hand is empty.</span>}
      <span className="hand-hint muted">{isTouch() ? 'Tap: card details & actions · Double-tap: play / cast · Hold: more' : manualOk(g) ? 'Click: play / cast · Right-click: more · Drag to battlefield, graveyard, exile or library' : 'Click: play / cast (mana is paid automatically) · Right-click: more'}</span>
    </div>
  );
}

/** Arc layout for the hand: CSS variables only, no animation. */
const fanStep = (n: number) => Math.min(3.5, 28 / Math.max(n, 1)); // degrees between neighbours
const fanDrop = (n: number) => Math.min(1.6, 10 / Math.max(n, 1)); // px per t² (arc depth)
function fanStyle(i: number, n: number): React.CSSProperties {
  const t = i - (n - 1) / 2;
  return {
    '--rot': `${(t * fanStep(n)).toFixed(2)}deg`,
    '--dy': `${(t * t * fanDrop(n)).toFixed(1)}px`,
    zIndex: i + 1,
  } as React.CSSProperties;
}
/**
 * Hand strip variables: --n (card count, for the overlap that fits the strip) and --lift, how far every card is raised so
 * the lowest point of the arc (outer cards: arc drop + the corner a rotation pushes down) stays on screen.
 */
function handStyle(n: number): React.CSSProperties {
  const t = (n - 1) / 2;
  const sin = Math.sin((t * fanStep(n) * Math.PI) / 180);
  return {
    '--n': String(Math.max(n, 1)),
    '--ov': String(Math.min(0.62, Math.max(0.08, (n - 4) * 0.06))),
    '--lift': `calc(${(t * t * fanDrop(n)).toFixed(1)}px + var(--hw) * ${(sin / 2).toFixed(3)} + 2px)`,
  } as React.CSSProperties;
}

function HandCard({ iid, i = 0, n = 1 }: { iid: string; i?: number; n?: number }) {
  const { g, me, menuFor, defaultAction, openMenu, setPayPreview, tapCard } = useGame();
  const lp = useLongPress((x, y) => { const cc = g.cards[iid]; if (cc && !isHidden(cc)) openMenu(x, y, menuFor(iid), faceOf(cc, getCard).name); });
  const c = g.cards[iid];
  if (!c || isHidden(c)) return <div className="hcard" style={fanStyle(i, n)}><CardBack /></div>;
  const face = faceOf(c, getCard);
  const st = castStatus(c.cardId, 0);
  const altHints = c.owner === me ? safeCastOptions(g, iid, 0).filter((o) => o.id !== 'normal' && !o.unavailable).map((o) => `${o.label}: ${optionText(o)}`) : [];
  const usable = c.owner === me ? castability(g, me, iid) : undefined;
  const strictCls = usable ? (usable.ok ? 'castable' : 'uncastable') : '';
  const showPay = () => {
    if (!usable?.ok) return;
    const p = autoPayPreview(g, me, iid, 0);
    if (p?.ok) setPayPreview(p.taps);
  };
  return (
    <div className={`hcard ${strictCls} ${c.revealedTo.length ? 'revealed' : ''}`} style={fanStyle(i, n)} data-iid={iid} draggable={!isTouch()} {...lp.props}
      title={usable && !usable.ok ? usable.reason ?? 'Cannot be cast right now' : undefined}
      onMouseLeave={() => { setPayPreview([]); setPreview(null); }}
      onDragStart={(e) => { e.dataTransfer.setData('text/iid', iid); }}
      onMouseEnter={() => { showPay(); setPreview({ face, extra: [usable && !usable.ok ? `Can't cast: ${usable.reason ?? 'not now'}` : undefined, costNote(g, iid, 0, me), st ? AUTO_LABEL[st] : undefined, ...altHints].filter(Boolean).join(' · ') || undefined, backFace: c.cardId && getCard(c.cardId)?.faces ? (() => { const card = getCard(c.cardId!)!; return faceOf({ ...c, transformed: card.layout !== 'adventure' && card.layout !== 'split', castAs: card.layout === 'adventure' || card.layout === 'split' ? card.faces![1].name : undefined }, getCard); })() : undefined }); }}
      onClick={(e) => { if (lp.consumed()) return; noteHoldClick(e); if (isTouch()) tapCard(iid); else defaultAction(iid); }}
      onContextMenu={(e) => { e.preventDefault(); if (!isTouch()) openMenu(e.clientX, e.clientY, menuFor(iid), face.name); }}>
      <CardImage face={face} />
    </div>
  );
}

// ---------------------------------------------------------------- center: phases, stack, priority

function CenterBar({ match, onLeave, auto, setAuto, phone, onLog, children }: { match: MatchView; onLeave?: () => void; auto: AutoSettings; setAuto: (p: Partial<AutoSettings>) => void; phone?: boolean; onLog?: () => void; children?: React.ReactNode }) {
  const { g, me, act } = useGame();
  const phasesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = phasesRef.current;
    const el = box?.querySelector<HTMLElement>('.phase.current');
    if (box && el && phone) box.scrollLeft = el.offsetLeft - box.clientWidth / 2 + el.clientWidth / 2;
  }, [g.step, phone]);
  const myTurn = g.activePlayer === me;
  const name = (pid: string) => g.players.find((p) => p.pid === pid)?.name ?? '?';
  const mePlayer = g.players.find((p) => p.pid === me);
  const queued = (g.extraTurns ?? []).slice().reverse();
  const extra = !!g.nextNormalTurn;

  const toggleStop = (s: Step, own: boolean) => {
    if (!mePlayer) return;
    const list = own ? mePlayer.stops.own : mePlayer.stops.opp;
    const next = list.includes(s) ? list.filter((x) => x !== s) : [...list, s];
    act({ t: 'setStops', own: own ? next : mePlayer.stops.own, opp: own ? mePlayer.stops.opp : next });
  };
  return (
    <div className="center-bar">
      <div className="turn-info">
        <b>Turn {g.turn}</b> · {name(g.activePlayer)}
        {extra && <span className="extra-badge" title="This turn is an extra turn">Extra turn</span>}
        {queued.map((pid, i) => <span key={i} className="muted small"> · Next: extra turn for {name(pid)}</span>)}
        <span className="muted small"> · Game {match.gameNumber} · {match.wins[match.players[0]]}–{match.wins[match.players[1]]}</span>
        {onLeave && <button className="tiny" onClick={onLeave}>Stop watching</button>}
      </div>
      <div className={`phases ${inCombat(g) ? 'in-combat' : ''}`} ref={phasesRef}>
        {PHASE_STEPS.map((s) => {
          const own = myTurn;
          const ownStop = !!mePlayer?.stops.own.includes(s);
          const oppStop = !!mePlayer?.stops.opp.includes(s);
          const tip = `${myTurn ? 'Click to skip ahead to this step. ' : ''}Right-click: toggle your stop for ${myTurn ? 'your' : "your opponent's"} turns.`
            + ` Stops: ${ownStop ? 'your turn' : ''}${ownStop && oppStop ? ' + ' : ''}${oppStop ? "opponent's turn" : ''}${!ownStop && !oppStop ? 'none' : ''}.`;
          return (
            <div key={s} className={`phase ${g.step === s ? 'current' : ''} ${STEPS.indexOf(s) < STEPS.indexOf(g.step) ? 'past' : ''} ${myTurn ? 'mine' : 'theirs'} ${COMBAT_STEPS.includes(s) ? 'combat-step' : ''}`}
              title={tip} data-step={s}
              onClick={() => myTurn && STEPS.indexOf(s) > STEPS.indexOf(g.step) && act({ t: 'gotoStep', step: s })}
              onContextMenu={(e) => { e.preventDefault(); toggleStop(s, own); }}>
              {STEP_LABELS[s]}
              {ownStop && <span className="stop-dot own" />}
              {oppStop && <span className="stop-dot opp" />}
            </div>
          );
        })}
      </div>
      <CombatPanel />
      {me && g.phase === 'playing' && !phone && <AutoToggles auto={auto} setAuto={setAuto} />}
      {phone && <button className="log-btn" onClick={onLog}>Menu</button>}
      {children}
    </div>
  );
}

/** Toggle one stop: `own` = on my turns, otherwise on the opponent's turns. */
function useStops() {
  const { g, me, act } = useGame();
  const mePlayer = g.players.find((p) => p.pid === me);
  const toggle = (s: Step, own: boolean) => {
    if (!mePlayer) return;
    const list = own ? mePlayer.stops.own : mePlayer.stops.opp;
    const next = list.includes(s) ? list.filter((x) => x !== s) : [...list, s];
    act({ t: 'setStops', own: own ? next : mePlayer.stops.own, opp: own ? mePlayer.stops.opp : next });
  };
  return { stops: mePlayer?.stops, toggle, set: (own: Step[], opp: Step[]) => act({ t: 'setStops', own, opp }) };
}

/** Arena-style stops: one row per step, a column for my turns and one for the opponent's. */
function StopsEditor() {
  const { stops, toggle, set } = useStops();
  if (!stops) return null;
  return (
    <div className="stops-editor">
      <div className="se-head"><span>Stop at</span><span>My turn</span><span>Their turn</span></div>
      {PHASE_STEPS.map((s) => (
        <div key={s} className="se-row">
          <span>{STEP_LABELS[s]}</span>
          <label className="se-cell"><input type="checkbox" aria-label={`Stop at ${STEP_LABELS[s]} on my turn`} checked={stops.own.includes(s)} onChange={() => toggle(s, true)} /></label>
          <label className="se-cell"><input type="checkbox" aria-label={`Stop at ${STEP_LABELS[s]} on the opponent's turn`} checked={stops.opp.includes(s)} onChange={() => toggle(s, false)} /></label>
        </div>
      ))}
      <div className="se-foot">
        <button className="tiny" onClick={() => set(['main1', 'main2'], ['end'])}>Defaults</button>
        <button className="tiny" onClick={() => set([], [])}>Clear</button>
      </div>
      <p className="muted small se-note">Your main phase 1 and combat decisions always stop. A stop holds even with Auto-pass on.</p>
    </div>
  );
}

/** Settings popover from the phase bar: full control, hover zoom, stops, yields. Clamped to the viewport. */
function SettingsPopover({ anchor, onClose, auto, setAuto, setFullControl }: {
  anchor: DOMRect; onClose: () => void; auto: AutoSettings; setAuto: (p: Partial<AutoSettings>) => void; setFullControl: (on: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useClamped(ref, (w, h) => placeBeside(anchor, w, h, true), anchor);
  const zoom = useHoverZoom();
  useEffect(() => {
    const close = (e: Event) => { const t = e.target as HTMLElement; if (!ref.current?.contains(t) && !t.closest?.('.settings-btn')) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [onClose]);
  return (
    <div ref={ref} className="stops-pop" style={clampedStyle(pos)}>
      <label className={`tgl ${auto.fullControl ? 'on' : ''}`} title="Stop at every step and never auto-pass">
        <input type="checkbox" checked={auto.fullControl} onChange={(e) => setFullControl(e.target.checked)} /> Full control
      </label>
      <label className={`tgl ${zoom ? 'on' : ''}`} title="Show a large picture of the card under the mouse">
        <input type="checkbox" checked={zoom} onChange={(e) => setHoverZoom(e.target.checked)} /> Zoom cards on hover
      </label>
      {auto.yields.length > 0 && (
        <button className="tiny" title={`Auto-yielding to: ${auto.yields.join(', ')}`} onClick={() => setAuto({ yields: [] })}>Clear yields ({auto.yields.length})</button>
      )}
      <StopsEditor />
    </div>
  );
}

/** Auto-pass / full control switches (in the phase bar on desktop, in the game menu on phones). */
function AutoToggles({ auto, setAuto, inline }: { auto: AutoSettings; setAuto: (p: Partial<AutoSettings>) => void; inline?: boolean }) {
  const { g, me, act } = useGame();
  const mePlayer = g.players.find((p) => p.pid === me);
  const [pop, setPop] = useState<DOMRect | null>(null);
  const closePop = useCallback(() => setPop(null), []);
  // Full control: stop at every step; turning it off restores the previous stops.
  const setFullControl = (on: boolean) => {
    setAuto({ fullControl: on });
    if (!mePlayer) return;
    try {
      if (on) {
        localStorage.setItem('ojb:stopsBackup', JSON.stringify(mePlayer.stops));
        const all = PHASE_STEPS;
        act({ t: 'setStops', own: all, opp: all });
      } else {
        const b = JSON.parse(localStorage.getItem('ojb:stopsBackup') ?? 'null');
        if (b?.own && b?.opp) act({ t: 'setStops', own: b.own, opp: b.opp });
      }
    } catch { /* ignore */ }
  };
  const autoPass = (
    <label className={`tgl ${auto.autoPass && !auto.fullControl ? 'on' : ''}`} title="Pass priority automatically when you have nothing to respond with (never skips your stops, main phases or combat decisions)">
      <input type="checkbox" checked={auto.autoPass} onChange={(e) => setAuto({ autoPass: e.target.checked })} /> Auto-pass
    </label>
  );
  const hold = (
    <label className={`tgl hold-tgl ${auto.hold ? 'on' : ''}`} title="Hold priority: keep priority after you cast a spell or activate an ability, so you can respond to it yourself (e.g. sacrifice Lion's Eye Diamond with a wheel on the stack). Ctrl/Cmd-click a card to hold for that one spell.">
      <input type="checkbox" checked={auto.hold} onChange={(e) => setAuto({ hold: e.target.checked })} /> Hold priority
    </label>
  );
  if (inline) {
    return (
      <div className="auto-toggles">
        {autoPass}
        {hold}
        <label className={`tgl ${auto.fullControl ? 'on' : ''}`} title="Stop at every step and never auto-pass">
          <input type="checkbox" checked={auto.fullControl} onChange={(e) => setFullControl(e.target.checked)} /> Full control
        </label>
        {auto.yields.length > 0 && <button className="tiny" onClick={() => setAuto({ yields: [] })}>Clear yields ({auto.yields.length})</button>}
        <StopsEditor />
      </div>
    );
  }
  return (
    <div className="auto-toggles">
      {autoPass}
      {hold}
      {auto.fullControl && <span className="tgl on" title="Full control is on">Full control</span>}
      <button className={`tiny settings-btn ${pop ? 'sel' : ''}`} title="Stops (my turn / opponent's turn), full control, hover zoom"
        onClick={(e) => setPop(pop ? null : e.currentTarget.getBoundingClientRect())}>Stops ▾</button>
      {pop && <SettingsPopover anchor={pop} onClose={closePop} auto={auto} setAuto={setAuto} setFullControl={setFullControl} />}
    </div>
  );
}

/**
 * Proposals the opponent must agree to (like fix mode): Scry 1, discard at random (me / opponent) and, in fix mode,
 * shuffle a card from my hand into my library.
 */
function proposeItems(ctx: GameCtx): MenuItem[] {
  const { g, me, opp, act, pickOption, toast } = ctx;
  if (!me || g.phase !== 'playing') return [];
  const busy = !!g.proposal;
  const send = async (a: GameAction) => { const err = await act(a); if (err) toast(err); };
  const name = (pid: string) => g.players.find((p) => p.pid === pid)?.name ?? '?';
  const hand = g.players.find((p) => p.pid === me)?.zones.hand ?? [];
  const items: MenuItem[] = [
    { label: 'Scry 1 (ask opponent)', disabled: busy, onClick: () => send({ t: 'propose', kind: 'scry1' }) },
    { label: 'I discard a card at random (ask opponent)', disabled: busy || !hand.length, onClick: () => send({ t: 'propose', kind: 'discardRandom', target: me }) },
    { label: `${name(opp)} discards a card at random (ask)`, disabled: busy, onClick: () => send({ t: 'propose', kind: 'discardRandom', target: opp }) },
  ];
  if (fixModeOn(g) || !isStrictGame(g)) {
    items.push({
      label: 'Shuffle a card from hand into library… (ask opponent)', disabled: busy || !hand.length, onClick: async () => {
        const iid = await pickOption('Shuffle which card into your library?', hand.map((i) => {
          const c = g.cards[i];
          return { value: i, label: c && !isHidden(c) ? faceOf(c, getCard).name : 'Card' };
        }));
        if (iid) await send({ t: 'propose', kind: 'shuffleIntoLibrary', iid });
      },
    });
  }
  return items;
}

function PassButton({ okRef }: { okRef: React.MutableRefObject<() => void> }) {
  const gctx = useGame();
  const { g, me, opp, act, openMenu, undo } = gctx;
  const phone = useLayout() !== 'desktop';
  const myTurn = g.activePlayer === me;
  const havePriority = g.priority === me && g.phase === 'playing';
  const name = (pid: string) => g.players.find((p) => p.pid === pid)?.name ?? '?';
  const attackers = g.battlefield.filter((id) => g.cards[id].attacking).length;
  const landLeft = me ? landPlaysLeft(g, me) : null;
  const landsPlayed = (g.players.find((p) => p.pid === me) as { landsPlayed?: number } | undefined)?.landsPlayed ?? 0;
  // Floating mana of both players, right by the pass button (me first).
  const pools = g.players.filter((pl) => Object.values(pl.manaPool).some((n) => n > 0)).sort((a) => (a.pid === me ? -1 : 1));

  let okLabel = 'Pass';
  if (g.stack.length) okLabel = 'Resolve';
  else if (g.step === 'attackers' && myTurn && !g.combat.attackersDeclared) okLabel = attackers ? `Attack with ${attackers}` : 'No attacks';
  else if (g.step === 'blockers' && !myTurn && !g.combat.blockersDeclared) okLabel = 'Confirm blocks';
  else if (g.step === 'damage' && g.combat.proposal) okLabel = 'Confirm damage';
  else if (myTurn) {
    const next = STEPS[STEPS.indexOf(g.step) + 1];
    okLabel = next && next !== 'cleanup' ? `To ${STEP_LABELS[next]}` : 'End turn';
  }
  okRef.current = () => { if (havePriority) act({ t: 'pass' }); };
  // Declare attackers: "Attack with all" (every creature that can legally attack the opponent) / "Clear attackers".
  const declaring = havePriority && myTurn && g.step === 'attackers' && !g.combat.attackersDeclared;
  const canAttackAll = declaring ? attackAllCandidates(g, me, opp) : [];
  const myAttackers = declaring ? g.battlefield.filter((id) => g.cards[id].attacking && g.cards[id].controller === me) : [];

  return (
    <div className="priority">
      {phone && g.phase === 'playing' && me && landLeft != null && !declaring && <span className={`land-plays land-chip ${landLeft === 0 ? 'none' : ''}`}>Land {landsPlayed}/{landsPlayed + landLeft}</span>}
      {pools.length > 0 && (
        <div className="pool-float">
          {pools.map((pl) => (
            <span key={pl.pid} className={`pool-chip ${pl.pid === me ? 'mine' : 'theirs'}`} title={`${pl.name}'s floating mana`}>
              <span className="mp-label">{pl.pid === me ? 'Your mana' : pl.name}</span><ManaPips pool={pl.manaPool} />
            </span>
          ))}
        </div>
      )}
      {declaring && (canAttackAll.length > 0 || myAttackers.length > 0) && (
        <div className="attack-all">
          {canAttackAll.length > 0 && <button className="attack-all-btn" title="Declare every creature that can attack your opponent"
            onClick={() => { for (const iid of canAttackAll) act({ t: 'declareAttacker', iid, target: opp }); }}>{phone ? 'Attack all' : 'Attack with all'}</button>}
          {myAttackers.length > 0 && <button className="clear-attackers-btn" title="Remove all declared attackers"
            onClick={() => { for (const iid of myAttackers) act({ t: 'declareAttacker', iid, target: null }); }}>{phone ? 'Clear' : 'Clear attackers'}</button>}
        </div>
      )}
      {g.phase === 'playing' && me && (havePriority
        ? <button className="primary ok" onClick={() => act({ t: 'pass' })} title="F2 / Space">{okLabel}</button>
        : <span className="waiting">Waiting for {name(g.priority)}…</span>)}
      {me && g.phase === 'playing' && phone && (
        <button className="more-btn" aria-label="More actions" onClick={(e) => openMenu(e.clientX, e.clientY, [
          ...(myTurn ? [{ label: 'End turn', onClick: () => act({ t: 'nextTurn' }) }] : []),
          { label: 'Pass to end of turn', onClick: () => act({ t: 'passUntilEOT' }) },
          { label: 'Undo', disabled: !g.canUndo, onClick: undo },
          ...(!fixModeOn(g) && !fixRequest(g) && isStrictGame(g) ? [{ label: 'Fix board (ask opponent)', onClick: () => act({ t: 'requestFixMode' } as never) }] : []),
          // A second menu (not a submenu): the phone menu stays short enough not to scroll.
          { label: 'Propose… (opponent agrees)', onClick: () => openMenu(e.clientX, e.clientY, proposeItems(gctx), 'Propose') },
        ], 'Actions')}>⋯</button>
      )}
      {me && g.phase === 'playing' && !phone && (
        <div className="sub-actions">
          {myTurn && <button className="tiny" onClick={() => act({ t: 'nextTurn' })} title="Skip to the end of your turn">End turn</button>}
          <button className="tiny" onClick={() => act({ t: 'passUntilEOT' })} title="F6 / Ctrl+Space: auto-pass until end of turn">Pass to EOT</button>
          {!fixModeOn(g) && !fixRequest(g) && isStrictGame(g) && <button className="tiny" title="Ask your opponent to let you fix the board by hand" onClick={() => act({ t: 'requestFixMode' } as never)}>Fix board</button>}
          <button className="tiny propose-btn" title="Ask your opponent to agree to: scry 1, a random discard, or (fix mode) shuffling a card into your library"
            onClick={(e) => openMenu(e.clientX, e.clientY, proposeItems(gctx), 'Propose')}>Propose…</button>
          <button className="tiny undo-btn" disabled={!g.canUndo} onClick={undo} title="Ctrl+Z (closes any open popup first)">Undo</button>
          <button className="tiny" onClick={(e) => openMenu(e.clientX, e.clientY, [
            { label: 'Stops: gold dot = your turn, red dot = opponent\'s turn. Edit both under "Stops".', disabled: true },
            { label: 'Right-click a phase to toggle a stop for the current turn type.', disabled: true },
            { label: 'Right-click a trigger on the stack to always yield to it.', disabled: true },
            { label: 'Ctrl/Cmd-click a card (or turn on "Hold priority") to keep priority after casting it.', disabled: true },
          ], 'Help')}>?</button>
        </div>
      )}
    </div>
  );
}

function targetName(g: GameView, r: TargetRef): string {
  if (r.kind === 'player') return g.players.find((p) => p.pid === r.pid)?.name ?? '?';
  if (r.kind === 'stack') { const it = g.stack.find((x) => x.id === r.id); return it ? it.text : 'stack item'; }
  const c = g.cards[r.iid];
  return c && !isHidden(c) ? faceOf(c, getCard).name : 'a card';
}

function Stack({ yields, setAuto }: { yields: string[]; setAuto: (p: Partial<AutoSettings>) => void }) {
  const { g, act, openMenu, menuFor, mode, pickTarget, isLegal, setHoverTargets } = useGame();
  if (!g.stack.length) return null;
  const targeting = mode?.kind === 'target';
  const stackItems = (s: (typeof g.stack)[number], yieldable: boolean, yielding: boolean, src: string | undefined): MenuItem[] => {
    const items = s.iid ? menuFor(s.iid) : [];
    if (yieldable) items.push({ label: yielding ? `Stop yielding to ${src}` : `Always yield to this (${src})`, onClick: () => setAuto({ yields: yielding ? yields.filter((y) => y !== src) : [...yields, src!] }) });
    return items;
  };
  return (
    <div className="stack">
      <div className="stack-title">Stack ({g.stack.length})</div>
      {g.stack.slice().reverse().map((s, i, arr) => {
        const c = s.iid ? g.cards[s.iid] : undefined;
        const face = c && !isHidden(c) && !c.faceDown ? faceOf(c, getCard) : undefined;
        // Abilities and triggers show their source's art (also once the source has left the battlefield, e.g. a fetchland).
        const srcCard = !c && s.sourceIid ? g.cards[s.sourceIid] : undefined;
        const srcFace = srcCard && !isHidden(srcCard) && !srcCard.faceDown ? faceOf(srcCard, getCard) : undefined;
        const art = face ?? srcFace;
        const refs = s.auto?.targets?.flat() ?? [];
        const legal = targeting ? isLegal({ kind: 'stack', id: s.id }) : null;
        const src = sourceName(g, s);
        const yieldable = s.kind !== 'spell' && !!src;
        const yielding = !!src && yields.includes(src);
        return (
          <div key={s.id} className={`stack-item ${i === 0 ? 'top' : ''} ${s.kind} ${targeting ? (legal ? 'legal-target' : 'dim') : ''}`}
            style={{ zIndex: arr.length - i }}
            data-stack-id={s.id}
            onMouseEnter={() => { if (art) setPreview({ face: art, extra: face ? undefined : s.text }); if (refs.length) setHoverTargets(refs.flatMap((r) => (r.kind === 'card' ? [r.iid] : []))); }}
            onMouseLeave={() => refs.length && setHoverTargets([])}
            onClick={targeting ? (e) => { e.stopPropagation(); pickTarget({ kind: 'stack', id: s.id }); } : isTouch() ? (e) => {
              e.stopPropagation();
              const items = stackItems(s, yieldable, yielding, src);
              if (art) showSheet({ face: art, extra: `${s.text} · ${g.players.find((p) => p.pid === s.controller)?.name ?? ''}`, items });
              else if (items.length) openMenu(e.clientX, e.clientY, items, src);
            } : undefined}
            onContextMenu={(e) => {
              e.preventDefault();
              const items = stackItems(s, yieldable, yielding, src);
              if (items.length) openMenu(e.clientX, e.clientY, items, face?.name ?? src);
            }}>
            {art ? <CardImage face={art} className="stack-img" />
              : c ? <CardBack className="stack-img" />
                : <div className="stack-ability">⚡</div>}
            {!face && art && <div className="stack-kind">{s.kind === 'trigger' ? 'Trigger' : 'Ability'}</div>}
            <div className="stack-text">
              <b>{s.auto && <span className="auto-badge" title="Resolved automatically">⚡ </span>}{s.kind === 'trigger' && <span className="trigger-badge">trigger</span>}{yielding && <span className="trigger-badge" title="Auto-yield on">yield</span>}{s.text}</b>
              <small>{!face && srcFace ? `${srcFace.name} · ` : ''}{g.players.find((p) => p.pid === s.controller)?.name}{s.x != null ? ` · X=${s.x}` : ''}</small>
              {refs.length > 0 && <small className="stack-targets">→ {refs.map((r) => targetName(g, r)).join(', ')}</small>}
            </div>
            {i === 0 && !targeting && manualOk(g) && (
              <div className="stack-btns">
                <button className="tiny" onClick={() => act({ t: 'resolve' })} title="Force-resolve now">Resolve</button>
                <button className="tiny" onClick={() => act({ t: 'counterTop' })}>Counter</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TargetBanner({ mode, advance, cancel }: { mode: Extract<NonNullable<Mode>, { kind: 'target' }>; advance: (m: typeof mode, chosen: TargetRef[][]) => void; cancel: () => void }) {
  const spec = mode.specs[mode.specIndex];
  const n = mode.chosen[mode.specIndex].length;
  const range = spec.min === spec.max ? `${spec.max}` : `${spec.min}–${spec.max}`;
  return (
    <div className="mode-hint target-hint" onClick={(e) => e.stopPropagation()}>
      <span>{mode.label}: choose target: {spec.prompt || spec.valid} ({mode.specIndex + 1} of {mode.specs.length}; {n}/{range} chosen)</span>
      <button className="tiny" disabled={n < spec.min} onClick={() => advance(mode, mode.chosen)}>Done</button>
      {spec.min === 0 && n > 0 && <button className="tiny" onClick={() => advance(mode, mode.chosen.map((l, i) => (i === mode.specIndex ? [] : l)))}>Skip</button>}
      {spec.min === 0 && n === 0 && <button className="tiny" onClick={() => advance(mode, mode.chosen)}>Skip</button>}
      <button className="tiny" onClick={cancel}>Cancel (Esc)</button>
    </div>
  );
}

/** Lists legal graveyard cards of every player while choosing a graveyard target. */
function GraveyardPicker({ spec }: { spec: TargetSpec }) {
  const { g, mode, pickTarget, isLegal } = useGame();
  const ids = g.players.flatMap((p) => p.zones.graveyard).filter((iid) => isLegal({ kind: 'card', iid }));
  const chosen = mode?.kind === 'target' ? mode.chosen[mode.specIndex] : [];
  return (
    <div className="target-picker" onClick={(e) => e.stopPropagation()}>
      <div className="muted small">Graveyards — {spec.prompt || spec.valid}</div>
      <div className="zone-grid">
        {ids.map((iid) => {
          const c = g.cards[iid];
          if (!c || isHidden(c)) return null;
          const face = faceOf(c, getCard);
          return (
            <div key={iid} className={`zcard legal-target ${chosen.some((r) => r.kind === 'card' && r.iid === iid) ? 'targeted' : ''}`} onMouseEnter={() => setPreview({ face })} onClick={() => pickTarget({ kind: 'card', iid })}>
              <CardImage face={face} />
            </div>
          );
        })}
        {ids.length === 0 && <span className="muted">No legal cards in graveyards.</span>}
      </div>
    </div>
  );
}

function PendingChoices() {
  const { g, me, act, mode, setMode, undo } = useGame();
  const mine = g.pending?.find((p) => p.pid === me);
  const others = (g.pending ?? []).filter((p) => p.pid !== me);
  const handling = useRef<string | null>(null); // pending id currently in targeting mode
  const [dismissed, setDismissed] = useState<string | null>(null); // pending id whose targeting was cancelled
  const tg = mine?.targets;
  const mineId = mine?.id;
  const startTargeting = useCallback((p: NonNullable<typeof mine>) => {
    const t = p.targets;
    if (!t) return;
    handling.current = p.id;
    setDismissed(null);
    setMode({
      kind: 'target', label: t.label, specs: t.specs, specIndex: 0, chosen: t.specs.map(() => []),
      controller: t.controller, sourceIid: t.sourceIid,
      onDone: (res) => {
        if (res) act({ t: 'chooseTargets', id: p.id, targets: res });
        else { handling.current = null; setDismissed(p.id); }
      },
    });
  }, [act, setMode]);
  useEffect(() => {
    if (!mine || !tg) return;
    if (handling.current === mine.id || dismissed === mine.id) return;
    if (mode) return; // wait until the current mode ends
    startTargeting(mine);
  }, [mine, tg, mode, dismissed, startTargeting]);
  // Pending answered/removed: forget it and leave targeting mode if it was ours.
  useEffect(() => {
    if (handling.current && !g.pending?.some((p) => p.id === handling.current)) {
      handling.current = null;
      if (mode?.kind === 'target') setMode(null);
    }
  }, [g.pending, mode, setMode]);
  const revealedIds = mine ? pendingRevealed(mine) : [];
  const targetingThis = !!tg && mode?.kind === 'target' && handling.current === mineId;
  const showModal = mine && !mine.divide && (!tg || (dismissed === mineId && mine.options.length > 0));
  return (
    <>
      {mine && tg && dismissed === mineId && (
        <div className="mode-hint target-hint" onClick={(e) => e.stopPropagation()}>
          <span>{mine.prompt}</span>
          <button className="tiny" onClick={() => startTargeting(mine)}>Choose targets for {tg.label}</button>
        </div>
      )}
      {mine?.divide && <PendingDivide pending={mine} />}
      {showModal && (
        <div className="modal-bg pending-bg" onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal pending" onMouseDown={(e) => e.stopPropagation()}>
            <p>{mine.prompt}</p>
            <RevealedPick pending={mine} />
            <div className="row">
              {tg && <button className="primary" onClick={() => startTargeting(mine)}>Choose targets for {tg.label}</button>}
              {mine.options.filter((o) => !revealedIds.includes(o.value)).map((o) => <PendingOption key={o.value} o={o} onClick={() => act({ t: 'choose', id: mine.id, value: o.value })} />)}
            </div>
            {g.canUndo && <div className="row modal-undo"><button className="tiny undo-btn" onClick={undo} title="Ctrl+Z">Undo</button></div>}
          </div>
        </div>
      )}
      {targetingThis && mine.options.length > 0 && (
        <div className="mode-hint target-hint pending-skip" onClick={(e) => e.stopPropagation()}>
          {mine.options.map((o) => <PendingOption key={o.value} tiny o={o} onClick={() => act({ t: 'choose', id: mine.id, value: o.value })} />)}
        </div>
      )}
      {others.map((p) => (
        <div key={p.id} className="undo-req pending-wait">Waiting for {g.players.find((x) => x.pid === p.pid)?.name ?? '?'} to decide: {p.prompt}</div>
      ))}
    </>
  );
}

/** Pending.divide: split `total` among the targets; answered with 'choose' and a JSON {key: amount}. */
function PendingDivide({ pending }: { pending: { id: string; prompt: string; options: { value: string; label: string }[]; divide?: { total: number; min: number; targets: { key: string; label: string }[] } } }) {
  const { act } = useGame();
  const d = pending.divide!;
  let even: Record<string, number> | undefined;
  try { const o = pending.options[0]; even = o ? JSON.parse(o.value) : undefined; } catch { even = undefined; }
  const validate = (v: Record<string, number>) => {
    const sum = d.targets.reduce((a, t) => a + (v[t.key] ?? 0), 0);
    if (d.targets.some((t) => (v[t.key] ?? 0) < d.min)) return `Each target needs at least ${d.min}`;
    return sum === d.total ? null : `Amounts must total ${d.total} (now ${sum})`;
  };
  return <DivideModal title={pending.prompt} total={d.total} targets={d.targets} even={even} validate={validate}
    onDone={(v) => { if (v) act({ t: 'choose', id: pending.id, value: JSON.stringify(v) }); }} />;
}

/** Cards revealed by a question (Duress-style): legal choices are clickable, the rest dimmed. */
function RevealedPick({ pending }: { pending: { id: string; options: { value: string; label: string }[] } }) {
  const { g, act } = useGame();
  const ids = pendingRevealed(pending);
  if (!ids.length) return null;
  return (
    <div className="revealed-pick">
      {ids.map((iid) => {
        const c = g.cards[iid];
        if (!c || isHidden(c)) return null;
        const face = faceOf(c, getCard);
        const opt = pending.options.find((o) => o.value === iid);
        return (
          <button key={iid} className={`rv ${opt ? 'legal' : 'illegal'}`} disabled={!opt} title={opt ? opt.label : `${face.name} (not a legal choice)`}
            onMouseEnter={() => setPreview({ face })} onClick={() => opt && act({ t: 'choose', id: pending.id, value: iid })}>
            <CardImage face={face} />
          </button>
        );
      })}
    </div>
  );
}

/** A pending answer: a small card image (hover preview) when the value is a visible card, else a text button. */
function PendingOption({ o, onClick, tiny }: { o: { value: string; label: string }; onClick: () => void; tiny?: boolean }) {
  const { g, faceByName } = useGame();
  const c = g.cards[o.value];
  // A card the view keeps hidden (library search): picture from my deck list by the option's name.
  const face = c && !isHidden(c) ? faceOf(c, getCard) : (!c || isHidden(c)) && o.value !== 'none' && /^[\w-]{6,}$/.test(o.value) ? faceByName(o.label) : undefined;
  if (face) {
    return (
      <button className="pend-card" title={o.label} onMouseEnter={() => setPreview({ face })} onClick={onClick}>
        <CardImage face={face} /><span>{o.label}</span>
      </button>
    );
  }
  return <button className={tiny ? 'tiny' : 'primary'} onClick={onClick}>{o.label}</button>;
}

function CombatPanel() {
  const { g, act } = useGame();
  const prop = g.combat.proposal;
  if (!prop) return null;
  return (
    <div className="combat-panel">
      <b>Combat damage</b>
      <ul>{prop.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
      {prop.dies.length > 0 && <div className="muted">Dies: {prop.dies.map((id) => { const c = g.cards[id]; return c && !isHidden(c) ? faceOf(c, getCard).name : '?'; }).join(', ')}</div>}
      <div className="muted small">Confirmed by: {prop.confirmed.map((p) => g.players.find((x) => x.pid === p)?.name).join(', ') || 'nobody yet'}</div>
      <div className="row">
        <button className="tiny" onClick={() => act({ t: 'proposeDamage' })}>Recalculate</button>
        <button className="tiny" onClick={() => act({ t: 'clearCombat' })} title="Skip the automatic result and handle damage by hand">Handle manually</button>
      </div>
    </div>
  );
}

function ActiveEffects() {
  const { g, setHoverTargets } = useGame();
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('ojb:effects') !== '0'; } catch { return true; } });
  const list = safeStatics(g);
  if (!list.length) return null;
  const toggle = () => { const n = !open; setOpen(n); try { localStorage.setItem('ojb:effects', n ? '1' : '0'); } catch { /* ignore */ } };
  return (
    <div className="active-effects">
      <div className="ae-head" onClick={toggle}>{open ? '▾' : '▸'} Active effects ({list.length})</div>
      {open && (
        <div className="ae-list">
          {list.map((s, i) => {
            const c = g.cards[s.sourceIid];
            const f = c && !isHidden(c) ? faceOf(c, getCard) : null;
            return (
              <div key={i} className="ae-item"
                onMouseEnter={() => { if (f) setPreview({ face: f }); setHoverTargets([s.sourceIid]); }}
                onMouseLeave={() => setHoverTargets([])}>
                <b>{f?.name ?? 'Unknown'}</b>{' '}
                {s.support !== 'full' && <span className="ae-badge" title="The engine does not fully apply this effect">reminder — apply by hand</span>}
                <div className="muted small">{s.description || s.mode}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GameLog() {
  const { g, me, act } = useGame();
  const [text, setText] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => g.log.slice(-200), [g.log]);
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight); }, [entries.length]);
  return (
    <div className="game-log">
      <div className="log-entries" ref={ref}>
        {entries.map((e, i) => <div key={i} className={`log-entry ${e.pid === me ? 'mine' : e.pid ? 'theirs' : 'sys'}`}>{e.text}</div>)}
      </div>
      {me && <input placeholder="Chat with your opponent…" value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && text.trim()) { act({ t: 'chat', text }); setText(''); } }} />}
    </div>
  );
}
