import fs from 'node:fs';
import path from 'node:path';
import { IGNORE_DIRS, WORKSPACE_DIR, ensureDir } from '../config.js';
import { git, run } from '../lib/git.js';
import { log } from '../lib/log.js';
import type { FileChange, Requirement, RepoRecord } from '../types.js';
import { requirementStore, repoStore } from '../store/repo-store.js';

export interface WorkspaceRepo {
  repo: RepoRecord;
  path: string;
  baseBranch: string;
  baseRev: string;
  branch: string;
  mode: 'worktree' | 'inplace';
}

export interface CleanupResult {
  repoId: string;
  repoName: string;
  ok: boolean;
  message: string;
}

function safeSlug(s: string) {
  return (
    s
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'repo'
  );
}

function firstLine(text: string) {
  const line =
    text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .pop() ?? '';
  return line.slice(0, 300);
}

/* ------------------------------------------------------------------ */
/* dependency / env bootstrapping for isolated worktrees               */
/* ------------------------------------------------------------------ */

/**
 * A `git worktree` only contains tracked files: no `node_modules`, no local
 * `.env`. Without them, every JS build (`vite`, `vue-tsc`, `tsc` …) fails and
 * the agent burns all repair rounds on a problem that has nothing to do with
 * its changes.
 */
function collectDependencyDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === 'node_modules') {
        out.push(childRel);
        continue;
      }
      if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), childRel, depth + 1);
    }
  };
  walk(root, '', 0);
  return out;
}

const ENV_FILE_RE = /^\.env(\.[A-Za-z0-9_-]+)?$/;

function collectEnvFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
        walk(path.join(dir, e.name), childRel, depth + 1);
      } else if (e.isFile() && ENV_FILE_RE.test(e.name)) {
        out.push(childRel);
      }
    }
  };
  walk(root, '', 0);
  return out;
}

async function isGitIgnored(repoPath: string, rel: string) {
  const res = await git(repoPath, ['check-ignore', '-q', rel]);
  return res.code === 0;
}

/**
 * Link `node_modules` trees and copy git-ignored `.env*` files into a worktree.
 * Only ignored paths are linked/copied, so the platform's automatic `git add -A`
 * can never commit dependencies or secrets.
 */
export async function linkWorkspaceDeps(
  repo: RepoRecord,
  wtPath: string,
  ctx: { jobId?: string; requirementId?: string } = {},
): Promise<string[]> {
  const prepared: string[] = [];
  const logCtx = { ...ctx, repoId: repo.id };

  for (const rel of collectDependencyDirs(repo.path)) {
    const src = path.join(repo.path, rel);
    const dst = path.join(wtPath, rel);
    if (fs.existsSync(dst)) continue;
    if (!(await isGitIgnored(repo.path, rel))) {
      log('warn', `${repo.name}: ${rel} 未被 .gitignore 忽略，跳过链接以避免把依赖提交进平台分支`, logCtx);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
      prepared.push(rel);
    } catch (err) {
      log('warn', `${repo.name}: 无法链接 ${rel}（${(err as Error).message}），构建可能缺少依赖`, logCtx);
    }
  }

  for (const rel of collectEnvFiles(repo.path)) {
    const src = path.join(repo.path, rel);
    const dst = path.join(wtPath, rel);
    if (fs.existsSync(dst)) continue;
    if (!(await isGitIgnored(repo.path, rel))) continue;
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      prepared.push(rel);
    } catch (err) {
      log('warn', `${repo.name}: 无法复制 ${rel}（${(err as Error).message}）`, logCtx);
    }
  }

  if (prepared.length) {
    log('info', `${repo.name}: 已为隔离工作区准备 ${prepared.join('、')}`, logCtx);
  }
  return prepared;
}

/* ------------------------------------------------------------------ */
/* git worktree helpers                                                */
/* ------------------------------------------------------------------ */

