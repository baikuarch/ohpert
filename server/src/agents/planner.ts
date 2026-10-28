import type { ArchitectureReport, Requirement, RequirementReport, RepoProfile, RepoRecord } from '../types.js';
import { log } from '../lib/log.js';
import { chat, chatStream, extractJson } from '../llm/client.js';
import { SYSTEM_BASE, repoFactSheet } from '../llm/prompts.js';
import { resolveAiSettings } from '../store/settings.js';
import { budget } from '../lib/util.js';
import { normalizeEndpoint } from '../analysis/repo-analyzer.js';

interface LlmReport {
  title?: string;
  summary?: string;
  background?: string;
  goals?: string[];
  acceptanceCriteria?: string[];
  impact?: { repoId: string; level?: 'high' | 'medium' | 'low'; reason?: string; areas?: string[]; files?: string[] }[];
  apiChanges?: { method?: string; path: string; description?: string; repo?: string; kind?: string }[];
  dataModelChanges?: string[];
  frontendScope?: string[];
  backendScope?: string[];
  risks?: string[];
  testPlan?: string[];
  estimates?: { repoId: string; files?: number; points?: number; note?: string }[];
  assumptions?: string[];
  outOfScope?: string[];
}

export interface PlanOptions {
  requirement: Requirement;
  records: RepoRecord[];
  profiles: Record<string, RepoProfile>;
  architecture: ArchitectureReport | null;
  jobId?: string;
}

const SCHEMA = `{
  "title": "需求的规范化标题（20字以内）",
  "summary": "一句话说明这次要做什么（150字内）",
  "background": "需求背景与业务价值（200字内）",
  "goals": ["可验证的目标1", "目标2"],
  "acceptanceCriteria": ["验收标准1（可测试）", "验收标准2"],
  "impact": [{"repoId": "受影响的工程id", "level": "high|medium|low", "reason": "为什么影响这个工程", "areas": ["模块/页面/接口"], "files": ["可能改动的真实文件路径"]}],
  "apiChanges": [{"method": "POST", "path": "/api/xxx", "description": "变更说明", "repo": "工程名", "kind": "new|modified|removed"}],
  "dataModelChanges": ["字段/表/枚举变化，没有则空数组"],
  "frontendScope": ["前端需要做的具体事情"],
  "backendScope": ["后端需要做的具体事情"],
  "risks": ["风险与缓解措施"],
  "testPlan": ["需要执行的测试/校验步骤"],
  "estimates": [{"repoId": "工程id", "files": 改动文件数估计, "points": 工作量点数(1-8), "note": "备注"}],
  "assumptions": ["假设/待确认项"],
  "outOfScope": ["明确不做的内容"]
}`;

function architectureBlock(arch: ArchitectureReport | null, profiles: Record<string, RepoProfile>) {
  if (!arch) return '（尚未生成整体架构分析，请仅依据工程事实判断影响面）';
  const domainText = arch.domains
    .map((d) => `- ${d.name}: ${d.description}（${d.repos.map((r) => profiles[r]?.name ?? r).join('、')}）`)
    .join('\n');
  const linkText = arch.links
    .slice(0, 18)
    .map((l) => `- ${profiles[l.from]?.name ?? l.from} ↔ ${profiles[l.to]?.name ?? l.to} [${l.kind}] ${l.summary}`)
    .join('\n');
  return `整体架构结论：\n${budget(arch.narrative, 5000)}\n\n业务域：\n${domainText || '（无）'}\n\n工程关联：\n${linkText || '（无）'}`;
}

