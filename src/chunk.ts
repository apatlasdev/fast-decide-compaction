import type {
  CallAnswer,
  CompactionState,
  FittedState,
  JevAsker,
  Message,
  ResolvedCompactOptions,
  ToolCall,
} from './types.js';

/**
 * Chunked Mercury Decide decisions for histories that no longer fit a
 * single state (the `history too large for Jev` fallback). The history
 * is split into contiguous windows of about `WINDOW_STATE_TOKENS`
 * estimated tokens; each window's state (a few messages of overlap
 * included as context) is fitted and its calls decided in their own
 * requests, then every window's answers are merged into one decision
 * per call. Ownership never overlaps: a call is decided by exactly one
 * window, so the merged result is identical to a single-state run —
 * only the state each request carries is smaller.
 */

/** Target state size per window. Leaves headroom for the question envelope (state + questions must stay under `maxRequestTokens`). */
export const WINDOW_STATE_TOKENS = 18_000;

/** Messages shared with the previous window, so a window's first entries keep the context they refer to. Context only: ownership never overlaps. */
export const WINDOW_OVERLAP_MESSAGES = 3;

/** One contiguous ownership range over the message list. */
export interface WindowRange {
  start: number;
  end: number;
}

/**
 * Domain functions `compact` injects, so this module stays pure
 * orchestration and the same file serves the Claude and Codex trees.
 */
export interface ChunkDeps {
  fitState: (
    messages: readonly Message[],
    calls: readonly ToolCall[],
    options: Pick<
      ResolvedCompactOptions,
      'maxStateTokens' | 'preserveRecentMessages' | 'goal'
    >,
  ) => FittedState;
  batchCalls: (
    calls: readonly ToolCall[],
    stateTokens: number,
    options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
  ) => ToolCall[][];
  askBatch: (
    asker: JevAsker,
    state: CompactionState,
    batch: readonly ToolCall[],
  ) => Promise<Map<string, CallAnswer>>;
  mapLimit: <T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ) => Promise<R[]>;
  maxConcurrent: number;
  estimateTokens: (text: string) => number;
}

/**
 * Per-message token cost, mirroring `fitState`'s `full` stage: the
 * serialised entry, each tool input capped at 1000 characters, a note
 * per tool result and one token per entry. Calibrated to run slightly
 * high, so windows land a little under the budget.
 */
export function perMessageTokens(
  messages: readonly Message[],
  estimateTokens: (text: string) => number,
): number[] {
  return messages.map((message) => {
    let tokens = estimateTokens(
      JSON.stringify({ role: message.role, text: message.text }),
    );
    for (const tool of message.toolUses) {
      let input = '';
      try {
        input = JSON.stringify(tool.input);
      } catch {
        input = '[unserializable input]';
      }
      tokens += estimateTokens(input.slice(0, 1000));
    }
    tokens += 40 * (message.toolResults?.length ?? 0);
    return tokens + 1;
  });
}

/**
 * Contiguous, non-overlapping ownership ranges of about `budget` tokens
 * each. Every message belongs to exactly one window; a window always
 * keeps at least one message, so a single huge message becomes its own
 * window. `overlap` is accepted for signature symmetry: it is applied
 * to state slices by the caller, never to ownership.
 */
export function splitIntoWindows(
  tokens: readonly number[],
  budget: number,
  overlap: number,
): WindowRange[] {
  const windows: WindowRange[] = [];
  let start = 0;
  let sum = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (i > start && sum + tokens[i] > budget) {
      windows.push({ start, end: i });
      start = i;
      sum = 0;
    }
    sum += tokens[i];
  }
  if (start < tokens.length) windows.push({ start, end: tokens.length });
  return windows;
}

/**
 * Assigns every call to the window that owns its `callIndex`. Each call
 * lands in exactly one window; overlap messages are state context only
 * and never re-own their calls.
 */
export function assignCallsToWindows(
  calls: readonly ToolCall[],
  windows: readonly WindowRange[],
): ToolCall[][] {
  const owned: ToolCall[][] = windows.map(() => []);
  for (const call of calls) {
    let lo = 0;
    let hi = windows.length - 1;
    let found = false;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (call.callIndex < windows[mid].start) {
        hi = mid - 1;
      } else if (call.callIndex >= windows[mid].end) {
        lo = mid + 1;
      } else {
        owned[mid].push(call);
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error(
        `call ${call.id} at message ${call.callIndex} is owned by no window`,
      );
    }
  }
  return owned;
}

