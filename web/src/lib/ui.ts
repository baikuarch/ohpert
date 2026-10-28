import type { RepoRole, RequirementStatus } from '../types';

export const ROLE_META: Record<RepoRole, { label: string; color: string; ring: string; icon: string }> = {
  frontend: { label: '前端', color: 'text-sky-700 bg-sky-50 border-sky-200', ring: 'ring-sky-500/40', icon: '🖥' },
  backend: {
    label: '后端',
    color: 'text-violet-700 bg-violet-50 border-violet-200',
    ring: 'ring-violet-500/40',
    icon: '⚙️',
  },
  fullstack: { label: '全栈', color: 'text-teal-700 bg-teal-50 border-teal-200', ring: 'ring-teal-500/40', icon: '🧩' },
  library: {
    label: '库/SDK',
    color: 'text-amber-700 bg-amber-50 border-amber-200',
    ring: 'ring-amber-500/40',
    icon: '📦',
  },
  mobile: {
    label: '移动端',
    color: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    ring: 'ring-emerald-500/40',
    icon: '📱',
  },
  infra: { label: '基础设施', color: 'text-slate-400 bg-ink-800 border-ink-700', ring: 'ring-slate-500/40', icon: '🛠' },
  unknown: {
    label: '未识别',
    color: 'text-slate-400 bg-ink-800 border-ink-700',
    ring: 'ring-slate-500/30',
    icon: '❓',
  },
};

export const STATUS_META: Record<RequirementStatus, { label: string; color: string; step: number }> = {
  draft: { label: '草稿', color: 'text-slate-400 bg-ink-800 border-ink-700', step: 0 },
  queued: { label: '排队中', color: 'text-amber-700 bg-amber-50 border-amber-200', step: 1 },
  analyzing: { label: 'AI 分析中', color: 'text-amber-700 bg-amber-50 border-amber-200', step: 1 },
  analyzed: { label: '已出需求报告', color: 'text-sky-700 bg-sky-50 border-sky-200', step: 2 },
  implementing: { label: 'AI 研发中', color: 'text-violet-700 bg-violet-50 border-violet-200', step: 3 },
  implemented: { label: '待验收', color: 'text-cyan-700 bg-cyan-50 border-cyan-200', step: 4 },
  accepting: { label: 'AI 验收中', color: 'text-cyan-700 bg-cyan-50 border-cyan-200', step: 4 },
  awaiting_approval: { label: '待你确认', color: 'text-emerald-700 bg-emerald-50 border-emerald-200', step: 5 },
  completed: { label: '已完成', color: 'text-emerald-700 bg-emerald-50 border-emerald-200', step: 6 },
  needs_rework: { label: '需返工', color: 'text-rose-700 bg-rose-50 border-rose-200', step: 3 },
  rejected: { label: '已驳回', color: 'text-rose-700 bg-rose-50 border-rose-200', step: 0 },
  failed: { label: '失败', color: 'text-rose-700 bg-rose-50 border-rose-200', step: 0 },
};

export const PRIORITY_META: Record<string, { label: string; color: string }> = {
  low: { label: '低', color: 'text-slate-500 border-ink-600' },
  normal: { label: '普通', color: 'text-sky-700 border-sky-200' },
  high: { label: '高', color: 'text-amber-700 border-amber-200' },
  urgent: { label: '紧急', color: 'text-rose-700 border-rose-200' },
};

export const PIPELINE_STEPS = [
  { key: 'queued', label: '入队', icon: '📥' },
  { key: 'analyzed', label: '需求分析', icon: '🔍' },
  { key: 'implemented', label: '研发', icon: '🛠' },
  { key: 'awaiting_approval', label: '验收', icon: '✅' },
  { key: 'completed', label: '确认完成', icon: '🏁' },
];

export function fmtTime(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

export function fmtDateTime(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

export function shortPath(p: string, max = 52) {
  if (p.length <= max) return p;
  const parts = p.split('/');
  if (parts.length < 3) return '…' + p.slice(-max);
  return `…/${parts.slice(-2).join('/')}`;
}

export function classNames(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(' ');
}

export function fmtNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
