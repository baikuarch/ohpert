import fs from 'node:fs';
import type { ImplementationRecord, RepoProfile, Requirement, TaskJob } from '../types.js';
import { bus, log } from '../lib/log.js';
import { git } from '../lib/git.js';
import { id as newId } from '../lib/util.js';
import { archStore, jobStore, repoStore, requirementStore } from '../store/repo-store.js';
import { analyzeArchitecture } from '../analysis/architect.js';
import { computeLinks, inferRole, profileRepo } from '../analysis/repo-analyzer.js';
import { planRequirement } from '../agents/planner.js';
import { implementRequirement } from '../agents/implementer.js';
import { aiReview, runStaticChecks } from '../agents/verifier.js';
import {
  cleanupWorkspace,
  collectChanges,
  commitWorkspace,
  prepareWorkspace,
  workspacePathFor,
  type WorkspaceRepo,
} from './workspace.js';
import { now } from '../store/db.js';

const registry = new Map<string, AbortController>();

export function createJob(requirementId: string | null, kind: TaskJob['kind'], message = ''): TaskJob {
  const job: TaskJob = {
    id: newId('job'),
    requirementId,
    kind,
    status: 'queued',
    progress: 0,
    message,
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: now(),
  };
  jobStore.create(job);
  bus.change('jobs', job.id);
  return job;
}

export function isRunning(jobId: string) {
  return registry.has(jobId);
}

/** Fire-and-forget runner with uniform lifecycle + error capture. */
export function runJob(job: TaskJob, work: (ctx: JobContext) => Promise<void>) {
  const ctrl = new AbortController();
  registry.set(job.id, ctrl);
  jobStore.update(job.id, { status: 'running', startedAt: now(), progress: 2, message: job.message || '启动中' });
  bus.change('jobs', job.id);

  const ctx: JobContext = {
    job,
    signal: ctrl.signal,
    log: (level, message, opts = {}) =>
      log(level, message, { jobId: job.id, requirementId: job.requirementId, ...opts }),
    progress: (p, message) => {
      const clamped = Math.max(0, Math.min(99, Math.round(p)));
      jobStore.update(job.id, { progress: clamped, message: message ?? jobStore.get(job.id)?.message ?? '' });
      bus.change('jobs', job.id);
    },
  };

  (async () => {
    try {
      await work(ctx);
      jobStore.update(job.id, { status: 'done', progress: 100, finishedAt: now(), message: '完成' });
    } catch (err) {
      const msg = (err as Error)?.message || String(err);
      ctx.log('error', `任务失败: ${msg}`);
      jobStore.update(job.id, { status: 'failed', error: msg, finishedAt: now(), progress: 100 });
      await releaseRequirement(job, msg, ctx);
    } finally {
      registry.delete(job.id);
      bus.change('jobs', job.id);
      if (job.requirementId) bus.change('requirements', job.requirementId);
    }
  })();
}

/** States that only make sense while a job is alive. */
const TRANSITIONAL: Requirement['status'][] = ['analyzing', 'implementing', 'accepting'];

/**
 * A failed/aborted job must never leave the requirement stuck in a transitional
 * state ("研发中"/"分析中"/"验收中"), otherwise the UI can never act on it again.
 * Release it back to a workable state and drop any half-built workspace.
 */
function releaseRequirement(
  job: TaskJob,
  message: string,
  ctx?: { log: (level: 'info' | 'warn', msg: string) => void },
) {
  if (!job.requirementId) return;
  const req = requirementStore.get(job.requirementId);
  if (!req || !TRANSITIONAL.includes(req.status)) return;
  requirementStore.patch(job.requirementId, {
    status: 'needs_rework',
    error: message,
    feedback: [...req.feedback, { at: now(), content: `任务失败：${message}`, by: 'ai' }],
  });
  return cleanupWorkspace(job.requirementId).then(
    () => ctx?.log('info', '需求已自动退回「需返工」，解决问题后可直接重新研发'),
    () => ctx?.log('warn', '需求已退回「需返工」，但清理临时工作区失败，请查看日志'),
  );
}

