import type { CallAnswer, CallDecision, Message, ToolCall } from './types.js';

/**
 * Size target ("economy mode"). Decide plus the reuse check decide what is worth keeping, not how
 * much fits. When a target is set and the kept history is still larger, this trims the lowest-value
 * kept results first, then the lowest-value remaining stubs, until the estimate is under the target
 * (or nothing is left to trim: conversation text and pinned messages are never touched).
 *
 * Value order, highest first: results the conversation keeps citing (in `reuseOrder`), then by the
 * model's keep score, then newer before older.
 */
export function trimToTarget(
  decisions: CallDecision[],
  calls: readonly ToolCall[],
  answers: ReadonlyMap<string, CallAnswer>,
  reuseOrder: readonly string[],
  currentChars: number,
  targetChars: number,
  headChars: number,
  inputChars: ReadonlyMap<string, number>,
): { trimmedResults: number; trimmedCalls: number; estimatedChars: number } {
  if (targetChars <= 0 || currentChars <= targetChars) {
    return { trimmedResults: 0, trimmedCalls: 0, estimatedChars: currentChars };
  }
  const rank = new Map(reuseOrder.map((id, index) => [id, index]));
  const byId = new Map(calls.map((call) => [call.id, call]));
  // Lowest value first.
  const value = (decision: CallDecision): [number, number, number] => {
    const reused = rank.has(decision.id) ? 1 : 0;
    const reuseRank = rank.has(decision.id) ? -(rank.get(decision.id) as number) : 0;
    const score = answers.get(decision.id)?.keepResult ?? 0;
    const newer = byId.get(decision.id)?.callIndex ?? 0;
    return [reused, reused ? reuseRank : score, newer];
  };
  const order = (a: CallDecision, b: CallDecision): number => {
    const va = value(a);
    const vb = value(b);
    return va[0] - vb[0] || va[1] - vb[1] || va[2] - vb[2];
  };
  let chars = currentChars;
  let trimmedResults = 0;
  let trimmedCalls = 0;

  const keptOnes = decisions.filter((d) => d.action === 'keep' && d.reason === 'kept').sort(order);
  for (const decision of keptOnes) {
    if (chars <= targetChars) break;
    const call = byId.get(decision.id);
    if (!call) continue;
    const saving = Math.max(0, call.resultChars - headChars);
    if (saving === 0) continue;
    decision.action = 'drop_result';
    decision.reason = 'result_dropped';
    chars -= saving;
    trimmedResults++;
  }
  if (chars > targetChars) {
    const stubs = decisions.filter((d) => d.action === 'drop_result').sort(order);
    for (const decision of stubs) {
      if (chars <= targetChars) break;
      const call = byId.get(decision.id);
      if (!call) continue;
      decision.action = 'drop_call';
      decision.reason = 'call_dropped';
      chars -= Math.min(call.resultChars, headChars) + (inputChars.get(decision.id) ?? 0);
      trimmedCalls++;
    }
  }
  return { trimmedResults, trimmedCalls, estimatedChars: Math.max(0, chars) };
}

export function messagesChars(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += message.text.length;
    for (const use of message.toolUses) total += JSON.stringify(use.input ?? {}).length + use.tool.length;
    for (const result of message.toolResults ?? []) total += result.text.length;
  }
  return total;
}
