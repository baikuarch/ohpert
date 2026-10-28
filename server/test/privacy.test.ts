import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Guard rails for the public repository: demo data and defaults must never
// carry a maintainer's home directory or a private gateway/model identifier.
const PRIVATE_MARKERS = [/\/Users\/[^/\s"']+\//, /\/home\/[^/\s"']+\//, /[A-Za-z]:\\\\Users\\\\/];

test('demo data contains no absolute home paths or private model identifiers', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'server', 'demo', 'sample-demo.json'), 'utf8');
  for (const marker of PRIVATE_MARKERS) assert.doesNotMatch(raw, marker);
  assert.doesNotMatch(raw, /"aiModel":\s*"auto\//);
});

test('default LLM settings are a public endpoint, not a private gateway', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'src', 'store', 'settings.ts'), 'utf8');
  assert.match(src, /https:\/\/api\.openai\.com\/v1/);
  assert.doesNotMatch(src, /127\.0\.0\.1|localhost/);
});

test('bundled samples are plain directories, not nested Git repositories', () => {
  const samples = path.join(ROOT, 'samples');
  for (const entry of fs.readdirSync(samples, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    assert.equal(fs.existsSync(path.join(samples, entry.name, '.git')), false, `${entry.name} must not ship a .git`);
  }
});