export interface JobContext {
  job: TaskJob;
  signal: AbortSignal;
  log: (
    level: 'info' | 'tool' | 'warn' | 'error' | 'success' | 'llm',
    message: string,
    opts?: { detail?: string | null; repoId?: string | null },
  ) => void;
  progress: (p: number, message?: string) => void;
}

/* ------------------------------------------------------------------ */
/* 1. 工程扫描 + 架构分析                                              */
/* ------------------------------------------------------------------ */

export async function startArchitectureAnalysis(opts: { repoIds?: string[]; jobMessage?: string } = {}) {
  const records = repoStore.list().filter((r) => !opts.repoIds?.length || opts.repoIds.includes(r.id));
  if (!records.length) throw new Error('请先添加至少一个 Git 工程');
  const job = createJob(null, 'analyze', opts.jobMessage ?? `分析 ${records.length} 个工程`);
  runJob(job, async (ctx) => {
    const profiles: Record<string, RepoProfile> = {};
    let done = 0;
    for (const rec of records) {
      ctx.progress((done / records.length) * 45, `扫描 ${rec.name} …`);
      ctx.log('info', `扫描工程 ${rec.name} (${rec.path})`, { repoId: rec.id });
      const profile = await profileRepo(rec);
      // inferRole is a pure heuristic: it emits frontend/backend/..., never 'unknown'
      const role = inferRole(profile, rec.name);
      profile.role = role;
      profile.roleSource = 'auto';
      repoStore.saveProfile(rec.id, profile);
      if (rec.roleSource !== 'user') {
        // persist the inferred role on the repo row too (repoStore.upsert would overwrite the profile)
        repoStore.setRoleSource(rec.id, role, 'auto');
      }
      profiles[rec.id] = profile;
      done++;
      ctx.log(
        'success',
        `${rec.name}: 角色=${profile.role}，框架=${profile.frameworks.join('/') || '未知'}，路由 ${profile.apiRoutes.length} 个，请求点 ${profile.apiCalls.length} 个`,
        { repoId: rec.id },
      );
      bus.change('repos', rec.id);
    }

    ctx.progress(55, '计算工程间关联…');
    const fresh = repoStore.list().filter((r) => profiles[r.id]);
    const links = computeLinks(fresh, profiles);
    ctx.log('info', `静态分析发现 ${links.length} 条工程关联`);

    ctx.progress(65, `AI 架构分析（${fresh.length} 个工程）…`);
    const report = await analyzeArchitecture(fresh, profiles, links, { jobId: job.id });
    archStore.save(report);
    ctx.progress(98, '架构图谱已生成');
    bus.change('architecture');
  });
  return job;
}

/* ------------------------------------------------------------------ */
/* 2 & 3. 需求分析 → 研发                                              */
/* ------------------------------------------------------------------ */

export function startRequirementAnalysis(reqId: string) {
  const req = requirementStore.get(reqId);
  if (!req) throw new Error('需求不存在');
  if (['analyzing', 'implementing', 'accepting'].includes(req.status)) throw new Error('该需求正在处理中');
  const records = repoStore.list();
  if (!records.length) throw new Error('请先添加 Git 工程');
  const profiles = repoStore.allProfiles();
  const architecture = archStore.get();

  requirementStore.patch(reqId, { status: 'analyzing', error: null, feedback: req.feedback });
  const job = createJob(reqId, 'plan', `分析需求 #${req.seq} ${req.title}`);
  requirementStore.patch(reqId, { jobId: job.id });
  bus.change('requirements', reqId);

  runJob(job, async (ctx) => {
    ctx.progress(10, '读取工程事实与架构结论…');
    const report = await planRequirement({
      requirement: requirementStore.get(reqId)!,
      records,
      profiles,
      architecture,
      jobId: job.id,
    });
    ctx.progress(90, '写入需求报告…');
    requirementStore.patch(reqId, { status: 'analyzed', report, analyzedAt: now(), jobId: job.id, error: null });
    bus.change('requirements', reqId);
  });
  return job;
}

