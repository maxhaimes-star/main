import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type GameAction, type GameView, isHidden, faceOf, type MatchView, STEP_LABELS, STEPS, type Step, type TargetRef, type TargetSpec, type ViewPlayer, type Zone,
} from '@ojb/shared';
import type { RoomProps } from '../Room.tsx';
import { CardBack, CardImage, getCard, PreviewPanel, setPreview } from '../cards.tsx';
import { Ctx, ContextMenu, type GameCtx, type MenuItem, type Mode, Prompt, TableCard, useGame, ModesModal, OptionsModal, DivideModal, type PickOption } from './ui.tsx';
import { castWithX, defaultAction as defaultActionImpl, menuFor as menuForImpl } from './actions.ts';
import { castStatus, AUTO_LABEL, costNote, legalTarget, optionText, safeCastOptions, safeStatics } from './engine.ts';
import { MulliganOverlay, PeekModal, Sideboarding, TokenModal, ZoneViewer } from './Modals.tsx';

type PromptState = { label: string; initial: string; numeric: boolean; resolve: (v: string | null) => void } | null;

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
  const me = g.me;
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
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toast = useCallback((msg: string) => { setToastMsg(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToastMsg(null), 2200); }, []);

  const [forceAsk, setForceAsk] = useState<{ error: string; resolve: (yes: boolean) => void } | null>(null);
  const rawAct = useCallback((action: GameAction) => send({ t: 'game', matchId: match.id, action }) as Promise<string | null>, [send, match.id]);
  // Static restrictions (Teferi, Ensnaring Bridge ...) come back as errors mentioning "force": offer to override.
  const act = useCallback(async (action: GameAction): Promise<string | null> => {
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

  const base = { g, me, act, ask, askText, pickModes, pickOption, divide, setMode, opp, mode, target };
  const menuFor = (iid: string) => menuForImpl(base, iid);
  const defaultAction = (iid: string) => defaultActionImpl(base, iid, menuFor, (items, title) => {
    const el = document.querySelector(`[data-iid="${iid}"]`)?.getBoundingClientRect();
    setMenu({ x: el ? el.left + el.width / 2 : innerWidth / 2, y: el ? el.top + 20 : innerHeight / 2, items, title });
  });

  const ctx: GameCtx = {
    g, me, self, opp, act, openMenu, mode, setMode, ask, askText, pickModes, pickOption, divide,
    openZone: (pid, z) => setZone({ pid, zone: z }), openTokens: () => setTokens(true), menuFor, defaultAction,
    target, pickTarget, isLegal, cast: (iid, face) => { castWithX(base, iid, face); }, toast, hoverTargets, setHoverTargets,
  };

  // Keyboard shortcuts
  const okRef = useRef<() => void>(() => {});
  const modeRef = useRef<Mode>(null);
  modeRef.current = mode;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      if (e.key === 'F2' || (e.key === ' ' && !e.repeat && t.tagName !== 'BUTTON')) { e.preventDefault(); okRef.current(); }
      if (e.key === 'F6') { e.preventDefault(); act({ t: 'passUntilEOT' }); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); act({ t: 'requestUndo' }); }
      if (e.key === 'Escape') { if (modeRef.current?.kind === 'target') modeRef.current.onDone(null); setMode(null); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [act]);

  const mePlayer = g.players.find((p) => p.pid === me);

  return (
    <Ctx.Provider value={ctx}>
      <div className={`table ${mode ? `mode-${mode.kind}` : ''}`} onClick={() => mode && mode.kind !== 'target' && setMode(null)}>
        <div className="table-main">
          <PlayerArea pid={opp} top />
          <CenterBar okRef={okRef} match={match} onLeave={onLeave} />
          <PlayerArea pid={self} />
          {me && <Hand pid={me} />}
        </div>
        <div className="table-side">
          <PreviewPanel />
          <ActiveEffects />
          <GameLog />
        </div>
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
        {mode && mode.kind !== 'target' && mode.kind !== 'attackPW' && (
          <div className="mode-hint">
            {mode.kind === 'attach' && 'Click the card to attach to (Esc to cancel)'}
            {mode.kind === 'block' && 'Click an attacking creature to block it (Esc to cancel)'}
          </div>
        )}
        {mode?.kind === 'target' && <TargetBanner mode={mode} advance={advance} cancel={cancelTarget} />}
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

function PlayerArea({ pid, top }: { pid: string; top?: boolean }) {
  const ctx = useGame();
  const { g } = ctx;
  const p = g.players.find((x) => x.pid === pid)!;
  const mine = g.battlefield.filter((id) => g.cards[id]?.controller === pid);
  const attachedTo = (id: string) => mine.filter((x) => g.cards[x].attachedTo === id).concat(g.battlefield.filter((x) => g.cards[x].attachedTo === id && g.cards[x].controller !== pid));
  const roots = mine.filter((id) => { const a = g.cards[id].attachedTo; return !a || !g.cards[a] || g.cards[a].zone !== 'battlefield'; });
  const isLand = (id: string) => { const c = g.cards[id]; return !isHidden(c) && !c.faceDown && faceOf(c, getCard).types.includes('Land') && !faceOf(c, getCard).types.includes('Creature'); };
  const isCreature = (id: string) => { const c = g.cards[id]; return isHidden(c) || c.faceDown || faceOf(c, getCard).types.includes('Creature') || (c.counters.animated ?? 0) > 0; };
  const lands = roots.filter(isLand);
  const creatures = roots.filter((id) => !isLand(id) && isCreature(id));
  const other = roots.filter((id) => !isLand(id) && !isCreature(id));
  const drop = useDrop((iid) => {
    const c = g.cards[iid];
    if (c?.zone === 'battlefield' && c.controller !== pid && ctx.me) ctx.act({ t: 'control', iid, pid });
    else dropTo(ctx, iid, 'battlefield');
  });
  const row = (ids: string[], cls: string) => (
    <div className={`bf-row ${cls}`}>{ids.map((id) => <TableCard key={id} iid={id} attachments={attachedTo(id)} />)}</div>
  );
  const rows = [row(creatures, 'creatures'), row(other, 'others'), row(lands, 'lands')];
  return (
    <div className={`player-area ${top ? 'top' : 'bottom'} ${g.activePlayer === pid ? 'active' : ''}`}>
      <PlayerPanel p={p} />
      <div className={`battlefield ${drop.over ? 'drop-over' : ''}`} {...drop.props}>
        {top ? rows.slice().reverse() : rows}
      </div>
      <Zones p={p} />
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
  return (
    <div className={`player-panel ${g.priority === p.pid && g.phase === 'playing' ? 'has-priority' : ''} ${targeting ? (legal ? 'legal-target' : 'dim') : ''} ${chosen ? 'targeted' : ''}`}
      onClick={targeting ? (e) => { e.stopPropagation(); pickTarget({ kind: 'player', pid: p.pid }); } : undefined}>
      <div className="pp-name">
        <span className={`dot ${p.conceded ? '' : 'on'}`} />{p.name}
        {g.activePlayer === p.pid && <span className="turn-badge">turn</span>}
      </div>
      <div className="life">
        {me && <button onClick={() => life(-1)} onContextMenu={(e) => { e.preventDefault(); life(-5); }} title="−1 (right-click −5)">−</button>}
        <span className={`life-num ${p.life <= 5 ? 'low' : ''}`} onClick={async () => { if (!me) return; const n = await ask(`Set ${p.name}'s life to`, p.life); if (n != null) life(n - p.life); }}>{p.life}</span>
        {me && <button onClick={() => life(1)} onContextMenu={(e) => { e.preventDefault(); life(5); }} title="+1 (right-click +5)">+</button>}
      </div>
      <div className="pcounters">
        {Object.entries(p.counters).filter(([, v]) => v > 0).map(([k, v]) => (
          <span key={k} className="pctr" title="click +1, right-click −1"
            onClick={() => me && act({ t: 'playerCounter', pid: p.pid, kind: k, delta: 1 })}
            onContextMenu={(e) => { e.preventDefault(); if (me) act({ t: 'playerCounter', pid: p.pid, kind: k, delta: -1 }); }}>{k} {v}</span>
        ))}
        {me && <button className="tiny" title="Add a player counter (poison, energy, experience, rad…)" onClick={async () => { const k = await askText('Counter (poison, energy, experience, rad, tickets…)', 'poison'); if (k) act({ t: 'playerCounter', pid: p.pid, kind: k, delta: 1 }); }}>+ctr</button>}
      </div>
      {p.designations.length > 0 && <div className="designations">{p.designations.map((d) => <span key={d} className="desig" onClick={() => isMe && act({ t: 'designation', name: d, on: false })}>{d === 'Monarch' ? '👑' : d === 'Initiative' ? '🗺' : '✦'} {d}</span>)}</div>}
      {(pool.length > 0 || isMe) && (
        <div className="mana-pool">
          {pool.map(([m, n]) => <span key={m} className={`pip pip-${m}`} title="click to spend 1" onClick={() => isMe && act({ t: 'addMana', mana: m, n: -1 })}>{m}{n > 1 ? `×${n}` : ''}</span>)}
          {isMe && <AddMana />}
        </div>
      )}
      {!isMe && me && <button className="tiny" onClick={() => act({ t: 'lookAtHand', pid: viewing ? null : p.pid })}>{viewing ? 'Hide hand' : 'Look at hand'}</button>}
      {!isMe && <span className="muted small">✋ {p.handCount}</span>}
      {p.zones.command.length > 0 && <button className="tiny" onClick={() => openZone(p.pid, 'command')}>Command ({p.zones.command.length})</button>}
      {isMe && <MyTools p={p} />}
      {!isMe && p.zones.hand.some((iid) => !isHidden(g.cards[iid])) && <button className="tiny" onClick={() => openZone(p.pid, 'hand')}>See revealed</button>}
    </div>
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
      <div className={`zone lib ${libDrop.over ? 'drop-over' : ''}`} {...libDrop.props} onClick={isMe ? libMenu : undefined} title={isMe ? 'Library — click for options (drop a card here to put it on top)' : 'Library'}>
        <CardBack label={String(p.libraryCount)} />
        {revealedTop.length > 0 && <div className="revealed-top" onMouseEnter={() => { const c = g.cards[revealedTop[0]]; if (!isHidden(c)) setPreview({ face: faceOf(c, getCard) }); }}>top: {revealedTop.map((i) => { const c = g.cards[i]; return isHidden(c) ? '?' : faceOf(c, getCard).name; }).join(', ')}</div>}
      </div>
      <div className={`zone gy ${gyDrop.over ? 'drop-over' : ''}`} {...gyDrop.props} onClick={() => openZone(p.pid, 'graveyard')} title="Graveyard">
        {topGy && !isHidden(g.cards[topGy]) ? <CardImage face={faceOf(g.cards[topGy] as never, getCard)} /> : <div className="empty-zone">GY</div>}
        <span className="zone-count">{p.zones.graveyard.length}</span>
      </div>
      <div className={`zone ex ${exDrop.over ? 'drop-over' : ''}`} {...exDrop.props} onClick={() => openZone(p.pid, 'exile')} title="Exile">
        {topEx && !isHidden(g.cards[topEx]) && !g.cards[topEx].faceDown ? <CardImage face={faceOf(g.cards[topEx] as never, getCard)} /> : <div className="empty-zone">Exile</div>}
        <span className="zone-count">{p.zones.exile.length}</span>
      </div>
    </div>
  );
}

function MyTools({ p }: { p: ViewPlayer }) {
  const ctx = useGame();
  const { act, openZone, openMenu, openTokens } = ctx;
  return (
    <div className="my-tools">
      <button className="tiny" onClick={() => openZone(p.pid, 'sideboard')}>Sideboard</button>
      <button className="tiny" onClick={openTokens}>Tokens</button>
      <button className="tiny" onClick={(e) => openMenu(e.clientX, e.clientY, [
        { label: 'Untap all my permanents', onClick: () => act({ t: 'untapAll' }) },
        { label: 'Reveal my hand', onClick: () => act({ t: 'revealHand' }) },
        { label: `Automatic triggers: ${(p as { autoTriggers?: boolean }).autoTriggers === false ? 'off (click to turn on)' : 'on (click to turn off)'}`, onClick: () => act({ t: 'setAutoTriggers', on: (p as { autoTriggers?: boolean }).autoTriggers === false } as never) },
        ...['Monarch', 'Initiative', "City's blessing", 'Day', 'Night'].map((d) => ({ label: `${p.designations.includes(d) ? 'Lose' : 'Take'} ${d}`, onClick: () => act({ t: 'designation', name: d, on: !p.designations.includes(d) }) })),
        { label: 'Put a free trigger/effect on the stack…', onClick: async () => { const t = await ctx.askText('Text'); if (t) act({ t: 'trigger', text: t }); } },
        { label: 'Concede game', onClick: () => { if (confirm('Concede this game?')) act({ t: 'concede' }); } },
      ], 'More')}>More…</button>
    </div>
  );
}

// ---------------------------------------------------------------- hand

function Hand({ pid }: { pid: string }) {
  const ctx = useGame();
  const { g } = ctx;
  const p = g.players.find((x) => x.pid === pid)!;
  const drop = useDrop((iid) => dropTo(ctx, iid, 'hand'));
  return (
    <div className={`hand ${drop.over ? 'drop-over' : ''}`} {...drop.props}>
      {p.zones.hand.map((iid) => <HandCard key={iid} iid={iid} />)}
      {p.zones.hand.length === 0 && <span className="muted">Your hand is empty.</span>}
      <span className="hand-hint muted">Click: play / cast · Right-click: more · Drag to battlefield, graveyard, exile or library</span>
    </div>
  );
}

function HandCard({ iid }: { iid: string }) {
  const { g, me, menuFor, defaultAction, openMenu } = useGame();
  const c = g.cards[iid];
  if (!c || isHidden(c)) return <div className="hcard"><CardBack /></div>;
  const face = faceOf(c, getCard);
  const st = castStatus(c.cardId, 0);
  const altHints = c.owner === me ? safeCastOptions(g, iid, 0).filter((o) => o.id !== 'normal' && !o.unavailable).map((o) => `${o.label}: ${optionText(o)}`) : [];
  return (
    <div className={`hcard ${c.revealedTo.length ? 'revealed' : ''}`} data-iid={iid} draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/iid', iid); }}
      onMouseEnter={() => setPreview({ face, extra: [costNote(g, iid, 0, me), st ? AUTO_LABEL[st] : undefined, ...altHints].filter(Boolean).join(' · ') || undefined, backFace: c.cardId && getCard(c.cardId)?.faces ? (() => { const card = getCard(c.cardId!)!; return faceOf({ ...c, transformed: card.layout !== 'adventure' && card.layout !== 'split', castAs: card.layout === 'adventure' || card.layout === 'split' ? card.faces![1].name : undefined }, getCard); })() : undefined })}
      onClick={() => defaultAction(iid)}
      onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, menuFor(iid), face.name); }}>
      <CardImage face={face} />
    </div>
  );
}

