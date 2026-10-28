import { EventEmitter } from 'node:events';
import type { LogEntry } from '../types.js';
import { logStore } from '../store/repo-store.js';

type Events = {
  log: LogEntry;
  change: { scope: 'repos' | 'requirements' | 'architecture' | 'jobs' | 'settings'; id?: string };
};

class Bus extends EventEmitter {
  private ring: LogEntry[] = [];
  private changeSubs = new Set<(e: Events['change']) => void>();
  private logSubs = new Set<(e: LogEntry) => void>();

  log(entry: Omit<LogEntry, 'id' | 'createdAt'>) {
    const saved = logStore.add(entry);
    this.ring.push(saved);
    if (this.ring.length > 500) this.ring.shift();
    this.emit('log', saved);
    for (const fn of this.logSubs) fn(saved);
    return saved;
  }

  recent(limit = 200) {
    return this.ring.slice(-limit);
  }

  onChange(fn: (e: Events['change']) => void) {
    this.changeSubs.add(fn);
    return () => this.changeSubs.delete(fn);
  }

  onLog(fn: (e: LogEntry) => void) {
    this.logSubs.add(fn);
    return () => this.logSubs.delete(fn);
  }

  change(scope: Events['change']['scope'], id?: string) {
    for (const fn of this.changeSubs) fn({ scope, id });
  }
}

export const bus = new Bus();

export function log(
  level: LogEntry['level'],
  message: string,
  opts: { jobId?: string | null; requirementId?: string | null; repoId?: string | null; detail?: string | null } = {},
) {
  const entry = bus.log({
    level,
    message,
    jobId: opts.jobId ?? null,
    requirementId: opts.requirementId ?? null,
    repoId: opts.repoId ?? null,
    detail: opts.detail ?? null,
  });
  const prefix = `[${level}]`;
  console.log(prefix, message.slice(0, 200));
  return entry;
}
