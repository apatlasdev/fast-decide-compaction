import { noulAnswer } from './request.js';
import { compactChunked } from './chunk.js';
import { reusedCallIds, laterIdentifierSets } from './reuse.js';
import { citedIn, DEFAULT_EXTRACT, extractCitedLines } from './extract.js';
import { trimToTarget } from './target.js';
import { collectToolCalls, estimateTokens, fitState } from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  keepThreshold: 0.5,
  preserveRecentMessages: 40,
  reuseKeep: true,
  targetChars: 0,
  extractCited: false,
  alwaysKeepTools: ['AskUserQuestion', 'ExitPlanMode'],
  archiveDir: '',
  activityIndex: false,
  extractOldText: false,
  preserveRecentChars: 0,
  reuseMinHits: 2,
  reuseBudgetChars: 400_000,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

/**
 * Mercury Decide (and Jev) evaluate every question against the full state, so a request costs
 * about `questions x (state + question)` input tokens, not `state + questions`. Measured
 * 2026-10-02: 60 questions over a ~14.5k-token state (869k tokens) answered; 70 questions
 * (~1.0M) were refused with HTTP 422 "Decision service could not complete the request", which
 * made every long-session compaction fall back to the built-in summary. Each request is
 * therefore capped at this estimated evaluation cost (the estimate runs 2-50% above the
 * tokens Mercury reports, so this stays well under the ~1M ceiling).
 */