/** Static pre-pass: which repos literally contain code that mentions the requirement. */
export function staticRelevance(req: Requirement, records: RepoRecord[], profiles: Record<string, RepoProfile>) {
  const tokens = extractTokens(req.title + ' ' + req.description);
  const scored = records.map((r) => {
    const p = profiles[r.id];
    let score = 0;
    const hits: string[] = [];
    if (!p) return { repoId: r.id, score, hits };
    const endpoints = [...p.apiRoutes, ...p.apiCalls];
    for (const ep of endpoints) {
      const normalized = normalizeEndpoint(ep.path);
      const segs = normalized.split('/').filter((s) => s.length > 2 && !/^:(param|id)$/.test(s));
      for (const t of tokens) {
        if (segs.some((s) => s.includes(t) || t.includes(s))) {
          score += 3;
          if (hits.length < 6) hits.push(`${ep.method} ${ep.path}`);
        }
      }
    }
    for (const t of tokens) {
      if (p.sharedTypes.some((s) => s.toLowerCase().includes(t))) {
        score += 2;
        if (hits.length < 8) hits.push(`类型 ${t}`);
      }
      if (p.topTrees.toLowerCase().includes(t)) {
        score += 2;
        if (hits.length < 10) hits.push(`目录 ${t}`);
      }
    }
    return { repoId: r.id, score, hits };
  });
  return scored.sort((a, b) => b.score - a.score);
}

const STOPWORDS = new Set([
  '增加',
  '支持',
  '新增',
  '需要',
  '实现',
  '功能',
  '页面',
  '用户',
  '可以',
  '以及',
  '进行',
  'the',
  'and',
  'for',
  'a',
  'an',
  'to',
  'of',
  'in',
  'on',
  'is',
  'are',
  'with',
  'api',
  'app',
  'web',
  'com',
  'http',
]);

export function extractTokens(text: string): string[] {
  const latin = (text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((w) => !STOPWORDS.has(w));
  const cjkSegments = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const cjk = cjkSegments.flatMap((seg) => {
    const out: string[] = [seg];
    for (let i = 0; i + 2 <= seg.length; i++) out.push(seg.slice(i, i + 2));
    return out.filter((w) => !STOPWORDS.has(w));
  });
  return [...new Set([...latin, ...cjk])].slice(0, 60);
}

export async function planRequirement(opts: PlanOptions): Promise<RequirementReport> {
  const { requirement, records, profiles, architecture } = opts;
  const settings = resolveAiSettings();
  const model = settings.planningModel || settings.model;
  const started = Date.now();

  const relevance = staticRelevance(requirement, records, profiles);
  const facts = records
    .filter((r) => profiles[r.id])
    .map((r) => repoFactSheet(profiles[r.id], 30, 30))
    .join('\n\n');

  const relevanceText = relevance
    .map(
      (r) =>
        `- ${profiles[r.repoId]?.name ?? r.repoId}: 关键词命中 ${r.score} 分 ${r.hits.length ? '（' + r.hits.slice(0, 6).join('; ') + '）' : ''}`,
    )
    .join('\n');

  const feedback = requirement.feedback.length
    ? `\n\n## 历史反馈（必须在本次分析中吸收）\n${requirement.feedback.map((f) => `- [${f.by}] ${f.content}`).join('\n')}`
    : '';

  const user = `## 任务
用户提出了一条新需求。请作为技术负责人输出**需求影响面分析报告**，明确前后端各工程的修改范围。

## 需求原文
- 标题: ${requirement.title}
- 优先级: ${requirement.priority}
- 描述:
${requirement.description}${feedback}

## 平台静态扫描的相关性预判（关键词/接口命中，可作为线索而非结论）
${budget(relevanceText, 4000)}

## 工程事实
${budget(facts, 55_000)}

## 整体架构
${architectureBlock(architecture, profiles)}

## 输出要求
- impact 必须覆盖所有真正受影响的工程（没有影响的前端或后端工程不要列）。
- files 只能用上面事实里出现过的真实路径或目录，不要虚构。
- apiChanges 的 path 用真实接口路径（如 /api/user/list）。
- 严格输出 JSON：
${SCHEMA}`;

  let payload: LlmReport | null = null;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2 && !payload; attempt++) {
    try {
      const messages = [
        { role: 'system' as const, content: SYSTEM_BASE },
        { role: 'user' as const, content: user },
      ];
      const res =
        attempt === 0
          ? await chatStream(settings, messages, {
              model,
              json: true,
              temperature: 0.2,
              maxTokens: Math.min(settings.maxTokens, 6000),
              timeoutMs: 420_000,
            })
          : await chat(settings, messages, {
              model,
              json: true,
              temperature: 0.1,
              maxTokens: Math.min(settings.maxTokens, 6000),
              timeoutMs: 420_000,
            });
      payload = extractJson<LlmReport>(res.content);
    } catch (err) {
      lastErr = err as Error;
      log('warn', `需求分析第 ${attempt + 1} 次失败: ${(err as Error).message}`, {
        jobId: opts.jobId,
        requirementId: requirement.id,
      });
    }
  }
  if (!payload) {
    throw new Error(`需求分析失败: ${lastErr?.message ?? '未知错误'}`);
  }

  const report = normalizeReport(payload, requirement, records, profiles);
  report.generatedAt = new Date().toISOString();
  report.aiModel = model;
  report.latencyMs = Date.now() - started;
  log('success', `需求报告生成完成：影响 ${report.impact.length} 个工程，${report.apiChanges.length} 个接口变更`, {
    jobId: opts.jobId,
    requirementId: requirement.id,
  });
  return report;
}

