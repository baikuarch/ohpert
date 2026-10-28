/**
 * Best-effort vetting for commands the coding agent wants to run.
 *
 * This is deliberately *not* a real sandbox: the agent still runs shell commands
 * as the current user. What we can do is reject obviously destructive or
 * exfiltrating commands, including the common ways to smuggle them through
 * wrappers (`sh -c`, `env`, `xargs`, `git -c`, `npm exec`, ...).
 */

export interface VetResult {
  ok: boolean;
  reason?: string;
}

/** Binaries that can execute arbitrary code / touch the machine outside the repo. */
const DENY_BINARIES = new Set([
  'sudo',
  'su',
  'doas',
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'ksh',
  'dash',
  'eval',
  'exec',
  'xargs',
  'nohup',
  'setsid',
  'chroot',
  'mount',
  'umount',
  'diskutil',
  'mkfs',
  'dd',
  'shred',
  'chmod',
  'chown',
  'chgrp',
  'launchctl',
  'systemctl',
  'service',
  'kill',
  'pkill',
  'killall',
  'crontab',
  'at',
  'osascript',
  'open',
  'defaults',
  'netcat',
  'nc',
  'ncat',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'curl',
  'wget',
  'tee',
  'rm',
  'rmdir',
  'unlink',
  'mkfile',
  'mktemp',
]);

/** Package managers that would install code from the network. */
const DENY_BINARIES_INSTALLERS = new Set(['brew', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'port', 'snap']);

/** Git subcommands that mutate history or the working tree. */
const DENY_GIT = new Set([
  'commit',
  'push',
  'reset',
  'checkout',
  'switch',
  'restore',
  'clean',
  'branch',
  'tag',
  'rebase',
  'merge',
  'cherry-pick',
  'revert',
  'stash',
  'worktree',
  'update-ref',
  'symbolic-ref',
  'config',
  'remote',
  'submodule',
  'gc',
  'filter-branch',
  'replace',
  'notes',
  'apply',
  'am',
  'format-patch',
  'send-email',
  'daemon',
  'instaweb',
]);

const DENY_PM_SUBCOMMANDS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'uninstall',
  'link',
  'dedupe',
  'update',
  'upgrade',
  'prune',
  'ci',
  'rebuild',
  'exec',
  'x',
  'dlx',
  'create',
  'init',
]);

/** Interpreters that can execute arbitrary inline code, bypassing the denylist. */
const INLINE_CODE_FLAGS: Record<string, string[]> = {
  python: ['-c'],
  python3: ['-c'],
  node: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'],
  bun: ['-e', '--eval'],
  ruby: ['-e'],
  perl: ['-e'],
  php: ['-r'],
  lua: ['-e'],
  rscript: ['-e'],
};

/** Wrappers that simply execute the following command. */
const WRAPPERS = new Set(['command', 'builtin', 'time', 'nice', 'env']);

function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let started = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) {
      cur += ch;
      started = true;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

/** Split a shell line into command segments (&&, ||, ;, |, newline). */
function splitSegments(command: string): string[][] {
  const segments: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      cur += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      segments.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      segments.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  segments.push(cur);

  return segments.map(tokenize).filter((tokens) => tokens.length > 0);
}

function baseName(token: string): string {
  return token.split(/[\\/]/).pop()?.toLowerCase() ?? token.toLowerCase();
}

function skipWrapper(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const bin = baseName(tokens[i]);
    if (!WRAPPERS.has(bin)) break;
    i++;
    // `env FOO=bar cmd`, `time -p cmd`, `nice -n 5 cmd`
    while (i < tokens.length && (tokens[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]))) {
      if (tokens[i] === '-n' || tokens[i] === '--adjustment') i++;
      i++;
    }
  }
  return tokens.slice(i);
}

function deny(segment: string, reason: string): VetResult {
  return { ok: false, reason: `拒绝执行：${reason}（命令片段：${segment.slice(0, 160)}）` };
}

