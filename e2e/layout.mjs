// Layout checks for the game table at desktop and phone sizes:
//  - no board element overflows the viewport or is clipped by an overflow container (scrollable strips excepted);
//  - the phase bar pieces and the pass/action buttons do not overlap each other or the piles;
//  - opened menus and submenus stay inside the viewport;
//  - the action buttons near the pass button do not cover any hand card (cards stay clickable).
import { browser, setup, shot, step, handLands, settle } from './lib.mjs';

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
    const subs = A.locator('.ctx-menu .ctx-item.has-sub');
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
await browser.close();
if (failed) { console.log('LAYOUT FAILED'); process.exit(1); }
console.log('LAYOUT OK');