/** Token costs, ownership windows and the calls each window owns. */
export function planWindows(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  options: {
    budget: number;
    overlap: number;
    estimateTokens: (text: string) => number;
  },
): { windows: WindowRange[]; owned: ToolCall[][]; tokens: number[] } {
  const tokens = perMessageTokens(messages, options.estimateTokens);
  const windows = splitIntoWindows(tokens, options.budget, options.overlap);
  const owned = assignCallsToWindows(calls, windows);
  return { windows, owned, tokens };
}

/**
 * Decides every call in windows, for histories whose single state does
 * not fit. Each window's state slice keeps `WINDOW_OVERLAP_MESSAGES`
 * messages of leading context (the last window additionally keeps the
 * globally recent messages pinned); the calls owned by the window are
 * batched under the usual caps and answered with the injected
 * `askBatch`. A failed request rejects, so the caller falls back to the
 * built-in summary — the same contract as the single-state path.
 *
 * @param deps fitState, batchCalls, askBatch, mapLimit, maxConcurrent
 *   and estimateTokens, injected by the caller.
 * @returns the merged answers, the largest window state size, a
 *   diagnostic stage string, the request count and the window count.
 */
export async function compactChunked(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  resolved: ResolvedCompactOptions,
  asker: JevAsker,
  deps: ChunkDeps,
): Promise<{
  answers: Map<string, CallAnswer>;
  stateTokens: number;
  stateStage: string;
  requests: number;
  windows: number;
}> {
  const { fitState, batchCalls, askBatch, mapLimit, maxConcurrent, estimateTokens } = deps;
  const { windows, owned } = planWindows(messages, calls, {
    budget: WINDOW_STATE_TOKENS,
    overlap: WINDOW_OVERLAP_MESSAGES,
    estimateTokens,
  });

  const answers = new Map<string, CallAnswer>();
  const tasks: { state: CompactionState; batch: ToolCall[] }[] = [];
  let stateTokens = 0;
  const lastWindow = windows.length - 1;

  for (let w = 0; w < windows.length; w++) {
    const { start, end } = windows[w];
    const sliceStart = Math.max(0, start - WINDOW_OVERLAP_MESSAGES);
    // A call's result message stays in its window's slice even when it lies
    // just past the ownership boundary.
    let sliceEnd = end;
    for (const call of owned[w]) {
      if (call.resultIndex + 1 > sliceEnd) sliceEnd = call.resultIndex + 1;
    }
    sliceEnd = Math.min(sliceEnd, messages.length);
    const slice = messages.slice(sliceStart, sliceEnd);
    // fitState indexes calls by position in the message list it is given, so
    // the slice's calls are re-based to the slice (answers are keyed by id).
    const sliceCalls = calls
      .filter((call) => call.callIndex >= sliceStart && call.callIndex < sliceEnd)
      .map((call) => ({
        ...call,
        callIndex: call.callIndex - sliceStart,
        resultIndex: call.resultIndex - sliceStart,
      }));
    const fitted = fitState(slice, sliceCalls, {
      maxStateTokens: resolved.maxStateTokens,
      preserveRecentMessages:
        w === lastWindow ? resolved.preserveRecentMessages : 0,
      goal: resolved.goal,
    });
    stateTokens = Math.max(stateTokens, fitted.tokens);
    const ownedNonPinned = owned[w].filter((call) => !call.pinned);
    if (ownedNonPinned.length === 0) continue;
    for (const batch of batchCalls(ownedNonPinned, fitted.tokens, resolved)) {
      tasks.push({ state: fitted.state, batch });
    }
  }

  const answered = await mapLimit(tasks, maxConcurrent, (task) =>
    askBatch(asker, task.state, task.batch),
  );
  for (const map of answered) {
    for (const [id, answer] of map) answers.set(id, answer);
  }

  return {
    answers,
    stateTokens,
    stateStage: `chunked (${windows.length} windows, max ${stateTokens} tokens)`,
    requests: tasks.length,
    windows: windows.length,
  };
}
