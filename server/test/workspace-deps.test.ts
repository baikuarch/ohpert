import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RepoRecord, Requirement } from '../src/types.js';

// Point the app's data dir at a throwaway location *before* importing modules
// that open the SQLite DB at import time.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohpert-data-'));
process.env.OHPERT_DATA_DIR = dataDir;

const { prepareWorkspace, cleanupWorkspace, workspacePathFor } = await import('../src/services/workspace.js');
const { repoStore } = await import('../src/store/repo-store.js');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=ohpert Test', '-c', 'user.email=test@local', ...args], {
    cwd,
    encoding: 'utf8',
  });

function makeRepo(): { dir: string; repo: RepoRecord } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohpert-repo-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: { build: 'vite build' } }));
  // Only ignored paths may be linked/copied, so that platform commits stay clean.
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n.env*\ndist\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const ok = true;\n');
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', '.bin', 'vite'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(dir, '.env.local'), 'SECRET=1\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');

  const repo: RepoRecord = {
    id: 'repo_abcdef123456',
    path: dir,
    name: 'demo-app',
    role: 'frontend',
    roleSource: 'auto',
    stack: [],
    description: '',
    branch: 'main',
    addedAt: new Date().toISOString(),
    lastAnalyzedAt: null,
  };
  return { dir, repo };
}

function makeRequirement(id: string): Requirement {
  const ts = new Date().toISOString();
  return {
    id,
    seq: 7,
    title: 'demo requirement',
    description: '',
    priority: 'normal',
    status: 'implementing',
    createdAt: ts,
    updatedAt: ts,
    queuedAt: null,
    analyzedAt: null,
    implementedAt: null,
    completedAt: null,
    report: null,
    implementation: null,
    acceptance: null,
    userConfirmation: null,
    reworkRounds: 0,
    feedback: [],
    jobId: null,
    error: null,
    targetRepos: [],
  };
}

const { repo } = makeRepo();
repoStore.upsert(repo, null);
const requirement = makeRequirement('req_deps000001');

test('prepareWorkspace links ignored node_modules and copies ignored .env files', async () => {
  const ws = await prepareWorkspace(repo, requirement);

  assert.equal(ws.mode, 'worktree');
  assert.equal(ws.path, workspacePathFor(requirement.id, repo));
  assert.ok(fs.existsSync(ws.path), 'worktree directory exists');

  const nodeModules = path.join(ws.path, 'node_modules');
  assert.ok(fs.lstatSync(nodeModules).isSymbolicLink(), 'node_modules is a symlink, not a full copy');
  assert.equal(fs.readFileSync(path.join(nodeModules, '.bin', 'vite'), 'utf8'), '#!/bin/sh\n');

  const envFile = path.join(ws.path, '.env.local');
  assert.ok(fs.lstatSync(envFile).isFile(), '.env.local is copied as a real file');
  assert.equal(fs.readFileSync(envFile, 'utf8'), 'SECRET=1\n');

  // Neither dependency tree nor secrets may show up as pending commits.
  const status = git(ws.path, 'status', '--porcelain');
  assert.equal(status.trim(), '', `worktree should be clean, got:\n${status}`);
});

test('cleanupWorkspace removes the worktree and its git metadata', async () => {
  const wsPath = workspacePathFor(requirement.id, repo);
  const results = await cleanupWorkspace(requirement.id);
  assert.equal(
    results.every((r) => r.ok),
    true,
    JSON.stringify(results),
  );
  assert.equal(fs.existsSync(wsPath), false);

  const list = git(repo.path, 'worktree', 'list', '--porcelain');
  assert.equal(list.includes(wsPath), false, 'worktree registration is pruned');
});
