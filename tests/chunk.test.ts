import { describe, expect, it } from 'vitest';
import { compact } from '../src/compact.js';
import { assignCallsToWindows, planWindows, splitIntoWindows } from '../src/chunk.js';
import { estimateTokens } from '../src/state.js';
import type { Message } from '../src/types.js';

const big = 'x'.repeat(900);
function history(pairs: number): Message[] {
  const messages: Message[] = [{ role: 'user', text: 'Goal: fix the build', toolUses: [], toolResults: [] }];
  for (let i = 0; i < pairs; i++) {
    messages.push({
      role: 'assistant',
      text: `step ${i} ${big}`,
      toolUses: [{ tool_use_id: `t${i}`, tool: 'Bash', input: { command: `cmd ${i} ${'y'.repeat(300)}` } }],
      toolResults: [],
    });
    messages.push({ role: 'user', text: `result ${i}`, toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: `out ${big}` }] });
  }
  return messages;
}
const mockAsker = (log: { requests: number; maxState: number }) => ({
  async ask(state: unknown, questions: Record<string, unknown>) {
    log.requests++;
    log.maxState = Math.max(log.maxState, estimateTokens(JSON.stringify(state)));
    if (log.maxState > 25_000) throw new Error('state over cap');
    return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: k.startsWith('result') ? 0.2 : 0.9 }])) };
  },
});

describe('chunked decisions', () => {
  it('splits into windows that cover every message exactly once', () => {
    const msgs = history(200);
    const { windows } = planWindows(msgs, [], { budget: 18_000, overlap: 3, estimateTokens });
    let prev = 0;
    for (const w of windows) {
      expect(w.start).toBe(prev);
      expect(w.end).toBeGreaterThan(w.start);
      prev = w.end;
    }
    expect(prev).toBe(msgs.length);
  });

  it('keeps a single huge message as its own window', () => {
    expect(splitIntoWindows([5, 100, 5], 10, 3)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ]);
  });

  it('assigns every call to exactly one window', () => {
    const calls = [0, 3, 4, 9].map((callIndex, n) => ({ id: `t${n}`, callIndex })) as never[];
    const owned = assignCallsToWindows(calls, [{ start: 0, end: 4 }, { start: 4, end: 10 }]);
    expect(owned.map((w) => w.length)).toEqual([2, 2]);
  });

  it('decides a history too large for one state, with every state under the cap', async () => {
    const log = { requests: 0, maxState: 0 };
    const msgs = history(1500);
    const result = await compact(msgs, mockAsker(log) as never, {});
    expect(result.stats.stateStage).toMatch(/^chunked/);
    expect(log.maxState).toBeLessThanOrEqual(25_000);
    expect(result.stats.calls).toBe(1500);
    expect(result.decisions.length).toBe(1500);
  });

  it('propagates a failed window request so the caller falls back', async () => {
    const asker = { ask: async () => { throw new Error('boom'); } };
    await expect(compact(history(1500), asker as never, {})).rejects.toThrow('boom');
  });
});
