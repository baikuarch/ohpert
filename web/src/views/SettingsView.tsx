import { useEffect, useState } from 'react';
import { Cpu, Loader2, Save, Terminal, CheckCircle2, XCircle, FolderTree, ShieldCheck, Download } from 'lucide-react';
import { api, type GatewayModel } from '../lib/api';
import { useApp } from '../store/app';
import { Collapsible, SectionTitle } from '../components/ui';
import { ModelRefreshBar, ModelSelect } from '../components/ModelSelect';

export function SettingsView() {
  const { ai, settings, notify, refresh, setAi, setSettings } = useApp();
  const [form, setForm] = useState({
    baseURL: '',
    apiKey: '',
    model: '',
    planningModel: '',
    codingModel: '',
    reviewModel: '',
    maxTurns: 28,
    temperature: 0.2,
    maxTokens: 16000,
  });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    latencyMs?: number;
    reply?: string;
    error?: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [roots, setRoots] = useState<string[]>([]);
  const [newRoot, setNewRoot] = useState('');
  const [models, setModels] = useState<GatewayModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsFetchedAt, setModelsFetchedAt] = useState<string | null>(null);

  /** Pull the catalogue from the gateway using the values currently in the form. */
  const loadModels = async (opts: { baseURL?: string; apiKey?: string } = {}) => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const res = await api.listModels({ baseURL: opts.baseURL ?? form.baseURL, apiKey: opts.apiKey ?? form.apiKey });
      if (res.ok) {
        setModels(res.models);
        setModelsFetchedAt(res.fetchedAt ?? new Date().toISOString());
        setModelsError(res.models.length ? null : '网关返回了空列表，可手动输入模型 ID');
      } else {
        setModels([]);
        setModelsError(res.error ?? '获取模型列表失败，可手动输入模型 ID');
      }
      return res;
    } catch (e) {
      setModels([]);
      setModelsError((e as Error).message);
      return null;
    } finally {
      setModelsLoading(false);
    }
  };

  // auto-load once the stored config is known; show options immediately
  useEffect(() => {
    if (!ai) return;
    setForm({
      baseURL: ai.baseURL,
      apiKey: '',
      model: ai.model,
      planningModel: ai.planningModel,
      codingModel: ai.codingModel,
      reviewModel: ai.reviewModel,
      maxTurns: ai.maxTurns,
      temperature: ai.temperature,
      maxTokens: ai.maxTokens,
    });
    void loadModels({ baseURL: ai.baseURL, apiKey: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai]);

  useEffect(() => {
    setRoots(settings.workspaceRoots ?? []);
  }, [settings.workspaceRoots]);

  const saveAi = async () => {
    setSaving(true);
    try {
      const res = await api.saveAi(form);
      setAi(res.ai);
      notify('ok', '模型配置已保存');
      void loadModels({ baseURL: res.ai.baseURL, apiKey: '' });
    } catch (e) {
      notify('err', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api.testAi({ baseURL: form.baseURL, apiKey: form.apiKey, model: form.model });
      setTestResult(res);
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="mx-auto max-w-[900px] px-7 py-6">
      <h1 className="text-xl font-semibold tracking-tight text-slate-100">设置</h1>
      <p className="mt-1 mb-5 text-[12.5px] text-slate-500">
        配置 AI 模型接入（任意 OpenAI 兼容接口）、工程浏览根目录与构建命令。
      </p>

      <div className="mb-6">
        <SectionTitle
          icon={<Cpu size={15} className="text-sky-600" />}
          title="AI 模型"
          desc="兼容 OpenAI /v1/chat/completions 协议。可为不同阶段指定不同模型以节省成本。"
        />
        <div className="card space-y-3 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="label">Base URL</label>
              <input
                className="input mono"
                value={form.baseURL}
                onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div>
              <label className="label">
                API Key{' '}
                {ai?.hasApiKey && <span className="text-emerald-400">（已配置 {ai.apiKey}，留空则不修改）</span>}
              </label>
              <input
                className="input mono"
                type="password"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                placeholder={ai?.hasApiKey ? '••••••••（保持不变）' : 'sk-…'}
              />
            </div>
          </div>
          <ModelRefreshBar
            loading={modelsLoading}
            count={models.length}
            error={modelsError}
            fetchedAt={modelsFetchedAt}
            baseURL={form.baseURL}
            onRefresh={() => void loadModels()}
          />

          <div className="grid gap-3 md:grid-cols-2">
            <ModelSelect
              label="默认模型"
              value={form.model}
              onChange={(v) => setForm({ ...form, model: v })}
              models={models}
              loading={modelsLoading}
              error={modelsError}
              placeholder="从下拉列表选择，或输入模型 ID"
              hint="需求分析与研发默认使用该模型"
            />
            <div className="flex items-end gap-2">
              <button className="btn-ghost" onClick={test} disabled={testing}>
                {testing ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} 测试连接
              </button>
              <button
                className="btn-ghost shrink-0"
                onClick={() => void loadModels()}
                disabled={modelsLoading}
                title="按当前填写的 Base URL / API Key 重新拉取模型列表"
              >
                {modelsLoading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} 获取模型列表
              </button>
              {testResult && (
                <span
                  className={`flex min-w-0 items-center gap-1 text-[11.5px] ${testResult.ok ? 'text-emerald-700' : 'text-rose-600'}`}
                >
                  {testResult.ok ? (
                    <CheckCircle2 size={12} className="shrink-0" />
                  ) : (
                    <XCircle size={12} className="shrink-0" />
                  )}
                  <span className="truncate" title={testResult.error || testResult.reply}>
                    {testResult.ok
                      ? `连接成功 · ${testResult.latencyMs}ms · "${testResult.reply}"`
                      : `失败：${testResult.error}`}
                  </span>
                </span>
              )}
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <ModelSelect
              label="需求分析模型"
              value={form.planningModel}
              onChange={(v) => setForm({ ...form, planningModel: v })}
              models={models}
              loading={modelsLoading}
              error={modelsError}
              placeholder="留空使用默认"
              allowEmpty
            />
            <ModelSelect
              label="编码模型"
              value={form.codingModel}
              onChange={(v) => setForm({ ...form, codingModel: v })}
              models={models}
              loading={modelsLoading}
              error={modelsError}
              placeholder="留空使用默认"
              allowEmpty
            />
            <ModelSelect
              label="验收模型"
              value={form.reviewModel}
              onChange={(v) => setForm({ ...form, reviewModel: v })}
              models={models}
              loading={modelsLoading}
              error={modelsError}
              placeholder="留空使用默认"
              allowEmpty
            />
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className="label">温度</label>
              <input
                className="input mono"
                type="number"
                step="0.05"
                min="0"
                max="1"
                value={form.temperature}
                onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="label">最大输出 Token</label>
              <input
                className="input mono"
                type="number"
                value={form.maxTokens}
                onChange={(e) => setForm({ ...form, maxTokens: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="label">单次研发最大轮数</label>
              <input
                className="input mono"
                type="number"
                value={form.maxTurns}
                onChange={(e) => setForm({ ...form, maxTurns: Number(e.target.value) })}
              />
            </div>
          </div>
          <div className="flex items-center justify-between pt-1">
            <span className="text-[11px] text-slate-500">
              配置文件位于 <code className="rounded bg-ink-800 px-1">.data/settings.json</code>
              也可通过环境变量 <code className="rounded bg-ink-800 px-1">OHPERT_LLM_API_KEY</code> 注入
            </span>
            <button className="btn-primary" onClick={saveAi} disabled={saving}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} 保存
            </button>
          </div>
        </div>
      </div>

      <div className="mb-6">
        <SectionTitle
          icon={<FolderTree size={15} className="text-amber-400" />}
          title="工程浏览根目录"
          desc="「添加工程」的文件浏览器将从这些目录开始，方便快速找到本地仓库。"
        />
        <div className="card space-y-2 p-4">
          {roots.map((r, i) => (
            <div key={r} className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1.5">
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate-300">{r}</span>
              <button
                className="text-[11px] text-rose-400 hover:underline"
                onClick={async () => {
                  const next = roots.filter((_, idx) => idx !== i);
                  const res = await api.saveRoots(next);
                  setRoots(res.workspaceRoots);
                  setSettings({ workspaceRoots: res.workspaceRoots });
                }}
              >
                移除
              </button>
            </div>
          ))}
          <div className="flex gap-2">
            <input
              className="input mono !text-[12px]"
              placeholder="~/projects"
              value={newRoot}
              onChange={(e) => setNewRoot(e.target.value)}
            />
            <button
              className="btn-ghost"
              onClick={async () => {
                if (!newRoot.trim()) return;
                const res = await api.saveRoots([...roots, newRoot.trim()]);
                setRoots(res.workspaceRoots);
                setSettings({ workspaceRoots: res.workspaceRoots });
                setNewRoot('');
              }}
            >
              添加
            </button>
          </div>
        </div>
      </div>

      <div className="mb-6">
        <SectionTitle
          icon={<Terminal size={15} className="text-violet-400" />}
          title="验收命令（可选覆盖）"
          desc="默认会自动探测各工程的 typecheck/build/lint 脚本；此处填写则优先执行。"
        />
        <div className="card space-y-3 p-4">
          {(['test', 'build', 'lint'] as const).map((k) => (
            <div key={k}>
              <label className="label">{k === 'test' ? '测试命令' : k === 'build' ? '构建命令' : '检查命令'}</label>
              <input
                className="input mono !text-[12px]"
                value={settings.commands[k] ?? ''}
                placeholder={k === 'build' ? '例如 npm run build（留空自动探测）' : '留空自动探测'}
                onChange={(e) => setSettings({ commands: { ...settings.commands, [k]: e.target.value } })}
              />
            </div>
          ))}
          <div className="flex justify-end">
            <button
              className="btn-ghost"
              onClick={async () => {
                await api.saveCommands(settings.commands);
                notify('ok', '命令配置已保存');
                await refresh();
              }}
            >
              <Save size={13} /> 保存命令
            </button>
          </div>
        </div>
      </div>

      <Collapsible title="🛡 安全说明" subtitle="ohpert 如何保护你的代码">
        <ul className="space-y-1.5 text-[11.5px] leading-relaxed text-slate-400">
          <li>
            • 所有代码、分支、数据库均保存在你本机的 <code className="rounded bg-ink-800 px-1">.data/</code> 目录。
          </li>
          <li>
            • 研发阶段使用独立的 <code className="rounded bg-ink-800 px-1">git worktree</code> 副本与{' '}
            <code className="rounded bg-ink-800 px-1">ohpert/req-*</code> 分支，不触碰你的工作区。
          </li>
          <li>• AI 的写文件工具被限制在工程目录内，并禁止执行 git push、安装依赖、删除系统目录等危险命令。</li>
          <li>• 任何改动都可以在需求详情页一键回滚。</li>
          <li>• 只有被扫描到的代码片段与 diff 会发送给你配置的模型服务，请自行评估数据合规要求。</li>
        </ul>
      </Collapsible>
      <div className="flex items-center gap-1.5 pt-4 text-[10.5px] text-slate-500">
        <ShieldCheck size={11} /> ohpert v0.1 · 本地优先 · 数据不出机器（除模型调用）
      </div>
    </div>
  );
}
