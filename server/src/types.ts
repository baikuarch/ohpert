export type RepoRole = 'frontend' | 'backend' | 'fullstack' | 'library' | 'mobile' | 'infra' | 'unknown';

export interface RepoRecord {
  id: string;
  path: string;
  name: string;
  role: RepoRole;
  roleSource: 'auto' | 'user';
  stack: string[];
  description: string;
  branch: string;
  addedAt: string;
  lastAnalyzedAt: string | null;
}

export interface SourceFile {
  path: string;
  ext: string;
  size: number;
  lines: number;
  content: string;
  score?: number;
}

export interface RepoProfile {
  id: string;
  path: string;
  name: string;
  role: RepoRole;
  roleSource: 'auto' | 'user';
  languages: Record<string, number>;
  frameworks: string[];
  packageManager: string | null;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  entryPoints: string[];
  apiCalls: ApiCallSite[];
  apiRoutes: ApiRouteSite[];
  envKeys: string[];
  sharedTypes: string[];
  configFiles: string[];
  fileCount: number;
  loc: number;
  branch: string;
  head: string;
  dirty: boolean;
  analyzedAt: string;
  summary: string;
  topTrees: string;
}

export interface ApiCallSite {
  file: string;
  method: string;
  path: string;
  line: number;
}

export interface ApiRouteSite {
  file: string;
  method: string;
  path: string;
  line: number;
  handler?: string;
  /** Path variants including router mount prefixes, e.g. ['/api/auth/login', '/login'] */
  alternates?: string[];
}

export interface RepoLink {
  id: string;
  from: string;
  to: string;
  kind: 'http-api' | 'shared-types' | 'shared-env' | 'npm-package' | 'data-model' | 'same-domain';
  strength: number;
  summary: string;
  evidence: { file: string; line?: number; detail: string }[];
  endpoints?: { method: string; path: string; backendFile?: string; frontendFiles: string[] }[];
}

export interface ArchitectureReport {
  generatedAt: string;
  aiModel: string;
  narrative: string;
  domains: { name: string; description: string; repos: string[] }[];
  links: RepoLink[];
  warnings: string[];
  techSummary: string;
}

export interface RepoSnapshot {
  repos: RepoRecord[];
  profiles: Record<string, RepoProfile>;
  architecture: ArchitectureReport | null;
}

export type JobKind = 'analyze' | 'plan' | 'implement' | 'accept';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TaskJob {
  id: string;
  requirementId: string | null;
  kind: JobKind;
  status: JobStatus;
  progress: number;
  message: string;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface LogEntry {
  id: number;
  jobId: string | null;
  requirementId: string | null;
  repoId: string | null;
  level: 'info' | 'tool' | 'llm' | 'warn' | 'error' | 'success';
  message: string;
  detail?: string | null;
  createdAt: string;
}

export type RequirementStatus =
  | 'draft'
  | 'queued'
  | 'analyzing'
  | 'analyzed'
  | 'implementing'
  | 'implemented'
  | 'accepting'
  | 'awaiting_approval'
  | 'completed'
  | 'needs_rework'
  | 'rejected'
  | 'failed';

export interface RequirementReport {
  summary: string;
  background: string;
  goals: string[];
  acceptanceCriteria: string[];
  impact: {
    repoId: string;
    repoName: string;
    role: RepoRole;
    level: 'high' | 'medium' | 'low';
    reason: string;
    areas: string[];
    files: string[];
  }[];
  apiChanges: {
    method: string;
    path: string;
    description: string;
    repo: string;
    kind: 'new' | 'modified' | 'removed' | string;
  }[];
  dataModelChanges: string[];
  frontendScope: string[];
  backendScope: string[];
  risks: string[];
  testPlan: string[];
  estimates: { repoId: string; repoName: string; files: number; points: number; note: string }[];
  assumptions: string[];
  outOfScope: string[];
  generatedAt?: string;
  aiModel?: string;
  latencyMs?: number;
}

export interface FileChange {
  repoId: string;
  repoName: string;
  file: string;
  kind: 'modified' | 'added' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  patch: string;
  source: 'ai' | 'review-fix';
}

export interface ImplementationRecord {
  startedAt: string;
  finishedAt: string;
  status: 'in_progress' | 'succeeded' | 'failed' | 'canceled';
  repos: { repoId: string; branch: string; baseBranch: string; baseRev: string; headAfter: string | null }[];
  files: FileChange[];
  diffStat: { files: number; additions: number; deletions: number };
  summary: string;
  commands: { command: string; ok: boolean; output: string }[];
  aiModel: string;
  turns: number;
  /** automatic build-failure repair rounds performed by the coding agent */
  repairRounds?: number;
  /** build failures that were still present when the repair budget ran out */
  unresolved?: string[];
}

export interface AcceptanceCheck {
  id: string;
  title: string;
  status: 'pass' | 'warn' | 'fail' | 'skipped';
  detail: string;
  evidence?: string[];
  /** command that was executed for build/typecheck checks */
  command?: string;
}

export interface AcceptanceReport {
  verdict: 'pass' | 'pass_with_notes' | 'fail';
  score: number;
  summary: string;
  checks: AcceptanceCheck[];
  perRepo: { repoId: string; repoName: string; verdict: string; notes: string }[];
  followUps: string[];
  generatedAt: string;
  aiModel: string;
}

export interface Requirement {
  id: string;
  seq: number;
  title: string;
  description: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: RequirementStatus;
  createdAt: string;
  updatedAt: string;
  queuedAt: string | null;
  analyzedAt: string | null;
  implementedAt: string | null;
  completedAt: string | null;
  report: RequirementReport | null;
  implementation: ImplementationRecord | null;
  acceptance: AcceptanceReport | null;
  userConfirmation: {
    confirmedAt: string;
    note: string;
    decision: 'approve' | 'reject';
  } | null;
  reworkRounds: number;
  feedback: { at: string; content: string; by: 'user' | 'ai' }[];
  jobId: string | null;
  error: string | null;
  targetRepos: string[];
}

export interface AiSettings {
  baseURL: string;
  apiKey: string;
  model: string;
  planningModel: string;
  codingModel: string;
  reviewModel: string;
  temperature: number;
  maxTokens: number;
  maxTurns: number;
  source: 'env' | 'settings' | 'none';
}

export interface CommandSettings {
  test: string;
  build: string;
  lint: string;
}
