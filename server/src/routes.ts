import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bus, log } from './lib/log.js';
import { isGitRepo, git } from './lib/git.js';
import { isInside, realpathNearest } from './lib/paths.js';
import { id as newId, basename, normalizePath } from './lib/util.js';
import { archStore, jobStore, logStore, repoStore, requirementStore } from './store/repo-store.js';
import {
  getRawSettings,
  publicAiSettings,
  resolveAiSettings,
  saveAiSettings,
  saveCommandSettings,
  saveWorkspaceRoots,
} from './store/settings.js';
import { now } from './store/db.js';
import { listModels, testConnection } from './llm/client.js';
import type { RepoRecord, Requirement, RequirementStatus } from './types.js';
import {
  cancelJob,
  isRunning,
  kickQueue,
  startAcceptance,
  startArchitectureAnalysis,
  startImplementation,
  startRequirementAnalysis,
  userConfirm,
} from './services/orchestrator.js';
import { cleanupWorkspace, revertRequirement } from './services/workspace.js';
import { seedDemo } from './services/demo.js';
import { probeRepoWrite } from './services/repo-probe.js';

export const api = new Hono();

const fail = (c: any, err: unknown, status: 400 | 403 | 404 | 500 = 400) =>
  c.json({ error: (err as Error)?.message ?? String(err) }, status);

/**
 * Filesystem browsing and repo registration are limited to the configured
 * workspace roots. The API is unauthenticated (local-first app), so without this
 * any page on the machine could enumerate or register arbitrary directories.
 */
function allowedRoots(): string[] {
  return (getRawSettings().workspaceRoots ?? []).filter(Boolean).map((r) => realpathNearest(r));
}

function isAllowedPath(target: string): boolean {
  const real = realpathNearest(target);
  return allowedRoots().some((root) => isInside(root, real));
}

/* ---------------------------- meta ---------------------------- */

api.get('/health', (c) => c.json({ ok: true, ts: now(), pid: process.pid }));

api.get('/bootstrap', (c) => {
  const repos = repoStore.list();
  const requirements = requirementStore.list();
  return c.json({
    repos,
    profiles: repoStore.allProfiles(),
    architecture: archStore.get(),
    requirements,
    jobs: jobStore.list(60),
    logs: logStore.list({ limit: 200 }),
    ai: publicAiSettings(),
    settings: { commands: getRawSettings().commands, workspaceRoots: getRawSettings().workspaceRoots },
    stats: computeStats(requirements),
  });
});

function computeStats(reqs: Requirement[]) {
  const byStatus: Record<string, number> = {};
  for (const r of reqs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return {
    total: reqs.length,
    active: reqs.filter((r) => !['completed', 'rejected'].includes(r.status)).length,
    completed: reqs.filter((r) => r.status === 'completed').length,
    awaiting: reqs.filter((r) => r.status === 'awaiting_approval').length,
    byStatus,
  };
}

/* ---------------------------- filesystem ---------------------------- */

api.get('/fs/dirs', (c) => {
  const input = c.req.query('path');
  const roots = getRawSettings().workspaceRoots ?? [];
  const target = input ? normalizePath(input) : (roots[0] ?? process.env.HOME ?? '/');
  try {
    if (!isAllowedPath(target)) {
      return c.json({ error: `只能浏览已配置的工作区根目录（当前：${roots.join('、') || '未配置'}）` }, 403);
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) return c.json({ error: '目录不存在' }, 400);
    const entries = fs
      .readdirSync(target, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => {
        const full = path.join(target, e.name);
        return { name: e.name, path: full, isGit: fs.existsSync(path.join(full, '.git')) };
      })
      .sort((a, b) => Number(b.isGit) - Number(a.isGit) || a.name.localeCompare(b.name));
    const parent = path.dirname(target);
    return c.json({
      path: target,
      parent: parent === target || !isAllowedPath(parent) ? null : parent,
      entries,
      roots,
      isGitRepo: fs.existsSync(path.join(target, '.git')),
    });
  } catch (err) {
    return fail(c, err);
  }
});

api.get('/fs/search', (c) => {
  const q = (c.req.query('q') ?? '').toLowerCase();
  const base = c.req.query('base') || getRawSettings().workspaceRoots?.[0] || process.env.HOME || '/';
  if (!q) return c.json({ results: [] });
  if (!isAllowedPath(base)) {
    return c.json({ error: '只能搜索已配置的工作区根目录', results: [], base }, 403);
  }
  const results: { name: string; path: string; isGit: boolean }[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (results.length >= 40 || depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= 40) return;
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || ['node_modules', 'Library', 'Applications', 'System'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.name.toLowerCase().includes(q) && !seen.has(full)) {
        seen.add(full);
        results.push({ name: e.name, path: full, isGit: fs.existsSync(path.join(full, '.git')) });
      }
      walk(full, depth + 1);
    }
  };
  walk(base, 0);
  return c.json({ results, base });
});

