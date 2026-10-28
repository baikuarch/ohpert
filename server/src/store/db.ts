import { DatabaseSync } from 'node:sqlite';
import { DB_FILE } from '../config.js';

export const db = new DatabaseSync(DB_FILE);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'unknown',
  role_source TEXT NOT NULL DEFAULT 'auto',
  description TEXT NOT NULL DEFAULT '',
  profile TEXT,
  added_at TEXT NOT NULL,
  last_analyzed_at TEXT
);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  queued_at TEXT,
  analyzed_at TEXT,
  implemented_at TEXT,
  completed_at TEXT,
  report TEXT,
  implementation TEXT,
  acceptance TEXT,
  confirmation TEXT,
  rework_rounds INTEGER NOT NULL DEFAULT 0,
  feedback TEXT NOT NULL DEFAULT '[]',
  job_id TEXT,
  error TEXT,
  target_repos TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS architecture (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  report TEXT NOT NULL,
  generated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  requirement_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  requirement_id TEXT,
  repo_id TEXT,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_req_status ON requirements(status, seq);
CREATE INDEX IF NOT EXISTS idx_logs_job ON logs(job_id, id);
CREATE INDEX IF NOT EXISTS idx_logs_req ON logs(requirement_id, id);
CREATE INDEX IF NOT EXISTS idx_jobs_req ON jobs(requirement_id, created_at);
`);

export function now() {
  return new Date().toISOString();
}

/** Crash recovery: things left 'running' from a previous process are stale. */
export function recoverStaleState(): { released: string[] } {
  const ts = now();
  // requirements that were mid-flight when the process died
  const stuck = db
    .prepare(`SELECT id FROM requirements WHERE status IN ('analyzing','implementing','accepting')`)
    .all() as { id: string }[];
  db.prepare(
    `UPDATE jobs SET status='failed', error='服务重启，任务已中断', finished_at=? WHERE status IN ('queued','running')`,
  ).run(ts);
  db.prepare(
    `UPDATE requirements SET status='needs_rework', error='服务重启导致任务中断，请重新执行', updated_at=?
     WHERE status IN ('analyzing','implementing','accepting')`,
  ).run(ts);
  return { released: stuck.map((r) => r.id) };
}
