import { useMemo, useState } from 'react';
import { ArrowRight, Crosshair, Link2, Network, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ArchitectureReport, RepoLink, RepoProfile, RepoRecord } from '../types';
import { ROLE_META, classNames, fmtDateTime } from '../lib/ui';
import { Chip, Collapsible, EmptyState } from './ui';

const KIND_META: Record<RepoLink['kind'], { label: string; color: string }> = {
  'http-api': { label: 'HTTP 接口调用', color: '#0284c7' },
  'shared-types': { label: '共享类型/模型', color: '#7c3aed' },
  'shared-env': { label: '共享环境变量', color: '#059669' },
  'npm-package': { label: 'npm 包依赖', color: '#d97706' },
  'data-model': { label: '数据模型耦合', color: '#db2777' },
  'same-domain': { label: '业务域相近', color: '#8b97a8' },
};

interface Props {
  repos: RepoRecord[];
  profiles: Record<string, RepoProfile>;
  architecture: ArchitectureReport | null;
  onFocusRepo?: (id: string) => void;
}

export function ArchitectureGraph({ repos, profiles, architecture }: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const [selectedLink, setSelectedLink] = useState<string | null>(null);

  const layout = useMemo(() => {
    const front = repos.filter((r) => ['frontend', 'mobile'].includes(r.role));
    const back = repos.filter((r) => ['backend', 'fullstack'].includes(r.role));
    const other = repos.filter((r) => !front.includes(r) && !back.includes(r));
    const columns = [front, other, back].filter((c) => c.length);
    const colX = columns.length === 1 ? [380] : columns.length === 2 ? [200, 560] : [150, 380, 610];
    const nodes: { repo: RepoRecord; x: number; y: number }[] = [];
    columns.forEach((col, ci) => {
      const gap = 460 / (col.length + 1);
      col.forEach((repo, i) => {
        nodes.push({ repo, x: colX[ci], y: Math.round(gap * (i + 1)) });
      });
    });
    // nudge overlapping nodes apart so unlinked repos don't pile up
    for (let iter = 0; iter < 40; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 118) {
            const push = (118 - dist) / 2 || 1;
            const ang = dist === 0 ? i - j : Math.atan2(dy, dx);
            a.x -= Math.cos(ang) * push;
            a.y -= Math.sin(ang) * push;
            b.x += Math.cos(ang) * push;
            b.y += Math.sin(ang) * push;
          }
        }
      }
    }
    for (const n of nodes) {
      n.x = Math.round(Math.max(90, Math.min(670, n.x)));
      n.y = Math.round(Math.max(44, Math.min(420, n.y)));
    }
    return nodes;
  }, [repos]);

  const nodeById = useMemo(() => new Map(layout.map((n) => [n.repo.id, n])), [layout]);
  const links = architecture?.links ?? [];

  if (!repos.length) {
    return (
      <EmptyState
        icon={<Network size={22} />}
        title="还没有工程"
        desc="添加多个 Git 工程后，这里会展示 AI 梳理出的工程关系图谱"
      />
    );
  }

  const activeLink = links.find((l) => l.id === selectedLink) ?? null;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="card relative overflow-hidden p-3">
        <svg viewBox="0 0 760 460" className="w-full" style={{ minHeight: 380 }}>
          <defs>
            {Object.entries(KIND_META).map(([kind, meta]) => (
              <marker
                key={kind}
                id={`arrow-${kind}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={meta.color} />
              </marker>
            ))}
            <filter id="nodeShadow" x="-20%" y="-30%" width="140%" height="160%">
              <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#101828" floodOpacity="0.10" />
            </filter>
            <radialGradient id="glow">
              <stop offset="0%" stopColor="rgba(56,189,248,0.10)" />
              <stop offset="100%" stopColor="rgba(56,189,248,0)" />
            </radialGradient>
          </defs>
          <circle cx="380" cy="230" r="230" fill="url(#glow)" opacity="0.9" />

          {links.map((link) => {
            const a = nodeById.get(link.from);
            const b = nodeById.get(link.to);
            if (!a || !b) return null;
            const dim = hover && hover !== link.from && hover !== link.to;
            const active =
              selectedLink === link.id ||
              (!selectedLink && !hover) ||
              (hover && (hover === link.from || hover === link.to));
            const meta = KIND_META[link.kind];
            // bend each edge perpendicular to the node axis and offset parallel edges,
            // so bidirectional / multi-kind pairs don't overlap into one thick line
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const kindIdx = Object.keys(KIND_META).indexOf(link.kind);
            const side = link.kind === 'same-domain' ? -1 : 1;
            const bend = Math.min(70, len * 0.18) * side + kindIdx * 5;
            const ux = -dy / len;
            const uy = dx / len;
            const mx = (a.x + b.x) / 2 + ux * bend;
            const my = (a.y + b.y) / 2 + uy * bend;
            const width = 1 + (link.strength / 100) * 2.2;
            return (
              <g
                key={link.id}
                opacity={dim ? 0.12 : active ? 1 : 0.35}
                className="cursor-pointer"
                onClick={() => setSelectedLink(activeLink?.id === link.id ? null : link.id)}
              >
                <path
                  d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
                  fill="none"
                  stroke={meta.color}
                  strokeWidth={width}
                  strokeDasharray={link.kind === 'same-domain' ? '4 4' : undefined}
                  markerEnd={`url(#arrow-${link.kind})`}
                />
                <text x={mx} y={my - 5} fill={meta.color} fontSize="9.5" opacity="0.9" textAnchor="middle">
                  {meta.label}
                </text>
              </g>
            );
          })}

          {layout.map(({ repo, x, y }) => {
            const meta = ROLE_META[repo.role];
            const p = profiles[repo.id];
            const isHover = hover === repo.id;
            return (
              <g
                key={repo.id}
                transform={`translate(${x},${y})`}
                onMouseEnter={() => setHover(repo.id)}
                onMouseLeave={() => setHover(null)}
                className="cursor-default"
              >
                <rect
                  x={-84}
                  y={-30}
                  width={168}
                  height={60}
                  rx={12}
                  fill="#ffffff"
                  stroke={isHover ? '#0284c7' : '#dbe0e8'}
                  strokeWidth={isHover ? 1.6 : 1}
                  filter="url(#nodeShadow)"
                />
                <text x={0} y={-10} textAnchor="middle" fill="#0b1220" fontSize="12.5" fontWeight="600">
                  {repo.name.length > 20 ? repo.name.slice(0, 19) + '…' : repo.name}
                </text>
                <text x={0} y={7} textAnchor="middle" fill="#6c798b" fontSize="9.5">
                  {meta.label} · {(p?.frameworks ?? []).slice(0, 2).join('/') || '未分析'}
                </text>
                <text x={0} y={21} textAnchor="middle" fill="#8b97a8" fontSize="8.5">
                  {p ? `${p.apiRoutes.length} 路由 · ${p.apiCalls.length} 请求点` : '待分析'}
                </text>
                <circle
                  cx={-72}
                  cy={-18}
                  r={3.2}
                  fill={
                    meta.color.includes('sky')
                      ? '#0284c7'
                      : meta.color.includes('violet')
                        ? '#7c3aed'
                        : meta.color.includes('amber')
                          ? '#d97706'
                          : meta.color.includes('emerald')
                            ? '#059669'
                            : meta.color.includes('teal')
                              ? '#0d9488'
                              : '#8b97a8'
                  }
                />
              </g>
            );
          })}
        </svg>
        <div className="pointer-events-none absolute bottom-2 left-3 flex flex-wrap gap-3 text-[10px]">
          {Object.entries(KIND_META).map(([k, m]) => (
            <span key={k} className="flex items-center gap-1 text-slate-500">
              <span className="inline-block h-[2px] w-4 rounded" style={{ background: m.color }} />
              {m.label}
            </span>
          ))}
        </div>
      </div>

      <div className="card flex min-h-0 flex-col p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-slate-200">
            <Link2 size={13} className="text-sky-600" /> 工程关联 ({links.length})
          </div>
          {architecture && <span className="text-[10px] text-slate-500">{fmtDateTime(architecture.generatedAt)}</span>}
        </div>
        <div className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
          {links.length === 0 && (
            <div className="py-6 text-center text-[11.5px] text-slate-500">
              暂无关联，点击上方「AI 分析架构」开始梳理
            </div>
          )}
          {links.map((l) => {
            const meta = KIND_META[l.kind];
            const a = repos.find((r) => r.id === l.from);
            const b = repos.find((r) => r.id === l.to);
            const active = selectedLink === l.id;
            return (
              <button
                key={l.id}
                onMouseEnter={() => setHover(l.from)}
                onMouseLeave={() => setHover(null)}
                onClick={() => setSelectedLink(active ? null : l.id)}
                className={classNames(
                  'w-full rounded-lg border px-2.5 py-2 text-left transition',
                  active
                    ? 'border-sky-300 bg-sky-50'
                    : 'border-ink-700 bg-ink-950 hover:border-ink-700 hover:bg-ink-800',
                )}
              >
                <div className="flex items-center gap-1.5 text-[11.5px] text-slate-300">
                  <span className="truncate font-medium">{a?.name ?? l.from}</span>
                  <ArrowRight size={11} className="shrink-0 text-slate-500" />
                  <span className="truncate font-medium">{b?.name ?? l.to}</span>
                  <span
                    className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[9.5px]"
                    style={{ background: meta.color + '22', color: meta.color }}
                  >
                    {meta.label}
                  </span>
                </div>
                <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-slate-500">{l.summary}</div>
                {l.kind === 'http-api' && l.endpoints && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {l.endpoints.slice(0, active ? 12 : 3).map((e) => (
                      <span
                        key={e.method + e.path}
                        className="rounded bg-ink-800 px-1 py-0.5 font-mono text-[9.5px] text-sky-700/90"
                      >
                        {e.method} {e.path}
                      </span>
                    ))}
                    {!active && l.endpoints.length > 3 && (
                      <span className="text-[9.5px] text-slate-500">+{l.endpoints.length - 3}</span>
                    )}
                  </div>
                )}
                {active && l.evidence.length > 0 && (
                  <div className="mt-2 space-y-1 border-t border-ink-700 pt-2">
                    {l.evidence.slice(0, 8).map((e, i) => (
                      <div key={i} className="flex gap-1.5 text-[10px] text-slate-500">
                        <Crosshair size={10} className="mt-0.5 shrink-0 text-slate-500" />
                        <span className="mono break-all">{e.detail}</span>
                      </div>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function ArchitectureNarrative({
  architecture,
  repos,
}: {
  architecture: ArchitectureReport;
  repos: RepoRecord[];
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-sky-200 bg-sky-50 p-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium text-sky-700">
          <Sparkles size={12} /> AI 架构结论
          <span className="ml-auto text-[10px] font-normal text-slate-500">
            {architecture.aiModel} · {fmtDateTime(architecture.generatedAt)}
          </span>
        </div>
        <div className="prose-ohpert max-h-[320px] overflow-y-auto pr-1">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{architecture.narrative}</ReactMarkdown>
        </div>
      </div>

      {architecture.domains.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {architecture.domains.map((d) => (
            <Chip key={d.name} title={d.description} className="border-violet-200 bg-violet-50 text-violet-800">
              🧩 {d.name}
              <span className="text-violet-600">
                · {d.repos.map((id) => repos.find((r) => r.id === id)?.name ?? id).join('/')}
              </span>
            </Chip>
          ))}
        </div>
      )}

      {architecture.warnings.length > 0 && (
        <Collapsible title={`⚠️ 风险与隐患 (${architecture.warnings.length})`} defaultOpen>
          <ul className="space-y-1.5">
            {architecture.warnings.map((w, i) => (
              <li key={i} className="flex gap-2 text-[11.5px] leading-relaxed text-amber-800">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-400" />
                {w}
              </li>
            ))}
          </ul>
        </Collapsible>
      )}
    </div>
  );
}