/** Remove a worktree directory and prune its stale git metadata. */
async function removeWorktree(repo: RepoRecord, wtPath: string): Promise<boolean> {
  if (!fs.existsSync(wtPath)) {
    await git(repo.path, ['worktree', 'prune']);
    return false;
  }
  const removed = await git(repo.path, ['worktree', 'remove', '--force', wtPath], 120_000);
  try {
    fs.rmSync(wtPath, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  // always prune: a failed `worktree remove` leaves an entry behind
  await git(repo.path, ['worktree', 'prune']);
  return removed.code === 0;
}

async function deleteBranch(repo: RepoRecord, branch: string): Promise<boolean> {
  if (!branch) return false;
  const exists = await git(repo.path, ['rev-parse', '--verify', `refs/heads/${branch}`]);
  if (exists.code !== 0) return false;
  const del = await git(repo.path, ['branch', '-D', branch]);
  return del.code === 0;
}

/** Delete every `ohpert/req-<seq>-*` branch recorded for a requirement in this repo. */
async function deleteRequirementBranches(repo: RepoRecord, req: Requirement): Promise<number> {
  const branches = new Set<string>();
  for (const entry of req.implementation?.repos ?? []) {
    if (entry.repoId === repo.id) branches.add(entry.branch);
  }
  const listed = await git(repo.path, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/ohpert/req-${req.seq}-*`,
  ]);
  for (const line of listed.stdout.split('\n')) {
    const branch = line.trim();
    if (branch) branches.add(branch);
  }
  let deleted = 0;
  for (const branch of branches) {
    if (await deleteBranch(repo, branch)) deleted++;
  }
  return deleted;
}

/* ------------------------------------------------------------------ */
/* workspace lifecycle                                                 */
/* ------------------------------------------------------------------ */

/**
 * Prepare an isolated writable copy for one repo.
 * Preferred: `git worktree` off the current HEAD in a separate directory so the
 * user's own checkout is never touched. We stop with an actionable error when a
 * worktree cannot be created instead of silently editing the user's checkout.
 */
export async function prepareWorkspace(
  repo: RepoRecord,
  requirement: Requirement,
  jobId?: string,
): Promise<WorkspaceRepo> {
  const root = repo.path;
  const branchName = `ohpert/req-${requirement.seq}-${safeSlug(requirement.title).toLowerCase().slice(0, 32) || 'feature'}`;

  const headRes = await git(root, ['rev-parse', 'HEAD']);
  if (headRes.code !== 0) throw new Error(`${repo.name}: 无法解析 HEAD（空仓库或非 git 仓库）`);
  const baseRev = headRes.stdout.trim();
  const baseBranchRes = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const baseBranch = baseBranchRes.stdout.trim() || 'HEAD';

  const worktreeParent = ensureDir(path.join(WORKSPACE_DIR, requirement.id));
  const wtPath = path.join(worktreeParent, `${safeSlug(repo.name)}-${repo.id.slice(0, 6)}`);

  // clean stale worktree dir + metadata
  if (fs.existsSync(wtPath)) {
    await removeWorktree(repo, wtPath);
  }

  // remove an existing branch with the same name (rework rounds reuse it)
  const branchExists = await git(root, ['rev-parse', '--verify', `refs/heads/${branchName}`]);
  if (branchExists.code === 0) {
    await git(root, ['worktree', 'prune']);
    const wtList = await git(root, ['worktree', 'list', '--porcelain']);
    const inUse = wtList.stdout.split('\n\n').some((b) => b.includes(`branch refs/heads/${branchName}`));
    if (!inUse) await git(root, ['branch', '-D', branchName]);
  }

  const add = await git(root, ['worktree', 'add', '-b', branchName, wtPath, baseRev], 120_000);
  if (add.code === 0) {
    await linkWorkspaceDeps(repo, wtPath, { jobId, requirementId: requirement.id });
    log('info', `${repo.name}: 已创建独立工作区 ${wtPath}（分支 ${branchName}）`, {
      jobId,
      requirementId: requirement.id,
      repoId: repo.id,
    });
    return { repo, path: wtPath, baseBranch, baseRev, branch: branchName, mode: 'worktree' };
  }

  // Never silently fall back to editing the user's own checkout: if git cannot
  // write here (macOS sandbox, read-only mount, restrictive ACLs …) we stop with
  // an actionable message instead of touching files the user didn't expect.
  const detail = (add.stderr || add.stdout).trim();
  const permissionDenied = /operation not permitted|permission denied|read-only|unable to create|EACCES/i.test(detail);
  throw new Error(
    permissionDenied
      ? `${repo.name}: 无法在该仓库创建平台分支（${firstLine(detail)}）。` +
          `ohpert 需要写入 ${path.join(root, '.git')} 的权限才能在独立 worktree 中改代码。` +
          `请确认该目录未被「文件与文件夹」权限、安全软件或 macOS 沙箱保护（例如授予终端/ohpert 完全磁盘访问权限），或把仓库放到可写目录后重试。`
      : `${repo.name}: 创建 git worktree 失败（${firstLine(detail)}）。请检查该仓库的 .git 是否完整可写。`,
  );
}

export function workspacePathFor(reqId: string, repo: RepoRecord) {
  return path.join(WORKSPACE_DIR, reqId, `${safeSlug(repo.name)}-${repo.id.slice(0, 6)}`);
}

/**
 * Remove a requirement's worktrees and (optionally) its platform branches.
 * `deleteBranches` stays off for failure cleanup so a half-finished branch can
 * still be inspected, and is on for explicit rollback / requirement deletion.
 */
export async function cleanupWorkspace(
  reqId: string,
  opts: { deleteBranches?: boolean } = {},
): Promise<CleanupResult[]> {
  const req = requirementStore.get(reqId);
  const dir = path.join(WORKSPACE_DIR, reqId);
  const results: CleanupResult[] = [];
  const repos = repoStore.list();
  const targets = new Map<string, { repo: RepoRecord; path: string }>();

  // Canonical path first (works for every id shape, including `repo_xxxxxx`),
  // then any repo recorded in the implementation whose folder is already gone
  // (its branch still needs deleting).
  for (const repo of repos) {
    const wtPath = workspacePathFor(reqId, repo);
    if (fs.existsSync(wtPath)) targets.set(repo.id, { repo, path: wtPath });
  }
  for (const entry of req?.implementation?.repos ?? []) {
    const repo = repoStore.get(entry.repoId);
    if (repo) targets.set(repo.id, { repo, path: workspacePathFor(reqId, repo) });
  }

  const cleanRepo = async (repo: RepoRecord, wtPath: string) => {
    try {
      await removeWorktree(repo, wtPath);
      const deleted = opts.deleteBranches && req ? await deleteRequirementBranches(repo, req) : 0;
      const message = deleted ? `已清理工作区并删除 ${deleted} 个平台分支` : '已清理工作区';
      results.push({ repoId: repo.id, repoName: repo.name, ok: true, message });
      log('info', `${repo.name}: ${message}`, { requirementId: reqId, repoId: repo.id });
    } catch (err) {
      const message = (err as Error).message;
      results.push({ repoId: repo.id, repoName: repo.name, ok: false, message });
      log('warn', `${repo.name}: 清理工作区失败：${message}`, { requirementId: reqId, repoId: repo.id });
    }
  };

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    /* no workspace directory */
  }

  for (const { repo, path: wtPath } of targets.values()) {
    await cleanRepo(repo, wtPath);
  }

  // Remove leftover directories for repos that are no longer registered: we
  // cannot prune their git metadata, but the disk copy must not linger.
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (!fs.existsSync(full)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return results;
}

/** Parse `git diff --numstat` plus full patch into structured FileChange records. */
export async function collectChanges(
  ws: WorkspaceRepo,
  baseRev: string,
  currentRev: string,
  source: FileChange['source'] = 'ai',
): Promise<FileChange[]> {
  const dir = ws.path;
  await git(dir, ['add', '-A']);
  const numstat = await git(dir, ['diff', '--numstat', baseRev, currentRev]);
  const patch = await git(dir, ['diff', '--patch', '--no-color', baseRev, currentRev], 120_000);
  const nameStatus = await git(dir, ['diff', '--name-status', baseRev, currentRev]);

  const kinds = new Map<string, FileChange['kind']>();
  for (const line of nameStatus.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [code, ...rest] = line.split('\t');
    const file = rest[rest.length - 1];
    if (!file) continue;
    const kind: FileChange['kind'] = code.startsWith('A')
      ? 'added'
      : code.startsWith('D')
        ? 'deleted'
        : code.startsWith('R')
          ? 'renamed'
          : 'modified';
    kinds.set(file, kind);
  }

  const chunks = splitPatchByFile(patch.stdout);
  const out: FileChange[] = [];
  for (const line of numstat.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [adds, dels, file] = line.split('\t');
    if (!file) continue;
    const binary = adds === '-' || dels === '-';
    out.push({
      repoId: ws.repo.id,
      repoName: ws.repo.name,
      file,
      kind: kinds.get(file) ?? 'modified',
      additions: binary ? 0 : Number(adds) || 0,
      deletions: binary ? 0 : Number(dels) || 0,
      patch: chunks.get(file) ?? '(二进制或过大文件，未展示 patch)',
      source,
    });
  }
  return out;
}

export function splitPatchByFile(patch: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!patch) return map;
  const lines = patch.split('\n');
  let cur: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (cur) map.set(cur, buf.join('\n'));
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      buf = [line];
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = m ? m[2] : null;
    } else if (cur) {
      buf.push(line);
    }
  }
  flush();
  return map;
}

export async function commitWorkspace(ws: WorkspaceRepo, message: string): Promise<string | null> {
  await git(ws.path, ['add', '-A']);
  const status = await git(ws.path, ['status', '--porcelain']);
  if (!status.stdout.trim()) return null;
  const res = await run(
    'git',
    ['-c', 'user.name=ohpert AI', '-c', 'user.email=ohpert@local', 'commit', '-m', message, '--no-verify'],
    { cwd: ws.path, env: { GIT_TERMINAL_PROMPT: '0' } },
  );
  if (res.code !== 0) throw new Error(`提交失败: ${res.stderr || res.stdout}`);
  const head = await git(ws.path, ['rev-parse', 'HEAD']);
  return head.stdout.trim();
}

/** Restore a repo to the state it had before the requirement was implemented. */
export async function revertRequirement(reqId: string, opts: { jobId?: string } = {}) {
  const req = requirementStore.get(reqId);
  if (!req) throw new Error('需求不存在');
  const impl = req.implementation;
  if (!impl) throw new Error('该需求没有代码改动记录');

  const results: { repoId: string; repoName: string; ok: boolean; message: string }[] = [];
  for (const entry of impl.repos) {
    const repo = repoStore.get(entry.repoId);
    if (!repo) {
      results.push({ repoId: entry.repoId, repoName: entry.repoId, ok: false, message: '工程已被移除' });
      continue;
    }
    const wtPath = workspacePathFor(reqId, repo);
    try {
      await removeWorktree(repo, wtPath);
      // legacy in-place implementations edited the user's checkout directly
      const head = await git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (head.code === 0 && head.stdout.trim() === entry.branch) {
        await git(repo.path, ['reset', '--hard', entry.baseRev]);
        await git(repo.path, ['checkout', entry.baseBranch]);
      }
      const deleted = await deleteBranch(repo, entry.branch);
      const message = deleted ? '已回滚并删除平台分支' : '已清理工作区（分支不存在或已被删除）';
      log('info', `${repo.name}: ${message}`, { jobId: opts.jobId, requirementId: reqId, repoId: repo.id });
      results.push({ repoId: entry.repoId, repoName: repo.name, ok: true, message });
    } catch (err) {
      results.push({ repoId: entry.repoId, repoName: repo.name, ok: false, message: (err as Error).message });
    }
  }
  try {
    fs.rmSync(path.join(WORKSPACE_DIR, reqId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return results;
}
