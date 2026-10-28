import { normalizeEndpoint } from './endpoint.js';

/**
 * API-contract verification helper.
 *
 * Each repo gets its own text corpus. A declared endpoint must be found in one
 * of the repos it actually belongs to, instead of a single global blob where a
 * frontend call could satisfy a backend requirement (or vice versa).
 */

export interface ApiChange {
  method: string;
  path: string;
  repo?: string;
}

export interface CorpusTarget {
  repoId: string;
  repoName: string;
}

export interface ApiChangeMatch {
  repoId: string;
  repoName: string;
  matched: string;
}

function contains(blob: string, needle: string): boolean {
  if (!needle || needle.length < 4) return false;
  const n = needle.toLowerCase();
  if (blob.includes(n)) return true;
  const stripped = n.replace(/^\/(api|v\d)\//, '/');
  return stripped !== n && blob.includes(stripped);
}

/** Does the `repo` field of a declared change refer to this repo? */
export function repoMatchesField(repoField: string | undefined, repoName: string): boolean {
  if (!repoField?.trim()) return false;
  const name = repoName.toLowerCase();
  const parts = repoField
    .toLowerCase()
    .split(/[\/,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.some((p) => p === name || p.includes(name) || name.includes(p));
}

/**
 * Find which repo implements a declared API change.
 *
 * `pool` should already be narrowed by the change's `repo` field when possible;
 * otherwise all target repos are considered.
 */
export function matchDeclaredApiChange(
  corpus: Map<string, string>,
  change: ApiChange,
  pool: CorpusTarget[],
): ApiChangeMatch | null {
  const norm = normalizeEndpoint(change.path);
  const segs = norm.split('/').filter(Boolean);
  const tail = segs.slice(-1)[0] ?? '';
  const strong = [
    `${change.method} ${change.path}`,
    `${change.method.toLowerCase()} ${change.path.toLowerCase()}`,
    change.path,
    norm,
    ...(segs.length >= 2 ? ['/' + segs.slice(-2).join('/')] : []),
  ];
  const weak = tail.length >= 4 ? [tail] : [];

  for (const target of pool) {
    const blob = (corpus.get(target.repoId) ?? '').toLowerCase();
    if (!blob) continue;
    const matched = strong.find((needle) => contains(blob, needle)) ?? weak.find((needle) => contains(blob, needle));
    if (matched) return { repoId: target.repoId, repoName: target.repoName, matched };
  }
  return null;
}
