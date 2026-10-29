import type { BootstrapData, LogEntry, RepoRecord, Requirement, TaskJob } from '../types';

type Json = Record<string, any>;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: text };
  }
  if (!res.ok) throw new Error(json?.error || `请求失败 (${res.status})`);
  return json as T;
}

const post = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown = {}) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown = {}) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

export const api = {
  bootstrap: () => request<BootstrapData>('/bootstrap'),

  // filesystem
  listDirs: (path?: string) =>
    request<{
      path: string;
      parent: string | null;
      entries: { name: string; path: string; isGit: boolean }[];
      roots: string[];
      isGitRepo: boolean;
    }>(`/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  searchDirs: (q: string, base?: string) =>
    request<{ results: { name: string; path: string; isGit: boolean }[]; base: string }>(
      `/fs/search?q=${encodeURIComponent(q)}${base ? `&base=${encodeURIComponent(base)}` : ''}`,
    ),

  // repos
  addRepos: (paths: string[], role?: string) =>
    post<{ added: RepoRecord[]; skipped: { path: string; reason: string }[]; repos: RepoRecord[] }>('/repos', {
      paths,
      role,
    }),
  updateRepo: (id: string, body: { role?: string; name?: string }) => patch<{ repo: RepoRecord }>(`/repos/${id}`, body),
  probeRepo: (id: string) =>
    request<{ ok: boolean; failedAt?: string; message: string; hints: string[]; gitDir?: string; detail?: string }>(
      `/repos/${id}/writable`,
    ),
  removeRepo: (id: string) => del<{ ok: boolean }>(`/repos/${id}`),

  // architecture
  analyzeArchitecture: () => post<{ job: TaskJob }>('/architecture/analyze', {}),

  // requirements
  listRequirements: (scope?: 'active' | 'history') =>
    request<{ requirements: Requirement[]; stats: BootstrapData['stats'] }>(
      `/requirements${scope ? `?scope=${scope}` : ''}`,
    ),
  getRequirement: (id: string) =>
    request<{ requirement: Requirement; jobs: TaskJob[]; logs: LogEntry[] }>(`/requirements/${id}`),
  createRequirement: (body: { title?: string; description: string; priority?: string; enqueue?: boolean }) =>
    post<{ requirement: Requirement }>('/requirements', body),
  updateRequirement: (id: string, body: Json) => patch<{ requirement: Requirement }>(`/requirements/${id}`, body),
  deleteRequirement: (id: string) => del<{ ok: boolean }>(`/requirements/${id}`),
  enqueue: (id: string) => post<{ requirement: Requirement }>(`/requirements/${id}/enqueue`),
  analyze: (id: string) => post<{ job: TaskJob }>(`/requirements/${id}/analyze`),
  implement: (id: string, feedbackNote?: string) =>
    post<{ job: TaskJob }>(`/requirements/${id}/implement`, { feedbackNote }),
  accept: (id: string) => post<{ job: TaskJob }>(`/requirements/${id}/accept`),
  confirm: (id: string, decision: 'approve' | 'reject', note: string) =>
    post<{ requirement: Requirement }>(`/requirements/${id}/confirm`, { decision, note }),
  revert: (id: string) => post<{ requirement: Requirement }>(`/requirements/${id}/revert`),
  addFeedback: (id: string, content: string) =>
    post<{ requirement: Requirement }>(`/requirements/${id}/feedback`, { content }),

  // jobs
  getJob: (id: string) => request<{ job: TaskJob; logs: LogEntry[] }>(`/jobs/${id}`),
  cancelJob: (id: string) => post<{ cancelled: boolean }>(`/jobs/${id}/cancel`),
  logs: (opts: { afterId?: number; requirementId?: string } = {}) =>
    request<{ logs: LogEntry[] }>(
      `/logs?${new URLSearchParams(
        Object.entries(opts)
          .filter(([, v]) => v != null)
          .map(([k, v]) => [k, String(v)]),
      )}`,
    ),

  // settings
  getSettings: () =>
    request<{ ai: BootstrapData['ai']; commands: BootstrapData['settings']['commands']; workspaceRoots: string[] }>(
      '/settings',
    ),
  saveAi: (body: Json) => put<{ ai: BootstrapData['ai'] }>('/settings/ai', body),
  listModels: (opts: { baseURL?: string; apiKey?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.baseURL) qs.set('baseURL', opts.baseURL);
    if (opts.apiKey) qs.set('apiKey', opts.apiKey);
    return request<ModelListResult>(`/settings/ai/models${qs.toString() ? `?${qs}` : ''}`);
  },
  testAi: (body: Json) =>
    post<{ ok: boolean; latencyMs?: number; reply?: string; error?: string; model?: string }>(
      '/settings/ai/test',
      body,
    ),
  saveCommands: (body: Json) => put<{ commands: BootstrapData['settings']['commands'] }>('/settings/commands', body),
  saveRoots: (roots: string[]) => put<{ workspaceRoots: string[] }>('/settings/roots', { roots }),
};

export interface GatewayModel {
  id: string;
  name: string;
  ownedBy?: string;
  contextWindow?: number;
  maxOutput?: number;
  reasoning?: boolean;
  modalities?: string[];
}

export interface ModelListResult {
  ok: boolean;
  baseURL: string;
  models: GatewayModel[];
  error?: string;
  fetchedAt?: string;
}

export interface LiveEvent {
  log?: LogEntry;
  change?: {
    scope: 'repos' | 'requirements' | 'architecture' | 'jobs' | 'settings';
    id?: string;
    job?: TaskJob;
    requirement?: Requirement;
    stats?: import('../types').Stats;
  };
}

/** Subscribe to the server's SSE stream; auto-reconnects with backoff. */
export function openEventStream(onEvent: (e: LiveEvent) => void, getAfterId: () => number) {
  let closed = false;
  let es: EventSource | null = null;
  let retry = 0;

  const connect = () => {
    if (closed) return;
    es = new EventSource(`/api/events?afterId=${getAfterId()}`);
    es.addEventListener('log', (ev) => {
      try {
        onEvent({ log: JSON.parse((ev as MessageEvent).data) });
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('change', (ev) => {
      try {
        onEvent({ change: JSON.parse((ev as MessageEvent).data) });
      } catch {
        /* ignore */
      }
    });
    es.onopen = () => {
      retry = 0;
    };
    es.onerror = () => {
      es?.close();
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 500 * retry);
    };
  };
  connect();

  return () => {
    closed = true;
    es?.close();
  };
}
