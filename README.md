# fast-decide-compaction

Claude Code plugin that replaces the compaction summary with Mercury Decide decisions:
every tool call and result is scored in one fast request, stale ones are
dropped or truncated, everything kept stays verbatim. Also usable as an npm
library.

## Overview

**What it does.** When a session gets long, most tools ask an LLM to write a summary of the old turns. This replaces that with Mercury Decide, a fast decision model: for every old tool call and result it answers "still needed?". Needed ones stay **word for word**; the rest are shortened or removed. Nothing is rewritten, so exact file paths, errors and commands survive. On top of Decide it adds a recency floor (the newest 40 messages are never touched) and a text check that keeps any result whose paths, ids or error names the later conversation keeps mentioning. Big histories are decided in windows; free-tier rate limits are retried.

**Where it works**

| Host | How it runs | Status |
|---|---|---|
| Claude Code in a terminal | plugin hook; compacts when context passes the threshold (default 60%) | designed for it (the original plugin's mode); not separately verified on this fork |
| Claude desktop app / headless (SDK) | the host cannot start a compaction from a hook, so the plugin queues `/compact` once context passes the threshold; the same Decide compaction then runs | worked in two long sessions (see `~/.claude/fast-decide-trace.log`); the ledger has about 20 compactions |
| Codex | hook entries in `~/.codex/config.toml`, each marked trusted (Codex silently skips untrusted hooks); the library files are the same code built to JavaScript | loads and passes its tests; not checked in a live Codex compaction |
| Any other harness | `decide-compact` CLI or `compactWire()` for Anthropic Messages, OpenAI Chat and a neutral format | tested with synthetic histories only |

**Bring your own key.** It needs *your own* OpenRouter API key (`OPENROUTER_API_KEY`) and uses the free model `inception/mercury-decide:free` by default. No shared key or account is involved. A condensed view of your session (tool names, tool inputs, abridged tool results and recent prompts) is sent to OpenRouter's Mercury Decide endpoint, so check their terms before using it on private code.

**Other harnesses**

```bash
npm install && npm run build
cat messages.json | OPENROUTER_API_KEY=... npx decide-compact --format anthropic --stats > compacted.json
```

```ts
import { JevClient, compactWire } from 'fast-decide-compaction';
const client = new JevClient({ apiKey: process.env.OPENROUTER_API_KEY, model: 'inception/mercury-decide:free',
  baseUrl: 'https://openrouter.ai/api/alpha/decisions' });
const { messages } = await compactWire('openai', myChatMessages, client, { preserveRecentMessages: 40 });
```

`compactWire` takes `anthropic`, `openai` or `generic` messages, returns the same format, hands back untouched messages as your own objects, and keeps tool calls and their results paired. The core (`compact()`) works on a neutral shape, so a new harness needs only a converter.

**Keeps the work flowing.** Claude Code compacts on its own in the middle of a turn, between model requests, and the turn simply carries on; background commands keep running through it. To make that happen at 67% of *whatever the model's window is* (instead of ~97%), set `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=67` in the `env` block of `~/.claude/settings.json`. This plugin's `session.compact` hook then does the Decide compaction in a few seconds, with no stop and no queued command. The queued `/compact` described above is only a fallback for hosts where that setting is unavailable; it ends the turn, so work does not resume by itself.

**Cost: what actually moves it.** Every turn re-reads the whole context, so cost follows how much you keep and how early you compact. `npm run cost` models it with OpenRouter's list prices (checked 2026-10-06; prompt caching on; 4k new and 600 output tokens per turn; a 20k-token summary; trigger at 67% of a 1M window):

| Model | Summary, $/turn | Economy mode (keeps ~40k tokens) | Fidelity mode (keeps ~50%) |
|---|---|---|---|
| Claude Sonnet 5.5 | $0.087 | +0.3% | +45% |
| Claude Opus 5.5 | $0.105 | -0.6% | +45% |
| GPT-6.1 Sol | $0.053 | -0.6% | +45% |
| GPT-6 Astra | $0.437 | +0.3% | +45% |

At a 67% trigger this does **not** save money: economy mode costs about the same as a summary, fidelity mode costs 45% more because it keeps more. The money lever is compacting earlier (`node scripts/cost-model.mjs --sweep`: compacting at 200k instead of 900k is about 50-60% cheaper per turn on every model above), which any tool can do and which gives up context. What this tool adds is *what survives*, shown next. All of this is a model with assumed turn sizes, not a measured bill.

**Recall at size** (replay of real sessions: share of the paths, ids and error names used later that survive; 3 slices of one agent's sessions, small sample):

| Setup | History left | Recall |
|---|---|---|
| LLM summary + last 40 messages | 3-5% (~10k tokens) | 23-44% |
| Decide, newest 20k tokens whole + trimmed to ~40k | 13-52% | 50-85% |
| Decide, tail 10% + target 15% | 19-56% | 57-81% |
| Decide, tail 15% + target 25% | 25-58% | 71-88% |
| Decide, tail 25% + target 40% | 38-64% | 80-88% |
| Keep only the newest text, same sizes | same | 65-93% |

The tail does most of the work. At equal size, Decide plus the reuse check is about level with keeping the newest text and well above a summary, and it does not clearly beat the newest-text baseline. Two limits: a session whose history is mostly the model's own prose (one slice was ~50% prose) cannot be trimmed below that, because this tool only removes tool output and never rewrites text; and line extraction (`extractCited`, `extractOldText`, keeping only lines that contain cited identifiers) was tested and made no measurable difference, so it is off.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same full state is resent with every request; requests run
   concurrently and their answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the Claude Code hook) decides what to fall back to.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Status of this fork

Experimental. What was measured, so you can judge it:

- Replay test: take a real coding-agent session, compact its first 80%, then check what fraction of the file paths, error names and ids used in the last 20% are still present (3 slices of one agent's sessions, so a small sample). Plain Decide dropped almost every tool call and scored 24-67% recall, below keeping the newest text of the same size.
- Two changes fixed most of that. (1) Newest 40 messages are protected instead of 6 (a recency floor, as in Unreal Agent's compaction). (2) A text-matching step keeps tool results whose paths, ids or error names the later conversation keeps mentioning, up to a size cap. With both, recall rose to 81-96% at 39-52% smaller history. That is on par with keeping the newest text of the same size (84-98%), not clearly better, and it shrinks the history much less than the old 70-90%.
- An LLM summary of the older part plus the last 40 messages kept 23-44% recall at 95-97% smaller. Different trade-off: much smaller, much more lost.
- The reuse step looks at the same kind of identifiers the test scores, so the test favours it. Treat the numbers as indicative.
- In real use on one long session (nine compactions), the agent carried on without visible loss of context.
- Large histories are decided in windows of about 18k tokens; free-tier rate limits are retried with backoff.
- In headless/SDK hosts (e.g. the Claude desktop app) the hook cannot start a compaction itself, so it queues `/compact` once context passes the threshold. Each step is written to `~/.claude/fast-decide-trace.log`.
- The per-call decision table is not printed by default; set `FAST_DECIDE_VERBOSE=1` to see it. Options: `mode` (fidelity | economy), `preserveRecentMessages` (default 40), `preserveRecentTokens`, `targetTokens`, `reuseKeep` (default true), `reuseMinHits` (2), `reuseBudgetChars` (400000).

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add tamaratran/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the toast reads
`fast-jev-compaction: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary, or `fallback to built-in summary (…)` when Jev
could not remove enough (short sessions, or when it fails).

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
