import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, openEventStream } from '../lib/api';
import type {
  ArchitectureReport,
  BootstrapData,
  LogEntry,
  RepoRecord,
  RepoProfile,
  Requirement,
  Stats,
  TaskJob,
} from '../types';

export type View = 'workspace' | 'requirements' | 'requirement' | 'history' | 'settings';

interface AppState {
  ready: boolean;
  error: string | null;
  repos: RepoRecord[];
  profiles: Record<string, RepoProfile>;
  architecture: ArchitectureReport | null;
  requirements: Requirement[];
  jobs: TaskJob[];
  logs: LogEntry[];
  stats: Stats;
  ai: BootstrapData['ai'];
  settings: BootstrapData['settings'];
  commands: BootstrapData['settings']['commands'];
  view: View;
  selectedRequirementId: string | null;
  connected: boolean;
  toast: { id: number; kind: 'ok' | 'err' | 'info'; message: string } | null;
  // actions
  refresh: () => Promise<void>;
  go: (view: View, requirementId?: string | null) => void;
  notify: (kind: 'ok' | 'err' | 'info', message: string) => void;
  setAi: (ai: BootstrapData['ai']) => void;
  setSettings: (s: { commands?: BootstrapData['settings']['commands']; workspaceRoots?: string[] }) => void;
  patchRequirement: (req: Requirement) => void;
  activeJobs: TaskJob[];
}

const Ctx = createContext<AppState | null>(null);

const EMPTY_STATS: Stats = { total: 0, active: 0, completed: 0, awaiting: 0, byStatus: {} };

