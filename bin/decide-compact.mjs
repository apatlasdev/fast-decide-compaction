#!/usr/bin/env node
// Compacts a message list with Mercury Decide. Works with any harness that can hand over its messages.
//   cat messages.json | decide-compact --format anthropic > compacted.json
// Needs `npm run build` first (this imports ../dist) and your own OpenRouter key in OPENROUTER_API_KEY.
import { readFileSync } from 'node:fs';
import { JevClient } from '../dist/index.js';
import { compactWire as wire } from '../dist/adapters.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log(`decide-compact [--format anthropic|openai|generic] [--in file] [--floor 40] [--no-reuse] [--stats]
Reads a JSON array of messages (or {"messages": [...]}) from --in or stdin and prints the compacted array.
Env: OPENROUTER_API_KEY (yours), DECIDE_MODEL (default inception/mercury-decide:free),
     DECIDE_BASE_URL (default https://openrouter.ai/api/alpha/decisions)`);
  process.exit(0);
}
const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error('Set OPENROUTER_API_KEY to your own OpenRouter key. This tool never ships or uses anyone else\'s.');
  process.exit(2);
}
const input = flag('in') ? readFileSync(flag('in'), 'utf8') : readFileSync(0, 'utf8');
const parsed = JSON.parse(input);
const raw = Array.isArray(parsed) ? parsed : parsed.messages;
const client = new JevClient({
  apiKey: key,
  model: process.env.DECIDE_MODEL ?? 'inception/mercury-decide:free',
  baseUrl: process.env.DECIDE_BASE_URL ?? 'https://openrouter.ai/api/alpha/decisions',
});
const { messages, result } = await wire(flag('format', 'anthropic'), raw, client, {
  preserveRecentMessages: Number(flag('floor', 40)),
  reuseKeep: !args.includes('--no-reuse'),
});
if (args.includes('--stats')) console.error(JSON.stringify(result.stats));
process.stdout.write(JSON.stringify(messages));
