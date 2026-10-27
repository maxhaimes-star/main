import type { CardInstance, GameState, GameView, HiddenCard, ViewCard, ViewPlayer } from './types.ts';
import { controls } from '../engine/turns.ts';
import { topCardVisible } from '../engine/permissions.ts';

/** Can `viewer` see the face of this card? (viewer null = spectator) */
export function canSee(state: GameState, viewer: string | null, c: CardInstance): boolean {
  if (viewer && c.revealedTo.includes(viewer)) return true;
  switch (c.zone) {
    case 'battlefield':
    case 'stack':
    case 'exile':
      if (!c.faceDown) return true;
      if (c.unseen) return false;
      return viewer === c.controller || viewer === c.owner;
    case 'graveyard':
    case 'command':
      return true;
    case 'hand': {
      if (viewer === c.owner || controls(state, viewer, c.owner)) return true; // Mindslaver: the controller sees the hand
      const v = viewer ? state.players.find((p) => p.pid === viewer) : undefined;
      return !!v && v.viewingHandOf === c.owner;
    }
    case 'library': {
      if (topCardVisible(state, viewer, c.iid)) return true; // Courser of Kruphix, Bolas's Citadel (engine/permissions.ts)
      if (viewer !== c.owner && !controls(state, viewer, c.owner)) return false;
      const p = state.players.find((x) => x.pid === c.owner);
      return !!p?.peek?.iids.includes(c.iid);
    }
    case 'sideboard':
      return viewer === c.owner;
  }
}

function hide(c: CardInstance): HiddenCard {
  return {
    iid: c.iid, hidden: true, owner: c.owner, controller: c.controller, zone: c.zone, tapped: c.tapped,
    counters: c.counters, faceDown: c.faceDown, ...(c.faceDown && c.faceDownAs ? { faceDownAs: c.faceDownAs } : {}), attachedTo: c.attachedTo, attacking: c.attacking, blocking: c.blocking,
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
    const ctrl = own || controls(state, viewer, p.pid); // Mindslaver: the controller sees what that player sees (not their sideboard)
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
      peek: ctrl ? p.peek : p.peek ? { mode: p.peek.mode, iids: [] } : null,
      viewingHandOf: p.viewingHandOf,
    };
  });
  const { history, cards: _c, players: _p, pending, events: _e, triggerQueue: _q, reveals, delayedTriggers: _d, turnStats: _t, remembered: _r, ...rest } = state;
  // Engine questions: only the answering player sees the options (they may name hidden cards); internal data never leaves the server.
  const pendingView = (pending ?? []).map((q) => {
    const mine = q.pid === viewer || controls(state, viewer, q.pid);
    const { revealed, ...rest } = q;
    return { ...rest, options: mine ? q.options : [], data: {}, ...(mine && revealed ? { revealed } : {}) };
  });
  // Reveals: only to those who were shown the cards (or own them); spectators see public ones.
  const everyone = state.players.map((p) => p.pid);
  const visibleReveals = (reveals ?? []).filter((r) => (viewer ? r.to.includes(viewer) : everyone.every((x) => r.to.includes(x))));
  // Pre-game questions: the library iids stay on the server.
  const pregame = state.pregame ? { pregame: { queue: [], deferred: state.pregame.deferred } } : {};
  // "Exiled with <permanent>" links of face-up exiled cards are public (Agatha's Soul Cauldron grants the exiled
  // creatures' abilities: the client needs them to offer those abilities).
  const publicRemembered: Record<string, string[]> = {};
  for (const [k, ids] of Object.entries(state.remembered ?? {})) {
    const src = k.startsWith('exiled|') ? k.slice(7) : k;
    if (state.cards[src]?.zone !== 'battlefield') continue;
    const shown = ids.filter((x) => state.cards[x]?.zone === 'exile' && !state.cards[x].faceDown);
    if (shown.length) publicRemembered[k] = shown;
  }
  return { ...rest, ...pregame, ...(Object.keys(publicRemembered).length ? { remembered: publicRemembered } : {}), reveals: visibleReveals, pending: pendingView, players, cards, canUndo: history.length > 0, me: state.players.some((p) => p.pid === viewer) ? viewer : null };
}
