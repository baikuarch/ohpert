import type { RepoProfile } from '../types.js';

export const SYSTEM_BASE = `你是资深全栈架构师 + 需求交付专家，工作在一个「多 Git 工程需求管理研发平台」中。
你的读者是真实开发者，请用简体中文专业、具体、可执行地表达。
规则：
- 只依据给定的事实（工程画像、代码片段、路径、接口）推断，不要编造不存在的文件、接口或依赖。
- 不确定时明确写出假设，不要假装确定。
- 涉及文件和接口时尽量给出真实路径与真实路径字面量。
- 输出必须是合法 JSON，不要包含注释、不要包含 Markdown 代码围栏之外的解释。`;

export function repoFactSheet(p: RepoProfile, maxApiCalls = 40, maxRoutes = 40): string {
  const langs = Object.entries(p.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([l, c]) => `${l}:${c}`)
    .join(', ');
  const fe = p.apiCalls
    .slice(0, maxApiCalls)
    .map((c) => `  - ${c.method} ${c.path}  (${c.file}:${c.line})`)
    .join('\n');
  const be = p.apiRoutes
    .slice(0, maxRoutes)
    .map((c) => `  - ${c.method} ${c.path}  (${c.file}:${c.line})`)
    .join('\n');
  return `### 工程 ${p.name}（id=${p.id}）
- 根目录: ${p.path}
- 角色: ${p.role}${p.roleSource === 'user' ? '（用户指定）' : '（自动推断）'}
- 分支/HEAD: ${p.branch || 'n/a'} ${p.head ? p.head.slice(0, 8) : ''} ${p.dirty ? '(有未提交改动)' : ''}
- 语言分布: ${langs || 'n/a'}
- 框架/依赖特征: ${p.frameworks.join(', ') || 'n/a'}
- 包管理器: ${p.packageManager ?? 'n/a'}
- 文件数: ${p.fileCount}，扫描代码行: ${p.loc}
- 主要目录: ${p.topTrees}
- 入口文件: ${p.entryPoints.join(', ') || 'n/a'}
- 构建/测试脚本: ${
    Object.entries(p.scripts)
      .map(([k, v]) => `${k}: ${v}`)
      .slice(0, 12)
      .join(' | ') || 'n/a'
  }
- 环境变量: ${p.envKeys.slice(0, 25).join(', ') || 'n/a'}
- 领域模型/类型(节选): ${p.sharedTypes.slice(0, 40).join(', ') || 'n/a'}
- 其它配置: ${p.configFiles.slice(0, 15).join(', ')}
- 对外 HTTP 调用点 (${p.apiCalls.length}):
${fe || '  - 无'}
- 暴露的 HTTP 路由 (${p.apiRoutes.length}):
${be || '  - 无'}`;
}
