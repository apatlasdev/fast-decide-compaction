import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio, resolveOptions } from '../src/compact.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

const HOOK_DEFAULTS = {
  compactAtPercent: 67,
  minReductionRatio: 0.25,
  // OpenRouter default: Inception's Mercury Decide (free, 32k ctx, same Decisions API).
  // Override with the `model` plugin option or the FAST_JEV_MODEL env var.
  // DEFAULT_MODEL ('jev-latest') is the TypeSafe-native path and is unchanged.
  model: 'inception/mercury-decide:free',
};

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  baseUrl?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
  /** Percent of the model's context window to keep as a whole-message tail / to trim the history to. */
  preserveRecentPercent?: number;
  targetPercent?: number;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
// Jev is reachable through OpenRouter's Decisions API with an OpenRouter key,
// which avoids a separate TypeSafe account. Override with the `baseUrl` option.
const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';

// `mode: economy` trades fidelity for a smaller, cheaper context: compact at 20% of the window,
// keep the newest ~20k tokens whole, and trim to about 40k tokens. Explicit options still win.
const ECONOMY_PRESET = {
  compactAtPercent: 67,
  preserveRecentMessages: 10,
  preserveRecentPercent: 2,
  targetPercent: 4,
} as const;

export function resolveHookConfig(options: PluginOptions): HookConfig {
  const economy = optionString(options, 'mode') === 'economy';
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = economy
    ? { preserveRecentMessages: ECONOMY_PRESET.preserveRecentMessages }
    : {};
  for (const key of [
    'keepThreshold',
    'preserveRecentMessages',
    'preserveRecentChars',
    'targetChars',
    'reuseMinHits',
    'reuseBudgetChars',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', economy ? ECONOMY_PRESET.compactAtPercent : HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
  };
  const tokenKeys: [string, 'preserveRecentChars' | 'targetChars'][] = [['preserveRecentTokens', 'preserveRecentChars'], ['targetTokens', 'targetChars']];
  for (const [tokenKey, charKey] of tokenKeys) {
    const value = options[tokenKey];
    if (typeof value === 'number' && Number.isFinite(value)) config[charKey] = Math.round(value * 4);
  }
  if (options['reuseKeep'] === false) config.reuseKeep = false;
  if (options['extractCited'] === true) config.extractCited = true;
  if (options['extractOldText'] === true) config.extractOldText = true;
  const preservePct = optionNumber(options, 'preserveRecentPercent', economy ? ECONOMY_PRESET.preserveRecentPercent : 0);
  const targetPct = optionNumber(options, 'targetPercent', economy ? ECONOMY_PRESET.targetPercent : 0);
  if (preservePct > 0) config.preserveRecentPercent = preservePct;
  if (targetPct > 0) config.targetPercent = targetPct;
  const baseUrl = optionString(options, 'baseUrl') ?? OPENROUTER_DECISIONS_URL;
  if (baseUrl) config.baseUrl = baseUrl;
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(
  fetchFn: HookFetch,
  apiKey: string,
  model: string,
  baseUrl?: string,
): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model, baseUrl }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const result = await compact(
    messages,
    jevAsker(fetchFn, config.apiKey, config.model, config.baseUrl),
    config,
  );
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

// --- savings ledger (local addition, 2026-09-19) -------------------------------
// The upstream plugin reports savings only to the UI, so nothing survives the
// session and "is it working" cannot be answered later. Append one JSONL row per
// compaction to ~/.claude/fast-decide-savings.jsonl. Best-effort: never throw, never
// block a compaction.
// 2026-09-23: Claude Code 2.1.281 refuses `$.session?.usage?.()` ($ nouns must be spelled
// `$.noun.event(...)` at the call site), and a hooks module has no Node, so the old
// `import('node:fs/promises')` append could never run. Both now go through `$`.
// Short diagnostic trail (last ~200 lines) so a silent trigger can be debugged from a file.
async function trace($: any, text: string): Promise<void> {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'));
    if (!home) return;
    const file = `${home}/.claude/fast-decide-trace.log`;
    let prior = '';
    try {
      prior = await $.fs.read(file);
    } catch {
      /* first line */
    }
    const NL = String.fromCharCode(10);
    const lines = (prior + `${new Date().toISOString()} ${text}` + NL).split(NL);
    await $.fs.write(file, lines.slice(-201).join(NL));
  } catch {
    /* tracing must never break compaction */
  }
}

