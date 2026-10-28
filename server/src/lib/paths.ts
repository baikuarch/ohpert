import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve the real path of the nearest existing ancestor.
 *
 * `fs.realpathSync` fails for files that do not exist yet (e.g. a file the agent
 * is about to create), so walk up until we hit something real and append the
 * missing tail again. This is what catches symlinks that point outside a repo.
 */
export function realpathNearest(target: string, seen: Set<string> = new Set()): string {
  let cur = path.resolve(target);
  const missing: string[] = [];
  while (true) {
    if (seen.has(cur)) return path.resolve(target); // symlink loop
    seen.add(cur);
    try {
      const real = fs.realpathSync(cur);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch {
      // A dangling symlink also fails realpathSync. Follow it manually so a
      // symlink pointing outside the repo cannot be used to create that file.
      try {
        if (fs.lstatSync(cur).isSymbolicLink()) {
          const link = fs.readlinkSync(cur);
          const realTarget = realpathNearest(path.resolve(path.dirname(cur), link), seen);
          return missing.length ? path.join(realTarget, ...missing.reverse()) : realTarget;
        }
      } catch {
        /* not a symlink / unreadable */
      }
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(target);
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** True when `target` is the same as, or nested inside, `root`. */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve `rel` inside `root` and refuse anything that escapes it - including
 * via `..` segments or symlinks whose real target lives outside the repo.
 */
export function resolveInside(root: string, rel: string): string {
  const rootReal = realpathNearest(root);
  const clean = rel.replace(/^[\\/]+/, '');
  const abs = path.resolve(rootReal, clean);
  if (!isInside(rootReal, abs)) {
    throw new Error(`路径越界，禁止访问工程根目录之外的路径: ${rel}`);
  }
  const real = realpathNearest(abs);
  if (!isInside(rootReal, real)) {
    throw new Error(`路径越界，禁止通过符号链接访问工程根目录之外的路径: ${rel}`);
  }
  return abs;
}
