import type { CardInstance, GameState, GameView, HiddenCard, ViewCard, ViewPlayer } from './types.ts';

/** Can `viewer` see the face of this card? (viewer null = spectator) */
export function canSee(state: GameState, viewer: string | null, c: CardInstance): boolean {
  if (viewer && c.revealedTo.includes(viewer)) return true;
  switch (c.zone) {
    case 'battlefield':
    case 'stack':
    case 'exile':
      if (!c.faceDown) return true;
      return viewer === c.controller || viewer === c.owner;
    case 'graveyard':
    case 'command':
      return true;
    case 'hand': {
      if (viewer === c.owner) return true;
      const v = viewer ? state.players.find((p) => p.pid === viewer) : undefined;
      return !!v && v.viewingHandOf === c.owner;
    }
    case 'library': {
      if (viewer !== c.owner) return false;
      const p = state.players.find((x) => x.pid === viewer);
      return !!p?.peek?.iids.includes(c.iid);
    }
    case 'sideboard':
      return viewer === c.owner;
  }
}

function hide(c: CardInstance): HiddenCard {
  return {
    iid: c.iid, hidden: true, owner: c.owner, controller: c.controller, zone: c.zone, tapped: c.tapped,
    counters: c.counters, faceDown: c.faceDown, attachedTo: c.attachedTo, attacking: c.attacking, blocking: c.blocking,
  };
}

/** The game as one player (or a spectator) is allowed to see it. */
export function viewFor(state: GameState, viewer: string | null): GameView {
  const cards: Record<string, ViewCard> = {};
  const include = (iid: string) => {
    const c = state.cards[iid];
    if (c) cards[iid] = canSee(state, viewer, c) ? c : hide(c);
  };
  state.battlefield.forEach(include);
  for (const s of state.stack) if (s.iid) include(s.iid);
  const players: ViewPlayer[] = state.players.map((p) => {
    const own = p.pid === viewer;
    const visibleLib = p.zones.library.filter((iid) => canSee(state, viewer, state.cards[iid]));
    // Library order is secret, so only expose the iids the viewer may see (peeked / revealed).
    visibleLib.forEach(include);
    p.zones.hand.forEach(include);
    p.zones.graveyard.forEach(include);
    p.zones.exile.forEach(include);
    p.zones.command.forEach(include);
    if (own) p.zones.sideboard.forEach(include);
    return {
      ...p,
      zones: {
        library: visibleLib,
        hand: p.zones.hand,
        graveyard: p.zones.graveyard,
        exile: p.zones.exile,
        command: p.zones.command,
        sideboard: own ? p.zones.sideboard : [],
      },
      libraryCount: p.zones.library.length,
      handCount: p.zones.hand.length,
      peek: own ? p.peek : p.peek ? { mode: p.peek.mode, iids: [] } : null,
      viewingHandOf: p.viewingHandOf,
    };
  });
  const { history, cards: _c, players: _p, pending, ...rest } = state;
  // Engine questions: only the answering player sees the options (they may name hidden cards); internal data never leaves the server.
  const pendingView = (pending ?? []).map((q) => ({ ...q, options: q.pid === viewer ? q.options : [], data: {} }));
  return { ...rest, pending: pendingView, players, cards, canUndo: history.length > 0, me: state.players.some((p) => p.pid === viewer) ? viewer : null };
}
