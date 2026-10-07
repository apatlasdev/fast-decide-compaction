import { describe, expect, it } from 'vitest';
import { compact } from '../src/compact.js';
import type { Message } from '../src/types.js';

const lowAsk: any = { async ask(_s: unknown, q: Record<string, unknown>) { return { answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: 0.1 }])) }; } };
const callHighAsk: any = { async ask(_s: unknown, q: Record<string, unknown>) { return { answers: Object.fromEntries(Object.keys(q).map((k) => [k, { noul: k.startsWith('call_') ? 0.9 : 0.1 }])) }; } };
const big = 'result line with src/app.ts '.repeat(200);

function history(): Message[] {
  const msgs: Message[] = [{ role: 'user', text: 'fix it', toolUses: [] }];
  for (let i = 0; i < 40; i++) {
    const tool = i === 3 ? 'AskUserQuestion' : i % 2 ? 'Bash' : 'Write';
    msgs.push({ role: 'assistant', text: 'step ' + i, toolUses: [{ tool_use_id: 'u' + i, tool, input: tool === 'Bash' ? { command: 'ls dir' + i } : { file_path: '/p/f' + i + '.ts', content: 'x'.repeat(3000) } }] });
    msgs.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u' + i, text: i === 3 ? 'user chose option B' : big }] });
  }
  msgs.push({ role: 'assistant', text: 'done', toolUses: [] });
  return msgs;
}

describe('safety and recovery features', () => {
  it('never drops the user\'s own answers', async () => {
    const r = await compact(history(), lowAsk, { preserveRecentMessages: 6, reuseKeep: false });
    expect(JSON.stringify(r.messages)).toContain('user chose option B');
  });
  it('lists archives, points truncation notes at them and indexes dropped calls', async () => {
    const msgs = history();
    const dropped = await compact(msgs, lowAsk, { preserveRecentMessages: 6, reuseKeep: false, archiveDir: '/arch/s1', activityIndex: true });
    expect(dropped.archives.length).toBeGreaterThan(10);
    expect(dropped.archives.every((a) => a.path.startsWith('/arch/s1/'))).toBe(true);
    expect(dropped.messages[1]!.text).toContain('earlier tool activity');
    expect(dropped.messages[1]!.text).toContain('Bash: ls dir');
    const truncated = await compact(msgs, callHighAsk, { preserveRecentMessages: 6, reuseKeep: false, archiveDir: '/arch/s1' });
    expect(JSON.stringify(truncated.messages)).toContain('full output saved at /arch/s1/u');
  });
  it('is off by default', async () => {
    const r = await compact(history(), lowAsk, { preserveRecentMessages: 6, reuseKeep: false });
    expect(r.archives).toHaveLength(0);
    expect(JSON.stringify(r.messages)).not.toContain('earlier tool activity');
  });
});