/* ---------------------------- repos ---------------------------- */

api.get('/repos', (c) => c.json({ repos: repoStore.list() }));

api.post('/repos', async (c) => {
  try {
    const body = await c.req.json<{ paths?: string[]; path?: string; role?: string }>();
    const inputs = body.paths ?? (body.path ? [body.path] : []);
    if (!inputs.length) return c.json({ error: '请提供工程目录' }, 400);
    const added: RepoRecord[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const raw of inputs) {
      const dir = normalizePath(path.resolve(raw.trim()));
      if (!isAllowedPath(dir)) {
        return c.json(
          {
            error: `工程必须位于已配置的工作区根目录内（当前：${(getRawSettings().workspaceRoots ?? []).join('、') || '未配置'}）：${dir}`,
          },
          403,
        );
      }
      if (!fs.existsSync(dir)) {
        skipped.push({ path: dir, reason: '目录不存在' });
        continue;
      }
      if (!(await isGitRepo(dir))) {
        skipped.push({ path: dir, reason: '不是 Git 仓库根目录（请选择包含 .git 的工程根目录）' });
        continue;
      }
      const existing = repoStore.list().find((r) => r.path === dir);
      if (existing) {
        skipped.push({ path: dir, reason: `已添加（${existing.name}）` });
        continue;
      }
      const remote = await git(dir, ['remote', 'get-url', 'origin']);
      const head = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const rec: RepoRecord = {
        id: newId('repo'),
        path: dir,
        name: basename(dir),
        role: (body.role as any) || 'unknown',
        roleSource: body.role ? 'user' : 'auto',
        description: remote.code === 0 ? remote.stdout.trim() : '',
        stack: [],
        branch: head.code === 0 ? head.stdout.trim() : '',
        addedAt: now(),
        lastAnalyzedAt: null,
      };
      repoStore.upsert(rec, null);
      added.push(rec);
      log('info', `添加工程 ${rec.name} (${rec.path})${rec.description ? ` ← ${rec.description}` : ''}`, {
        repoId: rec.id,
      });
    }
    bus.change('repos');
    return c.json({ added, skipped, repos: repoStore.list() });
  } catch (err) {
    return fail(c, err);
  }
});

/** Can ohpert actually write to this repo (create branch/worktree)? Used before研发 和 by the 重检 button. */
api.get('/repos/:id/writable', async (c) => {
  try {
    const probe = await probeRepoWrite(c.req.param('id'));
    return c.json(probe);
  } catch (err) {
    return c.json({ ok: false, message: (err as Error).message, hints: [] }, 200);
  }
});

api.patch('/repos/:id', async (c) => {
  const id = c.req.param('id');
  const rec = repoStore.get(id);
  if (!rec) return c.json({ error: '工程不存在' }, 404);
  const body = await c.req.json<{ role?: string; name?: string }>();
  if (body.role) repoStore.setRole(id, body.role);
  bus.change('repos', id);
  return c.json({ repo: repoStore.get(id) });
});

api.delete('/repos/:id', (c) => {
  const id = c.req.param('id');
  if (!repoStore.get(id)) return c.json({ error: '工程不存在' }, 404);
  repoStore.remove(id);
  bus.change('repos', id);
  return c.json({ ok: true });
});

