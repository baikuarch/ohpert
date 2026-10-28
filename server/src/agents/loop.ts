import type { ChatMessage, ToolCall } from '../llm/client.js';
import { chatStream } from '../llm/client.js';
import type { AgentToolSet } from './tools.js';
import type { AiSettings } from '../types.js';

export interface AgentRunResult {
  turns: number;
  finalText: string;
  toolCallCount: number;
  stopReason: 'final' | 'max_turns' | 'error';
  transcript: { role: string; content: string }[];
}

export interface RunAgentOptions {
  settings: AiSettings;
  model: string;
  system: string;
  user: string;
  tools: AgentToolSet;
  maxTurns?: number;
  temperature?: number;
  onLog: (level: 'info' | 'tool' | 'warn' | 'error' | 'success' | 'llm', message: string, detail?: string) => void;
  onUsage?: (promptTokens: number, completionTokens: number) => void;
  signal?: AbortSignal;
  /** Called after each assistant turn, before tools run. */
  onTurn?: (turn: number, content: string) => void;
}

const MAX_TOOL_OUTPUT = 12_000;

/**
 * A bounded ReAct loop: the model reasons, calls file tools, observes results,
 * until it stops requesting tools (or the turn budget is exhausted).
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const maxTurns = opts.maxTurns ?? 28;
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.system },
    { role: 'user', content: opts.user },
  ];
  const transcript: { role: string; content: string }[] = [];
  let toolCallCount = 0;
  let finalText = '';
  let stopReason: AgentRunResult['stopReason'] = 'max_turns';

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts.signal?.aborted) {
      stopReason = 'error';
      finalText = '任务被取消';
      break;
    }
    opts.onLog('llm', `第 ${turn}/${maxTurns} 轮：思考中…`);
    let res;
    try {
      res = await chatStream(opts.settings, messages, {
        model: opts.model,
        tools: opts.tools.defs,
        temperature: opts.temperature ?? 0.15,
        maxTokens: Math.min(opts.settings.maxTokens, 8000),
        handlers: {
          onFirstToken: () => opts.onLog('llm', `第 ${turn} 轮：开始输出`),
        },
        signal: opts.signal,
        timeoutMs: 600_000,
      });
    } catch (err) {
      if (opts.signal?.aborted) {
        stopReason = 'error';
        finalText = '任务被取消';
        break;
      }
      opts.onLog('error', `模型调用失败: ${(err as Error).message}`);
      stopReason = 'error';
      finalText = `模型调用失败: ${(err as Error).message}`;
      break;
    }
    opts.onUsage?.(res.usage.promptTokens, res.usage.completionTokens);

    const text = (res.content || '').trim();
    if (text) {
      transcript.push({ role: 'assistant', content: text });
      opts.onTurn?.(turn, text);
    }

    if (!res.toolCalls.length) {
      finalText = text;
      stopReason = 'final';
      break;
    }

    messages.push({ role: 'assistant', content: res.content || '', tool_calls: res.toolCalls as ToolCall[] });

    for (const call of res.toolCalls) {
      toolCallCount++;
      let args: Record<string, any> = {};
      try {
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        opts.onLog('warn', `工具参数不是合法 JSON: ${call.function.arguments?.slice(0, 200)}`);
      }
      const brief = summarizeCall(call.function.name, args);
      opts.onLog('tool', `→ ${call.function.name} ${brief}`);
      let content: string;
      try {
        const result = await opts.tools.exec(call.function.name, args);
        content = result.content;
      } catch (err) {
        content = `错误: ${(err as Error).message}`;
        opts.onLog('warn', `工具执行失败: ${(err as Error).message}`);
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: content.length > MAX_TOOL_OUTPUT ? content.slice(0, MAX_TOOL_OUTPUT) + '\n…[输出已截断]' : content,
      });
    }
  }

  if (stopReason === 'max_turns') {
    opts.onLog('warn', `已达到最大轮数 ${maxTurns}，停止。`);
  }
  return {
    turns: messages.filter((m) => m.role === 'assistant').length,
    finalText,
    toolCallCount,
    stopReason,
    transcript,
  };
}

function summarizeCall(name: string, args: Record<string, any>) {
  if (name === 'write_file') return `${args.path} (${String(args.content ?? '').length} 字符)`;
  if (name === 'edit_file')
    return `${args.path} (替换 ${String(args.old_text ?? '').length}→${String(args.new_text ?? '').length} 字符)`;
  if (name === 'run_command') return `"${args.command}"`;
  if (name === 'search_code') return `/${args.pattern}/`;
  return JSON.stringify(args).slice(0, 160);
}
