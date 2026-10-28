import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2, Pencil, RefreshCw, Search, AlertTriangle, X } from 'lucide-react';
import type { GatewayModel } from '../lib/api';
import { classNames } from '../lib/ui';

export interface ModelFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  models: GatewayModel[];
  loading: boolean;
  error: string | null;
  placeholder?: string;
  hint?: string;
  /** show a "clear / use default" action when empty means fallback */
  allowEmpty?: boolean;
}

function fmtContext(n?: number) {
  if (!n) return '';
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/**
 * A combobox: pick a model discovered from the gateway, or type any custom id.
 * Rendered in a portal so it is never clipped by the settings card.
 */
export function ModelSelect({
  label,
  value,
  onChange,
  models,
  loading,
  error,
  placeholder,
  hint,
  allowEmpty,
}: ModelFieldProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [custom, setCustom] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0, openUp: false });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const current = models.find((m) => m.id === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }, [models, query]);

  const place = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const menuHeight = Math.min(320, 56 + filtered.length * 40 + 40);
    const openUp = r.bottom + menuHeight + 12 > window.innerHeight && r.top > menuHeight;
    setPos({ top: openUp ? r.top - 6 : r.bottom + 6, left: r.left, width: r.width, openUp });
  };

  useLayoutEffect(() => {
    if (open) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filtered.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => place();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    const t = setTimeout(() => (custom ? inputRef.current : searchRef.current)?.focus(), 20);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, custom]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQuery('');
    setCustom(false);
  };

  return (
    <div>
      <label className="label flex items-center justify-between gap-2">
        <span>{label}</span>
        {allowEmpty && value && (
          <button
            type="button"
            className="text-[10.5px] font-normal text-slate-500 hover:text-sky-600"
            onClick={() => onChange('')}
            title="清空则使用默认模型"
          >
            使用默认
          </button>
        )}
      </label>

      <div
        ref={btnRef as any}
        onClick={() => {
          setOpen((o) => !o);
          setCustom(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setCustom(false);
          }
        }}
        role="combobox"
        aria-expanded={open}
        tabIndex={0}
        className={classNames(
          'input flex cursor-pointer items-center gap-2 text-left',
          open && 'border-sky-500 ring-2 ring-sky-500/15',
        )}
      >
        <span className={classNames('min-w-0 flex-1 truncate font-mono text-[12.5px]', !value && 'text-slate-500')}>
          {value || placeholder || '选择或输入模型 ID'}
        </span>
        {current && current.name !== current.id && (
          <span className="shrink-0 truncate text-[10.5px] text-slate-500">{current.name}</span>
        )}
        {loading ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-slate-500" />
        ) : (
          <ChevronDown size={13} className={classNames('shrink-0 text-slate-500 transition', open && 'rotate-180')} />
        )}
      </div>

      {hint && <div className="mt-1 text-[10.5px] text-slate-500">{hint}</div>}

      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[60] overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-[0_12px_32px_-8px_rgba(16,24,40,0.18),0_2px_8px_rgba(16,24,40,0.06)]"
            style={{
              left: pos.left,
              width: pos.width,
              top: pos.openUp ? undefined : pos.top,
              bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
            }}
          >
            <div className="flex items-center gap-1.5 border-b border-ink-700 px-2 py-1.5">
              <Search size={12} className="shrink-0 text-slate-500" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`搜索 ${models.length} 个可用模型…`}
                className="min-w-0 flex-1 bg-transparent text-[12px] text-slate-200 placeholder:text-slate-500 focus:outline-none"
              />
              {query && (
                <button onClick={() => setQuery('')} className="shrink-0 text-slate-500 hover:text-slate-300">
                  <X size={12} />
                </button>
              )}
            </div>

            {error ? (
              <div className="flex items-start gap-2 px-3 py-3 text-[11.5px] text-amber-700">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1 break-words">{error}</span>
              </div>
            ) : loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-[11.5px] text-slate-500">
                <Loader2 size={13} className="animate-spin" /> 正在从网关获取模型列表…
              </div>
            ) : models.length === 0 ? (
              <div className="px-3 py-4 text-[11.5px] text-slate-500">网关没有返回任何模型，可直接输入模型 ID。</div>
            ) : (
              <div className="max-h-[248px] overflow-y-auto py-1">
                {filtered.map((m) => {
                  const active = m.id === value;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => pick(m.id)}
                      className={classNames(
                        'flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-ink-800',
                        active && 'bg-sky-50',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className={classNames(
                            'block truncate font-mono text-[12px]',
                            active ? 'text-sky-700' : 'text-slate-200',
                          )}
                        >
                          {m.id}
                        </span>
                        <span className="block truncate text-[10.5px] text-slate-500">
                          {m.name}
                          {m.contextWindow ? ` · ${fmtContext(m.contextWindow)} 上下文` : ''}
                          {m.ownedBy ? ` · ${m.ownedBy}` : ''}
                        </span>
                      </span>
                      {active && <Check size={13} className="shrink-0 text-sky-600" />}
                    </button>
                  );
                })}
                {filtered.length === 0 && (
                  <div className="px-3 py-3 text-[11.5px] text-slate-500">没有匹配 “{query}” 的模型</div>
                )}
              </div>
            )}

            <div className="border-t border-ink-700 p-1.5">
              {custom ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = inputRef.current?.value.trim();
                    if (v) pick(v);
                  }}
                  className="flex items-center gap-1.5"
                >
                  <input
                    ref={inputRef}
                    defaultValue={query || value}
                    placeholder="输入任意模型 ID，回车确认"
                    className="min-w-0 flex-1 rounded-md border border-ink-700 px-2 py-1 font-mono text-[11.5px] text-slate-200 placeholder:text-slate-500 focus:border-sky-500 focus:outline-none"
                  />
                  <button type="submit" className="btn-primary !px-2 !py-1 !text-[11px]">
                    使用
                  </button>
                  <button
                    type="button"
                    onClick={() => setCustom(false)}
                    className="rounded p-1 text-slate-500 hover:text-slate-300"
                  >
                    <X size={12} />
                  </button>
                </form>
              ) : (
                <div className="flex items-center justify-between gap-1">
                  <button
                    type="button"
                    onClick={() => setCustom(true)}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] text-slate-500 transition hover:bg-ink-800 hover:text-sky-600"
                  >
                    <Pencil size={11} /> 自定义输入模型 ID
                  </button>
                  {models.length > 0 && <span className="pr-1 text-[10px] text-slate-500">共 {models.length} 个</span>}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

