import { Deferred, Effect, Option } from "effect";

import type { BaseContext } from "./executable";
import { workflowEffectAccess } from "./internal/workflow-effect-access";
import type { RunStatus } from "./types";
import type {
  ErrorShape,
  Workflow,
  WorkflowResult,
  WorkflowState,
} from "./workflow";

/**
 * Live handle for a single dispatched run. Wraps a {@link Workflow} with the
 * queue-owned terminal deferred and the JS-first sync accessors consumers read
 * (`status`, `snapshot`, `output`, `results`, `error`). The only coupling back
 * to the Queue is the injected `persist` closure, threaded on dispatch/adopt so
 * `cancel()` can write terminal state even when the driver fiber never runs.
 */
export class DispatchedWorkflow<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> {
  readonly id: string;
  readonly queueId: string;
  readonly workflow: Workflow<I, O, X>;
  // Optional override for the persisted run.step — Orchestrator threads
  // its registry key here. Falls back to workflow.name when unset.
  readonly #stepName: string | undefined;
  // Closure that writes the current workflow state to the runs row.
  // Injected on dispatch/adopt so cancel() can persist terminal state
  // when the driver fiber may not run.
  readonly #persist: (snap: WorkflowState) => Promise<void>;
  readonly #onCancel: ((snapshot: WorkflowState) => Promise<void>) | undefined;
  readonly #authorityManagedSuspensions: boolean;
  readonly #withControl:
    | (<T>(operation: () => Promise<T>) => Promise<T>)
    | undefined;

  /** Queue-owned terminal handle. Succeeded by #runOne after persistence +
   * emit, or by cancel() for runs that never reach the driver. Distinct from
   * workflow.result(), which resolves when the workflow reaches terminal.
   * Callers awaiting dispatched.result() see queue side-effects as applied. */
  readonly #settled: Deferred.Deferred<unknown>;
  #admissionFailure: Error | null = null;

  constructor(args: {
    readonly id: string;
    readonly queueId: string;
    readonly workflow: Workflow<I, O, X>;
    readonly step?: string;
    readonly persist: (snap: WorkflowState) => Promise<void>;
    readonly onCancel?: (snapshot: WorkflowState) => Promise<void>;
    readonly authorityManagedSuspensions?: boolean;
    readonly withControl?: <T>(operation: () => Promise<T>) => Promise<T>;
  }) {
    this.id = args.id;
    this.queueId = args.queueId;
    this.workflow = args.workflow;
    this.#stepName = args.step;
    this.#persist = args.persist;
    this.#onCancel = args.onCancel;
    this.#authorityManagedSuspensions =
      args.authorityManagedSuspensions ?? false;
    this.#withControl = args.withControl;
    this.#settled = Effect.runSync(Deferred.make<unknown>());
  }