async function recordSavings(
  $: any,
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    let ctxPercent: number | undefined;
    let ctxTokens: number | undefined;
    try {
      const u = await $.session.usage();
      ctxPercent = u?.context?.percent;
      ctxTokens = u?.context?.tokens;
    } catch {
      /* usage unavailable at this point; record the rest anyway */
    }
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'));
    if (!home) return;
    const file = `${home}/.claude/fast-decide-savings.jsonl`;
    let prior = '';
    try {
      prior = await $.fs.read(file);
    } catch {
      /* first row */
    }
    const row = { at: new Date().toISOString(), ctxPercent, ctxTokens, ...entry };
    await $.fs.write(file, prior + JSON.stringify(row) + '\n');
  } catch {
    /* never let bookkeeping break compaction */
  }
}
// ------------------------------------------------------------------------------

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  $.ui.log(text);
  $.ui.toast(text, { timeoutMs: 15_000 });
}


// 2026-09-22 (long-session freezes): every Jev call and the whole compaction are time-boxed.
// compactSession() sends its batches with Promise.all and $.http.fetch has no timeout, so one
// hung OpenRouter request left turn.complete waiting forever: the session showed as running,
// ran nothing, and queued every new message. On timeout the handler throws, which falls back
// to the built-in compaction (next(event)) instead of freezing the session.
const JEV_CALL_TIMEOUT_MS = 60_000;
const JEV_COMPACT_BUDGET_MS = 150_000;
// The timer is $.clock.after: a hooks module has no setTimeout global in this build.
function withTimeout<T>($: any, work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: { cancel: () => void } | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = $.clock.after(ms, () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)));
  });
  return Promise.race([work, expired]).finally(() => { timer?.cancel(); });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  let skipNoticeShown = false;
  // Headless/SDK hosts cannot start a compaction from a hook, but they accept a queued
  // `/compact` prompt. Ask at most once per 10 minutes, and stop asking if a request
  // never produced a session.compact event (the host did not treat it as a command).
  let slashCompactAt = 0;
  let slashCompactSeenAt = 0;
  let slashCompactDisabled = false;
  const SLASH_COMPACT_COOLDOWN_MS = 10 * 60 * 1000;

  on('session.compact', async ($, event, next) => {
    slashCompactSeenAt = Date.now();
    void trace($, `session.compact fired trigger=${(event as any)?.trigger ?? '?'} messages=${(event as any)?.messages?.length ?? '?'}`);
    try {
      let envModel: string | undefined;
      try { envModel = (await $.env.get('FAST_DECIDE_MODEL')) || (await $.env.get('FAST_JEV_MODEL')) || undefined; } catch { /* env unavailable */ }
      const model = optionString(options, 'model') ?? envModel ?? configured.model;
      const config: HookConfig = { ...configured, model, apiKey: await getApiKey($, configured) };
      // Percent-of-window options become characters once the window is known (4 chars per token).
      if (config.preserveRecentPercent || config.targetPercent) {
        try {
          const usage = await $.session.usage();
          const tokens = usage?.context?.tokens;
          const percent = usage?.context?.percent;
          if (tokens && percent && percent > 0) {
            const windowTokens = (tokens * 100) / percent;
            if (config.preserveRecentPercent && config.preserveRecentChars === undefined) {
              config.preserveRecentChars = Math.round((config.preserveRecentPercent / 100) * windowTokens * 4);
            }
            if (config.targetPercent && config.targetChars === undefined) {
              config.targetChars = Math.round((config.targetPercent / 100) * windowTokens * 4);
            }
          }
        } catch { /* window unknown: the message and result-based options still apply */ }
      }
      // Archive dropped tool output to disk (the agent can read it back instead of re-running the tool)
      // and add a short index of dropped calls. Both default on; set `archive` / `activityIndex` false to turn off.
      if (options['activityIndex'] !== false) config.activityIndex = true;
      if (options['archive'] !== false) {
        try {
          const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'));
          if (home) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const dir = `${home}/.claude/fast-decide-archive/${stamp}`;
            await $.fs.write(`${dir}/README.txt`, 'Full text of tool results that fast-decide-compaction shortened. File name = tool_use_id.');
            config.archiveDir = dir;
          }
        } catch { /* cannot write: compact without pointers */ }
      }
      const { result, messages } = await withTimeout($, compactSession(event.messages, config, async (url, init) => {
        const response = await withTimeout($, $.http.fetch(url, init), JEV_CALL_TIMEOUT_MS, 'Jev request');
        return { status: response.status, ok: response.ok, text: response.text };
      }), JEV_COMPACT_BUDGET_MS, 'Jev compaction');
      if (result.archives.length > 0) {
        const MAX_FILE = 200_000;
        for (let i = 0; i < result.archives.length; i += 8) {
          await Promise.all(
            result.archives.slice(i, i + 8).map((a) =>
              $.fs.write(a.path, a.text.length > MAX_FILE ? a.text.slice(0, MAX_FILE) + ' [archive cut at 200000 characters]' : a.text).catch(() => undefined),
            ),
          );
        }
      }
      // The per-call table is thousands of characters on big sessions; the summary line below
      // already says what happened. Set FAST_DECIDE_VERBOSE=1 to print every decision.
      let verbose = false;
      try { verbose = ['1', 'true'].includes(((await $.env.get('FAST_DECIDE_VERBOSE')) ?? '').toLowerCase()); } catch { /* env unavailable */ }
      if (verbose) for (const line of decisionLogLines(result)) $.ui.log(line);
      if (reductionRatio(result) < config.minReductionRatio) {
        await recordSavings($, {
          outcome: 'fallback_below_minimum',
          messagesBefore: event.messages.length,
          reduction: reductionRatio(result),
          minReduction: config.minReductionRatio,
          stats: result.stats,
          summaryCallAvoided: false,
        });
        notify(
          $,
          `fallback to built-in summary (below ${percent(config.minReductionRatio)} minimum: ${summarize(result)})`,
        );
        return next(event);
      }
      await recordSavings($, {
        outcome: 'jev_kept_verbatim',
        messagesBefore: event.messages.length,
        messagesAfter: messages.length,
        messagesDropped: event.messages.length - messages.length,
        reduction: reductionRatio(result),
        stats: result.stats,
        summaryCallAvoided: true,
      });
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`,
      );
      return { messages };
    } catch (error) {
      await recordSavings($, {
        outcome: 'fallback_error',
        messagesBefore: event.messages.length,
        error: error instanceof Error ? error.message : String(error),
        summaryCallAvoided: false,
      });
      notify(
        $,
        `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`,
      );
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < configured.compactAtPercent) return next(event);
      void trace($, `turn.complete percent=${context.percent} threshold=${configured.compactAtPercent}`);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void trace($, `session.compact() refused: ${reason.slice(0, 160)} (disabled=${slashCompactDisabled})`);
      if (/headless|not available/i.test(reason) && !slashCompactDisabled) {
        const now = Date.now();
        if (slashCompactAt > 0 && slashCompactSeenAt < slashCompactAt && now - slashCompactAt > 120_000) {
          slashCompactDisabled = true; // the last request never compacted anything
        } else if (now - slashCompactAt > SLASH_COMPACT_COOLDOWN_MS) {
          slashCompactAt = now;
          // Ask after this turn has finished: inside the hook the turn is still waiting on us,
          // and the host refuses to start a command or prompt from there.
          $.clock.after(1500, async () => {
            let how = '';
            try {
              await $.command.run({ command: 'compact' });
              how = 'command.run';
            } catch (runError) {
              void trace($, `command.run(compact) failed: ${runError instanceof Error ? runError.message.slice(0, 160) : String(runError)}`);
              try {
                await $.prompt.submit({ text: '/compact' });
                how = 'prompt.submit';
              } catch (submitError) {
                slashCompactDisabled = true;
                void trace($, `prompt.submit failed: ${submitError instanceof Error ? submitError.message.slice(0, 160) : String(submitError)}`);
              }
            }
            if (how) {
              void trace($, `queued /compact via ${how}`);
              $.ui.log('fast-decide-compaction: context is past the threshold, asking the host to /compact');
            }
          });
        }
      } else if (!skipNoticeShown) {
        // The host's own compaction still goes through the session.compact hook. Say so once, briefly.
        skipNoticeShown = true;
        $.ui.log('fast-decide-compaction: host compacts this session (hook auto-trigger unavailable here)');
      }
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
