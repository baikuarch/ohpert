import { buildToolSet } from './tools.js';
import { runAgent } from './loop.js';
import { buildFailureDigest, runBuildChecks, type BuildResult } from './build-check.js';
import type { Requirement, RepoProfile, RepoRecord } from '../types.js';
import { resolveAiSettings } from '../store/settings.js';
import type { WorkspaceRepo } from '../services/workspace.js';
import { budget } from '../lib/util.js';

export function implementationSystemPrompt() {
  return `你是一名执行需求研发的资深全栈工程师。你现在直接操作多个工程的代码仓库副本。

工作规则：
1. 先用 search_code / read_file 弄清现有实现，再动手改；不要凭空猜测文件内容。
2. 优先使用 edit_file 做精确修改；新建文件用 write_file。一次只改一处，保证正确性。
3. 前后端要一起改：如果需求涉及接口变化，必须同时修改后端（路由/服务/模型）和前端（请求封装/页面/类型定义），保持字段名与路径一致。
4. 保持工程既有代码风格（缩进、命名、目录结构、组件风格）。
5. 修改完成后，尽量用 run_command 运行该工程自己的校验脚本：先看 package.json 的 scripts，再用工程实际使用的包管理器执行（例如 pnpm run build / yarn run typecheck / npm run lint）；没有脚本时可用 \`npx --no-install tsc --noEmit\` 或 \`mvn -q -DskipTests compile\`。工程内没有依赖时不要安装，直接跳过并说明。
6. 不要执行 git commit / push；平台会自动记录改动。
7. 当所有改动完成并验证后，停止调用工具，输出一段简明的「改动总结」：每个工程改了哪些文件、为什么改、如何验证。`;
}

export function buildImplementationUser(opts: {
  req: Requirement;
  records: RepoRecord[];
  profiles: Record<string, RepoProfile>;
  targets: WorkspaceRepo[];
  feedbackNote: string;
}) {
  const { req, profiles, targets, feedbackNote } = opts;
  const report = req.report;
  const targetText = targets
    .map((w) => {
      const p = profiles[w.repo.id];
      return `### ${w.repo.name} (分支 ${w.branch}, 基于 ${w.baseBranch}@${w.baseRev.slice(0, 8)})
- 角色: ${w.repo.role}
- 技术栈: ${p?.frameworks.join(', ') || ''} / ${Object.keys(p?.languages ?? {}).join(', ')}
- 可用脚本: ${
        Object.entries(p?.scripts ?? {})
          .map(([k, v]) => `${k}="${v}"`)
          .join(' | ') || '无 package.json scripts'
      }
- 代表文件: ${(p?.entryPoints ?? []).slice(0, 5).join(', ')}
- 主要目录: ${p?.topTrees ?? ''}
${
  w.repo.role === 'backend' || (p?.apiRoutes.length ?? 0) > (p?.apiCalls.length ?? 0)
    ? `- 现有路由: ${(p?.apiRoutes ?? [])
        .slice(0, 25)
        .map((r) => `${r.method} ${r.path}`)
        .join(', ')}`
    : `- 现有请求点: ${(p?.apiCalls ?? [])
        .slice(0, 25)
        .map((r) => `${r.method} ${r.path}`)
        .join(', ')}`
}`;
    })
    .join('\n\n');

  const impactText = (report?.impact ?? [])
    .map((i) => `- ${i.repoName} [${i.level}] ${i.reason}${i.files.length ? `；建议文件: ${i.files.join(', ')}` : ''}`)
    .join('\n');

  return `## 需求
标题：${req.title}
优先级：${req.priority}
描述：
${req.description}

## 需求分析报告（计划）
摘要：${report?.summary ?? ''}
目标：
${(report?.goals ?? []).map((g) => `- ${g}`).join('\n') || '- （无）'}
验收标准：
${(report?.acceptanceCriteria ?? []).map((g) => `- ${g}`).join('\n') || '- （无）'}
接口变更：
${(report?.apiChanges ?? []).map((a) => `- ${a.method} ${a.path} (${a.kind}) ${a.description}`).join('\n') || '- （无）'}
前端范围：
${(report?.frontendScope ?? []).map((g) => `- ${g}`).join('\n') || '- （无）'}
后端范围：
${(report?.backendScope ?? []).map((g) => `- ${g}`).join('\n') || '- （无）'}

## 影响面
${impactText || '- （无）'}
${feedbackNote}

## 可用工程（已为你准备好可写副本）
${budget(targetText, 20_000)}

## 开始
请按计划逐步修改代码，最终输出改动总结。`;
}

export interface ImplementResult {
  result: Awaited<ReturnType<typeof runAgent>>;
  model: string;
  touched: Set<string>;
  /** every build/typecheck run performed, in order (initial + repair rounds) */
  commands: { command: string; ok: boolean; output: string }[];
  /** number of automatic repair rounds actually executed */
  repairRounds: number;
  /** unresolved build failures after the budget ran out */
  failures: BuildResult[];
  /** human readable summary across all agent turns */
  summary: string;
}

