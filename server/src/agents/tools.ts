import fs from 'node:fs';
import path from 'node:path';
import { IGNORE_DIRS, BINARY_EXTS } from '../config.js';
import { runShell } from '../lib/git.js';
import { walkFiles, relOf } from '../lib/fs-scan.js';
import { resolveInside } from '../lib/paths.js';
import { vetCommand } from '../lib/shell-vet.js';
import type { WorkspaceRepo } from '../services/workspace.js';

export interface AgentHooks {
  onLog: (level: 'info' | 'tool' | 'warn' | 'error' | 'success' | 'llm', message: string, detail?: string) => void;
}

export interface ToolResult {
  content: string;
  changedFiles?: string[];
}

const MAX_READ = 60_000;

const HARD_DENY = new Set(['.git', '.ohpert', 'node_modules']);

function isDenied(rel: string) {
  return rel.split('/').some((seg) => HARD_DENY.has(seg));
}

export interface AgentToolSet {
  defs: import('../llm/client.js').ToolDef[];
  exec: (name: string, args: Record<string, any>) => Promise<ToolResult>;
  touched: Set<string>;
}

export function buildToolSet(wss: WorkspaceRepo[], hooks: AgentHooks): AgentToolSet {
  const touched = new Set<string>();
  let active = wss[0]; // repos are addressed as `repoName:relative/path`

  const repoNames = wss.map((w) => w.repo.name);
  const repoHint = `工程名可选值: ${repoNames.join(', ')}。路径格式为 "工程名:相对路径"，例如 "${repoNames[0]}:src/index.ts"；若不写工程名则使用当前工程。`;

  function parseTarget(target: string): { ws: WorkspaceRepo; rel: string } {
    const m = /^([^:\/\\]+)[:\/](.+)$/.exec(target.trim());
    if (m && repoNames.includes(m[1])) {
      const ws = wss.find((w) => w.repo.name === m[1])!;
      active = ws;
      return { ws, rel: m[2] };
    }
    return { ws: active, rel: target.trim() };
  }

  function displayPath(ws: WorkspaceRepo, rel: string) {
    return `${ws.repo.name}:${rel}`;
  }

  const defs: import('../llm/client.js').ToolDef[] = [
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: `列出某个工程目录下的文件与子目录（自动忽略 node_modules/.git/dist）。${repoHint}`,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '目录路径，工程名:相对路径，或 "." 表示工程根目录' } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: `读取文本文件内容（带行号）。修改前必须先读取。${repoHint}`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '工程名:相对路径' },
            start_line: { type: 'number', description: '起始行，1-based，可选' },
            end_line: { type: 'number', description: '结束行，可选' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_code',
        description: `在多个工程中按正则搜索代码，返回命中位置。用于找接口、组件、类型定义。${repoHint}`,
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'JavaScript 正则表达式，如 "user/:id" 或 "export (function|const) Login"',
            },
            repo: { type: 'string', description: '只在指定工程内搜索，可选' },
            glob: { type: 'string', description: '文件名过滤子串，如 ".vue" 或 "controller"，可选' },
            max_results: { type: 'number', description: '最多返回条数，默认 40' },
          },
          required: ['pattern'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: `覆盖写入文件（不存在则创建，自动创建父目录）。只能写工程内部路径。${repoHint}`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '工程名:相对路径' },
            content: { type: 'string', description: '完整文件内容' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: `精确替换文件中的一段文本（old_text 必须在文件中唯一出现）。比 write_file 更安全，优先使用。${repoHint}`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '工程名:相对路径' },
            old_text: { type: 'string', description: '要替换的原文（含缩进，必须唯一）' },
            new_text: { type: 'string', description: '替换后的文本' },
          },
          required: ['path', 'old_text', 'new_text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_file',
        description: '删除文件（谨慎使用）。',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '工程名:相对路径' } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description:
          '在指定工程目录执行一条命令（如 pnpm run build、npx --no-install tsc --noEmit、pytest、mvn -q compile）。不要执行 git commit/push、不要安装依赖、不要删除目录。',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: '要执行的命令' },
            repo: { type: 'string', description: '工程名，可选，默认当前工程' },
            timeout_seconds: { type: 'number', description: '超时秒数，默认 180' },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'switch_repo',
        description: '切换当前工作工程。',
        parameters: {
          type: 'object',
          properties: { repo: { type: 'string', description: `工程名，可选值: ${repoNames.join(', ')}` } },
          required: ['repo'],
        },
      },
    },
  ];

  async function exec(name: string, args: Record<string, any>): Promise<ToolResult> {
    switch (name) {
      case 'list_dir': {
        const { ws, rel } = parseTarget(String(args.path ?? '.'));
        const abs = resolveInside(ws.path, rel || '.');
        if (!fs.existsSync(abs)) return { content: `目录不存在: ${displayPath(ws, rel)}` };
        const entries = fs
          .readdirSync(abs, { withFileTypes: true })
          .filter((e) => !(e.isDirectory() && IGNORE_DIRS.has(e.name)))
          .slice(0, 300)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return { content: `${displayPath(ws, rel || '.')}:\n${entries.join('\n') || '(空目录)'}` };
      }
      case 'read_file': {
        const { ws, rel } = parseTarget(String(args.path));
        const abs = resolveInside(ws.path, rel);
        if (!fs.existsSync(abs)) return { content: `文件不存在: ${displayPath(ws, rel)}` };
        const st = fs.statSync(abs);
        if (st.isDirectory()) return { content: `${displayPath(ws, rel)} 是目录，请用 list_dir` };
        if (st.size > 2_000_000) return { content: '文件过大，拒绝读取' };
        const text = fs.readFileSync(abs, 'utf8');
        const lines = text.split('\n');
        const s = Math.max(1, Number(args.start_line) || 1);
        const e = Math.min(lines.length, Number(args.end_line) || Math.min(lines.length, s + 800));
        const slice = lines
          .slice(s - 1, e)
          .map((l, i) => `${String(s + i).padStart(5)}| ${l}`)
          .join('\n');
        return { content: `${displayPath(ws, rel)} (${lines.length} 行, 显示 ${s}-${e})\n${slice.slice(0, MAX_READ)}` };
      }
      case 'search_code': {
        const re = new RegExp(String(args.pattern), 'm');
        const filter = String(args.glob ?? '');
        const maxResults = Math.min(Number(args.max_results) || 40, 120);
        const targets = args.repo ? wss.filter((w) => w.repo.name === String(args.repo)) : wss;
        const out: string[] = [];
        for (const ws of targets) {
          const files = walkFiles(ws.path, { maxFiles: 20_000 }).filter((f) => {
            const rel = relOf(ws.path, f);
            if (isDenied(rel)) return false;
            if (filter && !rel.includes(filter)) return false;
            return !BINARY_EXTS.has(path.extname(rel).toLowerCase());
          });
          for (const full of files) {
            let content: string;
            try {
              const st = fs.statSync(full);
              if (st.size > 500_000) continue;
              content = fs.readFileSync(full, 'utf8');
            } catch {
              continue;
            }
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              re.lastIndex = 0;
              if (re.test(lines[i])) {
                out.push(`${ws.repo.name}:${relOf(ws.path, full)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                if (out.length >= maxResults) break;
              }
            }
            if (out.length >= maxResults) break;
          }
          if (out.length >= maxResults) break;
        }
        return { content: out.length ? out.join('\n') : `未找到匹配 "${args.pattern}"` };
      }
      case 'write_file': {
        const { ws, rel } = parseTarget(String(args.path));
        if (isDenied(rel)) throw new Error(`禁止写入 ${rel}`);
        const abs = resolveInside(ws.path, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(args.content ?? ''), 'utf8');
        touched.add(displayPath(ws, rel));
        return { content: `已写入 ${displayPath(ws, rel)} (${String(args.content ?? '').split('\n').length} 行)` };
      }
      case 'edit_file': {
        const { ws, rel } = parseTarget(String(args.path));
        if (isDenied(rel)) throw new Error(`禁止修改 ${rel}`);
        const abs = resolveInside(ws.path, rel);
        if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${displayPath(ws, rel)}，新建请用 write_file`);
        const oldText = String(args.old_text ?? '');
        const newText = String(args.new_text ?? '');
        const content = fs.readFileSync(abs, 'utf8');
        const first = content.indexOf(oldText);
        if (first < 0) throw new Error(`old_text 未在 ${displayPath(ws, rel)} 中找到，请先 read_file 获取准确原文`);
        if (content.indexOf(oldText, first + 1) >= 0) {
          throw new Error(`old_text 在 ${displayPath(ws, rel)} 中出现多次，请提供更多上下文以保证唯一`);
        }
        fs.writeFileSync(abs, content.slice(0, first) + newText + content.slice(first + oldText.length), 'utf8');
        touched.add(displayPath(ws, rel));
        return { content: `已修改 ${displayPath(ws, rel)}` };
      }
      case 'delete_file': {
        const { ws, rel } = parseTarget(String(args.path));
        if (isDenied(rel)) throw new Error(`禁止删除 ${rel}`);
        const abs = resolveInside(ws.path, rel);
        if (!fs.existsSync(abs)) return { content: `文件不存在: ${displayPath(ws, rel)}` };
        fs.rmSync(abs);
        touched.add(displayPath(ws, rel));
        return { content: `已删除 ${displayPath(ws, rel)}` };
      }
      case 'run_command': {
        const cmd = String(args.command ?? '').trim();
        if (!cmd) return { content: '命令为空' };
        const verdict = vetCommand(cmd);
        if (!verdict.ok) {
          hooks.onLog('warn', verdict.reason ?? '命令被拒绝');
          return { content: verdict.reason ?? '命令被拒绝' };
        }
        const ws = args.repo ? (wss.find((w) => w.repo.name === String(args.repo)) ?? active) : active;
        const timeoutMs = Math.min(Math.max(Number(args.timeout_seconds) || 180, 5), 600) * 1000;
        hooks.onLog('tool', `$ ${cmd}  (cwd=${ws.repo.name}, timeout=${timeoutMs / 1000}s)`);
        const res = await runShell(cmd, { cwd: ws.path, timeoutMs });
        const output = `${res.stdout}\n${res.stderr}`.trim().slice(-8000);
        hooks.onLog(
          res.code === 0 ? 'success' : 'warn',
          `命令退出码 ${res.code}${res.timedOut ? ' (超时)' : ''}: ${cmd}`,
        );
        return { content: `exit_code=${res.code}${res.timedOut ? ' (超时)' : ''}\n${output || '(无输出)'}` };
      }
      case 'switch_repo': {
        const target = wss.find((w) => w.repo.name === String(args.repo));
        if (!target) return { content: `找不到工程 ${args.repo}，可选: ${repoNames.join(', ')}` };
        active = target;
        return { content: `当前工程已切换为 ${active.repo.name}` };
      }
      default:
        return { content: `未知工具: ${name}` };
    }
  }

  return { defs, exec, touched };
}