const MAX_EVAL_TOKENS_PER_REQUEST = 600_000;
/** Requests in flight at once; one failing request still fails the compaction (caller falls back). */
const MAX_CONCURRENT_REQUESTS = 4;

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    reuseKeep: options.reuseKeep ?? DEFAULT_OPTIONS.reuseKeep,
    targetChars: Math.max(0, finite(options.targetChars, DEFAULT_OPTIONS.targetChars)),
    extractCited: options.extractCited ?? DEFAULT_OPTIONS.extractCited,
    alwaysKeepTools: options.alwaysKeepTools ?? DEFAULT_OPTIONS.alwaysKeepTools,
    archiveDir: options.archiveDir ?? DEFAULT_OPTIONS.archiveDir,
    activityIndex: options.activityIndex ?? DEFAULT_OPTIONS.activityIndex,
    extractOldText: options.extractOldText ?? DEFAULT_OPTIONS.extractOldText,
    preserveRecentChars: Math.max(0, finite(options.preserveRecentChars, DEFAULT_OPTIONS.preserveRecentChars)),
    reuseMinHits: Math.max(1, Math.floor(finite(options.reuseMinHits, DEFAULT_OPTIONS.reuseMinHits))),
    reuseBudgetChars: Math.max(0, finite(options.reuseBudgetChars, DEFAULT_OPTIONS.reuseBudgetChars)),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
  };
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: 'noul',
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  let currentEval = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    // Two questions per call, each evaluated against the whole state.
    const evalCost = 2 * (stateTokens + REQUEST_OVERHEAD_TOKENS) + tokens;
    if (
      current.length > 0 &&
      (currentTokens + tokens > budget || currentEval + evalCost > MAX_EVAL_TOKENS_PER_REQUEST)
    ) {
      batches.push(current);
      current = [];
      currentTokens = 0;
      currentEval = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
    currentEval += evalCost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'>,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

/** Runs `fn` over `items` with at most `limit` in flight; stops starting new work after a failure. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The free tier answers 429 when requests bunch up; wait and retry a few times before giving up. */
async function askWithRetry(asker: JevAsker, state: CompactionState, questions: JevQuestions) {
  const waits = [1500, 4000, 9000, 20000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await asker.ask(state, questions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/429|rate.?limit/i.test(message) || attempt >= waits.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
    }
  }
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await askWithRetry(asker, state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

function truncatedResultText(text: string, isError: boolean, headChars: number, pointer?: string): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}[fast-jev-compaction truncated ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; ${pointer ? `full output saved at ${pointer}` : 're-run the tool if needed'}]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
  pointers: ReadonlyMap<string, string> = new Map(),
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
          pointers.get(tool.tool_use_id),
        );
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars, pointers.get(result.tool_use_id));
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** One compact line per dropped call: what was run and, if archived, where the full output is. */
export function activityNote(
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  pointers: ReadonlyMap<string, string>,
  maxChars = 30_000,
): string {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const lines: string[] = [];
  for (const decision of decisions) {
    if (decision.action !== 'drop_call') continue;
    const call = byId.get(decision.id);
    if (!call) continue;
    const input = call.input ?? {};
    const key = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']
      .map((name) => input[name])
      .find((value) => typeof value === 'string') as string | undefined;
    const arg = (key ?? JSON.stringify(input)).split(String.fromCharCode(10))[0]!.slice(0, 90);
    const where = pointers.get(call.tool_use_id);
    lines.push(`${call.tool}: ${arg}${where ? ` -> ${where}` : ''}`);
  }
  if (lines.length < 3) return '';
  let body = lines.join(String.fromCharCode(10));
  while (body.length > maxChars && lines.length > 3) {
    lines.shift();
    body = lines.join(String.fromCharCode(10));
  }
  return `[fast-decide-compaction: earlier tool activity whose details were dropped (oldest first)]${String.fromCharCode(10)}${body}`;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions. Throws when Jev fails or the
 * history cannot be fitted; the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  if (resolved.preserveRecentChars > 0) {
    // Protect whole newest messages up to the character budget, never fewer than the message floor.
    let budget = resolved.preserveRecentChars;
    let count = 0;
    for (let i = messages.length - 1; i >= 1; i--) {
      const size = messageChars(messages[i]!);
      if (budget - size < 0 && count > 0) break;
      budget -= size;
      count++;
    }
    resolved.preserveRecentMessages = Math.max(resolved.preserveRecentMessages, count);
  }
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  const answers = new Map<string, CallAnswer>();
  let requestCount = 0;
  if (candidates.length > 0) {
    let state: ReturnType<typeof fitState> | null = null;
    try {
      state = fitState(messages, calls, resolved);
    } catch (error) {
      // Only an oversized history is handled by chunking; anything else is a real failure.
      if (!/history too large/.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
    // A single state squeezed into the cap (old calls merged or left out) hides what the
    // calls were for, and Decide then drops nearly everything. Windows at full detail decide better.
    if (state && state.stage !== 'full') state = null;
    if (state) {
      fitted = state;
      batches = batchCalls(candidates, state.tokens, resolved);
      requestCount = batches.length;
      const answered = await mapLimit(batches, MAX_CONCURRENT_REQUESTS, (batch) =>
        askBatch(asker, state.state, batch),
      );
      for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
    } else {
      const chunked = await compactChunked(messages, calls, resolved, asker, {
        fitState,
        batchCalls,
        askBatch,
        mapLimit,
        maxConcurrent: MAX_CONCURRENT_REQUESTS,
        estimateTokens,
      });
      fitted = { tokens: chunked.stateTokens, stage: chunked.stateStage };
      requestCount = chunked.requests;
      for (const [id, answer] of chunked.answers) answers.set(id, answer);
    }
  }

  // Reuse override: results whose identifiers the conversation keeps referring to stay,
  // whatever Decide scored them. Plain text matching, no extra model call.
  let reuseOrder: string[] = [];
  if (resolved.reuseKeep) {
    reuseOrder = reusedCallIds(messages, calls, answers, resolved.keepThreshold, {
      minHits: resolved.reuseMinHits,
      budgetChars: resolved.reuseBudgetChars,
    });
    for (const id of reuseOrder) answers.set(id, { keepCall: 1, keepResult: 1 });
  }

  const alwaysKeep = new Set(resolved.alwaysKeepTools);
  const decisions = calls.map((call) =>
    alwaysKeep.has(call.tool)
      ? ({ id: call.id, tool: call.tool, keepCall: 1, keepResult: 1, action: 'keep', reason: 'kept' } as CallDecision)
      : decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  // Archive: full text of every dropped result goes to `<archiveDir>/<tool_use_id>.txt` (saved by the caller).
  const archives: { path: string; text: string }[] = [];
  const pointers = new Map<string, string>();
  const fillArchive = (): void => {
    archives.length = 0;
    pointers.clear();
    if (!resolved.archiveDir) return;
    const decisionById = new Map(decisions.map((d) => [d.id, d]));
    for (const call of calls) {
      const decision = decisionById.get(call.id);
      if (!decision || decision.action === 'keep') continue;
      const result = messages[call.resultIndex]?.toolResults?.find((r) => r.tool_use_id === call.tool_use_id);
      if (!result || result.text.length <= resolved.truncateHeadChars + 120) continue;
      let dir = resolved.archiveDir;
      while (dir.endsWith('/') || dir.endsWith(String.fromCharCode(92))) dir = dir.slice(0, -1);
      const path = `${dir}/${call.tool_use_id}.txt`;
      archives.push({ path, text: result.text });
      pointers.set(call.tool_use_id, path);
    }
  };
  fillArchive();
  // Line extraction: kept results and old long assistant messages shrink to the lines that
  // contain identifiers cited later; every kept line is verbatim.
  let workMessages: readonly Message[] = messages;
  if (resolved.extractCited || resolved.extractOldText) {
    const later = laterIdentifierSets(messages);
    const copy = messages.slice();
    const pinnedFrom = messages.length - resolved.preserveRecentMessages;
    if (resolved.extractCited) {
      const callById = new Map(calls.map((call) => [call.id, call]));
      for (const decision of decisions) {
        if (decision.action !== 'keep' || decision.reason !== 'kept') continue;
        const call = callById.get(decision.id);
        const source = call ? copy[call.resultIndex] : undefined;
        if (!call || !source?.toolResults) continue;
        let changed = false;
        const results = source.toolResults.map((result) => {
          if (result.tool_use_id !== call.tool_use_id) return result;
          const text = extractCitedLines(result.text, citedIn(result.text, later[call.resultIndex]!));
          if (text === result.text) return result;
          changed = true;
          call.resultChars = text.length;
          return { tool_use_id: result.tool_use_id, text, isError: result.isError };
        });
        if (changed) copy[call.resultIndex] = { role: source.role, text: source.text, toolUses: source.toolUses, toolResults: results };
      }
    }
    if (resolved.extractOldText) {
      for (let i = 1; i < pinnedFrom; i++) {
        const message = copy[i]!;
        if (message.role !== 'assistant' || message.text.length < 1200) continue;
        const text = extractCitedLines(message.text, citedIn(message.text, later[i]!), { ...DEFAULT_EXTRACT, minChars: 1200 });
        if (text !== message.text) copy[i] = { role: message.role, text, toolUses: message.toolUses, toolResults: message.toolResults };
      }
    }
    workMessages = copy;
  }
  let kept = applyDecisions(
    workMessages,
    decisions,
    calls,
    resolved.truncateHeadChars,
    pointers,
  );
  if (resolved.targetChars > 0) {
    const now = kept.reduce((sum, message) => sum + messageChars(message), 0);
    const inputChars = new Map<string, number>();
    for (const call of calls) inputChars.set(call.id, JSON.stringify(call.input ?? {}).length);
    const trimmed = trimToTarget(
      decisions,
      calls,
      answers,
      reuseOrder,
      now,
      resolved.targetChars,
      resolved.truncateHeadChars,
      inputChars,
    );
    if (trimmed.trimmedResults + trimmed.trimmedCalls > 0) {
      fillArchive();
      kept = applyDecisions(workMessages, decisions, calls, resolved.truncateHeadChars, pointers);
    }
  }
  if (resolved.activityIndex) {
    const note = activityNote(decisions, calls, pointers);
    if (note) kept = [kept[0]!, { role: 'user', text: note, toolUses: [] }, ...kept.slice(1)];
  }
  return {
    messages: kept,
    archives,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: requestCount,
      ms: Date.now() - started,
    },
  };
}
