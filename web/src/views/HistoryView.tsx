import { useMemo, useState } from 'react';
import { CheckCircle2, History, Search, Download, GitBranch } from 'lucide-react';
import { PRIORITY_META, classNames, fmtDateTime, fmtTime } from '../lib/ui';
import { useApp } from '../store/app';
import { Chip, EmptyState } from '../components/ui';

export function HistoryView() {
  const { requirements, go } = useApp();
  const [q, setQ] = useState('');
  const [repoFilter, setRepoFilter] = useState('');

  const history = useMemo(() => requirements.filter((r) => r.status === 'completed'), [requirements]);

  const repos = useMemo(() => {
    const set = new Set<string>();
    for (const r of history) for (const i of r.report?.impact ?? []) set.add(i.repoName);
    return [...set];
  }, [history]);

  const filtered = history
    .filter((r) => !q || r.title.includes(q) || r.description.includes(q))
    .filter((r) => !repoFilter || (r.report?.impact ?? []).some((i) => i.repoName === repoFilter))
    .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));

  const stats = useMemo(() => {
    const files = history.reduce((a, r) => a + (r.implementation?.diffStat.files ?? 0), 0);
    const adds = history.reduce((a, r) => a + (r.implementation?.diffStat.additions ?? 0), 0);
    const dels = history.reduce((a, r) => a + (r.implementation?.diffStat.deletions ?? 0), 0);
    const avgScore =
      history.filter((r) => r.acceptance).reduce((a, r) => a + (r.acceptance!.score ?? 0), 0) /
      Math.max(1, history.filter((r) => r.acceptance).length);
    return { files, adds, dels, avgScore: Math.round(avgScore) };
  }, [history]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ohpert-history-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-[1400px] px-7 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-slate-100">
            <History size={18} className="text-emerald-400" /> 已完成历史
          </h1>
          <p className="mt-1 text-[12.5px] text-slate-500">
            经 AI 验收并由你确认完成的需求归档，可追溯报告、改动与验收结论。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              className="input !w-56 !py-1.5 !pl-8 !text-[12px]"
              placeholder="搜索需求…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {repos.length > 0 && (
            <select
              className="input !w-40 !py-1.5 !text-[12px]"
              value={repoFilter}
              onChange={(e) => setRepoFilter(e.target.value)}
            >
              <option value="">全部工程</option>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          )}
          <button className="btn-ghost" disabled={!filtered.length} onClick={exportJson}>
            <Download size={14} /> 导出
          </button>
        </div>
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <MiniStat label="已完成需求" value={history.length} />
        <MiniStat label="改动文件" value={stats.files} />
        <MiniStat label="代码增删" value={`+${stats.adds}/-${stats.dels}`} />
        <MiniStat label="平均验收分" value={history.length ? stats.avgScore : '—'} />
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<History size={22} />}
          title={history.length ? '没有匹配的需求' : '还没有已完成的需求'}
          desc={
            history.length
              ? '换个关键词或清除工程筛选试试。'
              : '当需求走完「分析 → 研发 → AI 验收 → 你的确认」后，会归档到这里。'
          }
          action={
            history.length ? undefined : (
              <button className="btn-ghost" onClick={() => go('requirements')}>
                前往需求队列
              </button>
            )
          }
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => (
            <button
              key={r.id}
              onClick={() => go('requirement', r.id)}
              className="group w-full rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-left transition hover:border-emerald-200 hover:bg-ink-800"
            >
              <div className="flex flex-wrap items-center gap-2">
                <CheckCircle2 size={13} className="text-emerald-400" />
                <span className="font-mono text-[11px] text-slate-500">#{r.seq}</span>
                <span className="text-[13.5px] font-medium text-slate-100">{r.title}</span>
                <Chip className={classNames('border', (PRIORITY_META[r.priority] ?? PRIORITY_META.normal).color)}>
                  {(PRIORITY_META[r.priority] ?? PRIORITY_META.normal).label}
                </Chip>
                {r.acceptance && (
                  <Chip className="border border-emerald-200 bg-emerald-50 text-emerald-700">
                    验收 {r.acceptance.score} 分
                  </Chip>
                )}
                {r.reworkRounds > 0 && (
                  <Chip className="border border-rose-200 bg-rose-50 text-rose-700">返工 {r.reworkRounds} 次</Chip>
                )}
                <span className="ml-auto text-[10.5px] text-slate-500">完成于 {fmtTime(r.completedAt)}</span>
              </div>
              <div className="mt-1 line-clamp-1 text-[11.5px] text-slate-500">{r.report?.summary}</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-slate-500">
                {r.implementation && (
                  <>
                    <span>{r.implementation.diffStat.files} 文件</span>
                    <span className="text-emerald-500/80">+{r.implementation.diffStat.additions}</span>
                    <span className="text-rose-500/80">-{r.implementation.diffStat.deletions}</span>
                  </>
                )}
                {r.implementation?.repos.map((rp) => (
                  <span key={rp.repoId} className="flex items-center gap-1 font-mono">
                    <GitBranch size={9} /> {rp.branch.replace('ohpert/', '')}
                  </span>
                ))}
                {r.userConfirmation?.note && <span className="text-slate-500">备注：{r.userConfirmation.note}</span>}
                <span className="ml-auto">{fmtDateTime(r.completedAt)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card px-3.5 py-3">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="mt-0.5 text-[19px] font-bold leading-none text-slate-200">{value}</div>
    </div>
  );
}