api.post('/demo/seed', async (c) => {
  try {
    const body = await c.req.json<{ force?: boolean }>().catch(() => ({}) as any);
    const res = await seedDemo({ force: body?.force });
    bus.change('repos');
    bus.change('architecture');
    bus.change('requirements');
    log('info', `已载入演示数据（新增工程：${res.added.join('、') || '无'}）`);
    return c.json(res);
  } catch (err) {
    return fail(c, err);
  }
});

/* ---------------------------- architecture ---------------------------- */

api.get('/architecture', (c) => c.json({ architecture: archStore.get() }));

api.post('/architecture/analyze', async (c) => {
  try {
    const body = await c.req.json<{ repoIds?: string[] }>().catch(() => ({}) as any);
    const job = await startArchitectureAnalysis({ repoIds: body?.repoIds });
    return c.json({ job });
  } catch (err) {
    return fail(c, err);
  }
});

/* ---------------------------- requirements ---------------------------- */

const ACTIVE_STATUSES: RequirementStatus[] = [
  'draft',
  'queued',
  'analyzing',
  'analyzed',
  'implementing',
  'implemented',
  'accepting',
  'awaiting_approval',
  'needs_rework',
];

api.get('/requirements', (c) => {
  const scope = c.req.query('scope');
  const statuses = scope === 'history' ? ['completed'] : scope === 'active' ? ACTIVE_STATUSES : undefined;
  const list = requirementStore.list(statuses);
  return c.json({ requirements: list, stats: computeStats(requirementStore.list()) });
});

api.get('/requirements/:id', (c) => {
  const req = requirementStore.get(c.req.param('id'));
  if (!req) return c.json({ error: '需求不存在' }, 404);
  return c.json({
    requirement: req,
    jobs: jobStore.forRequirement(req.id),
    logs: logStore.list({ requirementId: req.id, limit: 400 }),
  });
});

api.post('/requirements', async (c) => {
  try {
    const body = await c.req.json<{
      title?: string;
      description?: string;
      priority?: Requirement['priority'];
      enqueue?: boolean;
      targetRepos?: string[];
    }>();
    const description = (body.description ?? '').trim();
    if (!description) return c.json({ error: '需求描述不能为空' }, 400);
    const title = (body.title ?? '').trim() || description.split('\n')[0].slice(0, 40);
    if (!repoStore.list().length) return c.json({ error: '请先添加并分析 Git 工程' }, 400);
    const req: Requirement = {
      id: newId('req'),
      seq: requirementStore.nextSeq(),
      title,
      description,
      priority: body.priority ?? 'normal',
      status: 'draft',
      createdAt: now(),
      updatedAt: now(),
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
      targetRepos: body.targetRepos ?? [],
    };
    requirementStore.create(req);
    log('info', `新需求入队 #${req.seq} ${req.title}`, { requirementId: req.id });
    if (body.enqueue !== false) {
      requirementStore.patch(req.id, { status: 'queued', queuedAt: now() });
      kickQueue();
    }
    bus.change('requirements', req.id);
    return c.json({ requirement: requirementStore.get(req.id) });
  } catch (err) {
    return fail(c, err);
  }
});

api.patch('/requirements/:id', async (c) => {
  const id = c.req.param('id');
  if (!requirementStore.get(id)) return c.json({ error: '需求不存在' }, 404);
  const body = await c.req.json<Partial<Requirement>>();
  const allowed: Partial<Requirement> = {};
  if (typeof body.title === 'string') allowed.title = body.title;
  if (typeof body.description === 'string') allowed.description = body.description;
  if (body.priority) allowed.priority = body.priority;
  if (body.targetRepos) allowed.targetRepos = body.targetRepos;
  requirementStore.patch(id, allowed);
  bus.change('requirements', id);
  return c.json({ requirement: requirementStore.get(id) });
});

api.delete('/requirements/:id', async (c) => {
  const id = c.req.param('id');
  const req = requirementStore.get(id);
  if (!req) return c.json({ error: '需求不存在' }, 404);
  if (req.jobId && isRunning(req.jobId)) await cancelJob(req.jobId);
  // Explicitly delete the platform branches as well: removing the row otherwise
  // leaks `ohpert/req-*` refs and worktrees in every affected repository.
  const cleanup = await cleanupWorkspace(id, { deleteBranches: true });
  requirementStore.remove(id);
  bus.change('requirements', id);
  return c.json({ ok: true, cleanup });
});

