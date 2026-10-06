import type {
  HarnessToolEvent,
  HarnessTurnDriver,
} from "@foundry/agents/harness";
import type { SessionInput } from "@foundry/agents/session";

export type DriverRun = Parameters<HarnessTurnDriver["run"]>[0];

/** One tool call's outcome, before the run's identity is stamped on it. */
export interface ToolReport {
  activityId?: string;
  input: unknown;
  outcome: HarnessToolEvent["outcome"];
  reason?: string;
  toolCallId: string;
  toolName: string;
}

export type ReportTool = (report: ToolReport) => Promise<void>;

/**
 * Reports each tool call's outcome to the run at most once. A native CLI can
 * surface one outcome through several channels (a hook, a permission callback,
 * a denial list), so a repeat is dropped. `reset` starts a fresh turn.
 */
export function toolReporter(
  agentId: string,
  harness: string,
  currentRun: () => DriverRun
): { report: ReportTool; reset: () => void } {
  const seen = new Set<string>();
  return {
    async report(event) {
      const key = `${event.toolCallId}:${event.outcome}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      const run = currentRun();
      await run.onToolEvent({
        ...(event.activityId ? { activityId: event.activityId } : {}),
        agentId,
        harness,
        inputSummary: inputSummary(event.input),
        outcome: event.outcome,
        sessionId: run.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...(event.reason ? { reason: event.reason } : {}),
      });
    },
    reset() {
      seen.clear();
    },
  };
}

export function inputText(input: SessionInput): string {
  if (typeof input === "string") {
    return input;
  }
  return input.parts
    .map((part) => {
      if (part.type !== "text") {
        throw new Error(
          "CLI harness input currently supports text parts only."
        );
      }
      return part.text;
    })
    .join("\n");
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** Summaries describe the shape, never command strings, file contents, or credentials. */
function inputSummary(input: unknown): string {
  return `Input fields: ${Object.keys(record(input)).sort().join(", ") || "none"}`;
}

export function eventStream<T>(): {
  stream: AsyncIterable<T>;
  push: (value: T) => void;
  close: () => void;
} {
  const items: T[] = [];
  const state: { closed: boolean } = { closed: false };
  let wake: (() => void) | undefined;
  return {
    close() {
      state.closed = true;
      wake?.();
    },
    push(value) {
      if (!state.closed) {
        items.push(value);
        wake?.();
      }
    },
    stream: {
      async *[Symbol.asyncIterator]() {
        while (!state.closed || items.length > 0) {
          if (items.length > 0) {
            yield items.shift() as T;
          } else {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }
      },
    },
  };
}
