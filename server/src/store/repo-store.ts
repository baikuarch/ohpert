import { db, now } from './db.js';
import type { RepoRecord, RepoProfile, Requirement, TaskJob, LogEntry, ArchitectureReport } from '../types.js';

type Row = Record<string, any>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function rowToRepo(r: Row): RepoRecord {
  const profile = parseJson<RepoProfile | null>(r.profile, null);
  return {
    id: r.id,
    path: r.path,
    name: r.name,
    role: r.role === 'unknown' && profile ? profile.role : r.role,
    roleSource: r.role_source,
    description: r.description || '',
    stack: profile?.frameworks?.length
      ? profile.frameworks
      : profile?.languages
        ? Object.keys(profile.languages).slice(0, 4)
        : [],
    branch: profile?.branch || '',
    addedAt: r.added_at,
    lastAnalyzedAt: r.last_analyzed_at,
  };
}

export const repoStore = {
  list(): RepoRecord[] {
    return (db.prepare('SELECT * FROM repos ORDER BY added_at ASC').all() as Row[]).map(rowToRepo);
  },
  get(id: string): RepoRecord | null {
    const r = db.prepare('SELECT * FROM repos WHERE id=?').get(id) as Row | undefined;
    return r ? rowToRepo(r) : null;
  },
  getProfile(id: string): RepoProfile | null {
    const r = db.prepare('SELECT profile FROM repos WHERE id=?').get(id) as Row | undefined;
    return r ? parseJson<RepoProfile | null>(r.profile, null) : null;
  },
  allProfiles(): Record<string, RepoProfile> {
    const rows = db.prepare('SELECT id, profile FROM repos').all() as Row[];
    const out: Record<string, RepoProfile> = {};
    for (const r of rows) {
      if (r.profile) out[r.id] = parseJson<RepoProfile>(r.profile, null as any);
    }
    return out;
  },
  upsert(repo: RepoRecord, profile?: RepoProfile | null) {
    const exists = db.prepare('SELECT id FROM repos WHERE id=?').get(repo.id);
    if (exists) {
      db.prepare(
        `UPDATE repos SET path=?, name=?, role=?, role_source=?, description=?, added_at=?, last_analyzed_at=? WHERE id=?`,
      ).run(
        repo.path,
        repo.name,
        repo.role,
        repo.roleSource,
        repo.description,
        repo.addedAt,
        repo.lastAnalyzedAt,
        repo.id,
      );
    } else {
      db.prepare(
        `INSERT INTO repos (id, path, name, role, role_source, description, added_at, last_analyzed_at) VALUES (?,?,?,?,?,?,?,?)`,
      ).run(
        repo.id,
        repo.path,
        repo.name,
        repo.role,
        repo.roleSource,
        repo.description,
        repo.addedAt,
        repo.lastAnalyzedAt,
      );
    }
    if (profile !== undefined) this.saveProfile(repo.id, profile);
  },
  saveProfile(id: string, profile: RepoProfile | null) {
    db.prepare('UPDATE repos SET profile=?, last_analyzed_at=? WHERE id=?').run(
      profile ? JSON.stringify(profile) : null,
      profile ? profile.analyzedAt || now() : null,
      id,
    );
  },
  setRole(id: string, role: string) {
    db.prepare('UPDATE repos SET role=?, role_source=? WHERE id=?').run(role, 'user', id);
  },
  setRoleSource(id: string, role: string, source: 'auto' | 'user') {
    db.prepare('UPDATE repos SET role=?, role_source=? WHERE id=?').run(role, source, id);
  },
  remove(id: string) {
    db.prepare('DELETE FROM repos WHERE id=?').run(id);
  },
};

export const archStore = {
  get(): ArchitectureReport | null {
    const r = db.prepare('SELECT report FROM architecture WHERE id=1').get() as Row | undefined;
    return r ? parseJson<ArchitectureReport | null>(r.report, null) : null;
  },
  save(report: ArchitectureReport) {
    db.prepare(
      `INSERT INTO architecture (id, report, generated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET report=excluded.report, generated_at=excluded.generated_at`,
    ).run(JSON.stringify(report), report.generatedAt);
  },
  clear() {
    db.prepare('DELETE FROM architecture WHERE id=1').run();
  },
};

function rowToRequirement(r: Row): Requirement {
  return {
    id: r.id,
    seq: r.seq,
    title: r.title,
    description: r.description,
    priority: r.priority,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    queuedAt: r.queued_at,
    analyzedAt: r.analyzed_at,
    implementedAt: r.implemented_at,
    completedAt: r.completed_at,
    report: parseJson(r.report, null),
    implementation: parseJson(r.implementation, null),
    acceptance: parseJson(r.acceptance, null),
    userConfirmation: parseJson(r.confirmation, null),
    reworkRounds: r.rework_rounds || 0,
    feedback: parseJson(r.feedback, []),
    jobId: r.job_id || null,
    error: r.error || null,
    targetRepos: parseJson(r.target_repos, []),
  };
}

