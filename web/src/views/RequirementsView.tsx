import { useMemo, useState } from 'react';
import { ArrowRight, Inbox, Loader2, Plus, Send, Sparkles, X } from 'lucide-react';
import { api } from '../lib/api';
import { PRIORITY_META, STATUS_META, classNames, fmtTime } from '../lib/ui';
import { useApp } from '../store/app';
import type { Requirement } from '../types';
import { Chip, EmptyState, SectionTitle } from '../components/ui';

const ACTIVE = [
  'queued',
  'analyzing',
  'analyzed',
  'implementing',
  'implemented',
  'accepting',
  'awaiting_approval',
  'needs_rework',
  'draft',
  'failed',
];

export function RequirementsView() {
  const { requirements, go, stats, repos, architecture, requirements: all } = useApp();
  const [composerOpen, setComposerOpen] = useState(false);

  const active = useMemo(
    () =>
      requirements
        .filter((r) => ACTIVE.includes(r.status))
        .sort((a, b) => {
          const pa = { urgent: 0, high: 1, normal: 2, low: 3 }[a.priority] ?? 2;
          const pb = { urgent: 0, high: 1, normal: 2, low: 3 }[b.priority] ?? 2;
          return pa - pb || b.seq - a.seq;
        }),
    [requirements],
  );
  const waiting = active.filter((r) => r.status === 'awaiting_approval');
  const inFlight = active.filter((r) => ['analyzing', 'implementing', 'accepting'].includes(r.status));
  const queued = active.filter((r) => r.status === 'queued');

  return (
    <div className="mx-auto max-w-[1400px] px-7 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-slate-100">需求队列</h1>
          <p className="mt-1 text-[12.5px] text-slate-500">
            输入需求后会进入队列，AI 依次分析影响面 → 研发 → 自我验收，最后由你确认。
          </p>
        </div>
        <button className="btn-primary" onClick={() => setComposerOpen(true)} disabled={!repos.length}>
          <Plus size={15} /> 录入需求
        </button>
      </div>

      {!repos.length && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          <Sparkles size={14} /> 请先在「工程与架构」中添加并分析 Git 工程，然后再录入需求。
        </div>
      )}
      {repos.length > 0 && !architecture && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-[12px] text-sky-800">
          <Sparkles size={14} /> 尚未生成架构图谱，需求分析的影响面判断会不够准确，建议先到「工程与架构」执行 AI 分析。
        </div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatCard label="队列中" value={queued.length} tone="amber" hint="等待 AI 分析" />
        <StatCard label="进行中" value={inFlight.length} tone="violet" hint="分析 / 研发 / 验收" />
        <StatCard label="待你确认" value={waiting.length} tone="emerald" hint="AI 已完成验收" />
        <StatCard label="已完成" value={stats.completed} tone="slate" hint="进入历史队列" />
      </div>

      {composerOpen && (
        <RequirementComposer onClose={() => setComposerOpen(false)} onCreated={(r) => go('requirement', r.id)} />
      )}

      <SectionTitle
        icon={<Inbox size={15} className="text-sky-600" />}
        title={`进行中的需求 (${active.length})`}
        desc="点击任意需求查看分析报告、代码改动与验收结果"
      />

      {active.length === 0 ? (
        <EmptyState
          icon={<Inbox size={22} />}
          title="队列是空的"
          desc="录入一条需求，例如「订单列表增加批量取消功能，后端新增批量取消接口，前端增加多选与按钮」。"
          action={
            <button className="btn-primary" disabled={!repos.length} onClick={() => setComposerOpen(true)}>
              <Plus size={15} /> 录入第一条需求
            </button>
          }
        />
      ) : (
        <div className="space-y-2">
          {active.map((req) => (
            <RequirementRow key={req.id} req={req} onClick={() => go('requirement', req.id)} />
          ))}
        </div>
      )}

      {all.some((r) => r.status === 'completed') && (
        <button
          className="mt-6 flex items-center gap-1 text-[12px] text-slate-500 hover:text-sky-600"
          onClick={() => go('history')}
        >
          查看已完成历史 <ArrowRight size={12} />
        </button>
      )}
      <div className="h-8" />
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone: 'amber' | 'violet' | 'emerald' | 'slate';
  hint: string;
}) {
  const color =
    tone === 'amber'
      ? 'text-amber-700'
      : tone === 'violet'
        ? 'text-violet-700'
        : tone === 'emerald'
          ? 'text-emerald-700'
          : 'text-slate-300';
  return (
    <div className="card px-3.5 py-3">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={classNames('mt-0.5 text-[22px] font-bold leading-none', color)}>{value}</div>
      <div className="mt-1 text-[10px] text-slate-500">{hint}</div>
    </div>
  );
}

