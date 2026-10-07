import { describe, expect, it } from 'vitest';
import { compactWire } from '../src/adapters.js';

const asker: any = {
  async ask(_state: unknown, questions: Record<string, unknown>) {
    return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: 0.1 }])) };
  },
};
const big = 'x'.repeat(2000);

function build(format: 'anthropic' | 'openai'): any[] {
  const raw: any[] = [{ role: 'user', content: 'fix the build' }];
  for (let i = 0; i < 80; i++) {
    if (format === 'anthropic') {
      raw.push({ role: 'assistant', content: [{ type: 'text', text: `step ${i}` }, { type: 'tool_use', id: 'a' + i, name: 'Bash', input: { command: 'ls ' + i } }] });
      raw.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a' + i, content: big }] });
    } else {
      raw.push({ role: 'assistant', content: `step ${i}`, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'ls ' + i }) } }] });
      raw.push({ role: 'tool', tool_call_id: 'c' + i, content: big });
    }
  }
  raw.push({ role: 'assistant', content: 'done' });
  return raw;
}

describe('harness adapters', () => {
  for (const format of ['anthropic', 'openai'] as const) {
    it(`${format}: shrinks, keeps untouched messages as the caller's objects, keeps tool pairs valid`, async () => {
      const raw = build(format);
      const { messages } = await compactWire(format, raw, asker, { preserveRecentMessages: 6, reuseKeep: false });
      expect(JSON.stringify(messages).length).toBeLessThan(JSON.stringify(raw).length * 0.6);
      expect(messages[0]).toBe(raw[0]);
      expect(messages[messages.length - 1]).toBe(raw[raw.length - 1]);
      const uses = new Set<string>();
      const results: string[] = [];
      for (const m of messages) {
        if (format === 'anthropic') {
          for (const b of Array.isArray(m.content) ? m.content : []) {
            if (b.type === 'tool_use') uses.add(b.id);
            if (b.type === 'tool_result') results.push(b.tool_use_id);
          }
        } else {
          for (const c of m.tool_calls ?? []) uses.add(c.id);
          if (m.role === 'tool') results.push(m.tool_call_id);
        }
      }
      expect(results.every((id) => uses.has(id))).toBe(true);
    });
  }
});
