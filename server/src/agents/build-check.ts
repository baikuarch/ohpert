import fs from 'node:fs';
import path from 'node:path';
import { runShell } from '../lib/git.js';
import type { RepoProfile } from '../types.js';
import type { WorkspaceRepo } from '../services/workspace.js';

export interface BuildResult {
  repoId: string;
  repoName: string;
  label: string;
  command: string;
  ok: boolean;
  timedOut: boolean;
  output: string;
}

/** Package managers that can run `package.json` scripts, keyed by profile value. */
const RUNNERS: Record<string, string> = {
  pnpm: 'pnpm run',
  yarn: 'yarn run',
  bun: 'bun run',
  npm: 'npm run',
};

/**
 * Work out which package manager owns this checkout. The analysed profile is
 * preferred, but a freshly created worktree may belong to a repo whose profile
 * was produced before a lockfile changed, so fall back to the lockfiles on disk.
 */
function detectRunner(profile: RepoProfile | undefined, root: string): string {
  const known = profile?.packageManager ? RUNNERS[profile.packageManager] : undefined;
  if (known) return known;
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return RUNNERS.pnpm;
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return RUNNERS.yarn;
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) return RUNNERS.bun;
  return RUNNERS.npm;
}

/** Pick the most meaningful verification command for a repo, if any. */
export function detectCommand(
  profile: RepoProfile | undefined,
  dir?: string,
): { command: string | null; label: string } {
  if (!profile) return { command: null, label: '' };
  const root = dir ?? profile.path;
  const scripts = profile.scripts || {};
  const runner = detectRunner(profile, root);
  const run = (script: string) => `${runner} ${script}`;
  if (scripts.typecheck) return { command: run('typecheck'), label: 'typecheck' };
  if (scripts.build) return { command: run('build'), label: 'build' };
  if (scripts.lint) return { command: run('lint'), label: 'lint' };
  const exec = (name: string) => (process.platform === 'win32' ? `${name}.cmd` : `./${name}`);
  if (fs.existsSync(path.join(root, 'pom.xml'))) {
    const mvn = fs.existsSync(path.join(root, 'mvnw')) ? exec('mvnw') : 'mvn';
    return { command: `${mvn} -q -DskipTests compile`, label: 'mvn compile' };
  }
  if (fs.existsSync(path.join(root, 'build.gradle')) || fs.existsSync(path.join(root, 'build.gradle.kts'))) {
    const gradle = fs.existsSync(path.join(root, 'gradlew')) ? exec('gradlew') : 'gradle';
    return { command: `${gradle} compileJava -q`, label: 'gradle compile' };
  }
  if (fs.existsSync(path.join(root, 'go.mod'))) return { command: 'go build ./...', label: 'go build' };
  return { command: null, label: '' };
}

/** Run the detected build/typecheck for each workspace that declares one. */
export async function runBuildChecks(
  targets: WorkspaceRepo[],
  profiles: Record<string, RepoProfile>,
  opts: {
    onlyRepoIds?: Set<string>;
    timeoutMs?: number;
    onLog?: (level: 'info' | 'tool' | 'warn', message: string) => void;
  } = {},
): Promise<BuildResult[]> {
  const results: BuildResult[] = [];
  for (const ws of targets) {
    if (opts.onlyRepoIds && !opts.onlyRepoIds.has(ws.repo.id)) continue;
    const { command, label } = detectCommand(profiles[ws.repo.id], ws.path);
    if (!command) continue;
    opts.onLog?.('tool', `${ws.repo.name}: 执行 ${command}`);
    const res = await runShell(command, { cwd: ws.path, timeoutMs: opts.timeoutMs ?? 240_000 });
    const output = `${res.stdout}\n${res.stderr}`.trim();
    results.push({
      repoId: ws.repo.id,
      repoName: ws.repo.name,
      label,
      command,
      ok: res.code === 0,
      timedOut: Boolean(res.timedOut),
      output: output.slice(-6000),
    });
    opts.onLog?.(
      res.code === 0 ? 'info' : 'warn',
      `${ws.repo.name}: ${command} ${res.code === 0 ? '通过' : `失败（退出码 ${res.code}）`}`,
    );
  }
  return results;
}

/** Compact failure digest for feeding back to the coding model. */
export function buildFailureDigest(failed: BuildResult[]): string {
  return failed
    .map((r) => {
      // keep the most useful part: errors usually live at the end of the output
      const lines = r.output.split('\n').filter(Boolean);
      const errLines = lines.filter((l) => /error|错误|fail|失败|cannot|not found|expected/i.test(l)).slice(-25);
      const tail = (errLines.length ? errLines : lines.slice(-20)).join('\n').slice(0, 2600);
      return `### ${r.repoName} — \`${r.command}\` 失败（${r.label}${r.timedOut ? '，超时' : ''}）\n\`\`\`\n${tail}\n\`\`\``;
    })
    .join('\n\n');
}
