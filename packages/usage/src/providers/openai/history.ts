import { join } from "node:path";

import { historyFiles, jsonLines, mapLimit } from "../local";
import { count, record, text } from "../values";
import { quantities, type Work } from "../work";

/** Lines that carry usage, or the session, model and tier usage is attributed to. */
const MARKERS = [
  '"token_count"',
  '"turn_context"',
  '"thread_settings_applied"',
  '"session_meta"',
];
/** A fork copies its parent's history in a burst (gaps of 0-40 ms); real work follows a model turn. */
const FORK_COPY_MAX_GAP_MS = 1000;
const FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
] as const;

type TokenUsage = Readonly<Record<(typeof FIELDS)[number], number>>;

interface Rollout {
  forkAnchor?: number;
  lastSignature?: string;
  model: string;
  previous?: TokenUsage;
  sawMeta: boolean;
  session: string;
  standardSpeed: boolean;
}

const usageOf = (value: unknown): TokenUsage | undefined => {
  const raw = record(value);
  if (
    typeof raw.input_tokens !== "number" ||
    typeof raw.output_tokens !== "number"
  ) {
    return;
  }
  return Object.fromEntries(
    FIELDS.map((field) => [field, count(raw[field])])
  ) as TokenUsage;
};

const same = (a: TokenUsage, b: TokenUsage) =>
  FIELDS.every((field) => a[field] === b[field]);

const isFork = (meta: Record<string, unknown>): boolean =>
  typeof meta.forked_from_id === "string" ||
  typeof record(record(record(meta.source).subagent).thread_spawn)
    .parent_thread_id === "string";

/**
 * One `token_count` as work, or nothing. Each carries the request's own
 * usage (`last_token_usage`) and the session's running total; a total equal
 * to the last one is a re-emission, a zero request marks context size, and
 * the copies a fork makes of its parent only set the baseline.
 */
const countedWork = (
  state: Rollout,
  at: number,
  info: Record<string, unknown>
): Work | undefined => {
  const last = usageOf(info.last_token_usage);
  const total = usageOf(info.total_token_usage);
  if (state.forkAnchor !== undefined) {
    if (at - state.forkAnchor < FORK_COPY_MAX_GAP_MS) {
      state.forkAnchor = at;
      state.previous = total ?? state.previous;
      return;
    }
    state.forkAnchor = undefined;
  }
  const { previous } = state;
  state.previous = total ?? previous;
  if (!last || last.input_tokens + last.output_tokens === 0) {
    return;
  }
  if (total && previous && same(total, previous)) {
    return;
  }
  const signature = JSON.stringify(last);
  if (!total && signature === state.lastSignature) {
    return;
  }
  state.lastSignature = signature;
  const cached = last.cached_input_tokens;
  const written = last.cache_write_input_tokens;
  return {
    at,
    model: state.model,
    quantities: quantities({
      cachedInputTokens: cached,
      cacheWriteTokens: written,
      // Codex counts cached input inside `input_tokens`; reasoning is inside output.
      inputTokens: Math.max(0, last.input_tokens - cached - written),
      outputTokens: last.output_tokens,
      reasoningTokens: last.reasoning_output_tokens,
    }),
    session: state.session,
    standardSpeed: state.standardSpeed,
  };
};

const step = (state: Rollout, value: unknown): Work | undefined => {
  const line = record(value);
  const payload = record(line.payload);
  const at = Date.parse(String(line.timestamp));
  if (line.type === "session_meta") {
    // Only the first meta is this session's; a fork copies its parent's after it.
    if (!state.sawMeta) {
      state.sawMeta = true;
      state.session = text(payload.id) ?? state.session;
      state.forkAnchor = isFork(payload) && !Number.isNaN(at) ? at : undefined;
    }
    return;
  }
  if (line.type === "turn_context") {
    state.model = text(payload.model) ?? state.model;
    return;
  }
  if (payload.type === "thread_settings_applied") {
    const tier = record(payload.thread_settings).service_tier;
    state.standardSpeed = !(
      tier === "priority" ||
      tier === "fast" ||
      tier === "ultrafast"
    );
    return;
  }
  if (payload.type === "token_count" && state.model && !Number.isNaN(at)) {
    return countedWork(state, at, record(payload.info));
  }
};

const readRollout = async (file: string): Promise<Work[]> => {
  const state: Rollout = {
    model: "",
    sawMeta: false,
    session: file,
    standardSpeed: true,
  };
  const works: Work[] = [];
  // Every line updates the running state; the caller keeps what is in the span.
  for await (const value of jsonLines(file, MARKERS)) {
    const work = step(state, value);
    if (work) {
      works.push(work);
    }
  }
  return works;
};

/**
 * Codex's work since `since`, from the rollouts under `<home>/sessions/` and
 * `<home>/archived_sessions/`. A rollout moved between them can leave a copy
 * in both, so for a session found in more than one file, equal work is
 * counted once per occurrence within a file.
 */
export const readCodexHistory = async (
  home: string,
  since: Date
): Promise<Work[]> => {
  const files = await historyFiles(
    [join(home, "sessions"), join(home, "archived_sessions")],
    since
  );
  const perFile = await mapLimit(files, readRollout);
  const filesBySession = new Map<string, number>();
  for (const works of perFile) {
    for (const session of new Set(works.map((work) => work.session))) {
      filesBySession.set(session, (filesBySession.get(session) ?? 0) + 1);
    }
  }
  const counted = new Set<string>();
  const result: Work[] = [];
  for (const works of perFile) {
    const occurrences = new Map<string, number>();
    for (const work of works) {
      if ((filesBySession.get(work.session) ?? 0) > 1) {
        const key = JSON.stringify([
          work.session,
          work.at,
          work.model,
          work.quantities,
        ]);
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        if (counted.has(`${key}#${occurrence}`)) {
          continue;
        }
        counted.add(`${key}#${occurrence}`);
      }
      if (work.at >= since.getTime()) {
        result.push(work);
      }
    }
  }
  return result;
};
