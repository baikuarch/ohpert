import { CheckCircle2, XCircle, Info, X } from 'lucide-react';
import { classNames } from './lib/ui';
import { useApp } from './store/app';
import { WorkspaceView } from './views/WorkspaceView';
import { RequirementsView } from './views/RequirementsView';
import { RequirementDetailView } from './views/RequirementDetailView';
import { HistoryView } from './views/HistoryView';
import { SettingsView } from './views/SettingsView';
import { FolderGit2, ListTodo, History, Settings2, Activity } from 'lucide-react';

const NAV = [
  { key: 'workspace', label: '工程与架构', icon: FolderGit2, hint: '选择多个 Git 工程，AI 分析相互关系' },
  { key: 'requirements', label: '需求队列', icon: ListTodo, hint: '录入需求 → 分析 → 研发 → 验收' },
  { key: 'history', label: '已完成', icon: History, hint: '已确认完成的需求历史' },
  { key: 'settings', label: '设置', icon: Settings2, hint: '模型、命令与工作区配置' },
] as const;

export default function App() {
  const { view, go, stats, connected, ready, error, toast, activeJobs, architecture, repos } = useApp();

  return (
    <div className="flex h-full">
      <aside className="flex w-[248px] shrink-0 flex-col border-r border-ink-700 bg-ink-900">
        <div className="flex items-center gap-2.5 px-5 pb-4 pt-5">
          <div className="grid h-9 w-9 place-items-center rounded-lg bg-gradient-to-br from-sky-500 to-violet-500 text-lg font-black text-white shadow-lg shadow-sky-500/25">
            O
          </div>
          <div>
            <div className="text-[15px] font-semibold tracking-tight text-slate-100">ohpert</div>
            <div className="text-[11px] text-slate-500">AI 需求研发平台</div>
          </div>
        </div>

        <nav className="flex flex-col gap-1 px-3">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = view === item.key || (item.key === 'requirements' && view === 'requirement');
            return (
              <button
                key={item.key}
                onClick={() => go(item.key as any, null)}
                title={item.hint}
                className={classNames('nav-link', active && 'nav-link-active')}
              >
                <Icon size={16} className={active ? 'text-sky-600' : ''} />
                <span className="flex-1 text-left">{item.label}</span>
                {item.key === 'requirements' && stats.active > 0 && (
                  <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-600">
                    {stats.active}
                  </span>
                )}
                {item.key === 'requirements' && stats.awaiting > 0 && (
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_2px_rgba(52,211,153,0.5)]" />
                )}
                {item.key === 'history' && stats.completed > 0 && (
                  <span className="text-[10px] text-slate-500">{stats.completed}</span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="mx-3 mt-4 rounded-lg border border-ink-700 bg-ink-800 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
            <Activity size={12} /> 运行状态
          </div>
          <div className="space-y-1.5 text-[11px] text-slate-500">
            <div className="flex items-center justify-between">
              <span>工程</span>
              <span className="text-slate-300">{repos.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <span>架构图谱</span>
              <span className={architecture ? 'text-emerald-400' : 'text-slate-500'}>
                {architecture ? '已生成' : '未生成'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>实时通道</span>
              <span className={connected ? 'text-emerald-400' : 'text-rose-400'}>{connected ? '已连接' : '断开'}</span>
            </div>
            {activeJobs.length > 0 && (
              <div className="mt-2 border-t border-ink-700 pt-2 text-amber-700">
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                  {activeJobs[0].message || '任务进行中'}
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded bg-ink-800">
                  <div
                    className="h-full bg-amber-400/70 transition-all"
                    style={{ width: `${activeJobs[0].progress}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-auto px-5 py-4 text-[10.5px] leading-relaxed text-slate-500">
          本地优先 · 代码留在你的机器
          <br />
          ohpert v0.1
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!ready ? (
          <div className="grid flex-1 place-items-center">
            <div className="flex flex-col items-center gap-3 text-slate-500">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-700 border-t-sky-500" />
              正在连接 ohpert 服务…
            </div>
          </div>
        ) : error ? (
          <div className="grid flex-1 place-items-center p-8">
            <div className="card max-w-lg p-6 text-center">
              <XCircle className="mx-auto mb-3 text-rose-400" />
              <h3 className="text-base font-semibold text-slate-100">无法连接后端服务</h3>
              <p className="mt-2 text-sm text-slate-400">{error}</p>
              <p className="mt-3 text-xs text-slate-500">
                请确认服务已启动：<code className="rounded bg-ink-800 px-1">pnpm dev</code>
              </p>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {view === 'workspace' && <WorkspaceView />}
            {view === 'requirements' && <RequirementsView />}
            {view === 'requirement' && <RequirementDetailView />}
            {view === 'history' && <HistoryView />}
            {view === 'settings' && <SettingsView />}
          </div>
        )}
      </main>

      {toast && (
        <div
          key={toast.id}
          className={classNames(
            'fixed bottom-6 left-1/2 z-50 flex max-w-[560px] -translate-x-1/2 items-start gap-2 rounded-xl border px-4 py-3 text-sm shadow-2xl animate-slide-in',
            toast.kind === 'ok' && 'border-emerald-200 bg-white text-emerald-900',
            toast.kind === 'err' && 'border-rose-200 bg-white text-rose-900',
            toast.kind === 'info' && 'border-ink-600 bg-ink-900 text-slate-200',
          )}
        >
          {toast.kind === 'ok' ? (
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          ) : toast.kind === 'err' ? (
            <XCircle size={16} className="mt-0.5 shrink-0" />
          ) : (
            <Info size={16} className="mt-0.5 shrink-0" />
          )}
          <span className="whitespace-pre-wrap">{toast.message}</span>
          <X
            size={14}
            className="ml-2 mt-0.5 shrink-0 cursor-pointer opacity-50 hover:opacity-100"
            onClick={() => go(view, null)}
          />
        </div>
      )}
    </div>
  );
}
