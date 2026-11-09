import { randomUUID } from "node:crypto";
import type {
  LanguageModelV4,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type {
  ObserveTurn,
  TurnObservation,
} from "@foundry/agents/agents/model";
import type { HarnessToolEvent } from "@foundry/agents/harness";
import type { SessionEvent } from "@foundry/agents/session";
import type { TelemetryOptions } from "ai";
import { wrapLanguageModel } from "ai";

import type {
  ExecutionObservation,
  ExecutionUsage,
  ObservationStatus,
  ToolCallObservation,
} from "~/lib/executions";

/**
 * What an agent session does, as observations on the run that owns it: one
 * per model turn, from the Agents `observe` hook, and one per tool call,
 * from the session's event stream. They carry identity, kind, timing,
 * status, a safe error code and the usage a provider reported; never
 * prompts, tool arguments, tool results or file bodies.
 */

export type RecordObservation = (observation: ExecutionObservation) => void;

const SAFE_CODE = /[^A-Za-z0-9_.:-]/g;
const MAX_CODE_LENGTH = 64;

/** A failure's class, never its message: an `AbortError`, an `APICallError` with its status. */
export function errorCode(error: unknown): string {
  if (!(error instanceof Error)) {
    return "error";
  }
  const status =
    "statusCode" in error && typeof error.statusCode === "number"
      ? `:${String(error.statusCode)}`
      : "";
  return (
    `${error.name}${status}`.replace(SAFE_CODE, "").slice(0, MAX_CODE_LENGTH) ||
    "error"
  );
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

type UsageField = Exclude<keyof ExecutionUsage, "source">;

/** Sum what every call reported; a count any call left out stays unknown. */
class TurnUsage {
  #calls = 0;
  readonly #sums = new Map<UsageField, { count: number; total: number }>();

  add(usage: LanguageModelV4Usage | undefined): void {
    this.#calls += 1;
    const reported: Record<UsageField, number | undefined> = {
      cachedInputTokens: usage?.inputTokens.cacheRead,
      cacheWriteTokens: usage?.inputTokens.cacheWrite,
      inputTokens: usage?.inputTokens.total,
      outputTokens: usage?.outputTokens.total,
      reasoningTokens: usage?.outputTokens.reasoning,
      totalTokens:
        usage?.inputTokens.total === undefined ||
        usage.outputTokens.total === undefined
          ? undefined
          : usage.inputTokens.total + usage.outputTokens.total,
    };
    for (const [field, value] of Object.entries(reported) as [
      UsageField,
      number | undefined,
    ][]) {
      if (value !== undefined) {
        const sum = this.#sums.get(field) ?? { count: 0, total: 0 };
        this.#sums.set(field, {
          count: sum.count + 1,
          total: sum.total + value,
        });
      }
    }
  }

  known(): ExecutionUsage | undefined {
    const fields = [...this.#sums].filter(
      ([, sum]) => sum.count === this.#calls
    );
    if (this.#calls === 0 || fields.length === 0) {
      return undefined;
    }
    return {
      ...Object.fromEntries(fields.map(([field, sum]) => [field, sum.total])),
      source: "provider",
    };
  }
}

/** Every model call's reported usage, read off the provider's own response. */
function usageTap(usage: TurnUsage): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      usage.add(result.usage);
      return result;
    },
    async wrapStream({ doStream }) {
      const result = await doStream();
      let finished = false;
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<
            LanguageModelV4StreamPart,
            LanguageModelV4StreamPart
          >({
            flush() {
              if (!finished) {
                usage.add(undefined);
              }
            },
            transform(part, controller) {
              if (part.type === "finish") {
                finished = true;
                usage.add(part.usage);
              }
              controller.enqueue(part);
            },
          })
        ),
      };
    },
  };
}

