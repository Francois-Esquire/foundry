import type {
  LanguageModelV4,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import type { ObserveTurn, TurnObservation } from "@foundry/agents";
import {
  type HarnessToolEvent,
  isPolicyDeniedOutput,
} from "@foundry/agents/harness";
import type {
  SessionEvent,
  SessionMessage,
  SessionUsage,
} from "@foundry/agents/session";
import type { TelemetryOptions } from "ai";
import { wrapLanguageModel } from "ai";

import type {
  ExecutionObservation,
  ExecutionUsage,
  ObservationStatus,
  ToolCallObservation,
} from "~/lib/executions";

export type RecordObservation = (observation: ExecutionObservation) => void;

const SAFE_CODE = /[^A-Za-z0-9_.:-]/g;
const MAX_CODE_LENGTH = 64;

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

class TurnUsage {
  #calls = 0;
  readonly #sums = new Map<UsageField, { count: number; total: number }>();

  async response<T>(invoke: () => PromiseLike<T>): Promise<T> {
    try {
      return await invoke();
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "statusCode" in error &&
          error.statusCode === 429
        )
      ) {
        this.begin();
      }
      throw error;
    }
  }

  begin(): (usage: LanguageModelV4Usage | undefined) => void {
    this.#calls += 1;
    let reported = false;
    return (usage) => {
      if (!reported) {
        reported = true;
        this.#add(usage);
      }
    };
  }

  #add(usage: LanguageModelV4Usage | undefined): void {
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

function usageTap(usage: TurnUsage): LanguageModelV4Middleware {
  return {
    specificationVersion: "v4",
    async wrapGenerate({ doGenerate }) {
      const result = await usage.response(doGenerate);
      usage.begin()(result.usage);
      return result;
    },
    async wrapStream({ doStream }) {
      const result = await usage.response(doStream);
      const report = usage.begin();
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<
            LanguageModelV4StreamPart,
            LanguageModelV4StreamPart
          >({
            transform(part, controller) {
              if (part.type === "finish") {
                report(part.usage);
              }
              controller.enqueue(part);
            },
          })
        ),
      };
    },
  };
}

export function runTurnObserver(record: RecordObservation): ObserveTurn {
  return ({ model, sessionId }) => {
    const id = crypto.randomUUID();
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
      emit(error, outcome) {
        if (ended) {
          return;
        }
        ended = true;
        let status: ObservationStatus = "complete";
        if (outcome === "cancelled") {
          status = "cancelled";
        } else if (error !== undefined) {
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

function reportedUsage(usage: SessionUsage): ExecutionUsage {
  const fields: Record<UsageField, number | undefined> = {
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
  };
  return {
    ...Object.fromEntries(
      Object.entries(fields).filter(
        ([, value]) => typeof value === "number" && Number.isFinite(value)
      )
    ),
    source: "provider",
  };
}

export function observeCliTurn(
  record: RecordObservation,
  turn: {
    readonly model: string;
    readonly provider?: string;
    readonly sessionId: string;
    readonly signal?: AbortSignal;
  },
  stream: {
    readonly message: Promise<SessionMessage>;
    readonly usage: Promise<SessionUsage>;
  }
): void {
  const base = {
    id: crypto.randomUUID(),
    kind: "model-turn" as const,
    model: turn.model,
    ...(turn.provider === undefined ? {} : { provider: turn.provider }),
    sessionId: turn.sessionId,
    startedAt: new Date().toISOString(),
  };
  record({ ...base, status: "running" });
  const end = (
    status: ObservationStatus,
    code?: string,
    usage?: ExecutionUsage
  ) =>
    record({
      ...base,
      endedAt: new Date().toISOString(),
      ...(code === undefined ? {} : { errorCode: code }),
      status,
      ...(usage === undefined ? {} : { usage }),
    });
  const settle = async () => {
    let message: SessionMessage;
    try {
      message = await stream.message;
    } catch (error) {
      const cancelled = turn.signal?.aborted || isAbort(error);
      end(cancelled ? "cancelled" : "failed", errorCode(error));
      return;
    }
    let usage: ExecutionUsage | undefined;
    try {
      usage = reportedUsage(await stream.usage);
    } catch {
      usage = undefined;
    }
    if (turn.signal?.aborted) {
      end("cancelled", "AbortError", usage);
    } else if (message.status === "error") {
      end("failed", "turn_error", usage);
    } else {
      end("complete", undefined, usage);
    }
  };
  settle().catch(() => undefined);
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
      emit: (error, outcome) => {
        for (const observation of opened) {
          observation.emit(error, outcome);
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

const CLI_TOOL_STATUS = {
  failed: "failed",
  ran: "complete",
  refused: "denied",
  started: "running",
} as const satisfies Record<string, ObservationStatus>;

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
        if (isPolicyDeniedOutput(event.output)) {
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