/** Models like to list the same endpoint twice (per frontend and per backend). */
function dedupeApiChanges(list: RequirementReport['apiChanges']) {
  const seen = new Map<string, RequirementReport['apiChanges'][number]>();
  for (const a of list) {
    const key = `${a.method} ${a.path.replace(/\/+$/, '')}`.toLowerCase();
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, a);
      continue;
    }
    // merge descriptions/repos instead of dropping information
    if (a.description && !prev.description.includes(a.description))
      prev.description = prev.description ? `${prev.description}；${a.description}` : a.description;
    if (a.repo && prev.repo && a.repo !== prev.repo) prev.repo = `${prev.repo}/${a.repo}`;
    else if (a.repo && !prev.repo) prev.repo = a.repo;
  }
  return [...seen.values()];
}

function normalizeReport(
  raw: LlmReport,
  req: Requirement,
  records: RepoRecord[],
  _profiles: Record<string, RepoProfile>,
): RequirementReport {
  const byId = new Map(records.map((r) => [r.id, r]));
  const byName = new Map(records.map((r) => [r.name, r]));

  const impact = (raw.impact ?? [])
    .map((i) => {
      const rec = byId.get(i.repoId) ?? byName.get(i.repoId) ?? records.find((r) => r.name.includes(i.repoId));
      if (!rec) return null;
      return {
        repoId: rec.id,
        repoName: rec.name,
        role: rec.role,
        level: (['high', 'medium', 'low'].includes(String(i.level)) ? i.level : 'medium') as 'high' | 'medium' | 'low',
        reason: i.reason ?? '',
        areas: i.areas ?? [],
        files: i.files ?? [],
      };
    })
    .filter(Boolean) as RequirementReport['impact'];

  if (!impact.length) {
    // fallback: use static relevance so the report is never empty
    for (const r of records.slice(0, 3)) {
      impact.push({
        repoId: r.id,
        repoName: r.name,
        role: r.role,
        level: 'medium',
        reason: '模型未明确影响面，按工程角色兜底推断',
        areas: [],
        files: [],
      });
    }
  }

  return {
    summary: raw.summary ?? req.title,
    background: raw.background ?? '',
    goals: raw.goals ?? [],
    acceptanceCriteria: raw.acceptanceCriteria ?? [],
    impact,
    apiChanges: dedupeApiChanges(
      (raw.apiChanges ?? [])
        .filter((a) => a && typeof a.path === 'string' && a.path.trim())
        .map((a) => ({
          method: (a.method ?? 'GET').toUpperCase(),
          path: a.path.trim(),
          description: a.description ?? '',
          repo: a.repo ?? '',
          kind: (a.kind ?? 'modified') as string,
        })),
    ),
    dataModelChanges: raw.dataModelChanges ?? [],
    frontendScope: raw.frontendScope ?? [],
    backendScope: raw.backendScope ?? [],
    risks: raw.risks ?? [],
    testPlan: raw.testPlan ?? [],
    estimates: (raw.estimates ?? [])
      .map((e) => {
        const rec = byId.get(e.repoId) ?? byName.get(e.repoId);
        if (!rec) return null;
        return { repoId: rec.id, repoName: rec.name, files: e.files ?? 0, points: e.points ?? 0, note: e.note ?? '' };
      })
      .filter(Boolean) as RequirementReport['estimates'],
    assumptions: raw.assumptions ?? [],
    outOfScope: raw.outOfScope ?? [],
  };
}
