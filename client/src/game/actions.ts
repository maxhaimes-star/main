import {
  activatedAbilities, castableFaces, faceUpCosts, charmLimits, effectiveCost, faceOf, type GameAction, type GameView, isHidden, loyaltyAbilities, manaOptionsFor, triggeredAbilities, type CardInstance,
  type ManaOption, type TargetRef,
} from '@ojb/shared';
import { getCard } from '../cards.tsx';
import { abilityUsable, attackProblem, blockProblem, castability, safeHandClick, AUTO_LABEL, autoStatus, isStrict, manualOk, phyrexianChoice, summoningSickNoHaste, castStatus, dividedInfo, optionText, safeAbilities, safeActivated, safeCastOptions, safeDivisionError, safeSpecs, safeSpell, safeCastSpell } from './engine.ts';
import type { GameCtx, MenuItem, Mode } from './ui.tsx';

type Base = Pick<GameCtx, 'g' | 'me' | 'act' | 'ask' | 'askText' | 'pickModes' | 'pickOption' | 'divide' | 'setMode' | 'opp' | 'target'> & { toast?: (m: string) => void } & { mode: Mode };

const MANA_NAMES: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };

function visible(g: GameView, iid: string): CardInstance | null {
  const c = g.cards[iid];
  return c && !isHidden(c) ? c : null;
}

export function manaOptions(c: CardInstance): string[] {
  const card = c.cardId ? getCard(c.cardId) : undefined;
  if (!card || c.transformed) return [];
  const produced = card.producedMana;
  // "Add {C}{C}" style (Ancient Tomb, Sol lands), and "Add {G}{G}" style
  const doubles = /Add \{([WUBRGC])\}\{\1\}(?:\{\1\})?\.?/.exec(card.oracle);
  if (doubles && produced.length === 1) return [doubles[0].match(/\{[WUBRGC]\}/g)!.join('').replace(/[{}]/g, '')];
  return produced;
}

/** Scripted mana abilities (engine), or [] to fall back to manaOptions(). */
function scriptedMana(g: GameView, iid: string): ManaOption[] {
  try { return manaOptionsFor(g as never, iid, getCard); } catch { return []; }
}

const manaLabel = (o: ManaOption) => `${o.label}${o.sideEffects.length ? ` — ${o.sideEffects.join('; ')}` : ''}`;

