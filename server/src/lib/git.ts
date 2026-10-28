import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

const DEFAULT_TIMEOUT = 60_000;

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string>; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT,
        maxBuffer: 24 * 1024 * 1024,
        env: { ...process.env, ...(opts.env || {}) },
      },
      (err, stdout, stderr) => {
        const errAny = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        let code = 0;
        if (errAny) {
          if (typeof errAny.code === 'number') code = errAny.code;
          else if (errAny.killed) code = 124;
          else code = 1;
        }
        resolve({
          code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') || (errAny && typeof errAny.code === 'string' ? errAny.message : ''),
          timedOut: Boolean(errAny?.killed),
        });
      },
    );
    if (opts.input != null && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** Run a user-supplied shell command string (hooks are declared by the developer). */
export function runShell(command: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<RunResult> {
  return run('/bin/sh', ['-c', command], { ...opts, timeoutMs: opts.timeoutMs ?? 180_000 });
}

export async function git(cwd: string, args: string[], timeoutMs = DEFAULT_TIMEOUT): Promise<RunResult> {
  const res = await run('git', args, {
    cwd,
    timeoutMs,
    env: { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  return res;
}

export async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr || r.stdout}`);
  return r.stdout;
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (r.code !== 0) return false;
  // require it to be the repo root, not a nested folder
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return false;
  try {
    return fs.realpathSync(top.stdout.trim()) === fs.realpathSync(dir);
  } catch {
    return false;
  }
}

export function isProbablyGitRepo(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}