api.post('/requirements/:id/enqueue', (c) => {
  const id = c.req.param('id');
  const req = requirementStore.get(id);
  if (!req) return c.json({ error: '需求不存在' }, 404);
  if (['analyzing', 'implementing', 'accepting'].includes(req.status)) return c.json({ error: '需求正在处理中' }, 400);
  requirementStore.patch(id, { status: 'queued', queuedAt: now(), error: null });
  kickQueue();
  bus.change('requirements', id);
  return c.json({ requirement: requirementStore.get(id) });
});

api.post('/requirements/:id/analyze', (c) => {
  try {
    const job = startRequirementAnalysis(c.req.param('id'));
    return c.json({ job });
  } catch (err) {
    return fail(c, err);
  }
});

api.post('/requirements/:id/implement', async (c) => {
  try {
    const body = await c.req.json<{ feedbackNote?: string }>().catch(() => ({}) as any);
    const job = startImplementation(c.req.param('id'), { feedbackNote: body?.feedbackNote });
    return c.json({ job });
  } catch (err) {
    return fail(c, err);
  }
});

api.post('/requirements/:id/accept', (c) => {
  try {
    const job = startAcceptance(c.req.param('id'));
    return c.json({ job });
  } catch (err) {
    return fail(c, err);
  }
});

api.post('/requirements/:id/confirm', async (c) => {
  try {
    const body = await c.req.json<{ decision: 'approve' | 'reject'; note?: string }>();
    if (!['approve', 'reject'].includes(body.decision))
      return c.json({ error: 'decision 必须为 approve 或 reject' }, 400);
    const req = await userConfirm(c.req.param('id'), body.decision, body.note ?? '');
    return c.json({ requirement: req });
  } catch (err) {
    return fail(c, err);
  }
});

api.post('/requirements/:id/revert', async (c) => {
  try {
    const id = c.req.param('id');
    const results = await revertRequirement(id);
    const req = requirementStore.get(id)!;
    requirementStore.patch(id, {
      status: 'needs_rework',
      implementation: null,
      acceptance: null,
      feedback: [...req.feedback, { at: now(), content: '用户回滚了代码改动', by: 'user' }],
    });
    bus.change('requirements', id);
    return c.json({ results, requirement: requirementStore.get(id) });
  } catch (err) {
    return fail(c, err);
  }
});

api.post('/requirements/:id/feedback', async (c) => {
  const id = c.req.param('id');
  const req = requirementStore.get(id);
  if (!req) return c.json({ error: '需求不存在' }, 404);
  const body = await c.req.json<{ content?: string; by?: 'user' | 'ai' }>();
  const content = (body.content ?? '').trim();
  if (!content) return c.json({ error: '反馈内容为空' }, 400);
  requirementStore.patch(id, { feedback: [...req.feedback, { at: now(), content, by: body.by ?? 'user' }] });
  bus.change('requirements', id);
  return c.json({ requirement: requirementStore.get(id) });
});

/* ---------------------------- jobs & logs ---------------------------- */

api.get('/jobs', (c) => c.json({ jobs: jobStore.list(80) }));

api.get('/jobs/:id', (c) => {
  const job = jobStore.get(c.req.param('id'));
  if (!job) return c.json({ error: '任务不存在' }, 404);
  return c.json({ job, logs: logStore.list({ jobId: job.id, limit: 400 }) });
});

api.post('/jobs/:id/cancel', async (c) => c.json({ cancelled: await cancelJob(c.req.param('id')) }));

api.get('/logs', (c) => {
  const afterId = Number(c.req.query('afterId') || 0);
  const requirementId = c.req.query('requirementId') || undefined;
  return c.json({ logs: logStore.list({ afterId: afterId || undefined, requirementId, limit: 300 }) });
});

/* ---------------------------- settings ---------------------------- */

api.get('/settings', (c) =>
  c.json({
    ai: publicAiSettings(),
    commands: getRawSettings().commands,
    workspaceRoots: getRawSettings().workspaceRoots,
  }),
);

