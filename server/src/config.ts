import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..', '..');

export const DATA_DIR = process.env.OHPERT_DATA_DIR
  ? path.resolve(process.env.OHPERT_DATA_DIR)
  : path.join(ROOT, '.data');

export const WORKSPACE_DIR = path.join(DATA_DIR, 'workspaces');
export const DB_FILE = path.join(DATA_DIR, 'ohpert.db');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const WEB_DIST = path.join(ROOT, 'web', 'dist');

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ensureDir(DATA_DIR);
ensureDir(WORKSPACE_DIR);

// The data dir holds the SQLite DB (requirement code diffs), settings.json with
// the LLM API key, and temporary worktrees: keep it private to the current user.
try {
  fs.chmodSync(DATA_DIR, 0o700);
  fs.chmodSync(WORKSPACE_DIR, 0o700);
} catch {
  /* best effort on filesystems without POSIX permissions */
}

export const PORT = Number(process.env.PORT || 5274);

export const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.idea',
  '.vscode',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.parcel-cache',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  'bin',
  'obj',
  '.gradle',
  'Pods',
  '.dart_tool',
  '.angular',
  '.svelte-kit',
  '.output',
  'tmp',
  'logs',
]);

export const TEXT_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.groovy',
  '.py',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.cs',
  '.fs',
  '.swift',
  '.m',
  '.mm',
  '.dart',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.proto',
  '.graphql',
  '.gql',
  '.sql',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.env',
  '.properties',
  '.md',
  '.mdx',
  '.txt',
  '.sh',
  '.bash',
  '.zsh',
  '.xml',
  '.html',
  '.css',
  '.scss',
  '.less',
]);

export const BINARY_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.jar',
  '.class',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp4',
  '.mp3',
  '.wav',
  '.lockb',
  '.sqlite',
  '.db',
  '.DS_Store',
]);
