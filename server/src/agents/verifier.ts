import fs from 'node:fs';
import path from 'node:path';
import type { AcceptanceCheck, AcceptanceReport, ImplementationRecord, RepoProfile, Requirement } from '../types.js';
import { chat, extractJson } from '../llm/client.js';
import { SYSTEM_BASE, repoFactSheet } from '../llm/prompts.js';
import { resolveAiSettings } from '../store/settings.js';
import { git, runShell } from '../lib/git.js';
import { detectCommand } from './build-check.js';
import { walkFiles } from '../lib/fs-scan.js';
import { budget } from '../lib/util.js';
import { matchDeclaredApiChange, repoMatchesField, type CorpusTarget } from '../lib/api-contract.js';
import type { WorkspaceRepo } from '../services/workspace.js';

interface LlmVerdict {
  verdict?: 'pass' | 'pass_with_notes' | 'fail';
  score?: number;
  summary?: string;
  checks?: { title: string; status?: 'pass' | 'warn' | 'fail' | 'skipped'; detail?: string; evidence?: string[] }[];
  perRepo?: { repoId?: string; repoName?: string; verdict?: string; notes?: string }[];
  followUps?: string[];
}

/** Deterministic checks that run before asking the model. */
export async function runStaticChecks(
  req: Requirement,
  targets: WorkspaceRepo[],
  profiles: Record<string, RepoProfile>,
  impl: ImplementationRecord | null,
  onLog: (level: 'info' | 'tool' | 'warn' | 'error' | 'success' | 'llm', message: string, detail?: string) => void,
): Promise<AcceptanceCheck[]> {
  const checks: AcceptanceCheck[] = [];

  // 1. changes exist
  const changedFiles =
    impl?.files.filter((f) => !/\.(lock|snap)$|package-lock\.json|pnpm-lock\.yaml/.test(f.file)) ?? [];
  checks.push({
    id: 'changes',
    title: '存在实际代码改动',
    status: changedFiles.length > 0 ? 'pass' : 'fail',
    detail: changedFiles.length
      ? `共 ${changedFiles.length} 个文件变更（+${impl?.diffStat.additions ?? 0} / -${impl?.diffStat.deletions ?? 0}）`
      : '未检测到任何代码改动',
    evidence: changedFiles.slice(0, 20).map((f) => `${f.repoName}:${f.file} (${f.kind})`),
  });

  // 2. working tree clean / committed
  const dirtyChecks: string[] = [];
  for (const ws of targets) {
    const status = await git(ws.path, ['status', '--porcelain']);
    if (status.stdout.trim()) dirtyChecks.push(`${ws.repo.name}: 仍有未记录改动`);
  }
  checks.push({
    id: 'committed',
    title: '改动已纳入版本控制（可回滚）',
    status: dirtyChecks.length ? 'warn' : 'pass',
    detail: dirtyChecks.length ? dirtyChecks.join('; ') : '所有改动已提交到平台分支，可随时一键回滚',
  });

  // 3. no conflict markers / obvious syntax debris
  const debris: string[] = [];
  for (const f of impl?.files ?? []) {
    if (!f.patch.includes('+')) continue;
    if (/^\+\s*(<{7}|={7}|>{7})/m.test(f.patch)) debris.push(`${f.repoName}:${f.file} 含冲突标记`);
    if (/^\+\s*(TODO: ?IMPLEMENT|your code here)/im.test(f.patch)) debris.push(`${f.repoName}:${f.file} 含占位代码`);
  }
  checks.push({
    id: 'cleanliness',
    title: '无冲突标记/占位代码',
    status: debris.length ? 'fail' : 'pass',
    detail: debris.length ? debris.join('; ') : '未发现冲突标记或占位实现',
  });

  // 4. build/typecheck for repos that declare a script
  for (const ws of targets) {
    const profile = profiles[ws.repo.id];
    const touchedThisRepo = impl?.files.some((f) => f.repoId === ws.repo.id);
    if (!touchedThisRepo) continue;
    const cmd = detectCommand(profile, ws.path);
    if (!cmd.command) {
      checks.push({
        id: `build:${ws.repo.id}`,
        title: `${ws.repo.name} 构建/类型检查`,
        status: 'skipped',
        detail: '该工程没有可识别的构建脚本',
      });
      continue;
    }
    onLog('tool', `执行验收命令 (${ws.repo.name}): ${cmd.command}`);
    const res = await runShell(cmd.command, { cwd: ws.path, timeoutMs: 300_000 });
    const output = `${res.stdout}\n${res.stderr}`.trim();
    checks.push({
      id: `build:${ws.repo.id}`,
      title: `${ws.repo.name} ${cmd.label}`,
      status: res.code === 0 ? 'pass' : 'fail',
      command: cmd.command,
      detail:
        res.code === 0
          ? `\`${cmd.command}\` 执行成功`
          : `\`${cmd.command}\` 退出码 ${res.code}${res.timedOut ? ' (超时)' : ''}`,
      evidence: [output.slice(-2500) || '(无输出)'],
    });
  }

  // 5. api contract consistency: each declared endpoint must appear in one of
  //    the repos it belongs to - never in one merged cross-repo blob, where a
  //    frontend call site could accidentally satisfy a backend requirement.
  const apiChanges = req.report?.apiChanges ?? [];
  if (apiChanges.length) {
    const corpus = new Map<string, string>();
    const addTo = (repoId: string, text: string) => corpus.set(repoId, `${corpus.get(repoId) ?? ''}\n${text}`);
    for (const ws of targets) corpus.set(ws.repo.id, corpus.get(ws.repo.id) ?? '');
    for (const f of impl?.files ?? []) addTo(f.repoId, f.patch);
    for (const ws of targets) {
      for (const f of impl?.files.filter((x) => x.repoId === ws.repo.id) ?? []) {
        try {
          const full = path.join(ws.path, f.file);
          if (fs.existsSync(full)) addTo(ws.repo.id, fs.readFileSync(full, 'utf8'));
        } catch {
          /* ignore */
        }
      }
    }
    // route registrations anywhere in each repo's source tree (not only changed files)
    for (const ws of targets) {
      try {
        const files = walkFiles(ws.path, { maxFiles: 8000 }).filter((f) =>
          /\.(m?[jt]sx?|java|kt|py|go|rb|php|cs)$/.test(f),
        );
        for (const full of files) {
          try {
            const st = fs.statSync(full);
            if (st.size > 300_000) continue;
            addTo(ws.repo.id, fs.readFileSync(full, 'utf8'));
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }

    const pool: CorpusTarget[] = targets.map((ws) => ({ repoId: ws.repo.id, repoName: ws.repo.name }));
    const found: string[] = [];
    const missing: string[] = [];
    for (const change of apiChanges) {
      const named = pool.filter((p) => repoMatchesField(change.repo, p.repoName) || p.repoId === change.repo);
      const candidates = named.length ? named : pool;
      const hit = matchDeclaredApiChange(corpus, change, candidates);
      if (hit) found.push(`${change.method} ${change.path} → ${hit.repoName}`);
      else missing.push(`${change.method} ${change.path}`);
    }
    checks.push({
      id: 'api-contract',
      title: '接口变更与代码一致',
      status: missing.length === 0 ? 'pass' : 'fail',
      detail: missing.length
        ? `已按工程分别校验；已找到: ${found.join('、') || '（无）'}；未找到实现: ${missing.join('、')}（若前端仅调用、后端未改动，属于正常情况）`
        : `报告中声明的 ${apiChanges.length} 个接口均在对应工程的代码中出现`,
      evidence: found.length ? [`匹配到的实现: ${found.join('\n')}`] : undefined,
    });
  }

  return checks;
}

export async function aiReview(opts: {
  req: Requirement;
  targets: WorkspaceRepo[];
  profiles: Record<string, RepoProfile>;
  impl: ImplementationRecord | null;
  staticChecks: AcceptanceCheck[];
  jobId: string;
  onLog: (level: 'info' | 'tool' | 'warn' | 'error' | 'success' | 'llm', message: string, detail?: string) => void;
}): Promise<AcceptanceReport> {
  const settings = resolveAiSettings();
  const model = settings.reviewModel || settings.model;
  const { req, impl, targets, profiles } = opts;

  // Read the post-change content of the most significant changed files for review
  const files = (impl?.files ?? []).slice(0, 18);
  const excerpts: string[] = [];
  for (const f of files) {
    const ws = targets.find((t) => t.repo.id === f.repoId);
    if (!ws || f.kind === 'deleted') {
      excerpts.push(`### ${f.repoName}:${f.file} (已删除)\n${f.patch.slice(0, 1200)}`);
      continue;
    }
    let content = '';
    try {
      const full = path.join(ws.path, f.file);
      if (fs.existsSync(full)) content = fs.readFileSync(full, 'utf8');
    } catch {
      /* ignore */
    }
    excerpts.push(
      `### ${f.repoName}:${f.file} (${f.kind}, +${f.additions}/-${f.deletions})\n【diff】\n${budget(f.patch, 2000)}\n【改动后内容】\n${budget(content, 2500)}`,
    );
  }

  const fact = targets.map((t) => repoFactSheet(profiles[t.repo.id], 15, 15)).join('\n\n');

  const staticText = opts.staticChecks.map((c) => `- [${c.status}] ${c.title}: ${c.detail}`).join('\n');

  const user = `## 任务
你是独立 QA 验收工程师。请对下面这次需求研发的代码改动做验收评审，判断是否满足验收标准。

## 需求
${req.title}
${req.description}

## 验收标准（来自需求报告）
${(req.report?.acceptanceCriteria ?? []).map((c) => `- ${c}`).join('\n') || '- （无）'}

## 需求影响面
${(req.report?.impact ?? []).map((i) => `- ${i.repoName}[${i.level}]: ${i.reason}`).join('\n')}

## 接口变更
${(req.report?.apiChanges ?? []).map((a) => `- ${a.method} ${a.path} (${a.kind}) ${a.description}`).join('\n') || '- （无）'}

## 自动化检查结果
${staticText || '- 无'}

## 工程事实
${budget(fact, 12_000)}

## 代码改动
${budget(excerpts.join('\n\n'), 45_000)}

## 输出 JSON
{
  "verdict": "pass | pass_with_notes | fail",
  "score": 0-100 的整数,
  "summary": "验收结论（150字内）",
  "checks": [{"title": "检查项", "status": "pass|warn|fail|skipped", "detail": "说明", "evidence": ["代码片段或文件:行"]}],
  "perRepo": [{"repoId": "工程id", "verdict": "通过/需关注/不通过", "notes": "说明"}],
  "followUps": ["建议后续处理的事项"]
}
要求：
- checks 至少覆盖「验收标准逐条核对」「前端实现一致性」「后端实现完整性」「接口契约前后端一致」「异常与边界」「测试覆盖」。
- 「存在实际代码改动」「改动已纳入版本控制」「无冲突标记/占位代码」三项由平台自动校验，**不要重复评估**。
- status 只能是 pass / warn / fail；「缺少测试」用 warn，不要用 fail（除非需求明确要求测试且缺失）。
- 自动化检查里标记为 [fail] 的项（例如构建/类型检查失败），必须在相应检查项里引用其输出并给出 fail。
- verdict 规则：存在 fail 检查项 -> verdict=fail；仅有 warn -> pass_with_notes；全部 pass -> pass。`;

  opts.onLog('llm', `AI 验收评审开始（模型 ${model}，${files.length} 个文件）`);
  const res = await chat(
    settings,
    [
      { role: 'system', content: SYSTEM_BASE },
      { role: 'user', content: user },
    ],
    { model, json: true, temperature: 0.15, maxTokens: Math.min(settings.maxTokens, 6000), timeoutMs: 420_000 },
  );
  const parsed = extractJson<LlmVerdict>(res.content);

  const checks: AcceptanceCheck[] = [
    ...opts.staticChecks,
    ...(parsed.checks ?? [])
      .filter((c) => !/存在实际代码改动|纳入版本控制|冲突标记|占位代码/.test(c.title))
      .map((c, i) => ({
        id: `ai-${i}`,
        title: c.title,
        status: (['pass', 'warn', 'fail', 'skipped'].includes(String(c.status))
          ? c.status
          : 'warn') as AcceptanceCheck['status'],
        detail: c.detail ?? '',
        evidence: c.evidence ?? [],
      })),
  ];

  // the documented rule wins over whatever the model claims
  const anyFail = checks.some((c) => c.status === 'fail');
  const anyWarn = checks.some((c) => c.status === 'warn');
  const verdict: AcceptanceReport['verdict'] = anyFail ? 'fail' : anyWarn ? 'pass_with_notes' : 'pass';

  const report: AcceptanceReport = {
    verdict,
    score: Math.max(
      0,
      Math.min(100, Number(parsed.score) || (verdict === 'pass' ? 90 : verdict === 'pass_with_notes' ? 75 : 45)),
    ),
    summary: parsed.summary ?? '',
    checks,
    perRepo: (parsed.perRepo ?? []).map((p) => {
      const rec = targets.find((t) => t.repo.id === p.repoId || t.repo.name === p.repoName);
      return {
        repoId: rec?.repo.id ?? '',
        repoName: rec?.repo.name ?? p.repoName ?? '',
        verdict: p.verdict ?? '',
        notes: p.notes ?? '',
      };
    }),
    followUps: parsed.followUps ?? [],
    generatedAt: new Date().toISOString(),
    aiModel: model,
  };
  opts.onLog(
    verdict === 'fail' ? 'error' : 'success',
    `AI 验收完成：${verdict}（${report.score} 分）${report.summary}`,
  );
  return report;
}