/** Queue: every `queued` requirement is analyzed in order, one at a time. */
let queueRunner: Promise<void> | null = null;
export function kickQueue() {
  if (queueRunner) return queueRunner;
  queueRunner = (async () => {
    while (true) {
      const next = requirementStore
        .list(['queued'])
        .sort((a, b) => (a.queuedAt ?? '').localeCompare(b.queuedAt ?? '') || a.seq - b.seq)[0];
      if (!next) break;
      try {
        const job = startRequirementAnalysis(next.id);
        await waitForJob(job.id);
      } catch (err) {
        log('error', `队列处理需求 #${next.seq} 失败: ${(err as Error).message}`, { requirementId: next.id });
        requirementStore.patch(next.id, { status: 'failed', error: (err as Error).message });
      }
    }
  })().finally(() => {
    queueRunner = null;
  });
  return queueRunner;
}

export function waitForJob(jobId: string, timeoutMs = 30 * 60_000): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      const j = jobStore.get(jobId);
      if (!j || !['queued', 'running'].includes(j.status) || Date.now() - started > timeoutMs) return resolve();
      setTimeout(tick, 1500);
    };
    tick();
  });
}

export function startImplementation(reqId: string, opts: { feedbackNote?: string } = {}) {
  const req = requirementStore.get(reqId);
  if (!req) throw new Error('需求不存在');
  if (!req.report) throw new Error('请先生成需求分析报告');
  if (['implementing', 'accepting'].includes(req.status)) throw new Error('该需求正在研发/验收中');

  const records = repoStore.list();
  const profiles = repoStore.allProfiles();
  const impactIds = new Set(req.report.impact.map((i) => i.repoId));
  const targetRecords = records.filter((r) => impactIds.has(r.id) && profiles[r.id]);
  if (!targetRecords.length) throw new Error('需求报告中没有任何受影响的工程');

  requirementStore.patch(reqId, { status: 'implementing', error: null });
  const job = createJob(reqId, 'implement', `研发需求 #${req.seq} ${req.title}`);
  requirementStore.patch(reqId, { jobId: job.id });
  bus.change('requirements', reqId);

  runJob(job, async (ctx) => {
    const startedAt = now();
    const workspaces: WorkspaceRepo[] = [];
    const repoEntries: ImplementationRecord['repos'] = [];

    for (const rec of targetRecords) {
      ctx.progress(Math.min(20, 5 + workspaces.length * 4), `准备 ${rec.name} 工作区…`);
      const ws = await prepareWorkspace(rec, rowReq(), job.id);
      workspaces.push(ws);
      repoEntries.push({
        repoId: rec.id,
        branch: ws.branch,
        baseBranch: ws.baseBranch,
        baseRev: ws.baseRev,
        headAfter: null,
      });
    }

    function rowReq() {
      return requirementStore.get(reqId)!;
    }

    const feedbackNote = buildFeedbackNote(rowReq());
    const userNote = opts.feedbackNote ? `\n\n## 用户补充说明（最高优先级）\n${opts.feedbackNote}\n` : '';

    ctx.progress(25, `AI 开始编码（${workspaces.map((w) => w.repo.name).join(', ')}）…`);

    const { result, model, touched, commands, repairRounds, failures, summary } = await implementRequirement({
      req: rowReq(),
      records,
      profiles,
      targets: workspaces,
      feedbackNote: feedbackNote + userNote,
      jobId: job.id,
      onLog: (level, message, detail) => ctx.log(level, message, { detail }),
      onPhase: (label, ratio) => ctx.progress(Math.round(25 + ratio * 55), label),
    });

    ctx.progress(80, '收集改动并提交到平台分支…');
    const allChanges: ImplementationRecord['files'] = [];
    for (let i = 0; i < workspaces.length; i++) {
      const ws = workspaces[i];
      const before = await getHead(ws);
      const commitMsg = `feat(ohpert): 需求 #${req.seq} ${req.title}\n\n由 ohpert AI 自动生成\n需求ID: ${reqId}\n模型: ${model}`;
      const committed = await commitWorkspace(ws, commitMsg);
      const headAfter = committed ?? before;
      repoEntries[i].headAfter = headAfter;
      if (committed)
        ctx.log('success', `${ws.repo.name}: 已提交 ${committed.slice(0, 8)}（分支 ${ws.branch}）`, {
          repoId: ws.repo.id,
        });
      if (headAfter) {
        const changes = await collectChanges(ws, ws.baseRev, headAfter);
        allChanges.push(...changes);
      }
    }

    const diffStat = {
      files: allChanges.length,
      additions: allChanges.reduce((a, c) => a + c.additions, 0),
      deletions: allChanges.reduce((a, c) => a + c.deletions, 0),
    };

    const implementation: ImplementationRecord = {
      startedAt,
      finishedAt: now(),
      status: result.stopReason === 'error' ? 'failed' : 'succeeded',
      repos: repoEntries,
      files: allChanges,
      diffStat,
      summary: summary || '（模型未输出总结）',
      commands,
      aiModel: model,
      turns: result.turns,
      repairRounds,
      unresolved: failures.map((f) => `${f.repoName}: ${f.command}`),
    };

    ctx.log(
      allChanges.length ? 'success' : 'warn',
      `研发结束：${diffStat.files} 个文件变更 (+${diffStat.additions}/-${diffStat.deletions})，工具调用 ${result.toolCallCount} 次，触发文件 ${touched.size} 个`,
    );
    if (repairRounds > 0) {
      ctx.log(
        failures.length ? 'warn' : 'success',
        `自动修复 ${repairRounds} 轮${failures.length ? `，仍有 ${failures.length} 个工程构建未通过` : '，构建已全部通过'}`,
      );
    }

    requirementStore.patch(reqId, {
      status: result.stopReason === 'error' ? 'needs_rework' : 'implemented',
      implementation,
      implementedAt: now(),
      error:
        result.stopReason === 'error'
          ? '研发过程出错，请查看日志'
          : failures.length
            ? `自动修复 ${repairRounds} 轮后仍有构建失败：${failures.map((f) => `${f.repoName}（${f.command}）`).join('、')}，建议验收前手动处理或继续返工`
            : null,
      jobId: job.id,
    });
    ctx.progress(98, '研发完成，等待验收');
    bus.change('requirements', reqId);
  });
  return job;
}

