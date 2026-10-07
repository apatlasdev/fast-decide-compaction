import { compact } from './compact.js';
import type { CompactOptions, CompactResult, Message } from './types.js';

/**
 * Harness adapters. The core (`compact`) works on a small neutral shape:
 *   { role, text, toolUses: [{ tool_use_id, tool, input }], toolResults: [{ tool_use_id, text, isError }] }
 * These helpers convert the two common wire formats to that shape and back, so any harness
 * that can hand over its message list can use the same compaction:
 *   - "anthropic": Messages API  ({ role, content: string | blocks[] } with tool_use / tool_result blocks)
 *   - "openai":    Chat Completions ({ role, content, tool_calls[] } plus { role: 'tool', tool_call_id, content })
 *   - "generic":   the neutral shape itself
 * Messages the compaction leaves untouched are returned as the caller's own objects. Only messages
 * whose tool results were shortened or removed are rebuilt, in the same wire format.
 */

export type WireFormat = 'anthropic' | 'openai' | 'generic';

type Json = Record<string, any>;

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && (block as Json).type === 'text' ? String((block as Json).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
    } catch {
      return { raw };
    }
  }
  return {};
}

export function fromAnthropic(raw: readonly Json[]): Message[] {
  return raw.map((message) => {
    const out: Message = { role: message.role === 'assistant' ? 'assistant' : 'user', text: '', toolUses: [], toolResults: [] };
    const content = message.content;
    if (typeof content === 'string') out.text = content;
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') out.text += (out.text ? '\n' : '') + String(block.text ?? '');
        else if (block.type === 'tool_use') out.toolUses.push({ tool_use_id: String(block.id), tool: String(block.name), input: block.input ?? {} });
        else if (block.type === 'tool_result') out.toolResults.push({ tool_use_id: String(block.tool_use_id), text: blockText(block.content), isError: !!block.is_error });
      }
    }
    return out;
  });
}

export function fromOpenAI(raw: readonly Json[]): Message[] {
  return raw.map((message) => {
    if (message.role === 'tool') {
      return { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: String(message.tool_call_id), text: blockText(message.content), isError: false }] } as Message;
    }
    const out: Message = { role: message.role === 'assistant' ? 'assistant' : 'user', text: blockText(message.content), toolUses: [], toolResults: [] };
    for (const call of message.tool_calls ?? []) {
      out.toolUses.push({ tool_use_id: String(call.id), tool: String(call.function?.name ?? call.name ?? 'tool'), input: parseArguments(call.function?.arguments ?? call.arguments) });
    }
    return out;
  });
}

function toAnthropic(message: Message): Json {
  const blocks: Json[] = [];
  if (message.text) blocks.push({ type: 'text', text: message.text });
  for (const use of message.toolUses) blocks.push({ type: 'tool_use', id: use.tool_use_id, name: use.tool, input: use.input });
  for (const result of message.toolResults ?? []) blocks.push({ type: 'tool_result', tool_use_id: result.tool_use_id, content: result.text, is_error: result.isError || undefined });
  return { role: message.role, content: blocks };
}

function toOpenAI(message: Message): Json {
  const results = message.toolResults ?? [];
  if (results.length > 0 && message.toolUses.length === 0 && !message.text) {
    // One tool message per result; the caller flattens arrays (see toWire).
    return { role: 'tool', _results: results };
  }
  const out: Json = { role: message.role, content: message.text || null };
  if (message.toolUses.length > 0) {
    out.tool_calls = message.toolUses.map((use) => ({ id: use.tool_use_id, type: 'function', function: { name: use.tool, arguments: JSON.stringify(use.input ?? {}) } }));
  }
  return out;
}

export function toWire(format: WireFormat, message: Message): Json[] {
  if (format === 'anthropic') return [toAnthropic(message)];
  if (format === 'openai') {
    const built = toOpenAI(message);
    if (built.role === 'tool') return (built._results as NonNullable<Message['toolResults']>).map((r) => ({ role: 'tool', tool_call_id: r.tool_use_id, content: r.text }));
    return [built];
  }
  return [message as unknown as Json];
}

export interface CompactWireResult {
  messages: Json[];
  result: CompactResult;
}

/**
 * Compacts a message list in the given wire format.
 * `asker` is anything with `ask(state, questions)`; use `JevClient` from this package for Mercury Decide.
 */
export async function compactWire(
  format: WireFormat,
  raw: readonly Json[],
  asker: Parameters<typeof compact>[1],
  options: CompactOptions = {},
): Promise<CompactWireResult> {
  const neutral: Message[] = format === 'anthropic' ? fromAnthropic(raw) : format === 'openai' ? fromOpenAI(raw) : (raw as unknown as Message[]);
  const result = await compact(neutral, asker, options);
  const original = new Map<Message, Json>();
  neutral.forEach((message, index) => original.set(message, raw[index]!));
  const messages: Json[] = [];
  for (const message of result.messages) {
    const own = original.get(message);
    if (own) messages.push(own);
    else messages.push(...toWire(format, message));
  }
  return { messages, result };
}