export function ModelRefreshBar({
  loading,
  count,
  error,
  fetchedAt,
  onRefresh,
  baseURL,
}: {
  loading: boolean;
  count: number;
  error: string | null;
  fetchedAt: string | null;
  onRefresh: () => void;
  baseURL: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-[11px]">
      <span className="text-slate-500">网关模型</span>
      {loading ? (
        <span className="flex items-center gap-1 text-slate-500">
          <Loader2 size={11} className="animate-spin" /> 获取中…
        </span>
      ) : error ? (
        <span className="flex min-w-0 flex-1 items-center gap-1 text-amber-700" title={error}>
          <AlertTriangle size={11} className="shrink-0" />
          <span className="truncate">{error}</span>
        </span>
      ) : (
        <span className="text-emerald-700">
          ✓ 已获取 {count} 个模型
          {fetchedAt ? ` · ${new Date(fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}
        </span>
      )}
      <span className="ml-auto truncate font-mono text-[10.5px] text-slate-500" title={baseURL}>
        {baseURL}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className="flex shrink-0 items-center gap-1 rounded-md border border-ink-700 px-2 py-0.5 text-slate-500 transition hover:border-ink-600 hover:text-sky-600 disabled:opacity-40"
      >
        <RefreshCw size={10} className={loading ? 'animate-spin' : ''} /> 刷新列表
      </button>
    </div>
  );
}
