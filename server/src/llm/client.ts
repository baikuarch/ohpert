import type { AiSettings } from '../types.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: ChatUsage;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  tools?: ToolDef[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class LlmError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

function buildBody(settings: AiSettings, messages: ChatMessage[], opts: ChatOptions, stream: boolean) {
  const body: Record<string, any> = {
    model: opts.model || settings.model,
    messages,
    stream,
    temperature: opts.temperature ?? settings.temperature,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }
  if (opts.json) body.response_format = { type: 'json_object' };
  return body;
}

function headers(settings: AiSettings) {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (settings.apiKey) h.authorization = `Bearer ${settings.apiKey}`;
  return h;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(ms);
  if (!signal) return timeoutSignal;
  if (typeof (AbortSignal as any).any === 'function') return (AbortSignal as any).any([signal, timeoutSignal]);
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  signal.addEventListener('abort', abort, { once: true });
  timeoutSignal.addEventListener('abort', abort, { once: true });
  return ctrl.signal;
}

function parseError(status: number, text: string): LlmError {
  let msg = text.slice(0, 800);
  try {
    const j = JSON.parse(text);
    msg = j?.error?.message || j?.message || msg;
  } catch {
    /* keep raw */
  }
  // very common local-gateway misconfigurations get a friendlier hint
  const hint =
    status === 401 || status === 403
      ? '（鉴权失败：请检查 API Key / Base URL 配置）'
      : status === 404
        ? '（接口不存在：请检查 Base URL 是否以 /v1 结尾、模型名是否正确）'
        : '';
  return new LlmError(`LLM 调用失败 [${status}]: ${msg}${hint}`, status);
}

export async function chat(settings: AiSettings, messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const url = `${settings.baseURL}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(settings),
    body: JSON.stringify(buildBody(settings, messages, opts, false)),
    signal: withTimeout(opts.signal, opts.timeoutMs ?? 300_000),
  });
  const text = await res.text();
  if (!res.ok) throw parseError(res.status, text);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new LlmError(`LLM 返回非 JSON 响应: ${text.slice(0, 300)}`);
  }
  const choice = json.choices?.[0];
  if (!choice) throw new LlmError(`LLM 响应缺少 choices: ${text.slice(0, 300)}`);
  const msg = choice.message || {};
  return {
    content: msg.content ?? '',
    reasoning: msg.reasoning_content ?? '',
    toolCalls: msg.tool_calls ?? [],
    finishReason: choice.finish_reason ?? 'stop',
    usage: {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
    },
  };
}

export interface StreamHandlers {
  onContent?: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  onFirstToken?: () => void;
}

/** Streaming call. Accumulates tool calls (by index) exactly like OpenAI. */
export async function chatStream(
  settings: AiSettings,
  messages: ChatMessage[],
  opts: ChatOptions & { handlers?: StreamHandlers } = {},
): Promise<ChatResult> {
  const url = `${settings.baseURL}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(settings),
    body: JSON.stringify(buildBody(settings, messages, opts, true)),
    signal: withTimeout(opts.signal, opts.timeoutMs ?? 600_000),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw parseError(res.status, text);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  const toolCalls: ToolCall[] = [];
  let finishReason = 'stop';
  let usage: ChatUsage = { promptTokens: 0, completionTokens: 0 };
  let first = true;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return; // heartbeat / comment
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    if (json.usage) {
      usage = {
        promptTokens: json.usage.prompt_tokens ?? usage.promptTokens,
        completionTokens: json.usage.completion_tokens ?? usage.completionTokens,
      };
    }
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (delta.content) {
      if (first) {
        first = false;
        opts.handlers?.onFirstToken?.();
      }
      content += delta.content;
      opts.handlers?.onContent?.(delta.content);
    }
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      opts.handlers?.onReasoning?.(delta.reasoning_content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? toolCalls.length;
        if (!toolCalls[idx]) {
          toolCalls[idx] = { id: tc.id ?? `call_${idx}`, type: 'function', function: { name: '', arguments: '' } };
        }
        if (tc.id) toolCalls[idx].id = tc.id;
        if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
        if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      handleLine(line);
    }
  }
  if (buffer.trim()) handleLine(buffer);

  return {
    content,
    reasoning,
    toolCalls: toolCalls.filter(Boolean),
    finishReason,
    usage,
  };
}