  /** @internal Queue calls this from #runOne after bookkeeping. Idempotent. */
  _settle(value: unknown): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const already = yield* Deferred.poll(self.#settled);
      if (Option.isSome(already)) {
        return;
      }
      yield* Deferred.succeed(self.#settled, value);
    });
  }

  /** @internal Settle a handle whose durable row could not be admitted. */
  _rejectAdmission(error: Error): Effect.Effect<void> {
    return this._rejectInfrastructure(error);
  }

  /** @internal Settle a handle after an execution-infrastructure failure. */
  _rejectInfrastructure(error: Error): Effect.Effect<void> {
    this.#admissionFailure = error;
    const result: WorkflowResult = { error, status: "failed" };
    return this._settle(result);
  }

  get step(): string {
    return this.#stepName ?? this.workflow.name;
  }

  get status(): RunStatus {
    if (this.#admissionFailure) {
      return "failed";
    }
    return this.workflow.status;
  }

  /** Sync read of the latest workflow snapshot. Reflects the in-memory
   * projection; for hydrated runs, this is the seeded snapshot. */
  get snapshot(): WorkflowState {
    const state = this.workflow.state;
    if (!this.#admissionFailure) {
      return state;
    }
    return {
      ...state,
      completedAt: new Date().toISOString(),
      error: errorShape(this.#admissionFailure),
      status: "failed",
    };
  }

  /** The workflow's terminal output. `undefined` unless status is `complete`. */
  get output(): O | undefined {
    const s = this.snapshot;
    return s.status === "complete" ? (s.output as O) : undefined;
  }

  /**
   * Map of completed step outputs keyed by dot-joined path
   * (e.g., `"workflow.child"`, `"workflow.child.grandchild"`). Updated
   * reactively as steps complete. Empty `{}` for runs that haven't started.
   * Path-keyed because step names can repeat; the path is unambiguous.
   */
  get results(): Readonly<Record<string, unknown>> {
    return this.workflow.root.results;
  }

  /** Workflow-level error captured on the `failed` transition, or `null` for
   * non-failed runs. Plain shape: `{ name, message, stack? }`. */
  get error(): ErrorShape | null {
    return this.snapshot.error ?? null;
  }

  result(): Promise<unknown> {
    return Effect.runPromise(Deferred.await(this.#settled));
  }

  cancel(reason?: string): Promise<void> {
    if (this.#admissionFailure) {
      return Promise.resolve();
    }
    const self = this;
    const operation = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const workflow = workflowEffectAccess(self.workflow);
          const onCancel = self.#onCancel;
          if (onCancel) {
            // Store authority commits before the live workflow is mutated. A
            // rejected transaction therefore leaves a suspended handle intact
            // and resolvable rather than creating split-brain cancellation.
            const currentState = yield* workflow.state;
            yield* Effect.promise(() =>
              onCancel({
                ...currentState,
                completedAt:
                  currentState.completedAt ?? new Date().toISOString(),
                status: "cancelled",
              })
            );
            yield* workflow.cancel(reason);
          } else {
            yield* workflow.cancel(reason);
            const finalState = yield* workflow.state;
            yield* Effect.promise(() =>
              self.#persist({ ...finalState, status: "cancelled" })
            );
          }
          // Eagerly settle for runs cancelled before driver pickup; #runOne may
          // never settle. _settle is idempotent.
          const wfResult = yield* workflow.result;
          yield* self._settle(wfResult);
        })
      );
    return this.#withControl ? this.#withControl(operation) : operation();
  }

  /** @internal Apply a cancellation whose durable authority already committed. */
  _cancelAfterAuthority(reason?: string): Promise<void> {
    if (this.#admissionFailure) {
      return Promise.resolve();
    }
    const operation = () => this._cancelAfterAuthorityUnlocked(reason);
    return this.#withControl ? this.#withControl(operation) : operation();
  }

  /** @internal Queue control lock must already be held. */
  _cancelAfterAuthorityUnlocked(reason?: string): Promise<void> {
    if (this.#admissionFailure) {
      return Promise.resolve();
    }
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() =>
          self._cancelLiveAfterAuthorityUnlocked(reason)
        );
        yield* self._settle(result);
      })
    );
  }

  /** @internal Cancel live work without settling the queue-owned result. */
  _cancelLiveAfterAuthority(reason?: string): Promise<unknown> {
    if (this.#admissionFailure) {
      return Promise.resolve(undefined);
    }
    const operation = () => this._cancelLiveAfterAuthorityUnlocked(reason);
    return this.#withControl ? this.#withControl(operation) : operation();
  }

  /** @internal Queue control lock must already be held. */
  _cancelLiveAfterAuthorityUnlocked(reason?: string): Promise<unknown> {
    if (this.#admissionFailure) {
      return Promise.resolve(undefined);
    }
    const self = this;
    return Effect.runPromise(
      Effect.gen(function* () {
        const workflow = workflowEffectAccess(self.workflow);
        yield* workflow.cancel(reason);
        return yield* workflow.result;
      })
    );
  }

  resume(name: string, value: unknown): Promise<void> {
    if (this.#authorityManagedSuspensions) {
      return Promise.reject(
        new Error(
          "First-class Suspensions must be resolved through Orchestrator.resolve()"
        )
      );
    }
    return this.workflow.resume(name, value);
  }

  /** @internal Resume exactly one first-class suspension occurrence. */
  resumeOccurrence(
    stepPath: readonly string[],
    name: string,
    occurrence: number,
    value: unknown
  ): Promise<void> {
    return this.workflow.resumeOccurrence(stepPath, name, occurrence, value);
  }
}

function errorShape(error: Error): ErrorShape {
  return {
    message: error.message,
    name: error.name,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}