const MAX_REPAIR_ROUNDS = 3;

export async function implementRequirement(opts: {
  req: Requirement;
  records: RepoRecord[];
  profiles: Record<string, RepoProfile>;
  targets: WorkspaceRepo[];
  feedbackNote: string;
  jobId: string;
  onLog: (level: 'info' | 'tool' | 'warn' | 'error' | 'success' | 'llm', message: string, detail?: string) => void;
  repairRounds?: number;
  /** progress hook so the UI shows "第 2/3 轮自动修复" */
  onPhase?: (label: string, ratio: number) => void;
}): Promise<ImplementResult> {
  const settings = resolveAiSettings();
  const model = settings.codingModel || settings.model;
  const tools = buildToolSet(opts.targets, { onLog: opts.onLog });
  const commands: { command: string; ok: boolean; output: string }[] = [];
  const maxRepairs = opts.repairRounds ?? MAX_REPAIR_ROUNDS;

  const system = implementationSystemPrompt();
  const toolArgs = { settings, model, system, tools, maxTurns: settings.maxTurns, onLog: opts.onLog };

  let result = await runAgent({ ...toolArgs, user: buildImplementationUser(opts) });
  const summaries = [result.finalText];

  // ---- self-repair loop: verify with the repo's own build/typecheck and feed
  // failures back to the model instead of surfacing them at acceptance time ----
  let failures: BuildResult[] = [];
  let repairRounds = 0;
  for (let round = 0; round <= maxRepairs; round++) {
    if (result.stopReason === 'error') break;
    opts.onPhase?.(round === 0 ? '构建校验…' : `自动修复第 ${round}/${maxRepairs} 轮 · 校验中…`, 0.6);
    const touchedRepos = new Set(
      opts.targets.filter((t) => [...tools.touched].some((p) => p.startsWith(`${t.repo.name}:`))).map((t) => t.repo.id),
    );
    const checks = await runBuildChecks(opts.targets, opts.profiles, {
      onlyRepoIds: touchedRepos.size ? touchedRepos : undefined,
      onLog: (l, m) => opts.onLog(l === 'warn' ? 'warn' : l, m),
    });
    commands.push(...checks.map((c) => ({ command: `${c.repoName}: ${c.command}`, ok: c.ok, output: c.output })));
    failures = checks.filter((c) => !c.ok && !c.timedOut);

    if (!checks.length) {
      opts.onLog('info', '相关工程没有可用的构建/类型检查脚本，跳过自动校验');
      break;
    }
    if (!failures.length) {
      if (round > 0) opts.onLog('success', `第 ${round} 轮自动修复后构建全部通过`);
      else opts.onLog('success', `构建校验通过（${checks.length} 个工程）`);
      break;
    }

    if (round === maxRepairs) {
      opts.onLog('error', `自动修复已达上限 ${maxRepairs} 轮，仍有 ${failures.length} 个工程构建失败`);
      break;
    }

    repairRounds++;
    opts.onLog(
      'warn',
      `${failures.map((f) => f.repoName).join('、')} 构建失败，开始第 ${repairRounds}/${maxRepairs} 轮自动修复`,
    );
    opts.onPhase?.(`第 ${repairRounds}/${maxRepairs} 轮自动修复…`, 0.7 + repairRounds * 0.05);

    result = await runAgent({
      ...toolArgs,
      user: buildRepairUser(opts, failures, round + 1, maxRepairs),
    });
    summaries.push(result.finalText);
  }

  return {
    result,
    model,
    touched: tools.touched,
    commands,
    repairRounds,
    failures,
    summary: summaries.filter(Boolean).join('\n\n---\n\n'),
  };
}

/** Prompt used for each automatic repair round. */
function buildRepairUser(
  opts: { req: Requirement; targets: WorkspaceRepo[] },
  failures: BuildResult[],
  round: number,
  max: number,
) {
  return `## 自动修复（第 ${round}/${max} 轮）

你刚才的改动已经写入工作区，但工程的构建/类型检查没有通过。请**只修复这些错误**，不要重写整个功能，不要改动无关代码。

需求：${opts.req.title}

## 失败详情
${buildFailureDigest(failures)}

## 工作方式
1. 先 read_file 打开报错位置，确认错误原因（不要猜测）。
2. 用 edit_file 做最小修改。
3. 可以用 run_command 重新运行对应命令验证（例如被标记的工程目录里执行该命令）。
4. 全部修复后停止调用工具，输出「修复说明」：每个错误的原因和修法。

可修改的工程：${opts.targets.map((t) => t.repo.name).join('、')}`;
}
