import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FolderGit2,
  GitBranch,
  Layers,
  Loader2,
  Minus,
  Network,
  RefreshCw,
  Sparkles,
  Trash2,
  ChevronDown,
} from 'lucide-react';
import { api } from '../lib/api';
import { ROLE_META, classNames, fmtNum, fmtTime, shortPath } from '../lib/ui';
import { useApp } from '../store/app';
import { RepoPicker } from '../components/RepoPicker';
import { ArchitectureGraph, ArchitectureNarrative } from '../components/ArchitectureGraph';
import { Chip, EmptyState, SectionTitle } from '../components/ui';
import type { RepoRole } from '../types';

const ROLES: RepoRole[] = ['frontend', 'backend', 'fullstack', 'library', 'mobile', 'infra', 'unknown'];

export function WorkspaceView() {
  const { repos, profiles, architecture, activeJobs, jobs, refresh, notify } = useApp();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const analyzeJob = activeJobs.find((j) => j.kind === 'analyze');
  const lastAnalyze = jobs.find((j) => j.kind === 'analyze');

  const runAnalyze = async () => {
    setAnalyzing(true);
    try {
      await api.analyzeArchitecture();
      notify('info', 'AI 正在分析工程架构与相互关系，请稍候…');
    } catch (e) {
      notify('err', (e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

  const unanalyzed = repos.filter((r) => !profiles[r.id]);

  return (
    <div className="mx-auto max-w-[1400px] px-7 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-100">工程与架构</h1>
          <p className="mt-1 text-[12.5px] text-slate-500">
            先选择前端、后端等多个 Git 工程，AI 会扫描代码并梳理出工程之间的调用关系与业务联系。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => setPickerOpen(true)}>
            <FolderGit2 size={15} /> 添加工程
          </button>
          <button
            className="btn-primary"
            disabled={!repos.length || Boolean(analyzeJob) || analyzing}
            onClick={runAnalyze}
          >
            {analyzeJob ? (
              <Loader2 size={14} className="animate-spin" />
            ) : architecture ? (
              <RefreshCw size={14} />
            ) : (
              <Sparkles size={14} />
            )}
            {analyzeJob ? `分析中 ${analyzeJob.progress}%` : architecture ? '重新分析架构' : 'AI 分析架构'}
          </button>
        </div>
      </div>

      {analyzeJob && <AnalyzeProgress job={analyzeJob} />}

      {!repos.length ? (
        <EmptyState
          icon={<FolderGit2 size={22} />}
          title="第 1 步：选择你的 Git 工程"
          desc="支持同时选择前端、后端、SDK 等多个工程。ohpert 只读取代码做分析，研发阶段会在独立的 git worktree 分支中进行，不会污染你的工作区。"
          action={
            <button className="btn-primary" onClick={() => setPickerOpen(true)}>
              <FolderGit2 size={15} /> 选择工程目录
            </button>
          }
        />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {repos.map((repo) => (
              <RepoCard
                key={repo.id}
                repo={repo}
                profile={profiles[repo.id]}
                onRemove={async () => {
                  if (!confirm(`确定移除工程 ${repo.name}？不会删除本地代码。`)) return;
                  await api.removeRepo(repo.id);
                  await refresh();
                }}
              />
            ))}
            <button
              onClick={() => setPickerOpen(true)}
              className="flex min-h-[152px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-ink-700 text-slate-500 transition hover:border-sky-300 hover:text-sky-600"
            >
              <FolderGit2 size={20} />
              <span className="text-[12px]">添加更多工程</span>
            </button>
          </div>

          {unanalyzed.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
              <AlertTriangle size={14} />有 {unanalyzed.length} 个工程尚未完成扫描分析，请点击右上角「
              {architecture ? '重新分析架构' : 'AI 分析架构'}」。
            </div>
          )}

          <div>
            <SectionTitle
              icon={<Network size={15} className="text-sky-600" />}
              title="工程关系图谱"
              desc={architecture ? architecture.techSummary : 'AI 将基于接口调用、共享类型、依赖关系等线索绘制工程拓扑'}
              right={
                lastAnalyze?.finishedAt ? (
                  <span className="text-[11px] text-slate-500">
                    上次分析：{fmtTime(lastAnalyze.finishedAt)}
                    {lastAnalyze.status === 'failed' && (
                      <span className="ml-1 text-rose-400">（失败：{lastAnalyze.error}）</span>
                    )}
                  </span>
                ) : null
              }
            />
            <ArchitectureGraph repos={repos} profiles={profiles} architecture={architecture} />
          </div>

          {architecture && (
            <div>
              <SectionTitle icon={<Layers size={15} className="text-violet-400" />} title="架构说明与业务域" />
              <ArchitectureNarrative architecture={architecture} repos={repos} />
            </div>
          )}
        </div>
      )}

      <RepoPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onAdded={() => refresh()} />
    </div>
  );
}

function AnalyzeProgress({ job }: { job: { progress: number; message: string } }) {
  return (
    <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50 p-3">
      <div className="mb-2 flex items-center gap-2 text-[12.5px] text-sky-800">
        <Loader2 size={14} className="animate-spin" />
        {job.message || '扫描工程代码…'}
        <span className="ml-auto font-mono text-[11px] text-sky-600">{job.progress}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
        <div
          className="h-full rounded-full bg-sky-500 transition-all duration-500"
          style={{ width: `${job.progress}%` }}
        />
      </div>
    </div>
  );
}

function RepoCard({
  repo,
  profile,
  onRemove,
}: {
  repo: ReturnType<typeof useApp>['repos'][number];
  profile?: Record<string, any>;
  onRemove: () => void;
}) {
  const meta = ROLE_META[repo.role];
  const [roleOpen, setRoleOpen] = useState(false);
  const { refresh } = useApp();
  const langs = profile
    ? Object.entries(profile.languages as Record<string, number>)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
    : [];

  return (
    <div className={classNames('card group relative p-3.5 transition hover:border-ink-600', !profile && 'opacity-90')}>
      <div className="flex items-start gap-2">
        <div
          className={classNames('grid h-8 w-8 shrink-0 place-items-center rounded-lg border text-[13px]', meta.color)}
        >
          {meta.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-slate-100" title={repo.path}>
            {repo.name}
          </div>
          <div className="truncate text-[10.5px] text-slate-500" title={repo.path}>
            {shortPath(repo.path, 34)}
          </div>
        </div>
        <button
          onClick={() => setRoleOpen((o) => !o)}
          className={classNames('chip shrink-0 border', meta.color)}
          title="点击修改角色"
        >
          {meta.label}
          <ChevronDown size={9} />
        </button>
      </div>

      {roleOpen && (
        <div className="absolute right-2 top-10 z-10 w-32 overflow-hidden rounded-lg border border-ink-700 bg-ink-900 shadow-xl">
          {ROLES.map((r) => (
            <button
              key={r}
              className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11.5px] text-slate-300 hover:bg-ink-800"
              onClick={async () => {
                await api.updateRepo(repo.id, { role: r });
                setRoleOpen(false);
                await refresh();
              }}
            >
              {ROLE_META[r].icon} {ROLE_META[r].label}
              {repo.role === r && <CheckCircle2 size={11} className="ml-auto text-emerald-400" />}
            </button>
          ))}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap gap-1">
        {(profile?.frameworks ?? []).slice(0, 3).map((f: string) => (
          <Chip key={f} className="border-ink-700 bg-ink-800 text-[10px] text-slate-300">
            {f}
          </Chip>
        ))}
        {langs.map(([l, n]) => (
          <Chip key={l} className="border-ink-700 bg-transparent text-[10px] text-slate-500">
            {l} · {n}
          </Chip>
        ))}
      </div>

      {profile ? (
        <div className="mt-2.5 grid grid-cols-3 gap-1 border-t border-ink-700 pt-2 text-center">
          <Stat label="文件" value={fmtNum(profile.fileCount)} />
          <Stat label="路由" value={String(profile.apiRoutes.length)} />
          <Stat label="请求点" value={String(profile.apiCalls.length)} />
        </div>
      ) : (
        <div className="mt-2.5 flex items-center gap-1.5 border-t border-ink-700 pt-2 text-[11px] text-slate-500">
          <Minus size={11} /> 尚未扫描
        </div>
      )}

      <div className="mt-2 flex items-center justify-between text-[10.5px] text-slate-500">
        <span className="flex items-center gap-1">
          <GitBranch size={10} /> {profile?.branch || repo.branch || '—'}
          {profile?.dirty && <span className="text-amber-400">· 有改动</span>}
        </span>
        <button
          onClick={onRemove}
          className="opacity-0 transition hover:text-rose-400 group-hover:opacity-100"
          title="移除"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[12.5px] font-semibold text-slate-200">{value}</div>
      <div className="text-[9.5px] text-slate-500">{label}</div>
    </div>
  );
}
