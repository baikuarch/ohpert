import { randomBytes } from 'node:crypto';

export function id(prefix = ''): string {
  const r = randomBytes(6).toString('hex');
  return prefix ? `${prefix}_${r}` : r;
}

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function normalizePath(p: string) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

export function basename(p: string) {
  const parts = normalizePath(p).split('/');
  return parts[parts.length - 1] || p;
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

export function shortSha(sha: string) {
  return sha.slice(0, 8);
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Unicode-safe truncation for prompt budgets. */
export function budget(text: string, maxChars: number, label = '…'): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n${label}`;
}
