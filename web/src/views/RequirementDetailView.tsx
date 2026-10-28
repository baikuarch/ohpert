import { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  CheckCircle2,
  CircleDot,
  ClipboardCheck,
  Code2,
  FileText,
  FolderCheck,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  XCircle,
  Terminal,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../lib/api';
import { PRIORITY_META, ROLE_META, STATUS_META, classNames, fmtDateTime } from '../lib/ui';
import { useApp, useRequirementDetail } from '../store/app';
import { DiffViewer } from '../components/DiffViewer';
import { Collapsible, EmptyState, ScoreRing, Chip } from '../components/ui';
import type { AcceptanceCheck, Requirement } from '../types';

const STEPS = [
  { key: 'queued', label: '入队' },
  { key: 'analyzed', label: '需求分析' },
  { key: 'implemented', label: '研发' },
  { key: 'awaiting_approval', label: '验收' },
  { key: 'completed', label: '确认完成' },
];

const STEP_OF: Record<string, number> = {
  draft: 0,
  queued: 0,
  analyzing: 1,
  analyzed: 1,
  implementing: 2,
  needs_rework: 2,
  implemented: 3,
  accepting: 3,
  awaiting_approval: 3,
  completed: 4,
  failed: 0,
  rejected: 0,
};

export function RequirementDetailView() {
  const { selectedRequirementId, go, notify, refresh, repos: allRepos } = useApp();
  const { requirement, logs, loading, reload } = useRequirementDetail(selectedRequirementId);
  const [tab, setTab] = useState<'report' | 'code' | 'acceptance' | 'activity'>('report');
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [showReject, setShowReject] = useState(false);
  const [probe, setProbe] = useState<{
    ok: boolean;
    message: string;
    hints: string[];
    failedAt?: string;
    detail?: string;
  } | null>(null);
  const [probing, setProbing] = useState(false);

  const req = requirement;

  /** Re-check whether ohpert can write to the repos this requirement touches. */
  const checkPermissions = async (reqToCheck: Requirement) => {
    const ids = (reqToCheck.report?.impact ?? []).map((i) => i.repoId).filter(Boolean);
    const names = new Set((reqToCheck.report?.impact ?? []).map((i) => i.repoName));
    const targets = allRepos.filter((r) => ids.includes(r.id) || names.has(r.name));
    if (!targets.length) {
      notify('err', '没有找到该需求关联的工程');
      return;
    }
    setProbing(true);
    try {
      const results = await Promise.all(
        targets.map(async (r) => ({
          name: r.name,
          res: await api.probeRepo(r.id).catch((e) => ({ ok: false, message: (e as Error).message, hints: [] })),
        })),
      );
      const bad = results.filter((r) => !r.res.ok);
      if (!bad.length) {
        setProbe({ ok: true, message: `${results.map((r) => r.name).join('、')} 均可写，可以直接开始研发`, hints: [] });
        notify('ok', '权限检测通过');
      } else {
        const first = bad[0].res as any;
        setProbe({
          ok: false,
          failedAt: first.failedAt,
          message: `${bad.map((b) => b.name).join('、')} 不可写：${first.message}`,
          hints: first.hints ?? [],
          detail: first.detail,
        });
        notify('err', '权限检测未通过，请按提示处理后重试');
      }
    } finally {
      setProbing(false);
    }
  };

  const run = async (action: string, fn: () => Promise<unknown>, okMsg: string) => {
    setBusy(action);
    try {
      await fn();
      notify('ok', okMsg);
      await reload();
      await refresh();
    } catch (e) {
      notify('err', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!req) {
    return (
      <div className="p-8">
        <EmptyState
          icon={<CircleDot size={22} />}
          title={loading ? '加载中…' : '需求不存在'}
          action={
            <button className="btn-ghost" onClick={() => go('requirements')}>
              返回队列
            </button>
          }
        />
      </div>
    );
  }

  const st = STATUS_META[req.status];
  const step = STEP_OF[req.status] ?? 0;
  const busyGlobal = ['analyzing', 'implementing', 'accepting'].includes(req.status);
  // A run whose job died (server restarted, crash) leaves the status transitional;
  // after 3 minutes without a live job we stop pretending it is still working.
  const updatedMs = new Date(req.updatedAt).getTime();
  const staleRun = busyGlobal && Date.now() - updatedMs > 3 * 60_000;
  const stuck = busyGlobal && staleRun;

  const canAnalyze =
    ['draft', 'queued', 'failed', 'analyzed', 'needs_rework'].includes(req.status) ||
    (!req.report && (!['analyzing', 'implementing'].includes(req.status) || stuck));
  const canImplement =
    Boolean(req.report) &&
    (['analyzed', 'implemented', 'needs_rework', 'failed'].includes(req.status) || (stuck && !req.implementation));
  const canAccept =
    Boolean(req.implementation) && ['implemented', 'needs_rework', 'awaiting_approval'].includes(req.status);
  const canConfirm = req.status === 'awaiting_approval';
  return (
    <div className="mx-auto max-w-[1400px] px-7 py-5">
      {/* header */}
      <div className="mb-4">
        <button
          onClick={() => go('requirements')}
          className="mb-2 flex items-center gap-1 text-[11.5px] text-slate-500 hover:text-sky-600"
        >
          <ArrowLeft size={12} /> 返回需求队列
        </button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] text-slate-500">#{req.seq}</span>
              <h1 className="truncate text-xl font-semibold tracking-tight text-slate-100">{req.title}</h1>
              <span className={classNames('chip border', st.color)}>{st.label}</span>
              <span className={classNames('chip border', (PRIORITY_META[req.priority] ?? PRIORITY_META.normal).color)}>
                {(PRIORITY_META[req.priority] ?? PRIORITY_META.normal).label}优先级
              </span>
              {req.reworkRounds > 0 && (
                <span className="chip border border-rose-200 bg-rose-50 text-rose-700">返工 {req.reworkRounds} 轮</span>
              )}
            </div>
            <p className="mt-1.5 line-clamp-2 max-w-3xl whitespace-pre-wrap text-[12px] leading-relaxed text-slate-500">
              {req.description}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {canAnalyze && (
              <button
                className="btn-ghost"
                disabled={!!busy || busyGlobal}
                onClick={() => run('analyze', () => api.analyze(req.id), 'AI 开始分析需求…')}
              >
                {busy === 'analyze' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {req.report ? '重新分析' : '分析需求'}
              </button>
            )}
            {canImplement && (
              <button
                className="btn-primary"
                disabled={!!busy}
                onClick={() => run('implement', () => api.implement(req.id), 'AI 开始研发，可在下方查看实时日志')}
              >
                {busy === 'implement' || req.status === 'implementing' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Code2 size={14} />
                )}
                {req.implementation ? '继续研发 / 返工' : '开始研发'}
              </button>
            )}
            {canAccept && (
              <button
                className="btn-ghost"
                disabled={!!busy}
                onClick={() => run('accept', () => api.accept(req.id), 'AI 开始验收…')}
              >
                {busy === 'accept' || req.status === 'accepting' ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <ShieldCheck size={14} />
                )}
                {req.acceptance ? '重新验收' : 'AI 验收'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* pipeline */}
      <div className="card mb-4 flex items-center gap-1 px-4 py-3">
        {STEPS.map((s, i) => {
          const done = step > i || req.status === 'completed';
          const active = step === i && req.status !== 'completed';
          return (
            <div key={s.key} className="flex min-w-0 flex-1 items-center">
              <div className="flex min-w-0 items-center gap-1.5">
                <div
                  className={classNames(
                    'grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[9px] font-semibold',
                    done
                      ? 'border-emerald-400 bg-emerald-50 text-emerald-600'
                      : active
                        ? 'border-sky-500 bg-sky-100 text-sky-700'
                        : 'border-ink-700 text-slate-500',
                  )}
                >
                  {done ? (
                    <CheckCircle2 size={11} />
                  ) : active ? (
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
                  ) : (
                    i + 1
                  )}
                </div>
                <span
                  className={classNames(
                    'truncate text-[11.5px]',
                    done ? 'text-emerald-700' : active ? 'text-sky-700' : 'text-slate-500',
                  )}
                >
                  {s.label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div className={classNames('mx-2 h-px flex-1', done ? 'bg-emerald-500/30' : 'bg-ink-800')} />
              )}
            </div>
          );
        })}
      </div>

      {stuck && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-800">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">
            这个任务已经超过 3 分钟没有任何进展，可能已经中断（服务重启或进程退出）。需求被卡在「{st.label}」状态，
            {req.implementation ? '可以先验收现有改动。' : '可以直接重新开始。'}
          </span>
          <button
            className="btn-ghost shrink-0 !py-1 !text-[11.5px]"
            disabled={!!busy}
            onClick={async () => {
              setBusy('release');
              try {
                if (req.jobId) await api.cancelJob(req.jobId);
                notify('ok', '已尝试释放该需求，正在刷新状态…');
                await reload();
                await refresh();
              } catch (e) {
                notify('err', (e as Error).message);
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === 'release' ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />} 解除卡住状态
          </button>
        </div>
      )}

      {req.error && (
        <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-800">
          <div className="flex items-start gap-2">
            <XCircle size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 whitespace-pre-wrap">{req.error}</span>
            <button
              className="btn-ghost shrink-0 !py-1 !text-[11.5px]"
              disabled={probing}
              onClick={() => void checkPermissions(req)}
              title="重新检测相关工程是否可写（创建分支/worktree）"
            >
              {probing ? <Loader2 size={12} className="animate-spin" /> : <FolderCheck size={12} />} 重新检测权限
            </button>
          </div>

          {probe && (
            <div
              className={classNames(
                'mt-2 rounded-md border px-2.5 py-2 text-[11.5px]',
                probe.ok ? 'border-emerald-200 bg-white text-emerald-800' : 'border-rose-200 bg-white text-rose-800',
              )}
            >
              <div className="flex items-center gap-1.5 font-medium">
                {probe.ok ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                {probe.ok ? probe.message : '无法写入仓库，请按顺序排查'}
              </div>
              {!probe.ok && (
                <>
                  <div className="mt-1 text-slate-500">{probe.message}</div>
                  {probe.detail && (
                    <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-ink-950 p-1.5 font-mono text-[10.5px] text-slate-500">
                      {probe.detail}
                    </pre>
                  )}
                  <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-slate-600">
                    {probe.hints.map((h, i) => (
                      <li key={i}>{h}</li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* confirm banner */}
      {canConfirm && (
        <ConfirmBanner
          req={req}
          busy={busy}
          onApprove={() => run('approve', () => api.confirm(req.id, 'approve', ''), '需求已完成，进入历史队列')}
          onReject={() => setShowReject(true)}
        />
      )}

      {showReject && (
        <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3">
          <div className="mb-2 text-[12px] font-medium text-rose-800">
            请描述需要返工的问题（会作为下一轮研发的输入）
          </div>
          <textarea
            className="input min-h-[80px]"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            placeholder="例如：批量取消接口没有返回失败明细，且前端未提示部分失败"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setShowReject(false)}>
              取消
            </button>
            <button
              className="btn-danger"
              disabled={busy === 'reject'}
              onClick={async () => {
                await run('reject', () => api.confirm(req.id, 'reject', rejectNote), '已驳回，需求退回研发');
                setShowReject(false);
                setRejectNote('');
              }}
            >
              <ThumbsDown size={13} /> 确认驳回
            </button>
          </div>
        </div>
      )}

      {/* tabs */}
      <div className="mb-3 flex items-center gap-1 border-b border-ink-700">
        {[
          { key: 'report', label: '需求报告', icon: FileText, badge: req.report ? undefined : '待生成' },
          {
            key: 'code',
            label: '代码改动',
            icon: Code2,
            badge: req.implementation ? `${req.implementation.diffStat.files} 文件` : '无',
          },
          {
            key: 'acceptance',
            label: '验收结论',
            icon: ClipboardCheck,
            badge: req.acceptance ? (req.acceptance.verdict === 'fail' ? '未通过' : '已通过') : '无',
          },
          { key: 'activity', label: '执行日志', icon: Terminal, badge: logs.length ? String(logs.length) : undefined },
        ].map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key as any)}
              className={classNames(
                'flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] transition',
                active ? 'border-sky-500 text-slate-100' : 'border-transparent text-slate-500 hover:text-slate-300',
              )}
            >
              <Icon size={13} /> {t.label}
              {t.badge && <span className="rounded bg-ink-800 px-1 py-0.5 text-[9.5px] text-slate-500">{t.badge}</span>}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2 pb-1 text-[10.5px] text-slate-500">
          <span>创建于 {fmtDateTime(req.createdAt)}</span>
          <button onClick={reload} className="rounded p-1 hover:bg-ink-800 hover:text-slate-300" title="刷新">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {tab === 'report' && <ReportTab req={req} />}
      {tab === 'code' && (
        <div className="space-y-3">
          {req.implementation ? (
            <>
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[11.5px] text-slate-400">
                <span className="font-medium text-slate-200">改动统计</span>
                <span>{req.implementation.diffStat.files} 个文件</span>
                <span className="text-emerald-400">+{req.implementation.diffStat.additions}</span>
                <span className="text-rose-400">-{req.implementation.diffStat.deletions}</span>
                <span className="text-slate-500">·</span>
                <span>{req.implementation.turns} 轮对话</span>
                <span className="text-slate-500">·</span>
                <span>{req.implementation.aiModel}</span>
                {(req.implementation.repairRounds ?? 0) > 0 && (
                  <Chip
                    className={
                      req.implementation.unresolved?.length
                        ? 'border border-rose-200 bg-rose-50 text-rose-700'
                        : 'border border-emerald-200 bg-emerald-50 text-emerald-700'
                    }
                  >
                    {req.implementation.unresolved?.length
                      ? `自动修复 ${req.implementation.repairRounds} 轮后仍失败`
                      : `自动修复 ${req.implementation.repairRounds} 轮后通过`}
                  </Chip>
                )}
                {req.status !== 'completed' && (
                  <button
                    className="ml-auto flex items-center gap-1 text-rose-400 hover:underline"
                    onClick={async () => {
                      if (!confirm('确定回滚本次需求产生的所有代码改动？分支与工作区都会被清理。')) return;
                      await run('revert', () => api.revert(req.id), '代码已回滚');
                    }}
                  >
                    <RotateCcw size={11} /> 回滚改动
                  </button>
                )}
              </div>
              {req.implementation.unresolved && req.implementation.unresolved.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800">
                  <div className="flex items-center gap-1.5 font-medium">
                    <AlertTriangle size={12} /> 以下构建仍未通过，建议处理后再验收
                  </div>
                  <ul className="mt-1 space-y-0.5 font-mono text-[11px]">
                    {req.implementation.unresolved.map((u) => (
                      <li key={u}>· {u}</li>
                    ))}
                  </ul>
                </div>
              )}
              <DiffViewer files={req.implementation.files} branches={req.implementation.repos} />
              {req.implementation.summary && (
                <Collapsible title="AI 研发总结" defaultOpen>
                  <div className="prose-ohpert">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{req.implementation.summary}</ReactMarkdown>
                  </div>
                </Collapsible>
              )}
            </>
          ) : (
            <EmptyState
              icon={<Code2 size={22} />}
              title="还没有代码改动"
              desc={
                req.report
                  ? '点击右上角「开始研发」，AI 会在独立分支上修改前后端代码并提交。'
                  : '请先生成需求报告，再进行研发。'
              }
            />
          )}
        </div>
      )}
      {tab === 'acceptance' && <AcceptanceTab req={req} />}
      {tab === 'activity' && <ActivityTab logs={logs} />}
    </div>
  );
}

function ConfirmBanner({
  req,
  busy,
  onApprove,
  onReject,
}: {
  req: Requirement;
  busy: string | null;
  onApprove: () => void;
  onReject: () => void;
}) {
  const score = req.acceptance?.score ?? 0;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
      <CheckCircle2 size={18} className="text-emerald-400" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-emerald-900">
          AI 已完成验收（
          {req.acceptance?.verdict === 'pass_with_notes'
            ? '通过，但有备注'
            : req.acceptance?.verdict === 'pass'
              ? '通过'
              : '未通过'}
          ，{score} 分），等待你确认
        </div>
        <div className="mt-0.5 line-clamp-2 text-[11.5px] text-emerald-700/90">{req.acceptance?.summary}</div>
      </div>
      <button className="btn-danger" onClick={onReject} disabled={!!busy}>
        <ThumbsDown size={13} /> 驳回返工
      </button>
      <button className="btn-success" onClick={onApprove} disabled={!!busy}>
        {busy === 'approve' ? <Loader2 size={13} className="animate-spin" /> : <ThumbsUp size={13} />} 确认完成
      </button>
    </div>
  );
}

function ReportTab({ req }: { req: Requirement }) {
  const report = req.report;
  if (!report) {
    return (
      <EmptyState
        icon={<Sparkles size={22} />}
        title={req.status === 'analyzing' ? 'AI 正在分析需求…' : '尚未生成需求报告'}
        desc={
          req.status === 'analyzing'
            ? '正在结合工程架构与代码事实，推导影响面与修改范围，稍候即可看到报告。'
            : '点击右上角「分析需求」，AI 会产出一份包含影响面、接口变更、前后端修改范围的报告。'
        }
      />
    );
  }
  const levelColor = {
    high: 'text-rose-700 bg-rose-50 border-rose-200',
    medium: 'text-amber-700 bg-amber-50 border-amber-200',
    low: 'text-slate-300 bg-ink-800 border-slate-600/40',
  };
  const levelLabel = { high: '影响大', medium: '影响中', low: '影响小' };

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <div className="mb-1.5 flex items-center gap-2">
          <Sparkles size={14} className="text-sky-600" />
          <span className="text-[13px] font-semibold text-slate-100">需求摘要</span>
          <span className="ml-auto text-[10.5px] text-slate-500">
            {report.aiModel} {report.latencyMs ? `· ${(report.latencyMs / 1000).toFixed(1)}s` : ''}{' '}
            {report.generatedAt ? `· ${fmtDateTime(report.generatedAt)}` : ''}
          </span>
        </div>
        <p className="text-[13px] leading-relaxed text-slate-200">{report.summary}</p>
        {report.background && (
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-500">{report.background}</p>
        )}
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <BulletList title="目标" items={report.goals} tone="sky" />
          <BulletList title="验收标准" items={report.acceptanceCriteria} tone="emerald" />
        </div>
      </div>

      <div className="card p-4">
        <div className="mb-2 flex items-center gap-2">
          <AlertTriangle size={13} className="text-amber-400" />
          <span className="text-[13px] font-semibold text-slate-100">影响面（{report.impact.length} 个工程）</span>
        </div>
        <div className="space-y-2">
          {report.impact.map((i) => (
            <div key={i.repoId} className="rounded-lg border border-ink-700 bg-ink-950 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] font-medium text-slate-100">{i.repoName}</span>
                <Chip className={classNames('border', ROLE_META[i.role]?.color ?? '')}>
                  {ROLE_META[i.role]?.label ?? i.role}
                </Chip>
                <Chip className={classNames('border', levelColor[i.level])}>{levelLabel[i.level] ?? i.level}</Chip>
                {i.areas.map((a) => (
                  <Chip key={a} className="border-ink-700 bg-ink-800 text-[10px] text-slate-400">
                    {a}
                  </Chip>
                ))}
              </div>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-slate-400">{i.reason}</p>
              {i.files.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {i.files.slice(0, 8).map((f) => (
                    <span
                      key={f}
                      className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400"
                      title={f}
                    >
                      {f.replace(/^.*?(?=(src|app|packages|services|internal)\/)/, '')}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {report.apiChanges.length > 0 && (
        <div className="card p-4">
          <div className="mb-2 text-[13px] font-semibold text-slate-100">接口变更（{report.apiChanges.length}）</div>
          <div className="overflow-hidden rounded-lg border border-ink-700">
            <table className="w-full text-[11.5px]">
              <thead className="bg-ink-800 text-[10.5px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-2.5 py-1.5 text-left">方法</th>
                  <th className="px-2.5 py-1.5 text-left">路径</th>
                  <th className="px-2.5 py-1.5 text-left">类型</th>
                  <th className="px-2.5 py-1.5 text-left">说明</th>
                </tr>
              </thead>
              <tbody>
                {report.apiChanges.map((a, i) => (
                  <tr key={i} className="border-t border-ink-700">
                    <td className="px-2.5 py-1.5">
                      <span
                        className={classNames(
                          'chip border font-mono text-[10px]',
                          a.method === 'GET'
                            ? 'border-sky-200 bg-sky-50 text-sky-700'
                            : a.method === 'DELETE'
                              ? 'border-rose-200 bg-rose-50 text-rose-700'
                              : 'border-emerald-200 bg-emerald-50 text-emerald-700',
                        )}
                      >
                        {a.method}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 font-mono text-[11px] text-slate-200">{a.path}</td>
                    <td className="px-2.5 py-1.5">
                      <Chip
                        className={classNames(
                          'border',
                          a.kind === 'new'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : a.kind === 'removed'
                              ? 'border-rose-200 bg-rose-50 text-rose-700'
                              : 'border-amber-200 bg-amber-50 text-amber-700',
                        )}
                      >
                        {a.kind === 'new' ? '新增' : a.kind === 'removed' ? '删除' : '修改'}
                      </Chip>
                    </td>
                    <td className="px-2.5 py-1.5 text-slate-400">{a.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="card p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-sky-700">🖥 前端修改范围</div>
          <ul className="space-y-1.5">
            {report.frontendScope.length ? (
              report.frontendScope.map((s, i) => (
                <li key={i} className="flex gap-2 text-[11.5px] leading-relaxed text-slate-300">
                  <ArrowRight size={11} className="mt-1 shrink-0 text-sky-500/70" />
                  {s}
                </li>
              ))
            ) : (
              <li className="text-[11.5px] text-slate-500">无前端改动</li>
            )}
          </ul>
        </div>
        <div className="card p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-violet-700">
            ⚙️ 后端修改范围
          </div>
          <ul className="space-y-1.5">
            {report.backendScope.length ? (
              report.backendScope.map((s, i) => (
                <li key={i} className="flex gap-2 text-[11.5px] leading-relaxed text-slate-300">
                  <ArrowRight size={11} className="mt-1 shrink-0 text-violet-500/70" />
                  {s}
                </li>
              ))
            ) : (
              <li className="text-[11.5px] text-slate-500">无后端改动</li>
            )}
          </ul>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <BulletList title="⚠️ 风险" items={report.risks} tone="rose" card />
        <BulletList title="🧪 测试计划" items={report.testPlan} tone="emerald" card />
        {report.dataModelChanges.length > 0 && (
          <BulletList title="🗄 数据模型变化" items={report.dataModelChanges} tone="violet" card />
        )}
        {report.assumptions.length > 0 && (
          <BulletList title="❓ 假设与待确认" items={report.assumptions} tone="amber" card />
        )}
        {report.outOfScope.length > 0 && (
          <BulletList title="🚫 不在本次范围" items={report.outOfScope} tone="slate" card />
        )}
        {report.estimates.length > 0 && (
          <div className="card p-4">
            <div className="mb-2 text-[13px] font-semibold text-slate-100">📊 工作量估算</div>
            <div className="space-y-1">
              {report.estimates.map((e) => (
                <div key={e.repoId} className="flex items-center gap-2 text-[11.5px]">
                  <span className="text-slate-300">{e.repoName}</span>
                  <span className="text-slate-500">{e.files} 文件</span>
                  <span className="ml-auto chip border border-ink-700 bg-ink-800 text-slate-300">{e.points} pt</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BulletList({ title, items, tone, card }: { title: string; items: string[]; tone: string; card?: boolean }) {
  const color =
    tone === 'emerald'
      ? 'text-emerald-400'
      : tone === 'rose'
        ? 'text-rose-400'
        : tone === 'amber'
          ? 'text-amber-400'
          : tone === 'violet'
            ? 'text-violet-400'
            : tone === 'sky'
              ? 'text-sky-400'
              : 'text-slate-400';
  const body = (
    <>
      <div className="mb-1.5 text-[12px] font-semibold text-slate-200">{title}</div>
      <ul className="space-y-1">
        {items.length ? (
          items.map((t, i) => (
            <li key={i} className="flex gap-2 text-[11.5px] leading-relaxed text-slate-400">
              <span className={classNames('mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current', color)} />
              {t}
            </li>
          ))
        ) : (
          <li className="text-[11px] text-slate-500">无</li>
        )}
      </ul>
    </>
  );
  return card ? <div className="card p-4">{body}</div> : <div>{body}</div>;
}

function AcceptanceTab({ req }: { req: Requirement }) {
  const a = req.acceptance;
  if (!a) {
    return (
      <EmptyState
        icon={<ShieldCheck size={22} />}
        title={req.status === 'accepting' ? 'AI 正在验收…' : '尚未验收'}
        desc="研发完成后点击「AI 验收」，会先执行构建/类型检查等自动化校验，再由 AI 逐条核对验收标准。"
      />
    );
  }
  const verdictMeta =
    a.verdict === 'fail'
      ? { label: '验收未通过', color: 'text-rose-700', bg: 'border-rose-200 bg-rose-50' }
      : a.verdict === 'pass_with_notes'
        ? { label: '通过（有备注）', color: 'text-amber-700', bg: 'border-amber-200 bg-amber-50' }
        : { label: '验收通过', color: 'text-emerald-700', bg: 'border-emerald-200 bg-emerald-50' };

  const counts = a.checks.reduce(
    (acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="space-y-3">
      <div className={classNames('card flex flex-wrap items-center gap-4 p-4', verdictMeta.bg)}>
        <ScoreRing score={a.score} />
        <div className="min-w-0 flex-1">
          <div className={classNames('text-[14px] font-semibold', verdictMeta.color)}>{verdictMeta.label}</div>
          <p className="mt-1 text-[12px] leading-relaxed text-slate-300">{a.summary}</p>
          <div className="mt-1.5 flex flex-wrap gap-2 text-[10.5px] text-slate-500">
            <span>通过 {counts.pass ?? 0}</span>
            <span className="text-amber-400">警告 {counts.warn ?? 0}</span>
            <span className="text-rose-400">不通过 {counts.fail ?? 0}</span>
            <span>跳过 {counts.skipped ?? 0}</span>
            <span className="text-slate-500">
              · {a.aiModel} · {fmtDateTime(a.generatedAt)}
            </span>
          </div>
        </div>
      </div>

      <div className="card divide-y divide-ink-700">
        {a.checks.map((c) => (
          <CheckRow key={c.id} check={c} />
        ))}
      </div>

      {a.perRepo.length > 0 && (
        <div className="card p-4">
          <div className="mb-2 text-[13px] font-semibold text-slate-100">分工程结论</div>
          <div className="grid gap-2 md:grid-cols-2">
            {a.perRepo.map((p) => (
              <div key={p.repoName} className="rounded-lg border border-ink-700 bg-ink-950 p-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium text-slate-200">{p.repoName}</span>
                  <Chip
                    className={classNames(
                      'border',
                      /通过/.test(p.verdict)
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : /不通过/.test(p.verdict)
                          ? 'border-rose-200 bg-rose-50 text-rose-700'
                          : 'border-amber-200 bg-amber-50 text-amber-700',
                    )}
                  >
                    {p.verdict || '—'}
                  </Chip>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{p.notes}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {a.followUps.length > 0 && <BulletList title="📌 建议后续处理" items={a.followUps} tone="sky" card />}

      {req.userConfirmation && (
        <div
          className={classNames(
            'card p-3',
            req.userConfirmation.decision === 'approve' ? 'border-emerald-200' : 'border-rose-200',
          )}
        >
          <div className="text-[11.5px] text-slate-400">
            用户在 {fmtDateTime(req.userConfirmation.confirmedAt)}{' '}
            {req.userConfirmation.decision === 'approve' ? '确认完成' : '驳回返工'}
            {req.userConfirmation.note ? `：${req.userConfirmation.note}` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

function CheckRow({ check }: { check: AcceptanceCheck }) {
  const [open, setOpen] = useState(false);
  const tone =
    check.status === 'pass'
      ? 'text-emerald-400'
      : check.status === 'fail'
        ? 'text-rose-400'
        : check.status === 'warn'
          ? 'text-amber-400'
          : 'text-slate-500';
  const Icon =
    check.status === 'pass'
      ? CheckCircle2
      : check.status === 'fail'
        ? XCircle
        : check.status === 'warn'
          ? AlertTriangle
          : CircleDot;
  return (
    <div className="px-3 py-2">
      <div className="flex items-start gap-2">
        <Icon size={13} className={classNames('mt-0.5 shrink-0', tone)} />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] text-slate-200">{check.title}</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{check.detail}</div>
        </div>
        {check.evidence && check.evidence.length > 0 && (
          <button onClick={() => setOpen((o) => !o)} className="shrink-0 text-[10px] text-slate-500 hover:text-sky-600">
            {open ? '收起' : '证据'}
          </button>
        )}
      </div>
      {open && check.evidence && (
        <pre className="mt-1.5 max-h-52 overflow-auto rounded bg-ink-950 p-2 font-mono text-[10.5px] leading-relaxed text-slate-400">
          {check.evidence.join('\n')}
        </pre>
      )}
    </div>
  );
}

function ActivityTab({ logs }: { logs: ReturnType<typeof useRequirementDetail>['logs'] }) {
  const levelColor: Record<string, string> = {
    info: 'text-slate-400',
    tool: 'text-sky-700',
    llm: 'text-violet-700',
    warn: 'text-amber-700',
    error: 'text-rose-700',
    success: 'text-emerald-700',
  };
  if (!logs.length)
    return (
      <EmptyState
        icon={<Terminal size={22} />}
        title="暂无执行日志"
        desc="AI 执行分析、研发、验收时会在这里实时输出过程日志。"
      />
    );
  return (
    <div className="card max-h-[560px] overflow-y-auto p-0">
      <div className="divide-y divide-ink-700">
        {logs.map((l) => (
          <div key={l.id} className="flex gap-2 px-3 py-1.5 font-mono text-[11px] leading-relaxed">
            <span className="w-16 shrink-0 text-slate-500">
              {new Date(l.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}
            </span>
            <span className={classNames('w-12 shrink-0 uppercase', levelColor[l.level])}>{l.level}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-slate-300">{l.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
