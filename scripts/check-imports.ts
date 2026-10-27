/**
 * Import-order smoke check: every shared module must load as the first (entry) import without a TDZ /
 * "before initialization" error from an import cycle.
 *   npx tsx scripts/check-imports.ts
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'shared', 'src');
const files = ['engine', 'game', '.'].flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith('.ts')).map((f) => join(root, d, f)));
let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--import', 'tsx', '-e', `await import(${JSON.stringify(f)})`], { stdio: 'pipe' });
  } catch (e) {
    bad++;
    const msg = String((e as { stderr?: Buffer }).stderr ?? e).split('\n').find((l) => /Error/.test(l)) ?? 'failed';
    console.log(`${f.slice(root.length + 1)}: ${msg}`);
  }
}
console.log(`${files.length - bad}/${files.length} modules load as the entry import`);
process.exit(bad ? 1 : 0);
