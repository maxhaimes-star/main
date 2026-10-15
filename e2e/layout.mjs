// Layout check: the action buttons near the pass button must not cover any hand card.
import { browser, setup, shot, step, OUT } from './lib.mjs';
import fs from 'node:fs';

fs.mkdirSync(OUT, { recursive: true });
let failed = false;
for (const [w, h] of [[1280, 720], [1440, 900], [1920, 1080]]) {
  step(`viewport ${w}x${h}`);
  const { A, close } = await setup('20 Lightning Bolt\n20 Mountain', `layout-${w}`);
  await A.setViewportSize({ width: w, height: h });
  await A.waitForTimeout(500);
  // A card is usable if the point a player would click (its visible upper middle) hits the card itself.
  const overlaps = await A.evaluate(() => {
    const cards = [...document.querySelectorAll('.hand .hcard')];
    return cards.filter((c) => {
      const r = c.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = Math.min(r.top + r.height * 0.25, window.innerHeight - 4);
      const el = document.elementFromPoint(x, y);
      return !el || !c.contains(el) && !el.closest('.hand');
    }).length;
  });
  await shot(A, `layout-${w}x${h}`);
  console.log(`  ${w}x${h}: ${overlaps} hand card(s) covered`);
  if (overlaps) failed = true;
  await close();
}
await browser.close();
if (failed) { console.log('LAYOUT FAILED'); process.exit(1); }
console.log('LAYOUT OK');
