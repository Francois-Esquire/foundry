import { Schema } from "effect";

import type { SuspensionState } from "./channels";
import {
  SuspensionAlreadySettledError,
  SuspensionNotFoundError,
} from "./errors";
import type {
  JsonValue,
  OrchestratorStore,
  Page,
  SuspensionCancellation,
  SuspensionQuery,
  SuspensionRecord,
  UpdateRunInput,
} from "./store";
import { JsonValueSchema } from "./store";

export interface ResolveSuspensionOptions {
  readonly expectedRevision?: number;
}

interface SuspensionLifecycleOptions {
  readonly publish: (record: SuspensionRecord) => Promise<void>;
  readonly resume: (
    record: SuspensionRecord,
    resolution: JsonValue
  ) => Promise<void>;
  readonly store: OrchestratorStore;
  readonly withRunControl: <T>(
    runId: string,
    operation: () => Promise<T>
  ) => Promise<T>;
}

/** Store-authoritative coordination for stable Suspension occurrences. */
export class SuspensionLifecycle {
  readonly #store: OrchestratorStore;
  readonly #publish: (record: SuspensionRecord) => Promise<void>;
  readonly #resume: SuspensionLifecycleOptions["resume"];
  readonly #withRunControl: SuspensionLifecycleOptions["withRunControl"];

  constructor(options: SuspensionLifecycleOptions) {
    this.#store = options.store;
    this.#publish = options.publish;
    this.#resume = options.resume;
    this.#withRunControl = options.withRunControl;
  }

  get(id: string): Promise<SuspensionRecord | null> {
    return this.#store.getSuspension(id);
  }

  list(query?: SuspensionQuery): Promise<Page<SuspensionRecord>> {
    return this.#store.listSuspensions(query);
  }

  async park(
    runId: string,
    fallbackStep: string,
    state: SuspensionState,
    runPatch: Omit<UpdateRunInput, "status"> = {}
  ): Promise<SuspensionRecord> {
    const request = state.request ?? state.meta ?? null;
    assertJsonValue(request, "Suspension request");
    const parking = await this.#store.parkSuspension(
      {
        kind: state.kind ?? "external",
        name: state.name,
        occurrence: state.occurrence ?? 0,
        reason: state.reason,
        request,
        runId,
        stepPath: state.stepPath ?? [fallbackStep],
      },
      runPatch
    );
    if (parking.created) {
      await this.#publish(parking.suspension).catch(() => undefined);
    }
    return parking.suspension;
  }

  async resolve(
    id: string,
    resolution: JsonValue,
    options: ResolveSuspensionOptions = {}
  ): Promise<SuspensionRecord> {
    const firstRead = await this.#store.getSuspension(id);
    if (!firstRead) {
      throw new SuspensionNotFoundError(id);
    }
    return this.#withRunControl(firstRead.runId, async () => {
      assertJsonValue(resolution, "Suspension resolution");
      const current = await this.#store.getSuspension(id);
      if (!current) {
        throw new SuspensionNotFoundError(id);
      }
      if (current.status !== "pending") {
        throw new SuspensionAlreadySettledError(id);
      }
      const settlement = await this.#store.settleSuspension(id, {
        expectedRevision: options.expectedRevision ?? current.revision,
        outcome: { resolution, status: "resolved" },
      });
      try {
        await this.#publish(settlement.suspension);
      } catch {
        // Observation is subordinate to durable control state. The injected
        // publisher records its own failure; replay must still be attempted.
      }
      await this.#resume(settlement.suspension, resolution);
      return settlement.suspension;
    });
  }

  async cancelRun(
    runId: string,
    runPatch: Omit<UpdateRunInput, "status"> = {}
  ): Promise<void> {
    const cancellation = await this.#store.cancelRunSuspensions(
      runId,
      runPatch
    );
    for (const record of cancellation.suspensions) {
      await this.#publish(record).catch(() => undefined);
    }
  }

  async requestRunCancellation(runId: string): Promise<SuspensionCancellation> {
    const cancellation = await this.#store.cancelRun(runId);
    await this.publishCancelled(cancellation.suspensions);
    return cancellation;
  }

  async publishCancelled(records: readonly SuspensionRecord[]): Promise<void> {
    for (const record of records) {
      await this.#publish(record).catch(() => undefined);
    }
  }
}

function assertJsonValue(
  value: unknown,
  label: string
): asserts value is JsonValue {
  if (!Schema.is(JsonValueSchema)(value)) {
    throw new Error(`${label} must be a finite, acyclic JSON value`);
  }
}
