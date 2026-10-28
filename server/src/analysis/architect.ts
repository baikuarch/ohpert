import type { ArchitectureReport, RepoLink, RepoProfile, RepoRecord } from '../types.js';
import { log } from '../lib/log.js';
import { chat, chatStream, extractJson } from '../llm/client.js';
import { SYSTEM_BASE, repoFactSheet } from '../llm/prompts.js';
import { resolveAiSettings } from '../store/settings.js';
import { budget } from '../lib/util.js';

interface LlmArch {
  narrative?: string;
  techSummary?: string;
  domains?: { name: string; description: string; repos: string[] }[];
  keyFlows?: { name: string; steps: string[]; repos: string[] }[];
  extraLinks?: { from: string; to: string; kind: string; summary: string }[];
  warnings?: string[];
}

const ARCH_SCHEMA = `{
  "narrative": "总体架构说明（300-800字，说明前后端如何协作、数据如何流转、各工程职责边界）",
  "techSummary": "技术栈一句话总结",
  "domains": [{"name": "业务域/模块名", "description": "该域负责什么", "repos": ["repo-id"]}],
  "keyFlows": [{"name": "关键链路名（如 登录鉴权、下单支付）", "steps": ["步骤1", "步骤2"], "repos": ["repo-id"]}],
  "extraLinks": [{"from": "repo-id", "to": "repo-id", "kind": "shared-types|data-model|same-domain", "summary": "说明"}],
  "warnings": ["配置风险/隐患，如 CORS、环境变量不一致、缺少文档"]
}`;

export async function analyzeArchitecture(
  records: RepoRecord[],
  profiles: Record<string, RepoProfile>,
  links: RepoLink[],
  opts: { jobId?: string; requirementId?: string | null } = {},
): Promise<ArchitectureReport> {
  const settings = resolveAiSettings();
  const model = settings.planningModel || settings.model;
  const facts = records
    .filter((r) => profiles[r.id])
    .map((r) => repoFactSheet(profiles[r.id]))
    .join('\n\n');

  const linkText =
    links.length === 0
      ? '（静态扫描未发现明确关联）'
      : links
          .map(
            (l) =>
              `- [${l.kind}][强度${l.strength}] ${profiles[l.from]?.name ?? l.from} → ${profiles[l.to]?.name ?? l.to}: ${l.summary}`,
          )
          .join('\n');

  const user = `## 任务
我提供了多个 Git 工程的事实材料。请完成：
1. 判断每个工程的技术角色（前端/后端/全栈/移动端/库/基础设施），并在 narrative 中说明依据。
2. 梳理工程之间的**业务链路关系**（谁调谁、数据从哪到哪、共享了哪些模型/枚举/配置）。
3. 划分业务域，列出关键链路（登录、鉴权、列表、详情等）。
4. 指出协作风险（接口契约不一致、CORS、环境变量命名冲突、共享类型重复定义等）。

## 工程事实
${budget(facts, 60_000)}

## 静态扫描得到的候选关联（可采纳/修正/补充）
${budget(linkText, 12_000)}

## 输出 JSON 结构（严格按此结构，repos 字段用工程 id）
${ARCH_SCHEMA}`;

  log('llm', `开始架构分析：${records.length} 个工程，模型 ${model}`, {
    jobId: opts.jobId,
    requirementId: opts.requirementId,
  });

  let content: string;
  try {
    const res = await chatStream(
      settings,
      [
        { role: 'system', content: SYSTEM_BASE },
        { role: 'user', content: user },
      ],
      {
        model,
        json: true,
        temperature: 0.2,
        maxTokens: Math.min(settings.maxTokens, 8000),
        timeoutMs: 420_000,
      },
    );
    content = res.content;
    if (!content?.trim()) throw new Error('模型未返回内容');
  } catch (err) {
    // one retry with the non-streaming path: some gateways drop streaming for JSON mode
    log('warn', `架构分析流式调用失败，重试非流式: ${(err as Error).message}`, { jobId: opts.jobId });
    const res = await chat(
      settings,
      [
        { role: 'system', content: SYSTEM_BASE },
        { role: 'user', content: user },
      ],
      { model, json: true, temperature: 0.2, maxTokens: Math.min(settings.maxTokens, 8000), timeoutMs: 420_000 },
    );
    content = res.content;
  }

  const parsed = extractJson<LlmArch>(content);
  const now = new Date().toISOString();

  // the LLM sometimes declares from==to (repeating a static http-api fact); drop those
  const llmLinks: RepoLink[] = (parsed.extraLinks ?? [])
    .filter((l) => l.from !== l.to)
    .filter(
      (l) =>
        Boolean(profiles[l.from]) &&
        Boolean(profiles[l.to]) &&
        l.from !== l.to &&
        ['http-api', 'shared-types', 'data-model', 'same-domain', 'npm-package', 'shared-env'].includes(
          String(l.kind),
        ) &&
        l.from !== l.to,
    )
    .map((l, i) => ({
      id: `llm:${i}:${l.from}->${l.to}`,
      from: l.from,
      to: l.to,
      kind: (['shared-types', 'data-model', 'same-domain', 'npm-package', 'shared-env', 'http-api'].includes(l.kind)
        ? l.kind
        : 'same-domain') as RepoLink['kind'],
      strength: 35,
      summary: l.summary,
      evidence: [],
    }));

  // merge: static evidence wins, LLM adds qualitative links
  const merged = [...links];
  for (const l of llmLinks) {
    const dup = merged.find(
      (m) =>
        (m.from === l.from && m.to === l.to && m.kind === l.kind) ||
        (m.from === l.to && m.to === l.from && m.kind === l.kind),
    );
    if (dup) {
      dup.strength = Math.max(dup.strength, l.strength);
      if (!dup.summary.includes(l.summary.slice(0, 20))) dup.summary += `；${l.summary}`;
    } else merged.push(l);
  }

  const flowBlock = (parsed.keyFlows ?? [])
    .map(
      (f) =>
        `#### ${f.name}\n${f.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n涉及工程：${f.repos.map((r) => profiles[r]?.name ?? r).join('、')}`,
    )
    .join('\n\n');

  const narrative = [parsed.narrative ?? '', flowBlock ? `\n\n### 关键链路\n${flowBlock}` : ''].join('').trim();

  const report: ArchitectureReport = {
    generatedAt: now,
    aiModel: model,
    narrative: narrative || '模型未给出架构说明。',
    domains: (parsed.domains ?? []).map((d) => ({ ...d, repos: d.repos.filter((r) => profiles[r]) })),
    links: merged.sort((a, b) => b.strength - a.strength),
    warnings: parsed.warnings ?? [],
    techSummary: parsed.techSummary ?? '',
  };

  log('success', `架构分析完成：识别 ${report.domains.length} 个业务域、${report.links.length} 条工程关联`, {
    jobId: opts.jobId,
  });
  return report;
}