/** Default click behaviour for a card. */
export function defaultAction(base: Base, iid: string, menu: (iid: string) => MenuItem[], open: (items: MenuItem[], title?: string) => void) {
  const { g, me, act, mode, setMode } = base;
  const c = g.cards[iid];
  if (!c) return;
  if (mode?.kind === 'target') return; // clicks are routed to pickTarget
  // Targeting modes first.
  if (mode?.kind === 'attach') {
    setMode(null);
    if (mode.iid !== iid) act({ t: 'attach', iid: mode.iid, to: iid });
    return;
  }
  if (mode?.kind === 'block') {
    if (c.attacking && c.controller !== me) {
      const why = blockProblem(g, mode.iid, iid);
      if (why) { base.toast?.(why); return; }
      act({ t: 'declareBlocker', iid: mode.iid, attacker: iid }); setMode(null); return;
    }
    if (iid === mode.iid) { setMode(null); return; }
  }
  if (!me) return;
  const vis = visible(g, iid);
  if (c.zone === 'battlefield') {
    // Combat declarations
    if (g.step === 'attackers' && g.activePlayer === me && !g.combat.attackersDeclared && c.controller === me && vis && faceOf(vis, getCard).types.includes('Creature')) {
      if (isStrict(g) && !c.attacking && (c.tapped || summoningSickNoHaste(g, iid))) { base.toast?.(c.tapped ? 'Tapped creatures cannot attack' : 'Summoning sick: cannot attack'); return; }
      if (c.attacking) { act({ t: 'declareAttacker', iid, target: null }); return; }
      const attackTo = (target: string) => {
        const why = attackProblem(g, me, iid, target);
        if (why) { base.toast?.(why); return; }
        act({ t: 'declareAttacker', iid, target });
      };
      // The opponent's planeswalkers can be attacked too: ask which.
      const pws = g.battlefield.filter((id) => { const x = visible(g, id); return !!x && x.controller !== me && faceOf(x, getCard).types.includes('Planeswalker'); });
      if (!pws.length || !base.opp) { if (base.opp) attackTo(base.opp); else act({ t: 'declareAttacker', iid, target: base.opp }); return; }
      const oppName = g.players.find((p) => p.pid === base.opp)?.name ?? 'Opponent';
      void base.pickOption('Attack whom?', [
        { value: base.opp, label: oppName, detail: 'Attack the player' },
        ...pws.map((pw) => { const x = visible(g, pw)!; return { value: pw, label: faceOf(x, getCard).name, detail: `Planeswalker — loyalty ${x.counters.loyalty ?? 0}` }; }),
      ]).then((target) => { if (target) attackTo(target); });
      return;
    }
    if (g.step === 'blockers' && g.activePlayer !== me && !g.combat.blockersDeclared && c.controller === me) {
      if (c.blocking) { act({ t: 'declareBlocker', iid, attacker: null }); return; }
      const attackers = g.battlefield.filter((id) => g.cards[id].attacking);
      if (isStrict(g) && !manualOk(g) && (c.tapped || attackers.every((a) => blockProblem(g, iid, a)))) {
        base.toast?.(c.tapped ? 'Tapped creatures cannot block' : (attackers.length ? blockProblem(g, iid, attackers[0]) ?? 'Cannot block' : 'Nothing to block'));
        return;
      }
      setMode({ kind: 'block', iid });
      return;
    }
    if (c.controller !== me) return;
    if (vis && !c.tapped) {
      const isLand = faceOf(vis, getCard).types.includes('Land');
      const scripted = scriptedMana(g, iid);
      if (scripted.length === 1 && (isLand || !faceOf(vis, getCard).types.includes('Creature'))) { act({ t: 'activateMana', iid, option: scripted[0].id }); return; }
      if (scripted.length > 1) { open(scripted.map((o) => ({ label: manaLabel(o), onClick: () => act({ t: 'activateMana', iid, option: o.id }) })), 'Tap for mana'); return; }
      // Oracle-text mana (no scripted mana ability) is a manual tap: only without rules enforcement / in fix mode.
      const opts = scripted.length || !manualOk(g) ? [] : manaOptions(vis);
      if (opts.length === 1 && (isLand || !faceOf(vis, getCard).types.includes('Creature'))) { act({ t: 'tapForMana', iid, mana: opts[0] }); return; }
      if (opts.length > 1) { open(opts.map((m) => ({ label: `Add ${m.split('').map((x) => `{${x}}`).join('')} (${MANA_NAMES[m[0]]})`, onClick: () => act({ t: 'tapForMana', iid, mana: m }) })), 'Tap for mana'); return; }
    }
    if (manualOk(g)) { act({ t: 'tap', iid }); return; }
    // Rules-enforced: never a manual action — show the card's abilities (activate / mana) instead.
    open(menu(iid), vis ? faceOf(vis, getCard).name : undefined);
    return;
  }
  if (c.zone === 'hand' && c.owner === me && vis) {
    const face = faceOf(vis, getCard);
    // A land with abilities usable from hand (cycling Triomes ...), several castable faces, {X}: the card's menu,
    // which shows each option (disabled with the reason when it can't be used now).
    const click = safeHandClick(g, me, iid);
    if (click === 'menu') { open(menu(iid), face.name); return; }
    // Strict: refuse before any cost / target / mode prompt.
    const u = castability(g, me, iid);
    if (u && !u.ok) { base.toast?.(u.reason ?? "Can't do that now"); return; }
    if (click === 'playLand') { act({ t: 'playLand', iid }); return; }
    castWithX(base, iid);
    return;
  }
  const items = menu(iid);
  if (items.length) open(items, vis ? faceOf(vis, getCard).name : undefined);
}