function buildFeedbackNote(req: ReturnType<typeof requirementStore.get> & object) {
  if (!req.userConfirmation && !req.feedback.length) return '';
  const lines: string[] = [];
  if (req.userConfirmation?.decision === 'reject') {
    lines.push(`- 上一轮验收被用户驳回：${req.userConfirmation.note || '（未填写原因）'}`);
  }
  for (const f of req.feedback.slice(-6)) lines.push(`- [${f.by}] ${f.content}`);
  return lines.length ? `\n## 历史反馈（本轮必须修复）\n${lines.join('\n')}\n` : '';
}

async function getHead(ws: WorkspaceRepo) {
  const { git } = await import('../lib/git.js');
  const r = await git(ws.path, ['rev-parse', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

/* ------------------------------------------------------------------ */
/* 4. 验收                                                             */
/* ------------------------------------------------------------------ */

export function startAcceptance(reqId: string) {
  const req = requirementStore.get(reqId);
  if (!req) throw new Error('需求不存在');
  if (!req.implementation) throw new Error('请先完成研发');
  if (req.status === 'accepting') throw new Error('验收进行中');
  if (!['implemented', 'needs_rework', 'awaiting_approval'].includes(req.status))
    throw new Error(`当前状态 ${req.status} 不能验收`);

  const profiles = repoStore.allProfiles();
  requirementStore.patch(reqId, { status: 'accepting', error: null });
  const job = createJob(reqId, 'accept', `验收需求 #${req.seq}`);
  requirementStore.patch(reqId, { jobId: job.id });
  bus.change('requirements', reqId);

  runJob(job, async (ctx) => {
    const current = requirementStore.get(reqId)!;
    const impl = current.implementation!;
    const targets: WorkspaceRepo[] = [];
    for (const entry of impl.repos) {
      const rec = repoStore.get(entry.repoId);
      if (!rec) continue;
      const wsPath = workspacePathFor(reqId, rec);
      // Never fall back to the user's main checkout: accepting there would build
      // and review code the requirement never produced, and could hide a lost
      // worktree. Make the operator rebuild instead.
      if (!fs.existsSync(wsPath)) {
        throw new Error(
          `${rec.name}: 需求 #${req.seq} 的独立验收工作区已不存在（${wsPath}）。` +
            `为避免在您自己的检出目录上误验收，请重新执行「研发」重建工作区后再验收。`,
        );
      }
      if (entry.headAfter) {
        const head = await git(wsPath, ['rev-parse', 'HEAD']);
        const actual = head.stdout.trim();
        if (head.code !== 0 || actual !== entry.headAfter) {
          throw new Error(
            `${rec.name}: 验收工作区 HEAD（${actual.slice(0, 8) || '无法读取'}）与研发记录（${entry.headAfter.slice(0, 8)}）不一致，` +
              `说明工作区可能已被其他任务改动，请重新研发后再验收。`,
          );
        }
      }
      targets.push({
        repo: rec,
        path: wsPath,
        baseBranch: entry.baseBranch,
        baseRev: entry.baseRev,
        branch: entry.branch,
        mode: 'worktree',
      });
    }

    ctx.progress(20, '运行自动化检查…');
    const staticChecks = await runStaticChecks(current, targets, profiles, impl, (l, m, d) =>
      ctx.log(l, m, { detail: d }),
    );

    ctx.progress(55, 'AI 代码审查…');
    const report = await aiReview({
      req: current,
      targets,
      profiles,
      impl,
      staticChecks,
      jobId: job.id,
      onLog: (l, m, d) => ctx.log(l, m, { detail: d }),
    });

    const nextStatus = report.verdict === 'fail' ? 'needs_rework' : 'awaiting_approval';
    requirementStore.patch(reqId, { status: nextStatus, acceptance: report, error: null, jobId: job.id });
    ctx.log('info', report.verdict === 'fail' ? '验收未通过，需求已退回研发' : 'AI 验收通过，等待用户确认');
    bus.change('requirements', reqId);
  });
  return job;
}

export async function userConfirm(reqId: string, decision: 'approve' | 'reject', note: string) {
  const req = requirementStore.get(reqId);
  if (!req) throw new Error('需求不存在');
  if (req.status !== 'awaiting_approval') throw new Error('当前需求不在待确认状态');
  const confirmation = { confirmedAt: now(), note, decision };
  if (decision === 'approve') {
    requirementStore.patch(reqId, {
      status: 'completed',
      completedAt: now(),
      userConfirmation: confirmation,
      feedback: [...req.feedback, { at: now(), content: note || '用户确认通过', by: 'user' }],
      error: null,
    });
    log('success', `需求 #${req.seq} 已由用户确认完成，进入历史队列`, { requirementId: reqId });
  } else {
    // Stay in 'implemented': the existing research/diff is still valid and can be
    // re-accepted; the user's rejection is carried into the next研发 round as feedback.
    requirementStore.patch(reqId, {
      status: req.implementation ? 'implemented' : 'needs_rework',
      userConfirmation: confirmation,
      reworkRounds: req.reworkRounds + 1,
      feedback: [...req.feedback, { at: now(), content: note || '用户驳回', by: 'user' }],
    });
    log('warn', `需求 #${req.seq} 被用户驳回，需要返工：${note || '（未填写原因）'}`, { requirementId: reqId });
  }
  bus.change('requirements', reqId);
  return requirementStore.get(reqId);
}

export async function cancelJob(jobId: string) {
  const ctrl = registry.get(jobId);
  const job = jobStore.get(jobId);
  if (!ctrl) {
    // job died with a previous process (or already finished): still make sure the
    // requirement isn't pinned in a transitional state.
    if (job) await releaseRequirement(job, '任务已取消');
    if (job?.requirementId) bus.change('requirements', job.requirementId);
    return false;
  }
  ctrl.abort();
  jobStore.update(jobId, { status: 'cancelled', finishedAt: now(), message: '已取消' });
  if (job) await releaseRequirement(job, '任务已取消');
  if (job?.requirementId) bus.change('requirements', job.requirementId);
  bus.change('jobs', jobId);
  return true;
}