/** One model-turn observation per agent `stream` or `generate` call. */
export function runTurnObserver(record: RecordObservation): ObserveTurn {
  return ({ model, sessionId }) => {
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const usage = new TurnUsage();
    const base = {
      id,
      kind: "model-turn" as const,
      model: model.id,
      ...(model.provider === undefined ? {} : { provider: model.provider }),
      sessionId,
      startedAt,
    };
    record({ ...base, status: "running" });
    let ended = false;
    return {
      emit(error) {
        if (ended) {
          return;
        }
        ended = true;
        let status: ObservationStatus = "complete";
        if (error !== undefined) {
          status = isAbort(error) ? "cancelled" : "failed";
        }
        const known = usage.known();
        record({
          ...base,
          endedAt: new Date().toISOString(),
          ...(error === undefined ? {} : { errorCode: errorCode(error) }),
          status,
          ...(known === undefined ? {} : { usage: known }),
        });
      },
      telemetry: { isEnabled: true },
      wrap: (inner: LanguageModelV4) =>
        wrapLanguageModel({ middleware: usageTap(usage), model: inner }),
    };
  };
}

function integrationsOf(
  telemetry: TelemetryOptions
): NonNullable<TelemetryOptions["integrations"]>[] {
  const { integrations } = telemetry;
  if (integrations === undefined) {
    return [];
  }
  return Array.isArray(integrations) ? integrations : [integrations];
}

/** Several observers as one: each wraps the model, adds its telemetry, and settles. */
export function composeObservers(
  ...observers: readonly ObserveTurn[]
): ObserveTurn {
  return (turn) => {
    const opened = observers
      .map((observe) => observe(turn))
      .filter(
        (observation): observation is TurnObservation => observation !== null
      );
    if (opened.length === 0) {
      return null;
    }
    const telemetry: TelemetryOptions = {
      ...Object.assign(
        {},
        ...opened.map((observation) => observation.telemetry)
      ),
      integrations: opened.flatMap((observation) =>
        integrationsOf(observation.telemetry)
      ),
      isEnabled: true,
    };
    return {
      emit: (error) => {
        for (const observation of opened) {
          observation.emit(error);
        }
      },
      telemetry,
      wrap: (model) =>
        opened.reduceRight(
          (inner, observation) => observation.wrap(inner),
          model
        ),
    };
  };
}

/** A refusal the Agents tool compiler returns in place of a result. */
function isDenial(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    "approved" in output &&
    output.approved === false
  );
}

const CLI_TOOL_STATUS = {
  failed: "failed",
  ran: "complete",
  refused: "denied",
  started: "running",
} as const satisfies Record<string, ObservationStatus>;

/**
 * Tool-call observations from a session's events: a built-in tool's call and
 * result, or a CLI harness's own tool events. `end` closes calls a turn left
 * open.
 */
export function toolObserver(
  record: RecordObservation,
  sessionId: string
): {
  readonly end: () => void;
  readonly event: (event: SessionEvent) => void;
} {
  const open = new Map<string, ToolCallObservation>();
  const put = (observation: ToolCallObservation) => {
    if (observation.status === "running") {
      open.set(observation.id, observation);
    } else {
      open.delete(observation.id);
    }
    record(observation);
  };
  const finish = (id: string, status: ObservationStatus, code?: string) => {
    const started = open.get(id);
    if (started) {
      put({
        ...started,
        endedAt: new Date().toISOString(),
        ...(code === undefined ? {} : { errorCode: code }),
        status,
      });
    }
  };
  const call = (id: string, name: string) =>
    put({
      id,
      kind: "tool-call",
      name,
      sessionId,
      startedAt: new Date().toISOString(),
      status: "running",
    });
  /** A CLI harness reports each call's start and outcome itself. */
  const cliTool = ({ outcome, toolCallId, toolName }: HarnessToolEvent) => {
    const id = `${sessionId}:${toolCallId}`;
    if (outcome === "started" || !open.has(id)) {
      call(id, toolName);
    }
    if (outcome !== "started") {
      finish(
        id,
        CLI_TOOL_STATUS[outcome],
        outcome === "ran" ? undefined : outcome
      );
    }
  };
  return {
    end() {
      for (const id of [...open.keys()]) {
        finish(id, "cancelled");
      }
    },
    event(event) {
      if (event.type === "tool-call") {
        call(`${sessionId}:${event.toolCallId}`, event.name);
      } else if (event.type === "tool-result" && !event.preliminary) {
        const id = `${sessionId}:${event.toolCallId}`;
        if (isDenial(event.output)) {
          finish(id, "denied", "denied");
        } else if (event.isError) {
          finish(id, "failed", "tool_error");
        } else {
          finish(id, "complete");
        }
      } else if (event.type === "harness-tool") {
        cliTool(event.event);
      }
    },
  };
}