export function RequirementRow({ req, onClick, dim }: { req: Requirement; onClick: () => void; dim?: boolean }) {
  const st = STATUS_META[req.status];
  const pr = PRIORITY_META[req.priority] ?? PRIORITY_META.normal;
  const impacted = req.report?.impact.length ?? 0;
  const busy = ['analyzing', 'implementing', 'accepting'].includes(req.status);
  return (
    <button
      onClick={onClick}
      className={classNames(
        'group w-full rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-left transition hover:border-ink-600 hover:bg-ink-800',
        dim && 'opacity-80',
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[11px] text-slate-500">#{req.seq}</span>
        <span className={classNames('chip border', st.color, busy && 'animate-pulse-slow')}>
          {busy && <Loader2 size={9} className="animate-spin" />}
          {st.label}
        </span>
        <span className="truncate text-[13.5px] font-medium text-slate-100">{req.title}</span>
        <span className={classNames('chip ml-auto border shrink-0', pr.color)}>{pr.label}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span className="line-clamp-1 max-w-[560px]">{req.report?.summary || req.description}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-[10.5px] text-slate-500">
        <span>{fmtTime(req.createdAt)}</span>
        {impacted > 0 && (
          <span className="text-slate-500">
            影响 {impacted} 个工程：{req.report!.impact.map((i) => i.repoName).join('、')}
          </span>
        )}
        {req.implementation && (
          <span>
            {req.implementation.diffStat.files} 文件 +{req.implementation.diffStat.additions}/-
            {req.implementation.diffStat.deletions}
          </span>
        )}
        {req.reworkRounds > 0 && <span className="text-rose-600">返工 {req.reworkRounds} 轮</span>}
        <ArrowRight size={11} className="ml-auto opacity-0 transition group-hover:opacity-100" />
      </div>
    </button>
  );
}

const TEMPLATES = [
  {
    label: '新增接口 + 前端页面',
    title: '订单批量取消',
    text: '用户可以在订单列表页面勾选多个待支付订单，一次性批量取消。\n后端提供 POST /api/orders/batch-cancel 接口，接收订单 id 数组，校验归属与状态后批量取消，返回成功/失败明细。\n前端订单列表增加多选框、全选与「批量取消」按钮，调用新接口后刷新列表。',
  },
  {
    label: '字段扩展（前后端）',
    title: '订单增加备注字段',
    text: '下单时可以填写备注（最多 100 字），订单详情与列表中展示备注。\n后端需要新增 remark 字段的校验与存储，前端下单页与详情页需要展示。',
  },
  {
    label: '修复缺陷',
    title: '退出登录后仍可访问列表',
    text: '用户退出登录后 token 已清除，但订单列表页面仍能打开并触发请求，期望：未登录时跳转到登录页。请检查前端路由守卫与请求拦截器。',
  },
];

function RequirementComposer({ onClose, onCreated }: { onClose: () => void; onCreated: (r: Requirement) => void }) {
  const { notify, refresh } = useApp();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Requirement['priority']>('normal');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!description.trim()) {
      notify('err', '请填写需求描述');
      return;
    }
    setBusy(true);
    try {
      const res = await api.createRequirement({
        title: title.trim(),
        description: description.trim(),
        priority,
        enqueue: true,
      });
      notify('ok', `需求 #${res.requirement.seq} 已入队，AI 将开始分析`);
      await refresh();
      onCreated(res.requirement);
      onClose();
    } catch (e) {
      notify('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/25 p-6 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-[680px] overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-[0_12px_32px_-8px_rgba(16,24,40,0.18),0_2px_8px_rgba(16,24,40,0.06)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-3.5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Send size={15} className="text-sky-600" /> 录入需求
          </h3>
          <button className="rounded p-1 text-slate-500 hover:bg-ink-800 hover:text-slate-100" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="space-y-3 px-5 py-4">
          <div>
            <label className="label">需求标题（可留空，自动取描述首行）</label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：订单批量取消"
            />
          </div>
          <div>
            <label className="label">
              详细描述 <span className="text-slate-500">· 写得越具体，AI 的影响面分析越准确</span>
            </label>
            <textarea
              className="input min-h-[168px] resize-y leading-relaxed"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                '描述业务目标、期望的后端接口、前端交互、边界条件等…\n例如：\n- 后端新增 POST /api/orders/batch-cancel，入参 { ids: string[] }\n- 只允许取消本人且状态为 pending 的订单\n- 前端订单列表支持多选 + 批量取消按钮'
              }
            />
          </div>
          <div className="flex items-center gap-3">
            <div>
              <label className="label">优先级</label>
              <div className="flex gap-1.5">
                {(['low', 'normal', 'high', 'urgent'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPriority(p)}
                    className={classNames(
                      'rounded-md border px-2.5 py-1 text-[11.5px] transition',
                      priority === p
                        ? 'border-sky-400 bg-sky-100 text-sky-700'
                        : 'border-ink-700 text-slate-400 hover:border-ink-600',
                    )}
                  >
                    {PRIORITY_META[p].label}
                  </button>
                ))}
              </div>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <span className="text-[10.5px] text-slate-500">模板：</span>
              {TEMPLATES.map((t) => (
                <Chip
                  key={t.label}
                  className="cursor-pointer border-ink-700 bg-ink-900 text-[10.5px] text-slate-400 hover:border-sky-300 hover:text-sky-700"
                  title={t.text.slice(0, 60)}
                >
                  <span
                    onClick={() => {
                      setTitle(t.title);
                      setDescription(t.text);
                    }}
                  >
                    {t.label}
                  </span>
                </Chip>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-ink-700 px-5 py-3">
          <span className="text-[11px] text-slate-500">提交后立即进入队列，AI 会自动开始分析</span>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose}>
              取消
            </button>
            <button className="btn-primary" onClick={submit} disabled={busy}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} 提交并入队
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