function readHash(): { view: View; id: string | null } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [view, id] = raw.split('/');
  const allowed: View[] = ['workspace', 'requirements', 'requirement', 'history', 'settings'];
  return { view: (allowed.includes(view as View) ? view : 'workspace') as View, id: id ?? null };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(() => {
    const initial = readHash();
    return {
      ready: false,
      error: null as string | null,
      repos: [] as RepoRecord[],
      profiles: {} as Record<string, RepoProfile>,
      architecture: null as ArchitectureReport | null,
      requirements: [] as Requirement[],
      jobs: [] as TaskJob[],
      logs: [] as LogEntry[],
      stats: EMPTY_STATS,
      ai: null as unknown as BootstrapData['ai'],
      settings: { commands: { test: '', build: '', lint: '' }, workspaceRoots: [] } as BootstrapData['settings'],
      view: initial.view,
      selectedRequirementId: initial.id,
      connected: false,
      toast: null as { id: number; kind: 'ok' | 'err' | 'info'; message: string } | null,
      lastLogId: 0,
    };
  });
  const [commands, setCommands] = useState({ test: '', build: '', lint: '' });
  const lastLogId = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback((kind: 'ok' | 'err' | 'info', message: string) => {
    setState((s) => ({ ...s, toast: { id: Date.now(), kind, message } }));
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setState((s) => ({ ...s, toast: null })), 4200);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api.bootstrap();
      lastLogId.current = Math.max(lastLogId.current, ...data.logs.map((l) => l.id), 0);
      setCommands(data.settings.commands);
      setState((s) => ({
        ...s,
        ready: true,
        error: null,
        repos: data.repos,
        profiles: data.profiles,
        architecture: data.architecture,
        requirements: data.requirements,
        jobs: data.jobs,
        logs: data.logs,
        stats: data.stats,
        ai: data.ai,
        settings: data.settings,
      }));
    } catch (err) {
      setState((s) => ({ ...s, ready: true, error: (err as Error).message }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // hash routing
  useEffect(() => {
    const onHash = () => {
      const { view, id } = readHash();
      setState((s) => ({
        ...s,
        view,
        selectedRequirementId: id ?? (view === 'requirement' ? s.selectedRequirementId : null),
      }));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((view: View, requirementId?: string | null) => {
    const hash = requirementId ? `#/${view}/${requirementId}` : `#/${view}`;
    if (window.location.hash !== hash) window.location.hash = hash;
    setState((s) => ({ ...s, view, selectedRequirementId: requirementId ?? null }));
  }, []);

  // live stream
  useEffect(() => {
    if (!state.ready) return;
    let pendingRequirements = new Set<string>();
    let pendingRepos = false;
    let pendingArch = false;
    let pendingSettings = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = async () => {
      flushTimer = null;
      if (pendingArch || pendingRepos) {
        const data = await api.bootstrap().catch(() => null);
        if (data) {
          setState((s) => ({
            ...s,
            repos: data.repos,
            profiles: data.profiles,
            architecture: data.architecture,
            jobs: data.jobs,
            stats: data.stats,
          }));
        }
        pendingArch = false;
        pendingRepos = false;
      }
      if (pendingRequirements.size) {
        const ids = [...pendingRequirements];
        pendingRequirements = new Set();
        const results = await Promise.all(
          ids.map((id) =>
            api
              .getRequirement(id)
              .then((r) => r.requirement)
              .catch(() => null),
          ),
        );
        const list = await api.listRequirements().catch(() => null);
        setState((s) => {
          const byId = new Map(s.requirements.map((r) => [r.id, r]));
          for (const r of results) if (r) byId.set(r.id, r);
          return {
            ...s,
            requirements: list ? list.requirements : [...byId.values()].sort((a, b) => b.seq - a.seq),
            stats: list ? list.stats : s.stats,
          };
        });
      }
      if (pendingSettings) {
        pendingSettings = false;
        const s = await api.getSettings().catch(() => null);
        if (s) {
          setCommands(s.commands);
          setState((prev) => ({
            ...prev,
            ai: s.ai,
            commands: s.commands,
            settings: { commands: s.commands, workspaceRoots: s.workspaceRoots },
          }));
        }
      }
    };

    const schedule = () => {
      if (!flushTimer) flushTimer = setTimeout(flush, 120);
    };

    const close = openEventStream(
      (evt) => {
        if (evt.log) {
          const entry = evt.log;
          setState((s) => ({
            ...s,
            connected: true,
            lastLogId: Math.max(s.lastLogId, entry.id),
            logs: [...s.logs.filter((l) => l.id !== entry.id), entry].slice(-400),
          }));
          lastLogId.current = Math.max(lastLogId.current, entry.id);
        }
        if (evt.change) {
          const c = evt.change;
          if (c.job) {
            setState((s) => ({
              ...s,
              jobs: [c.job!, ...s.jobs.filter((j) => j.id !== c.job!.id)].slice(0, 80),
            }));
          }
          if (c.scope === 'requirements' && c.requirement) {
            setState((s) => ({
              ...s,
              requirements: s.requirements.some((r) => r.id === c.requirement!.id)
                ? s.requirements.map((r) => (r.id === c.requirement!.id ? { ...r, ...c.requirement! } : r))
                : [c.requirement!, ...s.requirements],
              stats: c.stats ?? s.stats,
            }));
          } else if (c.scope === 'requirements') {
            pendingRequirements.add(c.id!);
            schedule();
          } else if (c.scope === 'repos') {
            pendingRepos = true;
            schedule();
          } else if (c.scope === 'architecture') {
            pendingArch = true;
            schedule();
          } else if (c.scope === 'settings') {
            pendingSettings = true;
            schedule();
          } else if (c.scope === 'jobs') {
            schedule();
          }
        }
        setState((s) => (s.connected ? s : { ...s, connected: true }));
      },
      () => lastLogId.current,
    );

    const ping = setTimeout(() => setState((s) => ({ ...s, connected: true })), 800);
    return () => {
      clearTimeout(ping);
      if (flushTimer) clearTimeout(flushTimer);
      close();
    };
  }, [state.ready]);

  const value = useMemo<AppState>(
    () => ({
      ...state,
      commands,
      settings: state.settings,
      activeJobs: state.jobs.filter((j) => j.status === 'running' || j.status === 'queued'),
      setAi: (ai) => setState((s) => ({ ...s, ai })),
      setSettings: (patch) => {
        if (patch.commands) setCommands(patch.commands);
        setState((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
      },
      patchRequirement: (req) =>
        setState((s) => ({
          ...s,
          requirements: s.requirements.some((r) => r.id === req.id)
            ? s.requirements.map((r) => (r.id === req.id ? req : r))
            : [req, ...s.requirements],
        })),
      notify,
      refresh,
      go,
    }),
    [state, commands, notify, refresh, go],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}

export function useRequirementDetail(id: string | null) {
  const [data, setData] = useState<{ requirement: Requirement | null; jobs: TaskJob[]; logs: LogEntry[] }>({
    requirement: null,
    jobs: [],
    logs: [],
  });
  const [loading, setLoading] = useState(false);
  const req = useApp().requirements.find((r) => r.id === id);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await api.getRequirement(id);
      setData(res);
    } catch {
      /* keep last */
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // keep in sync when the global list receives live updates
  useEffect(() => {
    if (req) setData((d) => ({ ...d, requirement: { ...(d.requirement ?? req), ...req } }));
  }, [req]);

  return { ...data, loading, reload: load };
}
