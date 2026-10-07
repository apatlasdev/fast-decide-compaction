import { describe, expect, it } from 'vitest';
import { identifierTokens, reusedCallIds } from '../src/reuse.js';
import type { Message, ToolCall } from '../src/types.js';

const msg = (role: 'user' | 'assistant', text: string, extra: Partial<Message> = {}): Message => ({
  role, text, toolUses: [], toolResults: [], ...extra,
});

describe('reuse override', () => {
  it('extracts paths, error names and ids', () => {
    const t = identifierTokens('see src/state.ts and PermissionError, id 9f3a1c77e2b0, plus build_cache_dir');
    expect(t.has('src/state.ts')).toBe(true);
    expect(t.has('PermissionError')).toBe(true);
    expect(t.has('9f3a1c77e2b0')).toBe(true);
    expect(t.has('build_cache_dir')).toBe(true);
  });

  it('keeps a dropped result whose identifiers come back later, not an unrelated one', () => {
    const messages: Message[] = [
      msg('user', 'goal'),
      msg('assistant', 'reading', { toolUses: [{ tool_use_id: 'a', tool: 'Read', input: { path: 'x' } }] }),
      msg('user', '', { toolResults: [{ tool_use_id: 'a', text: 'file lib/engine_core.py defines run_pipeline_step and RuntimeFault' }] }),
      msg('assistant', 'reading other', { toolUses: [{ tool_use_id: 'b', tool: 'Read', input: { path: 'y' } }] }),
      msg('user', '', { toolResults: [{ tool_use_id: 'b', text: 'nothing special here at all' }] }),
      msg('assistant', 'the bug is in lib/engine_core.py inside run_pipeline_step'),
    ];
    const calls = [
      { id: 't1', tool_use_id: 'a', tool: 'Read', input: {}, callIndex: 1, resultIndex: 2, resultChars: 70, isError: false, pinned: false },
      { id: 't2', tool_use_id: 'b', tool: 'Read', input: {}, callIndex: 3, resultIndex: 4, resultChars: 27, isError: false, pinned: false },
    ] as ToolCall[];
    const answers = new Map([['t1', { keepCall: 0.1, keepResult: 0.1 }], ['t2', { keepCall: 0.1, keepResult: 0.1 }]]);
    const ids = reusedCallIds(messages, calls, answers, 0.5, { minHits: 2, budgetChars: 1000 });
    expect(ids).toEqual(['t1']);
  });

  it('respects the character budget', () => {
    const messages: Message[] = [
      msg('user', 'goal'),
      msg('assistant', 'r', { toolUses: [{ tool_use_id: 'a', tool: 'Read', input: {} }] }),
      msg('user', '', { toolResults: [{ tool_use_id: 'a', text: 'lib/engine_core.py run_pipeline_step '.repeat(50) }] }),
      msg('assistant', 'uses lib/engine_core.py and run_pipeline_step'),
    ];
    const calls = [{ id: 't1', tool_use_id: 'a', tool: 'Read', input: {}, callIndex: 1, resultIndex: 2, resultChars: 1700, isError: false, pinned: false }] as ToolCall[];
    const answers = new Map([['t1', { keepCall: 0, keepResult: 0 }]]);
    expect(reusedCallIds(messages, calls, answers, 0.5, { minHits: 2, budgetChars: 100 })).toEqual([]);
  });
});