/** Extract the first balanced JSON object/array from arbitrary model text. */
export function extractJson<T>(text: string): T {
  if (!text) throw new LlmError('模型返回为空，无法解析 JSON');
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const firstObj = s.search(/[[{]/);
  if (firstObj > 0) s = s.slice(firstObj);
  const open = s[0];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        const slice = s.slice(0, i + 1);
        try {
          return JSON.parse(slice) as T;
        } catch (e) {
          try {
            return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')) as T;
          } catch {
            throw new LlmError(`JSON 解析失败: ${(e as Error).message}; 片段: ${slice.slice(0, 200)}`);
          }
        }
      }
    }
  }
  throw new LlmError(`未找到完整的 JSON 结构，片段: ${s.slice(0, 200)}`);
}

export interface GatewayModel {
  id: string;
  name: string;
  ownedBy?: string;
  contextWindow?: number;
  maxOutput?: number;
  reasoning?: boolean;
  modalities?: string[];
}

/**
 * Fetch the model catalogue from an OpenAI-compatible gateway (`GET {base}/models`).
 * Tolerates the common response variations: `{data: []}`, a bare array, and the
 * extra metadata some gateways (magpie / one-api / ollama proxies) attach.
 */
export async function listModels(settings: AiSettings): Promise<GatewayModel[]> {
  const base = settings.baseURL.replace(/\/+$/, '');
  const candidates = [`${base}/models`];
  // users often paste the full chat endpoint or forget /v1
  if (/\/v1$/i.test(base)) candidates.push(`${base.replace(/\/v1$/i, '')}/models`);
  else if (!/\/v\d+$/i.test(base)) candidates.push(`${base}/v1/models`);

  let lastErr: Error | null = null;
  for (const url of candidates) {
    try {
      const res = await fetch(url, {
        headers: headers(settings),
        signal: withTimeout(undefined, 20_000),
      });
      const text = await res.text();
      if (!res.ok) throw parseError(res.status, text);
      const json = JSON.parse(text);
      const raw: any[] = Array.isArray(json)
        ? json
        : Array.isArray(json?.data)
          ? json.data
          : Array.isArray(json?.models)
            ? json.models
            : [];
      if (!raw.length && !Array.isArray(json?.data) && !Array.isArray(json)) {
        throw new LlmError(`响应中没有模型列表（缺少 data 数组）: ${text.slice(0, 200)}`);
      }
      return raw
        .map((m): GatewayModel | null => {
          const id = typeof m === 'string' ? m : (m?.id ?? m?.name ?? m?.model);
          if (!id) return null;
          return {
            id: String(id),
            name: String(m?.display_name ?? m?.displayName ?? m?.name ?? id),
            ownedBy: m?.owned_by ?? m?.ownedBy ?? m?.provider,
            contextWindow: Number(m?.context_window ?? m?.context_length ?? m?.contextWindow) || undefined,
            maxOutput: Number(m?.max_output_tokens ?? m?.max_tokens ?? m?.maxOutput) || undefined,
            reasoning: typeof m?.reasoning === 'boolean' ? m.reasoning : undefined,
            modalities: Array.isArray(m?.modalities?.input)
              ? m.modalities.input
              : Array.isArray(m?.modalities)
                ? m.modalities
                : undefined,
          };
        })
        .filter(Boolean)
        .sort((a, b) => a!.id.localeCompare(b!.id)) as GatewayModel[];
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw lastErr ?? new LlmError('无法获取模型列表');
}

/** Ping the model; used by the settings screen. */
export async function testConnection(settings: AiSettings) {
  const started = Date.now();
  const res = await chat(settings, [{ role: 'user', content: '回复 OK 两个字符即可。' }], {
    maxTokens: 16,
    temperature: 0,
    timeoutMs: 60_000,
  });
  return { ok: true, latencyMs: Date.now() - started, model: settings.model, reply: res.content.slice(0, 100) };
}
