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

export class DispatchedWorkflow<
  I = unknown,
  O = unknown,
  X extends BaseContext = BaseContext,
> {
  readonly id: string;
  readonly queueId: string;
  readonly workflow: Workflow<I, O, X>;
  readonly #stepName: string | undefined;
  readonly #persist: (snap: WorkflowState) => Promise<void>;
  readonly #onCancel: ((snapshot: WorkflowState) => Promise<void>) | undefined;
  readonly #authorityManagedSuspensions: boolean;
  readonly #withControl:
    | (<T>(operation: () => Promise<T>) => Promise<T>)
    | undefined;

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

  /** @internal */
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

  /** @internal */
  _rejectAdmission(error: Error): Effect.Effect<void> {
    return this._rejectInfrastructure(error);
  }

  /** @internal */
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

  get snapshot(): WorkflowState {
    const { state } = this.workflow;
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

  get output(): O | undefined {
    const s = this.snapshot;
    return s.status === "complete" ? (s.output as O) : undefined;
  }

  get results(): Readonly<Record<string, unknown>> {
    return this.workflow.root.results;
  }

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
          const wfResult = yield* workflow.result;
          yield* self._settle(wfResult);
        })
      );
    return this.#withControl ? this.#withControl(operation) : operation();
  }

  /** @internal */
  _cancelAfterAuthority(reason?: string): Promise<void> {
    if (this.#admissionFailure) {
      return Promise.resolve();
    }
    const operation = () => this._cancelAfterAuthorityUnlocked(reason);
    return this.#withControl ? this.#withControl(operation) : operation();
  }

  /** @internal */
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

  /** @internal */
  _cancelLiveAfterAuthority(reason?: string): Promise<unknown> {
    if (this.#admissionFailure) {
      return Promise.resolve(undefined);
    }
    const operation = () => this._cancelLiveAfterAuthorityUnlocked(reason);
    return this.#withControl ? this.#withControl(operation) : operation();
  }

  /** @internal */
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

  /** @internal */
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
