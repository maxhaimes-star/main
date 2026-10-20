// Runs every browser test in sequence against a running server.
// Usage: npm run e2e -- [baseUrl] [outDir]      or      BASE_URL=http://localhost:3001 E2E_OUT=shots npm run e2e
// Env: ONLY=<name prefix> (strict/engine2: run one scenario), SCRIPTS=smoke,strict (subset), CHROME_PATH.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:3001';
const out = process.argv[3] ?? process.env.E2E_OUT ?? 'test-results';
const all = ['smoke', 'auction', 'strict', 'engine2', 'layout', 'cubelib', 'decks', 'bot', 'savant', 'powerup'];
const want = process.env.SCRIPTS ? process.env.SCRIPTS.split(',') : all;
const results = [];
for (const name of want) {
  console.log(`\n=== ${name} (${base}) ===`);
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, `${name}.mjs`), base, out], { stdio: 'inherit' });
  results.push({ name, ok: r.status === 0, secs: Math.round((Date.now() - t) / 1000) });
}
console.log('\n--- e2e summary ---');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.secs}s)`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