api.put('/settings/ai', async (c) => {
  try {
    const body = await c.req.json<Record<string, any>>();
    const patch: Record<string, any> = {};
    for (const k of ['baseURL', 'model', 'planningModel', 'codingModel', 'reviewModel']) {
      if (typeof body[k] === 'string') patch[k] = body[k].trim();
    }
    for (const k of ['temperature', 'maxTokens', 'maxTurns']) {
      if (body[k] != null && !Number.isNaN(Number(body[k]))) patch[k] = Number(body[k]);
    }
    // only overwrite the key when the user actually typed a new one (never echo back the mask)
    if (typeof body.apiKey === 'string' && body.apiKey.trim() && !body.apiKey.includes('••••')) {
      patch.apiKey = body.apiKey.trim();
    }
    saveAiSettings(patch);
    return c.json({ ai: publicAiSettings() });
  } catch (err) {
    return fail(c, err);
  }
});

api.post('/settings/ai/test', async (c) => {
  try {
    const body = await c.req.json<{ baseURL?: string; apiKey?: string; model?: string }>().catch(() => ({}) as any);
    const current = resolveAiSettings();
    const override = {
      ...current,
      baseURL: (body?.baseURL?.trim() || current.baseURL).replace(/\/+$/, ''),
      apiKey: body?.apiKey?.trim() && !body.apiKey.includes('••••') ? body.apiKey.trim() : current.apiKey,
      model: body?.model?.trim() || current.model,
    };
    const result = await testConnection(override);
    return c.json(result);
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 200);
  }
});

/**
 * List models exposed by an OpenAI-compatible gateway (GET {baseURL}/models).
 * The form may contain *unsaved* Base URL / API Key, so they are passed through
 * the same override logic as the connection test.
 */
api.get('/settings/ai/models', async (c) => {
  const current = resolveAiSettings();
  const baseURL = (c.req.query('baseURL')?.trim() || current.baseURL).replace(/\/+$/, '');
  const typedKey = c.req.query('apiKey')?.trim();
  const apiKey = typedKey && !typedKey.includes('••••') ? typedKey : current.apiKey;
  try {
    const models = await listModels({ ...current, baseURL, apiKey });
    return c.json({ ok: true, baseURL, models, fetchedAt: now() });
  } catch (err) {
    return c.json({ ok: false, baseURL, models: [], error: (err as Error).message }, 200);
  }
});

api.put('/settings/commands', async (c) => {
  const body = await c.req.json<{ test?: string; build?: string; lint?: string }>();
  return c.json({ commands: saveCommandSettings(body) });
});

api.put('/settings/roots', async (c) => {
  const body = await c.req.json<{ roots?: string[] }>();
  return c.json({ workspaceRoots: saveWorkspaceRoots((body.roots ?? []).filter(Boolean)) });
});

/* ---------------------------- SSE ---------------------------- */

api.get('/events', (c) => {
  const afterId = Number(c.req.query('afterId') || 0);
  return streamSSE(c, async (stream) => {
    let closed = false;
    const write = (event: string, data: unknown) => {
      if (closed) return;
      stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {
        closed = true;
      });
    };

    // replay recent log buffer so a reconnecting tab doesn't lose context
    const backfill = logStore.list({ afterId: afterId || undefined, limit: 120 });
    for (const l of backfill) write('log', l);
    write('open', { ts: now() });

    const offLog = bus.onLog((entry) => write('log', entry));
    const offChange = bus.onChange((change) => {
      write('change', {
        ...change,
        job: change.id && change.scope === 'jobs' ? jobStore.get(change.id) : undefined,
        requirement: change.id && change.scope === 'requirements' ? requirementStore.get(change.id) : undefined,
        stats: change.scope === 'requirements' ? computeStats(requirementStore.list()) : undefined,
      });
    });

    const heartbeat = setInterval(() => write('ping', { ts: now() }), 15_000);

    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener('abort', () => resolve());
      const check = setInterval(() => {
        if (closed) {
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });
    clearInterval(heartbeat);
    offLog();
    offChange();
    closed = true;
  });
});
