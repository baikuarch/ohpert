import fs from 'node:fs';
import path from 'node:path';
import { IGNORE_DIRS, TEXT_EXTS, BINARY_EXTS } from '../config.js';
import type { SourceFile } from '../types.js';

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.vue': 'Vue',
  '.svelte': 'Svelte',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.scala': 'Scala',
  '.groovy': 'Groovy',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.fs': 'F#',
  '.swift': 'Swift',
  '.dart': 'Dart',
  '.c': 'C',
  '.h': 'C',
  '.cc': 'C++',
  '.cpp': 'C++',
  '.hpp': 'C++',
  '.sql': 'SQL',
  '.proto': 'Protobuf',
  '.graphql': 'GraphQL',
  '.gql': 'GraphQL',
};

export function languageOf(p: string): string | null {
  return LANGUAGE_BY_EXT[path.extname(p).toLowerCase()] ?? null;
}

export function isTextFile(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  const base = path.basename(p);
  if (BINARY_EXTS.has(ext)) return false;
  if (TEXT_EXTS.has(ext)) return true;
  return ['Dockerfile', 'Makefile', 'Procfile', '.env.example', 'go.mod', 'pom.xml'].includes(base);
}

function shouldSkipDir(name: string): boolean {
  return IGNORE_DIRS.has(name) || name.startsWith('.');
}

export interface WalkOptions {
  maxFiles?: number;
  maxDepth?: number;
  includeHidden?: boolean;
  exts?: Set<string>;
}

/** Walk a repository tree, skipping build outputs / VCS / dependency folders. */
export function walkFiles(root: string, opts: WalkOptions = {}): string[] {
  const maxFiles = opts.maxFiles ?? 100_000;
  const maxDepth = opts.maxDepth ?? 24;
  const out: string[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length && out.length < maxFiles) {
    const { dir, depth } = stack.pop()!;
    if (depth > maxDepth) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (shouldSkipDir(e.name)) continue;
        stack.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        if (opts.exts && !opts.exts.has(path.extname(e.name).toLowerCase())) continue;
        if (!isTextFile(full)) continue;
        try {
          const st = fs.statSync(full);
          if (st.size > 1_500_000) continue;
        } catch {
          continue;
        }
        out.push(full);
        if (out.length >= maxFiles) break;
      }
    }
  }
  return out;
}

export function relOf(root: string, full: string) {
  return path.relative(root, full).split(path.sep).join('/');
}

export function readSource(root: string, rel: string, maxBytes = 400_000): SourceFile | null {
  const full = path.join(root, rel);
  try {
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > maxBytes) return null;
    const content = fs.readFileSync(full, 'utf8');
    return {
      path: rel,
      ext: path.extname(rel).toLowerCase(),
      size: st.size,
      lines: content.split('\n').length,
      content,
    };
  } catch {
    return null;
  }
}

export function searchFiles(
  root: string,
  pattern: RegExp,
  opts: { exts?: Set<string>; maxResults?: number; maxFiles?: number } = {},
): { file: string; line: number; text: string }[] {
  const files = walkFiles(root, { exts: opts.exts, maxFiles: opts.maxFiles ?? 6000 });
  const results: { file: string; line: number; text: string }[] = [];
  const maxResults = opts.maxResults ?? 200;
  for (const full of files) {
    let content: string;
    try {
      const st = fs.statSync(full);
      if (st.size > 500_000) continue;
      content = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (!pattern.test(content)) continue;
    const rel = relOf(root, full);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[i])) {
        results.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 300) });
        if (results.length >= maxResults) return results;
      }
    }
  }
  return results;
}

/** Grep a file list for a regex, returning matches with context. */
export function grepFiles(
  root: string,
  files: string[],
  pattern: RegExp,
  opts: { maxResults?: number; maxFiles?: number } = {},
): { file: string; line: number; text: string }[] {
  const maxResults = opts.maxResults ?? 300;
  const maxFiles = opts.maxFiles ?? 8000;
  const out: { file: string; line: number; text: string }[] = [];
  for (const rel of files.slice(0, maxFiles)) {
    const full = path.join(root, rel);
    let content: string;
    try {
      const st = fs.statSync(full);
      if (st.size > 500_000) continue;
      content = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (!content.includes(pattern.source.replace(/\\/g, '').slice(0, 6))) {
      // cheap pre-filter may miss complex regexes; fall through to real test
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      pattern.lastIndex = 0;
      if (pattern.test(lines[i])) {
        out.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 260) });
        if (out.length >= maxResults) return out;
      }
    }
  }
  return out;
}

export function countLoc(files: SourceFile[]) {
  return files.reduce((a, f) => a + f.lines, 0);
}

export function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [已截断，共 ${text.length} 字符]`;
}