// ---------------------------------------------------------------- center: phases, stack, priority

function CenterBar({ okRef, match, onLeave }: { okRef: React.MutableRefObject<() => void>; match: MatchView; onLeave?: () => void }) {
  const { g, me, act, openMenu } = useGame();
  const myTurn = g.activePlayer === me;
  const havePriority = g.priority === me && g.phase === 'playing';
  const name = (pid: string) => g.players.find((p) => p.pid === pid)?.name ?? '?';
  const attackers = g.battlefield.filter((id) => g.cards[id].attacking).length;
  const mePlayer = g.players.find((p) => p.pid === me);

  let okLabel = 'Pass';
  if (g.stack.length) okLabel = 'Resolve';
  else if (g.step === 'attackers' && myTurn && !g.combat.attackersDeclared) okLabel = attackers ? `Attack with ${attackers}` : 'No attack';
  else if (g.step === 'blockers' && !myTurn && !g.combat.blockersDeclared) okLabel = 'Confirm blocks';
  else if (g.step === 'damage' && g.combat.proposal) okLabel = 'Confirm damage';
  else if (myTurn) {
    const next = STEPS[STEPS.indexOf(g.step) + 1];
    okLabel = next && next !== 'cleanup' ? `To ${STEP_LABELS[next]}` : 'End turn';
  }
  okRef.current = () => { if (havePriority) act({ t: 'pass' }); };

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
        <div className="muted small">Game {match.gameNumber} · {match.wins[match.players[0]]}–{match.wins[match.players[1]]}</div>
        {onLeave && <button className="tiny" onClick={onLeave}>Stop watching</button>}
      </div>
      <div className="phases">
        {STEPS.filter((s) => s !== 'untap' && s !== 'cleanup').map((s) => {
          const own = myTurn;
          const stopped = mePlayer ? (own ? mePlayer.stops.own : mePlayer.stops.opp).includes(s) : false;
          return (
            <div key={s} className={`phase ${g.step === s ? 'current' : ''} ${STEPS.indexOf(s) < STEPS.indexOf(g.step) ? 'past' : ''}`}
              title={myTurn ? 'Click to skip ahead to this step. Right-click: toggle your stop.' : 'Right-click: toggle your stop on opponent turns.'}
              onClick={() => myTurn && STEPS.indexOf(s) > STEPS.indexOf(g.step) && act({ t: 'gotoStep', step: s })}
              onContextMenu={(e) => { e.preventDefault(); toggleStop(s, own); }}>
              {STEP_LABELS[s]}{stopped && <span className="stop-dot" />}
            </div>
          );
        })}
      </div>
      <Stack />
      <CombatPanel />
      <div className="priority">
        {g.phase === 'playing' && me && (havePriority
          ? <button className="primary ok" onClick={() => act({ t: 'pass' })} title="F2 / Space">{okLabel}</button>
          : <span className="waiting">Waiting for {name(g.priority)}…</span>)}
        {me && g.phase === 'playing' && (
          <div className="sub-actions">
            {myTurn && <button className="tiny" onClick={() => act({ t: 'nextTurn' })} title="Skip to the end of your turn">End turn</button>}
            <button className="tiny" onClick={() => act({ t: 'passUntilEOT' })} title="F6: auto-pass until end of turn">F6</button>
            <button className="tiny" disabled={!g.canUndo} onClick={() => act({ t: 'requestUndo' })} title="Ctrl+Z">Undo</button>
            <button className="tiny" onClick={(e) => openMenu(e.clientX, e.clientY, [
              { label: 'Stops are shown as dots on the phase bar.', disabled: true },
              { label: 'Right-click a phase to toggle a stop for the current turn type.', disabled: true },
            ], 'Help')}>?</button>
          </div>
        )}
      </div>
    </div>
  );
}

