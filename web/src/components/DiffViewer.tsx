import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Circle,
  FileCode2,
  FileDiff,
  FilePlus2,
  FileMinus,
  FilePen,
  Undo2,
  ChevronDown,
} from 'lucide-react';
import type { FileChange } from '../types';
import { classNames } from '../lib/ui';
import { CopyButton } from './ui';

const KIND_ICON = {
  modified: FilePen,
  added: FilePlus2,
  deleted: FileMinus,
  renamed: FileCode2,
};

const KIND_LABEL: Record<string, string> = { modified: '修改', added: '新增', deleted: '删除', renamed: '重命名' };

export function DiffViewer({
  files,
  branches,
}: {
  files: FileChange[];
  branches?: { repoId: string; branch: string; baseBranch: string; baseRev: string }[];
}) {
  const grouped = useMemo(() => {
    const map = new Map<string, FileChange[]>();
    for (const f of files) {
      const arr = map.get(f.repoName) ?? [];
      arr.push(f);
      map.set(f.repoName, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [files]);

  const [active, setActive] = useState<{ repo: string; file: string } | null>(() =>
    grouped[0]?.[1][0] ? { repo: grouped[0][0], file: grouped[0][1][0].file } : null,
  );
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());

  const current = useMemo(() => {
    if (!active) return null;
    return grouped.find(([r]) => r === active.repo)?.[1].find((f) => f.file === active.file) ?? null;
  }, [active, grouped]);

  const toggleReviewed = (key: string) =>
    setReviewed((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  if (!files.length) {
    return (
      <div className="rounded-lg border border-dashed border-ink-700 py-10 text-center text-[12px] text-slate-500">
        暂无代码改动
      </div>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div className="space-y-2">
        {grouped.map(([repoName, list]) => {
          const branch = branches?.find((b) => b.repoId === list[0].repoId);
          return (
            <div key={repoName} className="rounded-lg border border-ink-700 bg-ink-950">
              <div className="flex items-center justify-between border-b border-ink-700 px-2.5 py-1.5">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[11.5px] font-medium text-slate-300">{repoName}</span>
                  {branch && (
                    <span
                      className="chip shrink-0 border border-violet-200 bg-violet-50 font-mono text-[9px] text-violet-700"
                      title={`基于 ${branch.baseBranch}@${branch.baseRev.slice(0, 8)}`}
                    >
                      {branch.branch.replace('ohpert/', '')}
                    </span>
                  )}
                </div>
                <span className="shrink-0 text-[9.5px] text-slate-500">{list.length}</span>
              </div>
              <div className="max-h-[300px] overflow-y-auto py-1">
                {list.map((f) => {
                  const key = `${f.repoName}:${f.file}`;
                  const Icon = KIND_ICON[f.kind] ?? FileCode2;
                  const isActive = active?.repo === f.repoName && active?.file === f.file;
                  return (
                    <div
                      key={key}
                      role="button"
                      tabIndex={0}
                      onClick={() => setActive({ repo: f.repoName, file: f.file })}
                      className={classNames(
                        'flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1 text-left transition',
                        isActive ? 'bg-sky-50' : 'hover:bg-ink-800',
                      )}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleReviewed(key);
                        }}
                        className="shrink-0 text-slate-500 hover:text-emerald-400"
                        title="标记已审阅"
                      >
                        {reviewed.has(key) ? (
                          <CheckCircle2 size={11} className="text-emerald-400" />
                        ) : (
                          <Circle size={11} />
                        )}
                      </button>
                      <Icon
                        size={11}
                        className={classNames(
                          'shrink-0',
                          f.kind === 'added'
                            ? 'text-emerald-400'
                            : f.kind === 'deleted'
                              ? 'text-rose-400'
                              : 'text-slate-500',
                        )}
                      />
                      <span
                        className={classNames(
                          'truncate font-mono text-[10.5px]',
                          isActive ? 'text-sky-700' : 'text-slate-400',
                        )}
                        title={f.file}
                      >
                        {f.file.split('/').slice(-2).join('/')}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[9px]">
                        <span className="text-emerald-400">+{f.additions}</span>
                        <span className="ml-0.5 text-rose-400">-{f.deletions}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        <div className="px-1 text-[10.5px] text-slate-500">
          已审阅 {reviewed.size}/{files.length}
        </div>
      </div>

      <div className="min-w-0 overflow-hidden rounded-lg border border-ink-700 bg-ink-900">
        {current ? (
          <>
            <div className="flex items-center gap-2 border-b border-ink-700 px-3 py-1.5">
              <span className="chip border border-ink-700 bg-ink-900 text-[9.5px] text-slate-400">
                {KIND_LABEL[current.kind]}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-300">
                {current.repoName}/{current.file}
              </span>
              <span className="shrink-0 font-mono text-[10px]">
                <span className="text-emerald-400">+{current.additions}</span>{' '}
                <span className="text-rose-400">-{current.deletions}</span>
              </span>
              <CopyButton text={current.patch} />
            </div>
            <DiffBody patch={current.patch} />
          </>
        ) : (
          <div className="grid h-40 place-items-center text-[12px] text-slate-500">
            <span className="flex items-center gap-1.5">
              <FileDiff size={14} /> 选择左侧文件查看改动
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function DiffBody({ patch }: { patch: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const lines = patch.split('\n');
  const shown = collapsed ? lines.slice(0, 24) : lines.slice(0, 1200);
  return (
    <div>
      <div className="max-h-[520px] overflow-auto">
        <pre className="min-w-max p-0">
          <code className="block">
            {shown.map((line, i) => {
              const cls =
                line.startsWith('+++') ||
                line.startsWith('---') ||
                line.startsWith('diff ') ||
                line.startsWith('index ')
                  ? 'diff-meta'
                  : line.startsWith('@@')
                    ? 'diff-hunk'
                    : line.startsWith('+')
                      ? 'diff-add'
                      : line.startsWith('-')
                        ? 'diff-del'
                        : '';
              return (
                <div key={i} className={classNames('flex font-mono text-[11.5px] leading-[1.55]', cls)}>
                  <span className="w-10 shrink-0 select-none border-r border-ink-700 pr-1.5 text-right text-[9.5px] text-slate-600">
                    {i + 1}
                  </span>
                  <span className="whitespace-pre px-2">{line || ' '}</span>
                </div>
              );
            })}
          </code>
        </pre>
      </div>
      {(lines.length > 1200 || collapsed) && (
        <button
          className="flex w-full items-center justify-center gap-1 border-t border-ink-700 py-1 text-[10.5px] text-slate-500 hover:bg-ink-800"
          onClick={() => setCollapsed((c) => !c)}
        >
          <ChevronDown size={11} className={collapsed ? '' : 'rotate-180'} />{' '}
          {collapsed ? `展开全部 ${lines.length} 行` : '收起'}
        </button>
      )}
    </div>
  );
}

export function RevertHint({ onRevert }: { onRevert?: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-800 px-2.5 py-1.5 text-[10.5px] text-slate-500">
      <Undo2 size={11} />
      所有改动都已提交到独立分支，随时可以一键回滚且不影响主分支
      {onRevert && (
        <button className="ml-auto text-rose-400 hover:underline" onClick={onRevert}>
          回滚改动
        </button>
      )}
    </div>
  );
}
