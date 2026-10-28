import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from '../config.js';
import { git } from '../lib/git.js';
import { now } from '../store/db.js';
import { archStore, repoStore, requirementStore } from '../store/repo-store.js';
import type { ArchitectureReport, RepoProfile, RepoRecord, Requirement } from '../types.js';

const DEMO_FILE = path.join(ROOT, 'server', 'demo', 'sample-demo.json');
const SAMPLES_DIR = path.join(ROOT, 'samples');
const DEMO_REPOS_DIR = path.join(DATA_DIR, 'demo-repos');

interface DemoFile {
  repos: { name: string; role: RepoRecord['role'] }[];
  architecture: ArchitectureReport | null;
  requirements: Requirement[];
}

/** Rewrite the stable demo ids (demo-<name>) onto ids that exist in *this* install. */
function remapIds<T>(value: T, idMap: Record<string, string>): T {
  let s = JSON.stringify(value);
  for (const [demoId, realId] of Object.entries(idMap)) s = s.split(demoId).join(realId);
  return JSON.parse(s) as T;
}

function emptyProfile(rec: RepoRecord): RepoProfile {
  return {
    id: rec.id,
    path: rec.path,
    name: rec.name,
    role: rec.role,
    roleSource: 'auto',
    languages: {},
    frameworks: [],
    packageManager: null,
    scripts: {},
    dependencies: {},
    devDependencies: {},
    entryPoints: [],
    apiCalls: [],
    apiRoutes: [],
    envKeys: [],
    sharedTypes: [],
    configFiles: [],
    fileCount: 0,
    loc: 0,
    branch: 'main',
    head: '',
    dirty: false,
    analyzedAt: now(),
    summary: '示例工程（点击「重新分析架构」可重新扫描真实代码）',
    topTrees: '',
  };
}

/**
 * Copy a bundled sample into the private data directory and give it a local Git
 * history. The published `samples/` tree stays a plain directory (no nested
 * `.git`), while the demo still supports branches, worktrees and diffs.
 */
async function materializeDemoRepo(name: string): Promise<string | null> {
  const src = path.join(SAMPLES_DIR, name);
  if (!fs.existsSync(src)) return null;
  const dest = path.join(DEMO_REPOS_DIR, name);
  if (fs.existsSync(path.join(dest, '.git'))) return dest;

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(DEMO_REPOS_DIR, { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p);
      return !rel.split(path.sep).some((part) => part === '.git' || part === 'node_modules');
    },
  });

  const init = await git(dest, ['init', '-b', 'main']);
  if (init.code !== 0) throw new Error(`无法初始化演示工程 ${name}：${init.stderr || init.stdout}`);
  const add = await git(dest, ['add', '-A']);
  if (add.code !== 0) throw new Error(`无法暂存演示工程 ${name}：${add.stderr || add.stdout}`);
  const commit = await git(dest, [
    '-c',
    'user.name=ohpert Demo',
    '-c',
    'user.email=demo@ohpert.local',
    'commit',
    '--no-gpg-sign',
    '-m',
    'chore: initial demo snapshot',
  ]);
  if (commit.code !== 0) throw new Error(`无法提交演示工程 ${name}：${commit.stderr || commit.stdout}`);
  return dest;
}

/**
 * Seed this install with the bundled demo: registers copies of ./samples/*,
 * attaches a pre-computed architecture report and example requirements (one
 * finished, one mid-flight) so the UI can be explored before configuring an API key.
 */
export async function seedDemo(opts: { force?: boolean } = {}) {
  if (!fs.existsSync(DEMO_FILE)) throw new Error('演示数据缺失：server/demo/sample-demo.json');
  const demo = JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8')) as DemoFile;
  const idMap: Record<string, string> = {};
  const added: string[] = [];

  for (const entry of demo.repos) {
    const dir = await materializeDemoRepo(entry.name);
    if (!dir) continue;
    const already = repoStore.list().find((r) => r.path === dir);
    if (already) {
      idMap[`demo-${entry.name}`] = already.id;
      continue;
    }
    const rec: RepoRecord = {
      id: `repo_demo_${entry.name.replace(/[^a-z0-9]/gi, '').slice(0, 10)}`,
      path: dir,
      name: entry.name,
      role: entry.role,
      roleSource: 'auto',
      description: '自带示例工程',
      stack: [],
      branch: 'main',
      addedAt: now(),
      lastAnalyzedAt: null,
    };
    repoStore.upsert(rec, null);
    added.push(entry.name);
    idMap[`demo-${entry.name}`] = rec.id;
  }

  for (const rec of repoStore.list()) idMap[`demo-${rec.name}`] = rec.id;

  for (const rec of repoStore.list()) {
    if (!repoStore.getProfile(rec.id)) repoStore.saveProfile(rec.id, emptyProfile(rec));
  }

  if (demo.architecture && (!archStore.get() || opts.force)) {
    archStore.save(remapIds(demo.architecture, idMap));
  }

  if (opts.force || !requirementStore.list().length) {
    let seq = requirementStore.nextSeq();
    for (const req of demo.requirements) {
      if (requirementStore.get(req.id)) continue;
      const remapped = remapIds(req, idMap);
      requirementStore.create({ ...remapped, seq: seq++ });
      // persist the rich JSON columns (report / implementation / acceptance …)
      requirementStore.patch(remapped.id, remapped);
    }
  }

  return { added, idMap };
}