export async function castWithX(base: Base, iid: string, face?: number, manual?: boolean) {
  const c = visible(base.g, iid);
  const card = c?.cardId ? getCard(c.cardId) : undefined;
  let cost = face != null && card?.faces ? card.faces[face].manaCost : card?.manaCost ?? '';
  let costOption: string | undefined;
  if (!manual && c) {
    const opts = safeCastOptions(base.g, iid, face, base.me);
    const avail = opts.filter((o) => !o.unavailable);
    let chosen = avail.length === 1 ? avail[0] : undefined;
    if (avail.length > 1) {
      const id = await base.pickOption(`Cast ${(face != null ? card?.faces?.[face]?.name : undefined) ?? card?.name ?? 'spell'}`, opts.map((o) => ({ value: o.id, label: o.label, detail: optionText(o), disabled: o.unavailable })));
      if (!id) return;
      chosen = opts.find((o) => o.id === id);
    }
    if (chosen) {
      if (chosen.id !== 'normal') costOption = chosen.id;
      if (chosen.id !== 'normal' && chosen.id !== 'kicked' && /\{X\}/.test(chosen.cost)) cost = chosen.cost;
      else if (chosen.id !== 'normal' && chosen.id !== 'kicked') cost = chosen.cost || '';
    }
  }
  let x: number | undefined;
  // X in an additional cost (Vicious Rivalry: "pay X life") needs a value too.
  const xExtra = !manual && c ? (safeCastOptions(base.g, iid, face, base.me).find((o) => o.id === (costOption ?? 'normal'))?.extra ?? []).some((e) => /\bX\b/.test(e)) : false;
  if (/\{X\}/.test(cost) || xExtra) {
    const v = await base.ask('Value of X', 1);
    if (v == null) return;
    x = v;
  }
  // Phyrexian mana (strict auto-pay): mana first by default; offer paying life instead when that differs.
  let phyrexian: 'mana' | 'life' | undefined;
  const phy = manual ? undefined : phyrexianChoice(base.g, base.me, iid, face, costOption, x);
  if (phy && phy.life.ok && phy.life.life !== phy.mana.life) {
    if (!phy.mana.ok) phyrexian = 'life';
    else {
      const how = await base.pickOption('Pay Phyrexian mana', [
        { value: 'mana', label: phy.mana.life ? `Mana where possible (${phy.mana.life} life)` : 'Pay with mana', detail: 'Tap mana for the Phyrexian symbols' },
        { value: 'life', label: `Pay ${phy.life.life} life`, detail: '2 life per Phyrexian symbol' },
      ]);
      if (!how) return;
      phyrexian = how as 'mana' | 'life';
    }
  }
  let targets: TargetRef[][] | undefined;
  let modes: string[] | undefined;
  const sa = manual ? undefined : safeCastSpell(c?.cardId, face ?? 0, costOption);
  if (sa?.ability.choices?.length) {
    const ch = sa.ability.choices;
    // Mode count now (Flame of Anor: two with a Wizard) and whether a mode may repeat (Mystic Confluence).
    let lim = { min: sa.ability.charmMin ?? 1, max: sa.ability.charmMax ?? 1, repeat: sa.ability.params.CanRepeatModes === 'True' };
    try { if (base.me) lim = charmLimits(base.g as never, sa.ability, base.me, getCard); } catch { /* keep the printed numbers */ }
    const picked = await base.pickModes(card?.name ?? 'Choose modes', ch.map((m) => ({ value: m.name, label: m.ability.description || m.ability.api })), lim.min, lim.max, lim.repeat);
    if (!picked) return;
    modes = picked;
  }
  if (sa) {
    const specs = safeSpecs(sa.ability, modes);
    if (specs.length) {
      const t = await base.target(`Cast ${card ? (face != null && card.faces ? card.faces[face].name : card.name) : 'spell'}`, specs, iid);
      if (!t) return;
      targets = t;
    }
  }
  let division: Record<string, number> | undefined;
  if (sa && targets) {
    const d = await askDivision(base, sa.ability, modes, targets, x ?? 0, card?.name ?? 'spell');
    if (d === null) return;
    division = d;
  }
  base.act({ t: 'cast', iid, face, x, ...(phyrexian === 'life' ? { phyrexian } : {}), ...(costOption ? { costOption } : {}), ...(division ? { division } : {}), ...(targets ? { targets } : {}), ...(modes ? { modes } : {}), ...(manual ? { manual: true } : {}) });
}

