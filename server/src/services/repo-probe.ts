import fs from 'node:fs';
import path from 'node:path';
import { git } from '../lib/git.js';
import { repoStore } from '../store/repo-store.js';

export interface WriteProbe {
  ok: boolean;
  /** which capability failed, when ok=false */
  failedAt?: 'missing' | 'not-git' | 'git-dir' | 'objects' | 'refs' | 'lock' | 'worktree';
  message: string;
  /** concrete next steps the user can take */
  hints: string[];
  gitDir?: string;
  detail?: string;
}

const TCC_HINT =
  'macOS「系统设置 → 隐私与安全性 → 完全磁盘访问权限」中为你启动 ohpert 的终端/应用勾选授权，然后重启该终端再重试。';
const ICLOUD_HINT = '该目录可能在 iCloud/iCloud Drive 中，请把仓库移出 iCloud 或设置为“始终保留在本机”。';
const READONLY_HINT = '检查目录是否被挂载为只读、是否属于系统保护目录，或存在阻止写入的安全软件（如某些 EDR）。';
const SANDBOX_HINT = '若 ohpert 以沙箱方式运行（如某些桌面壳），请改用可写目录，或为该应用授予磁盘访问权限。';

function canWriteDir(dir: string): boolean {
  try {
    const probe = path.join(dir, `.ohpert-write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function canCreateChild(dir: string): boolean {
  try {
    const probe = path.join(dir, `.ohpert-probe-${process.pid}`);
    fs.mkdirSync(probe);
    fs.rmdirSync(probe);
    return true;
  } catch {
    return false;
  }
}

function canLockIndex(gitDir: string): boolean {
  const lock = path.join(gitDir, 'index.lock');
  try {
    const fd = fs.openSync(lock, 'wx');
    fs.closeSync(fd);
    fs.unlinkSync(lock);
    return true;
  } catch {
    return false;
  }
}

function isUnderICloud(p: string) {
  return /\/Library\/Mobile Documents|\/iCloud/i.test(p);
}

function isUnderTCCManaged(p: string) {
  // folders macOS guards by default (Documents / Desktop / Downloads / removable volumes)
  return (
    /^\/(Users\/[^/]+\/(Documents|Desktop|Downloads))/.test(p) ||
    /^\/Volumes\//.test(p) ||
    /^\/(System|Library|Applications|private)\//.test(p)
  );
}

/**
 * Probe whether ohpert can actually create a branch / worktree in a repo.
 * The check is cheap and side-effect free, so the UI can offer a "re-check" button.
 */
export async function probeRepoWrite(repoId: string): Promise<WriteProbe> {
  const repo = repoStore.get(repoId);
  if (!repo) return { ok: false, failedAt: 'missing', message: '工程不存在', hints: [] };
  const root = repo.path;
  if (!fs.existsSync(root)) {
    return {
      ok: false,
      failedAt: 'missing',
      message: `工程目录不存在：${root}`,
      hints: ['该目录可能已被移动或删除，请移除后重新添加。'],
    };
  }
  if (!fs.existsSync(path.join(root, '.git'))) {
    return {
      ok: false,
      failedAt: 'not-git',
      message: '该目录不是 Git 仓库根目录',
      hints: ['请选择包含 .git 的工程根目录。'],
    };
  }

  const gitDirRes = await git(root, ['rev-parse', '--absolute-git-dir']);
  const gitDir = gitDirRes.code === 0 ? gitDirRes.stdout.trim() : path.join(root, '.git');

  const base = { gitDir };
  if (!canWriteDir(gitDir)) {
    return {
      ok: false,
      failedAt: 'git-dir',
      message: `无法写入 ${gitDir}`,
      detail: 'ohpert 需要在 .git 内创建分支引用、index.lock 和 worktree 元数据。',
      hints: [
        isUnderTCCManaged(root) || isUnderTCCManaged(gitDir) ? TCC_HINT : READONLY_HINT,
        isUnderICloud(root) ? ICLOUD_HINT : SANDBOX_HINT,
        '或把仓库复制/移动到一个普通的可写目录（例如 ~/Projects 下新建的目录），再在 ohpert 中重新添加。',
      ],
      ...base,
    };
  }
  if (!fs.existsSync(path.join(gitDir, 'refs')) || !canCreateChild(path.join(gitDir, 'refs', 'heads'))) {
    return {
      ok: false,
      failedAt: 'refs',
      message: `无法在 ${path.join(gitDir, 'refs', 'heads')} 下创建分支引用`,
      detail: '创建分支需要的目录写入被拒绝。',
      hints: [READONLY_HINT, TCC_HINT],
      ...base,
    };
  }
  if (!fs.existsSync(path.join(gitDir, 'objects')) || !canCreateChild(path.join(gitDir, 'objects'))) {
    return {
      ok: false,
      failedAt: 'objects',
      message: `无法写入 ${path.join(gitDir, 'objects')}`,
      detail: 'worktree 检出需要写入对象库。',
      hints: [READONLY_HINT, TCC_HINT],
      ...base,
    };
  }
  if (!canLockIndex(gitDir)) {
    return {
      ok: false,
      failedAt: 'lock',
      message: `无法创建 ${path.join(gitDir, 'index.lock')}`,
      detail: '可能存在残留的 index.lock 或该文件被占用。',
      hints: [
        `检查并删除残留锁文件：rm -f "${path.join(gitDir, 'index.lock')}"（确认没有其他 git 进程在运行后再删）。`,
        '关闭正在占用该仓库的 IDE/命令行 git 操作后重试。',
      ],
      ...base,
    };
  }
  // last check: can git itself create a throwaway worktree?
  const tmp = path.join(gitDir, '..', `.ohpert-wt-probe-${process.pid}`);
  const wt = await git(root, ['worktree', 'add', '--detach', tmp, 'HEAD'], 60_000);
  if (wt.code !== 0) {
    await git(root, ['worktree', 'remove', '--force', tmp]);
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      failedAt: 'worktree',
      message: 'git worktree 创建失败',
      detail: (wt.stderr || wt.stdout).trim().slice(0, 400),
      hints: [
        '运行 `git worktree prune` 清理失效的 worktree 记录后重试。',
        '确认仓库不是“裸仓库/浅克隆”且磁盘空间充足。',
      ],
      ...base,
    };
  }
  await git(root, ['worktree', 'remove', '--force', tmp]);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  return { ok: true, message: '可以正常创建平台分支与工作区', hints: [], ...base };
}
