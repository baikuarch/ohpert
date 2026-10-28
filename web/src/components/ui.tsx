import type { ReactNode } from 'react';
import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { classNames } from '../lib/ui';

export function StatusDot({
  tone = 'idle',
  pulse = false,
}: {
  tone?: 'ok' | 'warn' | 'err' | 'idle' | 'run';
  pulse?: boolean;
}) {
  const color =
    tone === 'ok'
      ? 'bg-emerald-400'
      : tone === 'warn'
        ? 'bg-amber-400'
        : tone === 'err'
          ? 'bg-rose-400'
          : tone === 'run'
            ? 'bg-sky-500'
            : 'bg-slate-400';
  return <span className={classNames('inline-block h-2 w-2 rounded-full', color, pulse && 'animate-pulse')} />;
}

export function Chip({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={classNames('chip border', className ?? 'border-ink-700 bg-ink-800 text-slate-300')}>
      {children}
    </span>
  );
}

export function SectionTitle({
  icon,
  title,
  desc,
  right,
}: {
  icon?: ReactNode;
  title: string;
  desc?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div>
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-slate-100">
          {icon}
          {title}
        </h2>
        {desc && <p className="mt-0.5 text-xs text-slate-500">{desc}</p>}
      </div>
      {right}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={classNames('card', className)}>{children}</div>;
}

export function EmptyState({
  icon,
  title,
  desc,
  action,
}: {
  icon: ReactNode;
  title: string;
  desc?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-ink-700 px-6 py-14 text-center">
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-xl border border-ink-700 bg-ink-900 text-slate-500">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
      {desc && <p className="mt-1 max-w-md text-xs leading-relaxed text-slate-500">{desc}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ProgressBar({
  value,
  tone = 'accent',
  indeterminate,
}: {
  value: number;
  tone?: 'accent' | 'amber' | 'emerald' | 'rose';
  indeterminate?: boolean;
}) {
  const bg =
    tone === 'amber'
      ? 'bg-amber-400'
      : tone === 'emerald'
        ? 'bg-emerald-400'
        : tone === 'rose'
          ? 'bg-rose-400'
          : 'bg-sky-500';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
      {indeterminate ? (
        <div className={classNames('h-full w-1/3 rounded-full', bg, 'animate-[shimmer_1.2s_linear_infinite]')} />
      ) : (
        <div
          className={classNames('h-full rounded-full transition-all duration-500', bg)}
          style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
        />
      )}
    </div>
  );
}

export function KeyValue({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 text-[12px]">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className={classNames('text-right text-slate-300', mono && 'mono break-all')}>{children}</span>
    </div>
  );
}

export function Collapsible({
  title,
  subtitle,
  children,
  defaultOpen = false,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-950">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-slate-500" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-slate-500" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-slate-200">{title}</div>
          {subtitle && <div className="truncate text-[11px] text-slate-500">{subtitle}</div>}
        </div>
        {right}
      </button>
      {open && <div className="border-t border-ink-700 px-3 py-2.5">{children}</div>}
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="rounded p-1 text-slate-500 hover:bg-ink-800 hover:text-slate-200"
      title="复制"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* ignore */
        }
      }}
    >
      <Copy size={12} className={done ? 'text-emerald-400' : ''} />
    </button>
  );
}

export function ScoreRing({ score }: { score: number }) {
  const tone = score >= 85 ? '#059669' : score >= 65 ? '#0284c7' : score >= 45 ? '#d97706' : '#e11d48';
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-[68px] w-[68px] shrink-0">
      <svg viewBox="0 0 64 64" className="h-full w-full -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="#e6eaf1" strokeWidth="6" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - (c * Math.max(0, Math.min(100, score))) / 100}
          style={{ transition: 'stroke-dashoffset .6s ease' }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <span className="text-[17px] font-bold" style={{ color: tone }}>
          {score}
        </span>
      </div>
    </div>
  );
}