/** DividedAsYouChoose$: ask how to split the damage. undefined = nothing to divide, null = cancelled. */
async function askDivision(base: Base, ab: Parameters<typeof dividedInfo>[0], modes: string[] | undefined, targets: TargetRef[][], x: number, title: string): Promise<Record<string, number> | undefined | null> {
  const info = dividedInfo(ab, modes, x);
  if (!info) return undefined;
  const list = targets[info.spec] ?? [];
  if (list.length < 2) return undefined;
  const entries = list.map((t) => {
    if (t.kind === 'card') { const v = visible(base.g, t.iid); return { key: t.iid, label: v ? faceOf(v, getCard).name : 'Card' }; }
    if (t.kind === 'player') return { key: t.pid, label: base.g.players.find((p) => p.pid === t.pid)?.name ?? 'Player' };
    return { key: t.id, label: 'Spell' };
  });
  const r = await base.divide(`Divide damage: ${title}`, info.total, entries, (d) => safeDivisionError(ab, modes, targets, d, x));
  return r;
}

async function activateScripted(base: Base, iid: string, c: CardInstance, entry: ReturnType<typeof safeActivated>[number], label: string) {
  let x: number | undefined;
  if (/\bX\b/.test(entry.cost)) {
    const v = await base.ask('Value of X', 1);
    if (v == null) return;
    x = v;
  }
  let targets: TargetRef[][] | undefined;
  const specs = safeSpecs(entry.ability);
  if (specs.length) {
    const t = await base.target(label, specs, iid);
    if (!t) return;
    targets = t;
  }
  let division: Record<string, number> | undefined;
  if (targets) {
    const d = await askDivision(base, entry.ability, undefined, targets, x ?? 0, label);
    if (d === null) return;
    division = d;
  }
  base.act({ t: 'activate', iid, text: entry.ability.description || label, ability: entry.index, ...(division ? { division } : {}), ...(targets ? { targets } : {}), ...(x != null ? { x } : {}) });
}

const short = (t: string, n = 80) => (t.length > n ? t.slice(0, n) + '…' : t);

function hintOf(cost: string, cardId: string | undefined, face: number, eff?: string): string {
  const st = castStatus(cardId, face);
  const c = eff && eff !== cost ? `${eff} (printed ${cost})` : cost;
  return st ? `${c} ${AUTO_LABEL[st]}` : c;
}

function effCost(g: GameView, iid: string, face: number, me: string | null): string | undefined {
  try { return me ? effectiveCost(g as never, iid, face, getCard, me) || undefined : undefined; } catch { return undefined; }
}

const moveItems = (base: Base, iid: string, c: CardInstance): MenuItem[] => {
  const mv = (a: Omit<Extract<GameAction, { t: 'move' }>, 't' | 'iid'>) => () => base.act({ t: 'move', iid, ...a });
  const items: MenuItem[] = [];
  if (c.zone !== 'hand') items.push({ label: "To owner's hand", onClick: mv({ to: 'hand' }) });
  if (c.zone !== 'battlefield') {
    items.push({ label: 'Onto the battlefield', onClick: mv({ to: 'battlefield' }) });
    items.push({ label: 'Onto the battlefield tapped', onClick: mv({ to: 'battlefield', tapped: true }) });
    items.push({ label: 'Onto the battlefield face down', onClick: mv({ to: 'battlefield', faceDown: true }) });
  }
  if (c.zone !== 'graveyard') items.push({ label: 'To graveyard', onClick: mv({ to: 'graveyard' }) });
  if (c.zone !== 'exile') {
    items.push({ label: 'Exile', onClick: mv({ to: 'exile' }) });
    items.push({ label: 'Exile face down', onClick: mv({ to: 'exile', faceDown: true }) });
  }
  items.push({ label: 'Top of library', onClick: mv({ to: 'library', position: 'top' }) });
  items.push({ label: 'Bottom of library', onClick: mv({ to: 'library', position: 'bottom' }) });
  items.push({
    label: 'Nth from top…', onClick: async () => {
      const n = await base.ask('Position from the top (1 = top)', 3);
      if (n != null && n >= 1) base.act({ t: 'move', iid, to: 'library', position: n - 1 });
    },
  });
  if (c.zone !== 'command') items.push({ label: 'Command zone', onClick: mv({ to: 'command' }) });
  if (c.zone !== 'sideboard' && c.owner === base.me) items.push({ label: 'Sideboard', onClick: mv({ to: 'sideboard' }) });
  return items;
};