function targetName(g: GameView, r: TargetRef): string {
  if (r.kind === 'player') return g.players.find((p) => p.pid === r.pid)?.name ?? '?';
  if (r.kind === 'stack') { const it = g.stack.find((x) => x.id === r.id); return it ? it.text : 'stack item'; }
  const c = g.cards[r.iid];
  return c && !isHidden(c) ? faceOf(c, getCard).name : 'a card';
}

function Stack() {
  const { g, act, openMenu, menuFor, mode, pickTarget, isLegal, setHoverTargets } = useGame();
  if (!g.stack.length) return null;
  const targeting = mode?.kind === 'target';
  return (
    <div className="stack">
      <div className="stack-title">Stack</div>
      {g.stack.slice().reverse().map((s, i) => {
        const c = s.iid ? g.cards[s.iid] : undefined;
        const face = c && !isHidden(c) ? faceOf(c, getCard) : undefined;
        const refs = s.auto?.targets?.flat() ?? [];
        const legal = targeting ? isLegal({ kind: 'stack', id: s.id }) : null;
        return (
          <div key={s.id} className={`stack-item ${i === 0 ? 'top' : ''} ${targeting ? (legal ? 'legal-target' : 'dim') : ''}`}
            data-stack-id={s.id}
            onMouseEnter={() => { if (face) setPreview({ face }); if (refs.length) setHoverTargets(refs.flatMap((r) => (r.kind === 'card' ? [r.iid] : []))); }}
            onMouseLeave={() => refs.length && setHoverTargets([])}
            onClick={targeting ? (e) => { e.stopPropagation(); pickTarget({ kind: 'stack', id: s.id }); } : undefined}
            onContextMenu={(e) => { if (s.iid) { e.preventDefault(); openMenu(e.clientX, e.clientY, menuFor(s.iid), face?.name); } }}>
            {face ? <CardImage face={face} className="stack-img" /> : <div className="stack-ability">⚡</div>}
            <div className="stack-text">
              <b>{s.auto && <span className="auto-badge" title="Resolved automatically">⚡ </span>}{s.kind === 'trigger' && <span className="trigger-badge">trigger</span>}{s.text}</b>
              <small>{s.kind === 'trigger' && face ? `${face.name} · ` : ''}{g.players.find((p) => p.pid === s.controller)?.name}{s.x != null ? ` · X=${s.x}` : ''}</small>
              {refs.length > 0 && <small className="stack-targets">→ {refs.map((r) => targetName(g, r)).join(', ')}</small>}
            </div>
            {i === 0 && !targeting && (
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
  const { g, me, act, mode, setMode } = useGame();
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
  const targetingThis = !!tg && mode?.kind === 'target' && handling.current === mineId;
  const showModal = mine && (!tg || (dismissed === mineId && mine.options.length > 0));
  return (
    <>
      {mine && tg && dismissed === mineId && (
        <div className="mode-hint target-hint" onClick={(e) => e.stopPropagation()}>
          <span>{mine.prompt}</span>
          <button className="tiny" onClick={() => startTargeting(mine)}>Choose targets for {tg.label}</button>
        </div>
      )}
      {showModal && (
        <div className="modal-bg pending-bg" onMouseDown={(e) => e.stopPropagation()}>
          <div className="modal pending" onMouseDown={(e) => e.stopPropagation()}>
            <p>{mine.prompt}</p>
            <div className="row">
              {tg && <button className="primary" onClick={() => startTargeting(mine)}>Choose targets for {tg.label}</button>}
              {mine.options.map((o) => <PendingOption key={o.value} o={o} onClick={() => act({ t: 'choose', id: mine.id, value: o.value })} />)}
            </div>
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

/** A pending answer: a small card image (hover preview) when the value is a visible card, else a text button. */
function PendingOption({ o, onClick, tiny }: { o: { value: string; label: string }; onClick: () => void; tiny?: boolean }) {
  const { g } = useGame();
  const c = g.cards[o.value];
  if (c && !isHidden(c)) {
    const face = faceOf(c, getCard);
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
