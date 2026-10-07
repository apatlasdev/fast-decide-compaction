import type { CallAnswer, Message, ToolCall } from './types.js';

/**
 * Reuse signal: a tool result whose file paths, ids or error names keep coming back in the
 * conversation text that follows it is probably still needed. This is a plain text check, no
 * model call, and it overrides a "drop" so the agent does not lose what it keeps referring to.
 */
const TOKEN_RE =
  /(?:[A-Za-z]:)?[\w.\-/\\]{2,}\.[A-Za-z0-9]{1,6}\b|\b[A-Z][A-Za-z]+(?:Error|Exception)\b|\b[0-9a-f]{8,}\b|\b[A-Za-z_]+_[A-Za-z0-9_]{3,}/g;

export function identifierTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];
    if (token.length >= 6 && token.length <= 80) out.add(token);
  }
  return out;
}

/** later[i] = identifiers written in the conversation text and tool inputs of messages after i. */
export function laterIdentifierSets(messages: readonly Message[]): Set<string>[] {
  const later: Set<string>[] = new Array(messages.length);
  let running = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    later[i] = running;
    const message = messages[i]!;
    const inputs = message.toolUses.map((use) => JSON.stringify(use.input ?? {})).join(' ');
    const next = new Set(running);
    for (const token of identifierTokens(`${message.text ?? ''} ${inputs}`)) next.add(token);
    running = next;
  }
  return later;
}

export interface ReuseOptions {
  /** Distinct identifiers of a result that must reappear in later conversation text. */
  minHits: number;
  /** Most characters of extra results this step may keep. */
  budgetChars: number;
}

/** Ids of calls (not pinned, currently dropped) whose results should be kept after all. */
export function reusedCallIds(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  answers: ReadonlyMap<string, CallAnswer>,
  keepThreshold: number,
  options: ReuseOptions,
): string[] {
  // Narrative text per message: what the people and the model wrote, not tool output.
  const narrative = messages.map((message) => {
    const inputs = message.toolUses.map((use) => JSON.stringify(use.input ?? {})).join(' ');
    return `${message.text ?? ''} ${inputs}`;
  });
  // Suffix sets so "appears after the result" is a lookup: later[i] = identifiers in messages > i.
  const later: Set<string>[] = new Array(messages.length);
  let running = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    later[i] = running;
    const next = new Set(running);
    for (const token of identifierTokens(narrative[i]!)) next.add(token);
    running = next;
  }
  const scored: { id: string; hits: number; chars: number }[] = [];
  for (const call of calls) {
    if (call.pinned) continue;
    const answer = answers.get(call.id);
    if (!answer || answer.keepResult >= keepThreshold) continue; // already kept
    const resultMessage = messages[call.resultIndex];
    const result = resultMessage?.toolResults.find((r) => r.tool_use_id === call.tool_use_id);
    if (!result?.text) continue;
    const afterThis = later[call.resultIndex];
    if (!afterThis || afterThis.size === 0) continue;
    let hits = 0;
    for (const token of identifierTokens(result.text)) if (afterThis.has(token)) hits++;
    if (hits >= options.minHits) scored.push({ id: call.id, hits, chars: result.text.length });
  }
  // Most reused first; among equals, smaller results first so the budget covers more of them.
  scored.sort((a, b) => b.hits - a.hits || a.chars - b.chars);
  const chosen: string[] = [];
  let spent = 0;
  for (const item of scored) {
    if (spent + item.chars > options.budgetChars) continue;
    spent += item.chars;
    chosen.push(item.id);
  }
  return chosen;
}
