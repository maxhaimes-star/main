// Layout checks for the game table at desktop and phone sizes:
//  - no board element overflows the viewport or is clipped by an overflow container (scrollable strips excepted);
//  - the phase bar pieces and the pass/action buttons do not overlap each other or the piles;
//  - opened menus and submenus stay inside the viewport;
//  - the action buttons near the pass button do not cover any hand card (cards stay clickable).
import { browser, setup, shot, step, handLands, settle, passUntil, pressOk, logTail, errors } from './lib.mjs';

const VIEWPORTS = [[1280, 720], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440], [390, 844], [844, 390]];
const BOARD = [
  '.player-area', '.player-panel', '.battlefield', '.zones .zone', '.center-bar', '.turn-info', '.auto-toggles', '.phase',
  '.priority button', '.priority .waiting', '.stack', '.stack-item', '.hand', '.hcard', '.tcard', '.side-toggle', '.log-btn', '.life-num', '.mana-pool', '.rz', '.rz-entry', '.rz-card',
];

/** Runs in the page: list of problems (element overflow / clipping / overlaps). */
function boardProblems(sel) {
  const vw = innerWidth, vh = innerHeight, tol = 1.5;
  const out = [];
  const name = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}${el.textContent ? ` "${el.textContent.trim().slice(0, 18)}"` : ''}`;
  const scrollsX = (el) => { const s = getComputedStyle(el); return /(auto|scroll)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1; };
  const scrollsY = (el) => { const s = getComputedStyle(el); return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1; };
  for (const s of sel) {
    for (const el of document.querySelectorAll(`.table ${s}`)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      // horizontally scrollable strips (phone hand / battlefield rows / phase bar) may hold content beyond the edge
      let inScrollX = false, inScrollY = false;
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (scrollsX(a)) inScrollX = true;
        if (scrollsY(a)) inScrollY = true;
      }
      if (!inScrollX && (r.left < -tol || r.right > vw + tol)) out.push(`${name(el)} overflows the viewport horizontally (${Math.round(r.left)}..${Math.round(r.right)} of ${vw})`);
      if (!inScrollY && (r.top < -tol || r.bottom > vh + tol)) out.push(`${name(el)} overflows the viewport vertically (${Math.round(r.top)}..${Math.round(r.bottom)} of ${vh})`);
      // clipped by an ancestor that hides overflow (up to the first ancestor that scrolls in that axis)
      let cx = true, cy = true;
      for (let a = el.parentElement; a && !a.classList.contains('table'); a = a.parentElement) {
        const st = getComputedStyle(a);
        const ar = a.getBoundingClientRect();
        if (cx && !/(auto|scroll)/.test(st.overflowX) && st.overflowX !== 'visible' && (r.left < ar.left - tol || r.right > ar.right + tol)) { out.push(`${name(el)} is clipped horizontally by ${name(a).slice(0, 60)}`); break; }
        if (cy && !/(auto|scroll)/.test(st.overflowY) && st.overflowY !== 'visible' && (r.top < ar.top - tol || r.bottom > ar.bottom + tol)) { out.push(`${name(el)} is clipped vertically by ${name(a).slice(0, 60)}`); break; }
        if (/(auto|scroll)/.test(st.overflowX)) cx = false;
        if (/(auto|scroll)/.test(st.overflowY)) cy = false;
        if (/(auto|scroll)/.test(st.overflowY) && !el.closest('.stack, .hand, .log-entries') && a.scrollHeight > a.clientHeight + 1 && a.matches('.player-panel, .zones, .battlefield, .bf-front, .bf-back')) { out.push(`${name(a).slice(0, 60)} has to scroll to show ${name(el)}`); break; }
      }
    }
  }
  // overlaps between bar pieces / buttons and the things next to them
  const rects = (q) => [...document.querySelectorAll(q)].filter((e) => getComputedStyle(e).visibility !== 'hidden').map((e) => ({ e, r: e.getBoundingClientRect() })).filter((x) => x.r.width && x.r.height);
  const hit = (a, b) => a.left < b.right - tol && b.left < a.right - tol && a.top < b.bottom - tol && b.top < a.bottom - tol;
  const pairs = [
    ['.turn-info', '.phases .phase'], ['.phases .phase', '.auto-toggles'], ['.turn-info', '.auto-toggles'], ['.side-toggle', '.zones .zone'],
    ['.side-toggle', '.phases .phase'], ['.side-toggle', '.auto-toggles'], ['.priority button, .priority .waiting', '.zones .zone'],
    ['.priority button, .priority .waiting', '.player-panel'], ['.stack', '.zones .zone'], ['.player-panel', '.zones .zone'],
    ['.rz', '.hand'], ['.rz', '.priority button, .priority .waiting'], ['.rz', '.center-bar'], ['.rz', '.player-panel'], ['.rz', '.stack'],
  ];
  for (const [qa, qb] of pairs) {
    for (const a of rects(qa)) for (const b of rects(qb)) {
      if (a.e === b.e || a.e.contains(b.e) || b.e.contains(a.e)) continue;
      // the phone phase bar scrolls under the turn label: only count phases actually shown
      let br = b.r;
      const bar = b.e.closest('.phases');
      if (bar) { const p = bar.getBoundingClientRect(); br = { left: Math.max(br.left, p.left), right: Math.min(br.right, p.right), top: br.top, bottom: br.bottom }; if (br.right <= br.left) continue; }
      if (hit(a.r, br)) out.push(`${name(a.e).slice(0, 50)} overlaps ${name(b.e).slice(0, 50)}`);
    }
  }
  return out;
}

/** Runs in the page: the open menu / submenus that leave the viewport. */
function menuProblems() {
  const out = [];
  for (const el of document.querySelectorAll('.ctx-menu, .ctx-sub, .hover-preview, .stops-pop')) {
    const r = el.getBoundingClientRect();
    if (getComputedStyle(el).position === 'static') continue;
    if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) out.push(`${el.className} at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} leaves the ${innerWidth}x${innerHeight} viewport`);
  }
  return out;
}

const coveredHandCards = () => [...document.querySelectorAll('.hand .hcard')].filter((c) => {
  const r = c.getBoundingClientRect();
  const x = Math.min(Math.max(r.left + r.width / 2, 2), innerWidth - 2);
  const y = Math.min(r.top + r.height * 0.25, window.innerHeight - 4);
  const el = document.elementFromPoint(x, y);
  return !el || (!c.contains(el) && !el.closest('.hand'));
}).length;

let failed = false;
const fail = (m) => { console.log('  FAIL', m); failed = true; };
// LAYOUT_PART=basic | packed: run one part only (both by default).
const PART = process.env.LAYOUT_PART;
if (!PART || PART === 'basic') {
const { active: A, other: B, close } = await setup('20 Lightning Bolt\n20 Mountain', 'layout');
// Put something on the battlefield (a land) so the rows and the land's menu exist.
await handLands(A, 'Mountain').first().click().catch(() => {});
await settle(A, 600);

// Revealed zone: reveal my hand (via fix mode's manual tools) and check both players see it.
step('reveal my hand -> Revealed zone for both players');
await A.getByRole('button', { name: 'Fix board', exact: true }).click();
await B.getByRole('button', { name: 'Allow' }).click();
await A.locator('.fix-banner').waitFor();
await A.locator('.my-tools button:has-text("More")').first().click();
await A.locator('.ctx-menu .ctx-item', { hasText: 'Reveal my hand' }).click();
await A.getByRole('button', { name: 'Done fixing' }).click();
for (const [who, P] of [['revealer', A], ['opponent', B]]) {
  const z = P.locator('[data-testid=revealed-zone]');
  await z.waitFor({ timeout: 5000 }).catch(() => fail(`${who} does not see the Revealed zone`));
  const txt = await z.innerText().catch(() => '');
  if (!/(Max|Sam)/.test(txt) || !/Reveal hand/.test(txt)) fail(`${who}: Revealed zone should say who and what revealed (got "${txt.replace(/\n/g, ' | ')}")`);
  if (!(await z.locator('.rz-card img, .rz-card .text-card').count())) fail(`${who}: Revealed zone shows no cards`);
}
await shot(B, 'reveal-opponent-view');

for (const [w, h] of VIEWPORTS) {
  step(`viewport ${w}x${h}`);
  await A.setViewportSize({ width: w, height: h });
  await A.mouse.move(w / 2, 1);
  await A.waitForTimeout(500);
  await A.keyboard.press('Escape');
  const problems = await A.evaluate(boardProblems, BOARD);
  for (const p of [...new Set(problems)].slice(0, 12)) fail(`${w}x${h}: ${p}`);
  const covered = await A.evaluate(coveredHandCards);
  if (covered) fail(`${w}x${h}: ${covered} hand card(s) covered`);
  await shot(A, `layout-${w}x${h}`);
  // Revealed zone, expanded (history): still inside the viewport and clear of the hand and buttons.
  for (const P of [A, B]) {
    const tog = P.locator('.rz-head button:has-text("History")');
    if (await tog.count()) {
      await tog.click();
      await P.waitForTimeout(150);
      for (const p of [...new Set(await P.evaluate(boardProblems, BOARD))].slice(0, 8)) fail(`${w}x${h} revealed zone expanded: ${p}`);
      if (P === A) await shot(A, `reveal-open-${w}x${h}`);
      if (await P.locator('.modal-bg').count()) {
        // landscape phones: the history is a dialog; it must fit the viewport
        for (const p of await P.evaluate(() => { const r = document.querySelector('.modal-bg .modal').getBoundingClientRect(); return r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1 ? [`history dialog leaves the viewport (${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)})`] : []; })) fail(`${w}x${h}: ${p}`);
        await P.locator('.modal-bg .modal-head button:has-text("✕")').last().click();
      } else await P.locator('.rz-head button:has-text("Hide history")').click();
    } else fail(`${w}x${h}: no history toggle on the Revealed zone`);
  }

  // Menus: a hand card's menu, the land's menu with its submenu, and the More / help / phone action menus.
  const phone = await A.locator('.table.lay-portrait, .table.lay-landscape').count() > 0;
  const openers = [
    ['hand card', async () => { const c = A.locator('.hand .hcard').last(); await c.scrollIntoViewIfNeeded(); const b = await c.boundingBox(); await A.mouse.click(b.x + b.width / 2, b.y + 10, { button: 'right' }); }],
    ['land', async () => { const c = A.locator('.player-area.bottom .bf-row.lands .tcard').last(); await c.locator('.dots').click({ force: true }); }],
    ['more', async () => { const b = A.locator('.priority .more-btn, .my-tools button:has-text("More")').first(); await b.click(); }],
    ['help', async () => { const b = A.locator('.sub-actions button:has-text("?")'); if (await b.count()) await b.click(); }],
    ['stops', async () => { const b = A.locator('.settings-btn'); if (await b.count()) await b.click(); }],
  ];
  for (const [label, open] of openers) {
    try { await open(); } catch { continue; }
    await A.waitForTimeout(150);
    if (!(await A.locator('.ctx-menu, .stops-pop').count())) continue;
    for (const p of await A.evaluate(menuProblems)) fail(`${w}x${h} ${label} menu: ${p}`);
    const subs = A.locator('.ctx-menu .ctx-item.has-sub:not(.disabled)');
    if (await subs.count()) {
      await subs.last().click();
      await A.waitForTimeout(150);
      if (!(await A.locator('.ctx-sub').count())) fail(`${w}x${h} ${label}: submenu did not open on click`);
      for (const p of await A.evaluate(menuProblems)) fail(`${w}x${h} ${label} submenu: ${p}`);
    }
    if ((label === 'land' || label === 'stops') && !phone) await shot(A, `layout-${label}-${w}x${h}`);
    await A.keyboard.press('Escape');
    await A.waitForTimeout(100);
  }
}
await close();
}
// ---------------------------------------------------------------- packed boards
// 15, 25 and 40 permanents per side (lands with stacked basics and a nonbasic, creatures, tokens, artifacts), built in
// fix mode from the library (search) and the token maker. At every viewport: every battlefield card is whole, inside its
// board and the viewport, and clickable (not covered by another card or by the hand, buttons, stack or Revealed zone).
// Then a combat: an attacker gets its class, offset and a badge naming the defending player; a blocker names its attacker.

/** Runs in the page: battlefield cards outside their board / the viewport, or not clickable; and the permanents count. */
function battlefieldProblems() {
  const tol = 1.5, out = [];
  const name = (el) => `${el.closest('.player-area')?.classList.contains('top') ? 'top' : 'bottom'} ${el.closest('.bf-row')?.classList[1] ?? '?'} card ${el.dataset.iid}`;
  const counts = { top: 0, bottom: 0 };
  for (const card of document.querySelectorAll('.table .battlefield .tcard')) {
    const bf = card.closest('.battlefield');
    const side = card.closest('.player-area').classList.contains('top') ? 'top' : 'bottom';
    if (!card.closest('.attachment')) counts[side] += Number(card.querySelector('.stack-count')?.textContent.replace(/\D/g, '') || 1);
    const r = card.getBoundingClientRect(), b = bf.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) { out.push(`${name(card)} is ${Math.round(r.width)}x${Math.round(r.height)}`); continue; }
    if (r.left < b.left - tol || r.right > b.right + tol || r.top < b.top - tol || r.bottom > b.bottom + tol) {
      out.push(`${name(card)} leaves its board (${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)} vs ${Math.round(b.left)},${Math.round(b.top)}..${Math.round(b.right)},${Math.round(b.bottom)})`);
    }
    if (r.left < -tol || r.top < -tol || r.right > innerWidth + tol || r.bottom > innerHeight + tol) out.push(`${name(card)} leaves the viewport`);
    // clickable: some point of the card (its uncovered strip when overlapped) hits the card itself
    const pts = [];
    for (const fx of [0.08, 0.2, 0.5, 0.85]) for (const fy of [0.15, 0.5, 0.85]) pts.push([r.left + r.width * fx, r.top + r.height * fy]);
    const ok = pts.some(([x, y]) => { const e = document.elementFromPoint(x, y); return e && e.closest('.tcard') === card; });
    if (!ok) {
      const [x, y] = pts[4];
      const e = document.elementFromPoint(x, y);
      out.push(`${name(card)} is not clickable (covered by ${e ? `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}` : 'nothing'})`);
    }
  }
  const rows = [...document.querySelectorAll('.table .bf-row')].map((r) => `${r.closest('.player-area').classList.contains('top') ? 'T' : 'B'}:${r.classList[1]} cw=${r.dataset.cw} lines=${r.dataset.lines}${Number(r.dataset.overlap) ? ` ov=${r.dataset.overlap}` : ''}`);
  return { out, counts, rows };
}

/** Battlefield permanents of the bottom player (stacks count each land), by row. */
const myCounts = (P) => P.evaluate(() => {
  const n = (sel) => [...document.querySelectorAll(`.player-area.bottom .bf-row.${sel} .tcard`)].filter((c) => !c.closest('.attachment'))
    .reduce((a, c) => a + Number(c.querySelector('.stack-count')?.textContent.replace(/\D/g, '') || 1), 0);
  return { lands: n('lands'), creatures: n('creatures'), others: n('others') };
});

/** Fix mode: move up to `want` library cards matching `filter` onto the battlefield, via Search library. */
async function fromLibrary(P, wants) {
  await P.locator('.player-area.bottom .zone.lib').click();
  await P.locator('.ctx-menu .ctx-item', { hasText: 'Search library' }).click();
  const modal = P.locator('.modal', { hasText: 'Search your library' });
  await modal.waitFor();
  for (const [filter, want] of wants) {
    if (want <= 0) continue;
    await modal.locator('input[placeholder^="Filter"]').fill(filter);
    await P.waitForTimeout(100);
    const sel = modal.locator('.zcard select');
    let moved = 0;
    for (let i = 0; i < (await sel.count()) && moved < want; i++) {
      if ((await sel.nth(i).inputValue()) !== 'stay') continue;
      await sel.nth(i).selectOption('battlefield');
      moved++;
    }
  }
  await modal.getByRole('button', { name: 'Done' }).click();
  await settle(P, 400);
}

/** Fix mode: create n copies of a common token (by name). */
async function tokens(P, tokenIndex, n) {
  if (n <= 0) return;
  await P.locator('.my-tools button', { hasText: 'Tokens' }).click();
  const modal = P.locator('.modal', { hasText: 'Create tokens' });
  await modal.waitFor();
  const count = modal.locator('label', { hasText: 'How many?' }).locator('input');
  await count.fill(String(n));
  await count.press('Enter');
  await modal.locator('h4:has-text("Common") + .zone-grid .zcard').nth(tokenIndex).click();
  await settle(P, 400);
}
const TOK = { Treasure: 0, Clue: 1, Food: 2, Soldier: 3, Spirit: 4, Goblin: 5, Zombie: 6, Beast: 7 };

/** Bring the bottom player's side to `total` permanents: about 40% lands, 20% other permanents, the rest creatures. */
async function fillTo(P, total) {
  const lands = Math.round(total * 0.4), others = Math.round(total * 0.2), creatures = total - lands - others;
  let c = await myCounts(P);
  await fromLibrary(P, [['Rootbound Crag', Math.min(2, lands - c.lands)], ['Basic Land', lands - c.lands - 2], ['Sol Ring', Math.ceil((others - c.others) / 2)], ['Creature', Math.ceil((creatures - c.creatures) / 3)]]);
  c = await myCounts(P);
  // what the library could not supply: tokens (lands that are missing become creatures)
  const missingCreatures = creatures - c.creatures + Math.max(0, lands - c.lands);
  const kinds = [TOK.Soldier, TOK.Goblin, TOK.Beast, TOK.Spirit];
  for (let i = 0, left = missingCreatures; left > 0; i++) { const n = Math.ceil(left / (kinds.length - (i % kinds.length))); await tokens(P, kinds[i % kinds.length], n); left -= n; }
  const missingOthers = others - c.others;
  await tokens(P, TOK.Treasure, Math.ceil(missingOthers / 2));
  await tokens(P, TOK.Clue, Math.floor(missingOthers / 2));
  c = await myCounts(P);
  return c.lands + c.creatures + c.others;
}

/** Viewport sweep of the packed board (both boards as seen by P). */
async function checkPacked(P, label) {
  for (const [w, h] of VIEWPORTS) {
    await P.setViewportSize({ width: w, height: h });
    await P.mouse.move(w / 2, 1);
    await P.waitForTimeout(400);
    await P.keyboard.press('Escape');
    const r = await P.evaluate(battlefieldProblems);
    for (const p of r.out.slice(0, 10)) fail(`${label} ${w}x${h}: ${p}`);
    if (r.out.length > 10) fail(`${label} ${w}x${h}: ... and ${r.out.length - 10} more`);
    for (const p of [...new Set(await P.evaluate(boardProblems, BOARD))].slice(0, 8)) fail(`${label} ${w}x${h}: ${p}`);
    const covered = await P.evaluate(coveredHandCards);
    if (covered) fail(`${label} ${w}x${h}: ${covered} hand card(s) covered`);
    console.log(`    ${w}x${h}: ${r.counts.bottom}+${r.counts.top} permanents; ${r.rows.join(' · ')}`);
    await shot(P, `${label}-${w}x${h}`);
  }
}

if (!PART || PART === 'packed') {
  const deck = '12 Grizzly Bears\n8 Llanowar Elves\n8 Ornithopter\n6 Rootbound Crag\n6 Sol Ring';
  const { active: A, other: B, close } = await setup(deck, 'packed');
  step('packed boards: fix mode');
  await A.getByRole('button', { name: 'Fix board', exact: true }).click();
  await B.getByRole('button', { name: 'Allow' }).click();
  await A.locator('.fix-banner').waitFor();
  for (const total of [15, 25, 40]) {
    step(`packed boards: ${total} permanents per side`);
    for (const P of [A, B]) {
      await P.setViewportSize({ width: 1440, height: 900 });
      const n = await fillTo(P, total);
      if (n !== total) fail(`packed ${total}: ${P === A ? 'active' : 'other'} player has ${n} permanents`);
    }
    await settle(A, 500);
    const counts = (await A.evaluate(battlefieldProblems)).counts;
    if (counts.bottom !== total || counts.top !== total) fail(`packed ${total}: the board shows ${counts.bottom} (mine) and ${counts.top} (theirs) permanents`);
    if (total === 40 && !(await A.locator('.player-area .bf-row.lands .tcard.stacked').count())) fail('packed: identical basic lands are not stacked');
    await checkPacked(A, `packed${total}`);
    if (total === 40) await checkPacked(B, `packed${total}-other`);
  }
  await A.setViewportSize({ width: 1440, height: 900 });
  await B.setViewportSize({ width: 1440, height: 900 });
  await A.getByRole('button', { name: 'Done fixing' }).click();
  await settle(A, 500);

  // Combat: the other player's creatures were there since before their turn, so they can attack on it.
  step('combat: attacker class, offset and badge; blocker label');
  try {
    await passUntil([A, B], async () => (await B.locator('.player-area.bottom.active').count()) > 0 && /Attackers/.test(await B.locator('.phase.current').innerText().catch(() => '')), 'the other player\'s attackers step', 120);
    const can = B.locator('.player-area.bottom .bf-row.creatures .tcard.can-attack');
    if (!(await can.count())) fail('combat: no creature is highlighted as able to attack');
    if (!(await B.locator('.player-area.in-combat').count()) || !(await B.locator('.phases.in-combat .phase.combat-step').count())) fail('combat: no combat state on the boards / phase bar');
    const iid = await can.first().getAttribute('data-iid');
    // vertical offset of the card's centre from its slot's centre (negative = up)
    const slotBox = async (P, side) => P.locator(`.player-area.${side} .tcard[data-iid="${iid}"]`).evaluate((c) => { const s = c.parentElement.getBoundingClientRect(), r = c.getBoundingClientRect(); return { dy: (r.top + r.bottom) / 2 - (s.top + s.bottom) / 2 }; });
    const before = await slotBox(B, 'bottom');
    await B.locator(`.player-area.bottom .tcard[data-iid="${iid}"]`).click();
    await settle(B, 500);
    const atk = B.locator(`.player-area.bottom .tcard[data-iid="${iid}"]`);
    if (!/\battacking\b/.test(await atk.getAttribute('class'))) fail('combat: the declared attacker has no attacking class');
    const after = await slotBox(B, 'bottom');
    if (!(after.dy < before.dy - 3)) fail(`combat: the attacker did not move toward the opponent (${before.dy.toFixed(1)} -> ${after.dy.toFixed(1)})`);
    const badge = (await atk.locator('.combat-badge.attack').innerText().catch(() => '')).trim();
    if (!/Max|Sam/.test(badge)) fail(`combat: the attacker's badge should name the defending player (got "${badge}")`);
    await shot(B, 'combat-attacker-declaring');
    await pressOk(B, 600);
    // the defending player sees it on the top board, shifted down, and blocks it
    const theirs = A.locator(`.player-area.top .tcard[data-iid="${iid}"]`);
    await theirs.waitFor();
    if (!/\battacking\b/.test(await theirs.getAttribute('class'))) fail('combat: the defender does not see the attacker as attacking');
    const seen = await slotBox(A, 'top');
    if (!(seen.dy > 3)) fail(`combat: on the defender's screen the attacker is not shifted toward them (${seen.dy.toFixed(1)})`);
    await passUntil([A, B], async () => /Blockers/.test(await A.locator('.phase.current').innerText().catch(() => '')), 'blockers step', 30);
    const blocker = A.locator('.player-area.bottom .bf-row.creatures .tcard.can-block').first();
    if (await blocker.count()) {
      const bid = await blocker.getAttribute('data-iid');
      await blocker.click();
      await theirs.click();
      await settle(A, 500);
      const bl = A.locator(`.player-area.bottom .tcard[data-iid="${bid}"]`);
      if (!/\bblocking\b/.test(await bl.getAttribute('class'))) fail('combat: the blocker has no blocking class');
      const label = (await bl.locator('.combat-badge.block').innerText().catch(() => '')).trim();
      if (!label || label === '🛡') fail(`combat: the blocker's badge should name its attacker (got "${label}")`);
    } else fail('combat: no creature is highlighted as able to block');
    await A.mouse.move(1, 1);
    const r = await A.evaluate(battlefieldProblems);
    for (const p of r.out.slice(0, 8)) fail(`combat: ${p}`);
    await shot(A, 'combat-defender');
    await shot(B, 'combat-attacker');
    await B.setViewportSize({ width: 844, height: 390 });
    await A.setViewportSize({ width: 390, height: 844 });
    await settle(A, 400);
    for (const [P, l] of [[A, 'combat-phone-portrait'], [B, 'combat-phone-landscape']]) {
      await P.mouse.move(1, 1);
      for (const p of (await P.evaluate(battlefieldProblems)).out.slice(0, 8)) fail(`${l}: ${p}`);
      await shot(P, l);
    }
  } catch (e) {
    fail(`combat: ${e.message}\n${await logTail(A, 8)}`);
    await shot(A, 'combat-debug-A');
    await shot(B, 'combat-debug-B');
  }
  await close();
  if (errors.length) fail(`page errors: ${errors.join('; ')}`);
}

await browser.close();
if (failed) { console.log('LAYOUT FAILED'); process.exit(1); }
console.log('LAYOUT OK');