/** Returns `{ ok:false, reason }` when a command should not be executed. */
export function vetCommand(command: string): VetResult {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: '命令为空' };

  // Command substitution / variable-built command names let a line look harmless
  // while the shell executes whatever the substitution produces.
  if (/`|\$\(/.test(trimmed)) {
    return { ok: false, reason: '拒绝执行：不允许命令替换（反引号或 $(…)）' };
  }
  // Redirecting into an absolute path or the home dir would escape the repo.
  if (/(?:^|[^0-9])&?>>?\s*(?:~|\$HOME|\/(?!dev\/null\b))/i.test(trimmed)) {
    return { ok: false, reason: '拒绝执行：不允许重定向到工程目录之外的绝对路径或 HOME' };
  }

  for (const raw of splitSegments(trimmed)) {
    const segment = raw.join(' ');
    let tokens = raw;

    // strip leading environment assignments: FOO=bar npm run build
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
    tokens = skipWrapper(tokens);
    if (!tokens.length) continue;
    if (/^\$[{]?[A-Za-z_]/.test(tokens[0])) {
      return deny(segment, '不允许用变量拼接命令名');
    }

    const bin = baseName(tokens[0]);
    if (DENY_BINARIES.has(bin)) return deny(segment, `不允许执行 ${bin}`);
    if (DENY_BINARIES_INSTALLERS.has(bin)) return deny(segment, `不允许通过 ${bin} 安装系统软件`);

    const inlineFlags = INLINE_CODE_FLAGS[bin];
    if (
      inlineFlags &&
      tokens.slice(1).some((t) => inlineFlags.includes(t) || inlineFlags.some((f) => t.startsWith(`${f}=`)))
    ) {
      return deny(segment, `不允许用 ${bin} 执行内联代码（可绕过命令检查）`);
    }

    if (bin === 'git') {
      let i = 1;
      while (i < tokens.length) {
        const t = tokens[i];
        if (['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(t)) {
          const value = tokens[i + 1] ?? '';
          // `git -c alias.x='!sh -c ...' x` would execute an arbitrary shell command.
          if (t === '-c' && /^alias\./i.test(value) && value.includes('!')) {
            return deny(segment, '不允许通过 git alias 执行 shell 命令');
          }
          i += 2;
          continue;
        }
        if (t.startsWith('-')) {
          i++;
          continue;
        }
        break;
      }
      const sub = (tokens[i] ?? '').toLowerCase();
      if (DENY_GIT.has(sub)) return deny(segment, `不允许执行 git ${sub}`);
    }

    if (['npm', 'pnpm', 'yarn', 'bun'].includes(bin)) {
      let i = 1;
      while (i < tokens.length && tokens[i].startsWith('-')) {
        if (['--prefix', '--dir', '-C', '--cwd', '--registry', '--filter', '-F'].includes(tokens[i])) i += 2;
        else i++;
      }
      const sub = (tokens[i] ?? '').toLowerCase();
      if (DENY_PM_SUBCOMMANDS.has(sub)) return deny(segment, `不允许执行 ${bin} ${sub}（会安装/修改依赖）`);
    }

    if (bin === 'npx' || bin === 'bunx') {
      if (!tokens.includes('--no-install'))
        return deny(segment, `不允许 ${bin} 自动下载依赖，请加 --no-install 或使用工程内脚本`);
    }

    if (bin === 'pip' || bin === 'pip3' || bin === 'go' || bin === 'cargo') {
      const sub = (tokens[1] ?? '').toLowerCase();
      if (sub === 'install') return deny(segment, `不允许执行 ${bin} install`);
    }
    if (['python', 'python3'].includes(bin) && tokens.includes('-m') && tokens.includes('pip')) {
      if (tokens.includes('install')) return deny(segment, '不允许通过 pip 安装依赖');
    }

    if (bin === 'find' && (tokens.includes('-exec') || tokens.includes('-execdir') || tokens.includes('-delete'))) {
      return deny(segment, '不允许 find 执行命令或删除文件');
    }
  }

  return { ok: true };
}
