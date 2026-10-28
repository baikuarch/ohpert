import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowUp, Check, FolderGit2, Folder, Loader2, Search, X, Home } from 'lucide-react';
import { api } from '../lib/api';
import { classNames, shortPath } from '../lib/ui';
import { useApp } from '../store/app';

interface Props {
  open: boolean;
  onClose: () => void;
  onAdded: (paths: string[]) => void;
}

export function RepoPicker({ open, onClose, onAdded }: Props) {
  const { repos, notify } = useApp();
  const [current, setCurrent] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<{ name: string; path: string; isGit: boolean }[]>([]);
  const [roots, setRoots] = useState<string[]>([]);
  const [isGitRepo, setIsGitRepo] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<{ name: string; path: string; isGit: boolean }[]>([]);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  const existing = useMemo(() => new Set(repos.map((r) => r.path)), [repos]);

  const load = useCallback(async (path?: string) => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api.listDirs(path);
      setCurrent(res.path);
      setParent(res.parent);
      setEntries(res.entries);
      setRoots(res.roots ?? []);
      setIsGitRepo(res.isGitRepo);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && !current) void load();
  }, [open, current, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api.searchDirs(query.trim(), roots[0]);
        setResults(res.results);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 320);
    return () => clearTimeout(t);
  }, [query, roots]);

  if (!open) return null;

  const toggle = (path: string) => setSelected((s) => (s.includes(path) ? s.filter((p) => p !== path) : [...s, path]));

  const add = async () => {
    if (!selected.length) return;
    setAdding(true);
    try {
      const res = await api.addRepos(selected);
      if (res.added.length) {
        notify('ok', `已添加 ${res.added.length} 个工程：${res.added.map((r) => r.name).join('、')}`);
        onAdded(res.added.map((r) => r.path));
        setSelected([]);
        onClose();
      }
      if (res.skipped.length) {
        notify('info', res.skipped.map((s) => `${shortPath(s.path)}: ${s.reason}`).join('\n'));
      }
    } catch (e) {
      notify('err', (e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/25 p-6 backdrop-blur-[2px]"
      onMouseDown={onClose}
    >
      <div
        className="flex h-[600px] w-full max-w-[860px] flex-col overflow-hidden rounded-2xl border border-ink-700 bg-ink-900 shadow-[0_12px_32px_-8px_rgba(16,24,40,0.18),0_2px_8px_rgba(16,24,40,0.06)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-3.5">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <FolderGit2 size={16} className="text-sky-600" /> 选择 Git 工程目录
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              可多选；勾选后 AI 会分析这些工程之间的调用关系与业务联系
            </p>
          </div>
          <button className="rounded p-1.5 text-slate-500 hover:bg-ink-800 hover:text-slate-100" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-ink-700 px-4 py-2">
          <button className="btn-ghost !px-2 !py-1" disabled={!parent} onClick={() => parent && load(parent)}>
            <ArrowUp size={14} />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto rounded-md border border-ink-700 bg-ink-900 px-2 py-1">
            {current
              ?.split('/')
              .filter(Boolean)
              .map((seg, i, arr) => {
                const p = '/' + arr.slice(0, i + 1).join('/');
                return (
                  <button
                    key={p}
                    onClick={() => load(p)}
                    className="shrink-0 text-[11.5px] text-slate-400 hover:text-sky-600"
                  >
                    {i === 0 ? <Home size={11} className="inline" /> : seg}
                    {i < arr.length - 1 && <span className="ml-1 text-slate-500">/</span>}
                  </button>
                );
              })}
          </div>
          <div className="relative w-52">
            <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              className="input !py-1.5 !pl-7 !text-[12px]"
              placeholder="搜索目录名…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {searching && (
              <Loader2 size={12} className="absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-slate-500" />
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto p-2">
            {loading ? (
              <div className="flex h-32 items-center justify-center text-slate-500">
                <Loader2 className="animate-spin" size={18} />
              </div>
            ) : query.trim() ? (
              results.length ? (
                results.map((r) => (
                  <Row
                    key={r.path}
                    {...r}
                    checked={selected.includes(r.path)}
                    disabled={existing.has(r.path)}
                    onToggle={() => toggle(r.path)}
                    onOpen={() => load(r.path)}
                  />
                ))
              ) : (
                <div className="px-3 py-8 text-center text-xs text-slate-500">
                  没有找到匹配的目录（当前搜索范围：{roots[0]}）
                </div>
              )
            ) : entries.length ? (
              entries.map((e) => (
                <Row
                  key={e.path}
                  {...e}
                  checked={selected.includes(e.path)}
                  disabled={existing.has(e.path)}
                  onToggle={() => toggle(e.path)}
                  onOpen={() => load(e.path)}
                />
              ))
            ) : (
              <div className="px-3 py-8 text-center text-xs text-slate-500">该目录下没有子目录</div>
            )}
            {err && <div className="px-3 py-2 text-xs text-rose-400">{err}</div>}
          </div>

          <div className="w-[300px] shrink-0 border-l border-ink-700 p-4">
            <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">已选工程</div>
            {current && !query && (
              <div className="mb-3 rounded-lg border border-ink-700 bg-ink-900 p-2.5">
                <div className="truncate text-[11.5px] text-slate-400">{shortPath(current, 40)}</div>
                {isGitRepo ? (
                  existing.has(current) ? (
                    <div className="mt-1.5 text-[11px] text-slate-500">已在工程列表中</div>
                  ) : (
                    <button
                      className={classNames(
                        'mt-1.5 w-full rounded-md border px-2 py-1 text-[11.5px] transition',
                        selected.includes(current)
                          ? 'border-sky-300 bg-sky-100 text-sky-700'
                          : 'border-ink-600 text-slate-300 hover:border-sky-300',
                      )}
                      onClick={() => toggle(current)}
                    >
                      {selected.includes(current) ? '✓ 已选择当前目录' : '选择当前目录'}
                    </button>
                  )
                ) : (
                  <div className="mt-1.5 text-[11px] text-amber-700/80">当前目录不是 Git 仓库根目录</div>
                )}
              </div>
            )}

            <div className="max-h-[260px] space-y-1 overflow-y-auto">
              {selected.length === 0 && <div className="text-[11.5px] text-slate-500">尚未选择任何目录</div>}
              {selected.map((p) => (
                <div key={p} className="flex items-center gap-1.5 rounded-md bg-ink-900 px-2 py-1.5">
                  <FolderGit2 size={12} className="shrink-0 text-emerald-400" />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-slate-300" title={p}>
                    {shortPath(p, 28)}
                  </span>
                  <button onClick={() => toggle(p)} className="text-slate-500 hover:text-rose-400">
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-4 border-t border-ink-700 pt-3">
              <div className="label">或直接粘贴路径</div>
              <div className="flex gap-1.5">
                <input
                  className="input !py-1 !text-[11.5px]"
                  placeholder="~/projects/my-app"
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                />
                <button
                  className="btn-ghost !px-2 !py-1"
                  onClick={() => {
                    const p = manual.trim();
                    if (p && !selected.includes(p)) setSelected((s) => [...s, p]);
                    setManual('');
                  }}
                >
                  添加
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-ink-700 px-5 py-3">
          <div className="text-[11.5px] text-slate-500">
            已选 <span className="font-semibold text-sky-600">{selected.length}</span> 个
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose}>
              取消
            </button>
            <button className="btn-primary" disabled={!selected.length || adding} onClick={add}>
              {adding ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              添加到工程列表
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({
  name,
  path,
  isGit,
  checked,
  disabled,
  onToggle,
  onOpen,
}: {
  name: string;
  path: string;
  isGit: boolean;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <div
      className={classNames(
        'group flex items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-ink-800',
        checked && 'bg-sky-50',
        disabled && 'opacity-40',
      )}
    >
      <button
        disabled={disabled}
        onClick={onToggle}
        className={classNames(
          'grid h-4 w-4 shrink-0 place-items-center rounded border transition',
          checked ? 'border-sky-500 bg-sky-500 text-white' : 'border-ink-600 text-transparent hover:border-slate-400',
        )}
      >
        <Check size={11} strokeWidth={3} />
      </button>
      <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onOpen} title={path}>
        {isGit ? (
          <FolderGit2 size={14} className="shrink-0 text-emerald-400" />
        ) : (
          <Folder size={14} className="shrink-0 text-slate-500" />
        )}
        <span className="truncate text-[12.5px] text-slate-200">{name}</span>
        {isGit && (
          <span className="chip border border-emerald-200 bg-emerald-50 text-[10px] text-emerald-400">git</span>
        )}
      </button>
      <button className="rounded p-1 text-slate-500 group-hover:text-slate-400" title="进入目录" onClick={onOpen}>
        <ArrowLeft size={13} className="rotate-180" />
      </button>
    </div>
  );
}
