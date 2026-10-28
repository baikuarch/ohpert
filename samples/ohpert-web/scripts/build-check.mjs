// lightweight "build": validate every source file with node --check (ESM aware)
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'ohpert-build-'));
let failures = 0;
let checked = 0;
const walk = (root) => {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) {
      const tmp = join(dir, 'check.mjs');
      writeFileSync(tmp, readFileSync(p, 'utf8'));
      try {
        execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
        checked++;
      } catch (err) {
        failures++;
        console.error(`syntax error in ${p}\n${String(err.stderr).split('\n')[0]}`);
      }
    }
  }
};
walk(new URL('../src', import.meta.url).pathname);
if (failures) process.exit(1);
console.log(`build ok (${checked} files checked)`);
