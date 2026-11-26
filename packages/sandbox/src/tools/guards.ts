import type { SandboxToolName } from "./definitions";

export const DEFAULT_LIMITS = {
  maxCallsPerMinute: 120,
  maxOutputChars: 50_000,
} as const;

export interface SandboxToolLimits {
  readonly maxCallsPerMinute?: number;
  readonly maxOutputChars?: number;
}

export type SandboxToolOutcome = "allowed" | "refused" | "failed";

export interface SandboxToolEvent {
  readonly at: number;
  readonly input: unknown;
  readonly outcome: SandboxToolOutcome;
  readonly path?: string;
  readonly reason?: string;
  readonly tool: SandboxToolName;
  readonly truncated?: boolean;
}

export interface SandboxToolAudit {
  record(event: SandboxToolEvent): void;
}

export interface SandboxToolGuards {
  readonly audit?: SandboxToolAudit;
  readonly limits?: SandboxToolLimits;
  readonly now?: () => number;
}

export class SandboxRateLimitError extends Error {
  readonly reason = "rate";
  constructor(perMinute: number) {
    super(
      `Rate limit reached — more than ${perMinute} tool calls this minute.`
    );
    this.name = "SandboxRateLimitError";
  }
}

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

function clip(
  output: unknown,
  max: number
): { output: unknown; truncated: boolean } {
  if (typeof output !== "string" || output.length <= max) {
    return { output, truncated: false };
  }
  return { output: output.slice(0, max), truncated: true };
}

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
  try {
    state.audit?.record({
      at: state.now(),
      input: event.input,
      outcome: event.outcome,
      tool: event.name,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      ...(event.path === undefined ? {} : { path: event.path }),
      ...(event.truncated === true ? { truncated: true } : {}),
    });
  } catch {
    // biome-ignore lint/complexity/noUselessReturn: End the best-effort operation on failure.
    return;
  }
}
