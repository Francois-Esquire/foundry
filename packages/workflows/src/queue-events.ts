import type { DispatchedWorkflow } from "./dispatched-workflow";
import { errorToShape } from "./helpers";
import type { QueueEvent, QueueEventPayload } from "./queue-types";
import type { Telemetry } from "./telemetry";
import type { RunStatus, Unsubscribe } from "./types";

export class QueueEvents {
  readonly #telemetry: Telemetry;
  readonly #id: string;
  readonly #listeners = new Map<
    QueueEvent,
    Set<(payload: QueueEventPayload) => void>
  >();

  constructor(args: { telemetry: Telemetry; id: string }) {
    this.#telemetry = args.telemetry;
    this.#id = args.id;
  }

  on(
    event: QueueEvent,
    handler: (payload: QueueEventPayload) => void
  ): Unsubscribe {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    const subscribed = set;
    subscribed.add(handler);
    return () => subscribed.delete(handler);
  }

  run(
    event: QueueEvent,
    run: DispatchedWorkflow,
    statusOverride?: RunStatus
  ): void {
    const status = statusOverride ?? run.status;
    this.#telemetry.incrementMetric(`queue.runs.${event}`);
    this.log("info", `Run ${event}`, {
      runId: run.id,
      status,
      step: run.step,
    });
    this.#payload(event, {
      at: new Date().toISOString(),
      runId: run.id,
      status,
      step: run.step,
    });
  }

  queueLevel(
    event: QueueEvent,
    extras?: { error?: Error; runId?: string; step?: string }
  ): void {
    this.#telemetry.incrementMetric(`queue.${event}`);
    this.log("warn", `Queue ${event}`, {
      queueId: this.#id,
      ...(extras?.error ? { error: errorToShape(extras.error) } : {}),
    });
    this.#payload(event, {
      at: new Date().toISOString(),
      runId: extras?.runId ?? this.#id,
      status: "failed",
      step: extras?.step ?? "",
      ...(extras?.error ? { error: errorToShape(extras.error) } : {}),
    });
  }

  log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    metadata?: Record<string, unknown>
  ): void {
    this.#telemetry.appendLog(
      metadata ? { level, message, metadata } : { level, message }
    );
  }

  #payload(event: QueueEvent, payload: QueueEventPayload): void {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) {
      return;
    }
    for (const handler of set) {
      try {
        handler(payload);
      } catch {
        /* swallow */
      }
    }
  }
}