export const requirementStore = {
  list(statuses?: string[]): Requirement[] {
    const rows = statuses?.length
      ? (db
          .prepare(
            `SELECT * FROM requirements WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY seq DESC`,
          )
          .all(...statuses) as Row[])
      : (db.prepare('SELECT * FROM requirements ORDER BY seq DESC').all() as Row[]);
    return rows.map(rowToRequirement);
  },
  get(id: string): Requirement | null {
    const r = db.prepare('SELECT * FROM requirements WHERE id=?').get(id) as Row | undefined;
    return r ? rowToRequirement(r) : null;
  },
  nextSeq(): number {
    const r = db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM requirements').get() as Row;
    return Number(r.m) + 1;
  },
  create(req: Requirement) {
    db.prepare(
      `INSERT INTO requirements (id, seq, title, description, priority, status, created_at, updated_at, queued_at, target_repos, feedback, rework_rounds)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      req.id,
      req.seq,
      req.title,
      req.description,
      req.priority,
      req.status,
      req.createdAt,
      req.updatedAt,
      req.queuedAt,
      JSON.stringify(req.targetRepos),
      JSON.stringify(req.feedback || []),
      req.reworkRounds || 0,
    );
  },
  patch(id: string, patch: Partial<Requirement>) {
    const cur = this.get(id);
    if (!cur) return null;
    const next: Requirement = { ...cur, ...patch, updatedAt: now() };
    db.prepare(
      `UPDATE requirements SET title=?, description=?, priority=?, status=?, updated_at=?, queued_at=?, analyzed_at=?, implemented_at=?, completed_at=?,
       report=?, implementation=?, acceptance=?, confirmation=?, rework_rounds=?, feedback=?, job_id=?, error=?, target_repos=? WHERE id=?`,
    ).run(
      next.title,
      next.description,
      next.priority,
      next.status,
      next.updatedAt,
      next.queuedAt,
      next.analyzedAt,
      next.implementedAt,
      next.completedAt,
      next.report ? JSON.stringify(next.report) : null,
      next.implementation ? JSON.stringify(next.implementation) : null,
      next.acceptance ? JSON.stringify(next.acceptance) : null,
      next.userConfirmation ? JSON.stringify(next.userConfirmation) : null,
      next.reworkRounds,
      JSON.stringify(next.feedback || []),
      next.jobId,
      next.error,
      JSON.stringify(next.targetRepos || []),
      id,
    );
    return next;
  },
  remove(id: string) {
    db.prepare('DELETE FROM requirements WHERE id=?').run(id);
  },
};

function rowToJob(r: Row): TaskJob {
  return {
    id: r.id,
    requirementId: r.requirement_id,
    kind: r.kind,
    status: r.status,
    progress: r.progress,
    message: r.message,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
  };
}

export const jobStore = {
  list(limit = 40): TaskJob[] {
    return (db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(rowToJob);
  },
  get(id: string): TaskJob | null {
    const r = db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as Row | undefined;
    return r ? rowToJob(r) : null;
  },
  forRequirement(reqId: string): TaskJob[] {
    return (db.prepare('SELECT * FROM jobs WHERE requirement_id=? ORDER BY created_at DESC').all(reqId) as Row[]).map(
      rowToJob,
    );
  },
  create(job: TaskJob) {
    db.prepare(
      'INSERT INTO jobs (id, requirement_id, kind, status, progress, message, error, started_at, finished_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(
      job.id,
      job.requirementId,
      job.kind,
      job.status,
      job.progress,
      job.message,
      job.error,
      job.startedAt,
      job.finishedAt,
      job.createdAt,
    );
  },
  update(id: string, patch: Partial<TaskJob>) {
    const cur = this.get(id);
    if (!cur) return;
    const n = { ...cur, ...patch };
    db.prepare('UPDATE jobs SET status=?, progress=?, message=?, error=?, started_at=?, finished_at=? WHERE id=?').run(
      n.status,
      n.progress,
      n.message,
      n.error,
      n.startedAt,
      n.finishedAt,
      id,
    );
  },
};

/** Keep the log table bounded; a long-lived install otherwise grows forever. */
const LOG_RETENTION = 20_000;
const LOG_PRUNE_EVERY = 100;
let logsSincePrune = 0;

export const logStore = {
  add(entry: Omit<LogEntry, 'id' | 'createdAt'>): LogEntry {
    const ts = now();
    const info = db
      .prepare(
        'INSERT INTO logs (job_id, requirement_id, repo_id, level, message, detail, created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        entry.jobId ?? null,
        entry.requirementId ?? null,
        entry.repoId ?? null,
        entry.level,
        entry.message,
        entry.detail ?? null,
        ts,
      );
    if (++logsSincePrune >= LOG_PRUNE_EVERY) {
      logsSincePrune = 0;
      try {
        this.prune();
      } catch {
        /* pruning must never break logging */
      }
    }
    return { ...entry, id: Number(info.lastInsertRowid), createdAt: ts };
  },
  /** Delete all but the newest `keep` rows. Returns how many were removed. */
  prune(keep = LOG_RETENTION): number {
    const cutoff = db.prepare('SELECT id FROM logs ORDER BY id DESC LIMIT 1 OFFSET ?').get(keep) as Row | undefined;
    if (!cutoff) return 0;
    const info = db.prepare('DELETE FROM logs WHERE id <= ?').run(cutoff.id);
    return Number(info.changes) || 0;
  },
  list(opts: { requirementId?: string; jobId?: string; afterId?: number; limit?: number }): LogEntry[] {
    const limit = Math.min(opts.limit ?? 300, 1000);
    const where: string[] = [];
    const params: any[] = [];
    if (opts.requirementId) {
      where.push('requirement_id=?');
      params.push(opts.requirementId);
    }
    if (opts.jobId) {
      where.push('job_id=?');
      params.push(opts.jobId);
    }
    if (opts.afterId) {
      where.push('id>?');
      params.push(opts.afterId);
    }
    const sql = `SELECT * FROM logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, limit) as Row[];
    return rows
      .map((r) => ({
        id: r.id,
        jobId: r.job_id,
        requirementId: r.requirement_id,
        repoId: r.repo_id,
        level: r.level,
        message: r.message,
        detail: r.detail,
        createdAt: r.created_at,
      }))
      .reverse();
  },
};
