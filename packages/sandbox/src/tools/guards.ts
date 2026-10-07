/**
 * What wraps every tool the toolkit builds: coarse ceilings that turn a
 * runaway or hostile loop into a refusal instead of an unbounded disclosure,
 * and a record of what was attempted.
 *
 * This is the layer that can see a *tool call* — how many there have been,
 * how much text one is about to hand back. Byte accounting is deliberately
 * not here: a single `grep` reads a whole tree, and only the filesystem facet
 * can see those bytes, so per-file and per-environment byte ceilings live on
 * the provider.
 */

import { DEFAULT_LIMITS } from "./constants";
import type { SandboxToolName } from "./definitions";

export interface SandboxToolLimits {
  /** Tool calls allowed per rolling minute. Default 120. */
  readonly maxCallsPerMinute?: number;
  /** Clip applied to every tool result. Default 50_000 characters. */
  readonly maxOutputChars?: number;
}

export type SandboxToolOutcome = "allowed" | "refused" | "failed";

export interface SandboxToolEvent {
  readonly at: number;
  /** Raw tool input as received. */
  readonly input: unknown;
  readonly outcome: SandboxToolOutcome;
  /**
   * The path the call resolved to, when it named one. Absent on a refusal, so
   * a denial never records where it would have landed.
   */
  readonly path?: string;
  /**
   * Why an environment refused, when it said — `"escape"`, `"secret"`,
   * `"budget"`, or `"rate"` for this layer's own rate limit. Absent on an
   * allowed call and on an ordinary failure.
   */
  readonly reason?: string;
  readonly tool: SandboxToolName;
  /** True when the result was clipped to `maxOutputChars`. */
  readonly truncated?: boolean;
}

/** Fire-and-forget: recording must never block or fail a tool call. */
export interface SandboxToolAudit {
  record(event: SandboxToolEvent): void;
}

export interface SandboxToolGuards {
  readonly audit?: SandboxToolAudit;
  readonly limits?: SandboxToolLimits;
  /** Test seam for the rate window clock. */
  readonly now?: () => number;
}

/** Raised when the rate limit refuses a call, so it reads like any other
 *  environment refusal rather than a crash. */
export class SandboxRateLimitError extends Error {
  readonly reason = "rate";
  constructor(perMinute: number) {
    super(
      `Rate limit reached — more than ${perMinute} tool calls this minute.`
    );
    this.name = "SandboxRateLimitError";
  }
}

/**
 * The refusal reason an environment stamped on an error, if any — which is
 * what separates "the environment said no" from "the tool broke".
 *
 * Read structurally rather than by importing the error class: a specific
 * reason first (`"escape"`, `"secret"`, `"budget"`), then the portable
 * contract code, since a refusal can come from path normalization before any
 * provider gets a say and names no reason of its own.
 */
function reasonOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const own = (error as { reason?: unknown }).reason;
  if (typeof own === "string") {
    return own;
  }
  const detail = (error as { details?: { reason?: unknown } }).details?.reason;
  if (typeof detail === "string") {
    return detail;
  }
  const { code } = error as { code?: unknown };
  return code === "invalid-contract" ? "invalid-contract" : undefined;
}

/** Clip a string result; anything else passes through untouched. */
function clip(
  output: unknown,
  max: number
): { output: unknown; truncated: boolean } {
  if (typeof output !== "string" || output.length <= max) {
    return { output, truncated: false };
  }
  return { output: output.slice(0, max), truncated: true };
}

/**
 * Wrap one tool's `execute` with the rate limit, the output clip, and one
 * audit event per call on every exit path. `pathOf` reports which path the
 * call resolved to, for the record only.
 */
export function guardExecute<Input, Options>(
  name: SandboxToolName,
  execute: (input: Input, options: Options) => Promise<unknown>,
  state: GuardState,
  pathOf: (input: unknown) => string | undefined
): (input: Input, options: Options) => Promise<unknown> {
  return async (input, options) => {
    if (!takeCall(state)) {
      const error = new SandboxRateLimitError(state.maxCallsPerMinute);
      record(state, { input, name, outcome: "refused", reason: "rate" });
      throw error;
    }
    try {
      const raw = await execute(input, options);
      const { output, truncated } = clip(raw, state.maxOutputChars);
      record(state, {
        input,
        name,
        outcome: "allowed",
        path: pathOf(input),
        truncated,
      });
      return output;
    } catch (error: unknown) {
      const reason = reasonOf(error);
      record(state, {
        input,
        name,
        outcome: reason === undefined ? "failed" : "refused",
        reason,
      });
      throw error;
    }
  };
}

export interface GuardState {
  readonly audit: SandboxToolAudit | undefined;
  calls: number[];
  readonly maxCallsPerMinute: number;
  readonly maxOutputChars: number;
  readonly now: () => number;
}

export function guardState(guards: SandboxToolGuards = {}): GuardState {
  return {
    audit: guards.audit,
    calls: [],
    maxCallsPerMinute:
      guards.limits?.maxCallsPerMinute ?? DEFAULT_LIMITS.maxCallsPerMinute,
    maxOutputChars:
      guards.limits?.maxOutputChars ?? DEFAULT_LIMITS.maxOutputChars,
    now: guards.now ?? Date.now,
  };
}

/** Charge one call against the rolling-minute window. */
function takeCall(state: GuardState): boolean {
  const cutoff = state.now() - 60_000;
  state.calls = state.calls.filter((at) => at > cutoff);
  if (state.calls.length >= state.maxCallsPerMinute) {
    return false;
  }
  state.calls.push(state.now());
  return true;
}

function record(
  state: GuardState,
  event: {
    name: SandboxToolName;
    input: unknown;
    outcome: SandboxToolOutcome;
    reason?: string;
    path?: string;
    truncated?: boolean;
  }
): void {
  state.audit?.record({
    at: state.now(),
    input: event.input,
    outcome: event.outcome,
    tool: event.name,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    ...(event.path === undefined ? {} : { path: event.path }),
    ...(event.truncated === true ? { truncated: true } : {}),
  });
}