export function menuFor(base: Base, iid: string): MenuItem[] {
  const { g, me, act, ask, askText, setMode, opp } = base;
  const raw = g.cards[iid];
  if (!raw) return [];
  const c = visible(g, iid);
  if (!c) {
    // Hidden card (opponent's hand / face-down): nothing much to do.
    return [{ label: 'Hidden card', disabled: true }];
  }
  const face = faceOf(c, getCard);
  const card = c.cardId ? getCard(c.cardId) : undefined;
  const items: MenuItem[] = [];
  const mine = c.controller === me || c.owner === me;
  const manual = manualOk(g); // strict mode hides manual tools unless fix mode is on

  if (c.zone === 'battlefield') {
    if (manual) items.push({ label: c.tapped ? 'Untap' : 'Tap', onClick: () => act({ t: 'tap', iid }) });
    const scriptedM = scriptedMana(g, iid);
    const mana = scriptedM.length || !manual ? [] : manaOptions(c);
    if (scriptedM.length && !c.tapped && c.controller === me) {
      items.push({ label: 'Tap for mana', sub: scriptedM.map((o) => ({ label: manaLabel(o), onClick: () => act({ t: 'activateMana', iid, option: o.id }) })) });
    }
    if (mana.length && !c.tapped && c.controller === me) {
      items.push({ label: 'Tap for mana', sub: mana.map((m) => ({ label: m.split('').map((x) => `{${x}}`).join(''), onClick: () => act({ t: 'tapForMana', iid, mana: m }) })) });
    }
    const all = c.controller === me || manual ? safeAbilities(g, c).filter((e) => !e.zone) : [];
    // Rooms: "Unlock <door>" (a special action at sorcery speed, paying the door's mana cost) as its own menu item.
    for (const e of all.filter((x) => x.ability.api === '_Unlock')) {
      const door = card?.faces?.[parseInt(e.ability.params.Door ?? '-1', 10)];
      const label = `Unlock ${door?.name ?? 'door'}`;
      const u = abilityUsable(g, me, iid, e.index);
      items.push(u && !u.ok ? { label, disabled: true, hint: u.reason ?? "Can't unlock now" } : { label, hint: door?.manaCost, onClick: () => act({ t: 'activate', iid, text: label, ability: e.index }) });
    }
    // Prepare cards: while prepared, its controller may cast a copy of its spell (face 1).
    if (c.counters.prepared && c.controller === me && card?.faces?.[1]?.name && (card.layout === 'prepare' || card.layout === 'adventure')) {
      const spell = card.faces[1];
      const u = castability(g, me, iid, 1);
      const label = `Cast a copy of ${spell.name}`;
      items.push(u && !u.ok ? { label, disabled: true, hint: u.reason ?? "Can't cast it now" } : { label, hint: spell.manaCost, onClick: () => castWithX(base, iid, 1) });
    }
    // Face-down (morph / disguise / manifest / cloak): turning it face up is a special action paying its cost.
    if (c.faceDown && c.controller === me && !isHidden(c)) {
      const costs = faceUpCosts(c as CardInstance, getCard);
      if (costs.length) items.push({ label: 'Turn face up', hint: costs.join(' or '), onClick: () => act({ t: 'turnFaceUp', iid }) });
    }
    const scripted = all.filter((e) => e.ability.api !== '_Unlock');
    const manualLoyalty: MenuItem[] = loyaltyAbilities(face.oracle).map((l) => ({
      label: `[${l.cost > 0 ? '+' : ''}${l.cost}] ${l.text.slice(0, 70)}${l.text.length > 70 ? '…' : ''}`,
      onClick: async () => {
        let cost = l.cost;
        if (/\[[−-]X\]/.test(face.oracle) && l.cost === 0 && /X/.test(l.text)) { const x = await ask('X', 1); if (x == null) return; cost = -x; }
        act({ t: 'activate', iid, text: l.text, loyalty: cost });
      },
    }));
    const manualOracle: MenuItem[] = activatedAbilities(face.oracle).map((a) => ({ label: short(a), onClick: () => act({ t: 'activate', iid, text: a }) }));
    const otherManual: MenuItem = { label: 'Other… (manual)', onClick: async () => { const t = await askText('Ability text'); if (t) act({ t: 'activate', iid, text: t }); } };
    if (scripted.length) {
      items.push({
        label: 'Activate ability', sub: [
          ...scripted.map((e) => {
            const desc = e.ability.description || e.ability.api;
            const label = e.loyalty != null ? `[${e.loyalty > 0 ? '+' : ''}${e.loyalty}] ${short(desc, 70)}` : `${e.cost ? e.cost + ': ' : ''}${short(desc, 70)}`;
            const u = abilityUsable(g, me, iid, e.index);
            if (u && !u.ok) return { label, disabled: true, hint: u.reason ?? "Can't activate now" } as MenuItem;
            return { label, hint: autoStatus(e.ability) === 'auto' ? '⚡' : undefined, onClick: () => activateScripted(base, iid, c, e, desc) } as MenuItem;
          }),
          ...(manual ? [otherManual] : []),
        ],
      });
      if (manual && (manualLoyalty.length || manualOracle.length)) items.push({ label: 'Manual', sub: [...manualLoyalty, ...manualOracle] });
    } else if (manual) {
      if (manualLoyalty.length) items.push({ label: 'Loyalty ability', sub: manualLoyalty });
      items.push({ label: 'Activate ability', sub: [...manualOracle, { ...otherManual, label: 'Other…' }] });
    }
    const triggers = triggeredAbilities(face.oracle);
    if (manual) items.push({
      label: 'Put trigger on stack', sub: [
        ...triggers.map((t) => ({ label: t.length > 80 ? t.slice(0, 80) + '…' : t, onClick: () => act({ t: 'trigger', text: t, sourceIid: iid }) })),
        { label: 'Other…', onClick: async () => { const t = await askText('Trigger text'); if (t) act({ t: 'trigger', text: t, sourceIid: iid }); } },
      ],
    });
    // Combat
    if (g.step === 'attackers' && g.activePlayer === me && c.controller === me && !g.combat.attackersDeclared) {
      if (c.attacking) items.push({ label: 'Remove from attack', onClick: () => act({ t: 'declareAttacker', iid, target: null }) });
      else {
        const why = attackProblem(g, me, iid, opp);
        items.push(why ? { label: 'Attack opponent', disabled: true, hint: why } : { label: 'Attack opponent', onClick: () => act({ t: 'declareAttacker', iid, target: opp }) });
        const pws = g.battlefield.filter((id) => { const x = visible(g, id); return x && x.controller !== me && faceOf(x, getCard).types.includes('Planeswalker'); });
        for (const pw of pws) {
          const w = attackProblem(g, me, iid, pw);
          const label = `Attack ${faceOf(visible(g, pw)!, getCard).name}`;
          items.push(w ? { label, disabled: true, hint: w } : { label, onClick: () => act({ t: 'declareAttacker', iid, target: pw }) });
        }
      }
    }
    if (g.step === 'blockers' && g.activePlayer !== me && c.controller === me && !g.combat.blockersDeclared) {
      const attackers = g.battlefield.filter((id) => g.cards[id].attacking);
      if (!c.blocking) items.push({ label: 'Block', sub: attackers.map((a) => {
        const label = visible(g, a) ? faceOf(visible(g, a)!, getCard).name : 'face-down';
        const why = blockProblem(g, iid, a);
        return why ? { label, disabled: true, hint: why } : { label, onClick: () => act({ t: 'declareBlocker', iid, attacker: a }) };
      }) });
      if (c.blocking) items.push({ label: 'Stop blocking', onClick: () => act({ t: 'declareBlocker', iid, attacker: null }) });
    }
    if (!manual) return items;
    items.push({
      label: 'Counters', sub: [
        { label: '+1/+1 counter', onClick: () => act({ t: 'counter', iid, kind: '+1/+1', delta: 1 }) },
        { label: 'Remove +1/+1 counter', onClick: () => act({ t: 'counter', iid, kind: '+1/+1', delta: -1 }) },
        { label: '−1/−1 counter', onClick: () => act({ t: 'counter', iid, kind: '-1/-1', delta: 1 }) },
        { label: 'Remove −1/−1 counter', onClick: () => act({ t: 'counter', iid, kind: '-1/-1', delta: -1 }) },
        { label: 'Loyalty +1', onClick: () => act({ t: 'counter', iid, kind: 'loyalty', delta: 1 }) },
        { label: 'Loyalty −1', onClick: () => act({ t: 'counter', iid, kind: 'loyalty', delta: -1 }) },
        ...Object.keys(c.counters).filter((k) => !['+1/+1', '-1/-1', 'loyalty'].includes(k)).flatMap((k) => [
          { label: `${k} +1`, onClick: () => act({ t: 'counter', iid, kind: k, delta: 1 }) },
          { label: `${k} −1`, onClick: () => act({ t: 'counter', iid, kind: k, delta: -1 }) },
        ]),
        {
          label: 'Other counter…', onClick: async () => {
            const k = await askText('Counter type (e.g. level, valor, charge, lore, oil, stun)', 'charge');
            if (!k) return;
            const n = await ask(`How many ${k} counters? (negative removes)`, 1);
            if (n) act({ t: 'counter', iid, kind: k, delta: n });
          },
        },
      ],
    });
    items.push({
      label: 'Power / toughness', sub: [
        { label: '+1/+1 until end of turn', onClick: () => act({ t: 'pt', iid, dp: 1, dt: 1 }) },
        { label: '−1/−1 until end of turn', onClick: () => act({ t: 'pt', iid, dp: -1, dt: -1 }) },
        { label: '+X/+0 until end of turn…', onClick: async () => { const n = await ask('Power change', 2); if (n) act({ t: 'pt', iid, dp: n, dt: 0 }); } },
        { label: 'Custom until end of turn…', onClick: async () => { const p = await ask('Power change', 0); if (p == null) return; const t = await ask('Toughness change', 0); if (t == null) return; act({ t: 'pt', iid, dp: p, dt: t }); } },
        { label: 'Lasting modifier (anthem etc.)…', onClick: async () => { const p = await ask('Power change', 1); if (p == null) return; const t = await ask('Toughness change', 1); if (t == null) return; act({ t: 'pt', iid, dp: p, dt: t, permanent: true }); } },
        { label: 'Mark damage…', onClick: async () => { const n = await ask('Damage (negative removes)', 1); if (n) act({ t: 'damage', iid, delta: n }); } },
        { label: 'Animate (counts as a creature)', onClick: () => act({ t: 'counter', iid, kind: 'animated', delta: c.counters.animated ? -1 : 1 }) },
      ],
    });
    if (card?.faces && (card.layout === 'transform' || card.layout === 'modal_dfc' || card.layout === 'flip')) items.push({ label: c.transformed ? 'Transform to front' : `Transform (${card.faces[1].name})`, onClick: () => act({ t: 'transform', iid }) });
    items.push({ label: c.faceDown ? 'Turn face up' : 'Turn face down', onClick: () => act({ t: 'faceDown', iid, faceDown: !c.faceDown }) });
    items.push(c.attachedTo ? { label: 'Unattach', onClick: () => act({ t: 'attach', iid, to: null }) } : { label: 'Attach to… (then click a card)', onClick: () => setMode({ kind: 'attach', iid }) });
    items.push({ label: c.controller === me ? 'Give control to opponent' : 'Gain control', onClick: () => act({ t: 'control', iid, pid: c.controller === me ? opp : me! }) });
    items.push({ label: 'Create a token copy', onClick: () => act({ t: 'copyCard', iid }) });
    items.push({ label: c.noUntap ? 'Untaps normally' : "Doesn't untap", onClick: () => act({ t: 'noUntap', iid, value: !c.noUntap }) });
    items.push({ label: 'Note…', onClick: async () => { const t = await askText('Note (e.g. "flying", "exiled: Lightning Bolt")', c.note ?? ''); if (t != null) act({ t: 'note', iid, note: t }); } });
    items.push({ label: 'Move', sub: moveItems(base, iid, c) });
    return items;
  }

  if (c.zone === 'hand' || c.zone === 'graveyard' || c.zone === 'exile' || c.zone === 'library' || c.zone === 'command' || c.zone === 'sideboard') {
    const isLand = face.types.includes('Land');
    // Strict: castability up front. Cards I don't own (opponent's graveyard ...) only offer a cast that is legal.
    const u = castability(g, me, iid);
    const blocked = u && !u.ok ? (u.reason ?? "Can't do that now") : null;
    const offerCast = !blocked || c.owner === me;
    if (isLand && c.owner === me) items.push(blocked ? { label: 'Play land', disabled: true, hint: blocked } : { label: 'Play land', onClick: () => act({ t: 'playLand', iid }) });
    const castItem = (it: MenuItem): MenuItem => (blocked ? { label: it.label, disabled: true, hint: blocked } : it);
    if (offerCast && (!isLand || card?.layout === 'modal_dfc')) {
      // Transforming / flip cards are cast front face up (rule 711.2): only the faces that can be cast.
      if (card?.faces && castableFaces(card).length > 1) {
        for (const fi of castableFaces(card)) {
          // Each face is checked on its own (a Room's door / split half costs only its own mana cost).
          const fu = blocked || isLand ? undefined : castability(g, me, iid, fi);
          const faceItem = (it: MenuItem): MenuItem => (fu && !fu.ok ? { label: it.label, disabled: true, hint: fu.reason ?? "Can't do that now" } : castItem(it));
          items.push(faceItem({ label: `Cast ${card.faces[fi].name}`, hint: hintOf(card.faces[fi].manaCost, c.cardId, fi, effCost(g, iid, fi, me)), onClick: () => castWithX(base, iid, fi) }));
          if (manual && safeSpell(c.cardId, fi)) items.push({ label: `Cast ${card.faces[fi].name} (resolve by hand)`, onClick: () => castWithX(base, iid, fi, true) });
        }
      } else {
        items.push(castItem({ label: c.zone === 'hand' ? 'Cast' : `Cast from ${c.zone}`, hint: hintOf(face.manaCost, c.cardId, 0, effCost(g, iid, 0, me)), onClick: () => castWithX(base, iid) }));
        if (manual && safeSpell(c.cardId, 0)) items.push({ label: 'Cast (resolve by hand)', onClick: () => castWithX(base, iid, undefined, true) });
      }
    }
    // Abilities activated from this zone (cycling, channel, ninjutsu, graveyard abilities).
    const fromZone = c.owner === me ? safeActivated(c.cardId, 0).filter((e) => e.zone === c.zone) : [];
    for (const e of fromZone) {
      const desc = e.ability.description || e.ability.api;
      const au = abilityUsable(g, me, iid, e.index);
      items.push(au && !au.ok ? { label: short(desc, 70), disabled: true, hint: au.reason ?? "Can't activate now" }
        : { label: short(desc, 70), hint: autoStatus(e.ability) === 'auto' ? '⚡' : undefined, onClick: () => activateScripted(base, iid, c, e, desc) });
    }
    if (c.zone === 'hand' && mine && manual) {
      items.push({ label: 'Cast face down (morph/disguise)', onClick: () => act({ t: 'cast', iid, faceDown: true }) });
      items.push({ label: 'Reveal', onClick: () => act({ t: 'reveal', iid }) });
      items.push({ label: 'Discard', onClick: () => act({ t: 'move', iid, to: 'graveyard' }) });
      const cyc = /cycling \{/i.test(face.oracle);
      if (cyc && !fromZone.some((e) => /Cycling/.test(e.keyword ?? ''))) items.push({ label: 'Cycle (discard, draw)', onClick: async () => { await act({ t: 'move', iid, to: 'graveyard' }); act({ t: 'draw', n: 1 }); } });
    }
    if (manual) items.push({ label: 'Move', sub: moveItems(base, iid, c) });
    return items;
  }

  if (c.zone === 'stack' && manual) {
    items.push({ label: 'Resolve now', onClick: () => act({ t: 'resolve' }) });
    items.push({ label: 'Counter (to graveyard)', onClick: () => act({ t: 'move', iid, to: 'graveyard' }) });
    items.push({ label: 'Move', sub: moveItems(base, iid, c) });
  }
  return items;
}
