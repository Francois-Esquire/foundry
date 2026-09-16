import type { Scope } from "effect";

import { Effect, Match, Schema, Stream, SubscriptionRef } from "effect";

import type { ChannelEvent } from "./channels";

/**
 * Projected runtime state: receives {@link applyEvent} updates via
 * Channels and serves as canonical read for persistence.
 *
 * Three stores under one SubscriptionRef (atomic updates):
 *   - `steps`: flat Record<key, StepSnapshot> by dot-joined path
 *   - `workflow`: tree + cursor + name + input (null if unwrapped)
 *   - `results`: denormalized outputs (kept separate from steps so
 *     result subscribers don't wake on status-only ticks)
 *
 * Identity-free (no `runId`/`queueId`). Consumers use per-store
 * derivations (stepsChanges/workflowChanges/resultsChanges) or full
 * state via changes.
 */

// ── Status vocab ──

/**
 * Step-level status. Distinct from `RunStatus` (run-level) — a Run
 * can be `queued` while its steps are `pending`, etc.
 *
 *   - `pending`   seeded when a workflow dispatches; before `started`
 *   - `running`   step is currently executing
 *   - `complete`  step returned a value
 *   - `failed`    step threw or bailed
 *   - `skipped`   branch arm not taken (writer: composer)
 *   - `suspended` step is parked awaiting `resume`
 *   - `aborted`   step interrupted by cancellation
 *   - `paused`    operator-paused mid-flight; resumes back to `running`
 */
export const StepStatusSchema = Schema.Literal(
  "pending",
  "running",
  "complete",
  "failed",
  "skipped",
  "suspended",
  "aborted",
  "paused"
);
export type StepStatus = Schema.Schema.Type<typeof StepStatusSchema>;

// ── Tree types ──

/**
 * A node in the workflow's structural tree. Carries no live status —
 * status lives in the flat `steps` map under the same `key`.
 */
export interface WorkflowStepNode {
  readonly children?: readonly WorkflowStepNode[];
  readonly index: number;
  readonly key: string;
  readonly name: string;
}
export const WorkflowStepNodeSchema: Schema.Schema<WorkflowStepNode> =
  Schema.suspend(() =>
    Schema.Struct({
      children: Schema.optional(Schema.Array(WorkflowStepNodeSchema)),
      index: Schema.Number,
      key: Schema.String,
      name: Schema.String,
    })
  );

/**
 * The structural plan + cursor. Nullable — single-step Runs (Step.run
 * without a Workflow wrapper) leave this null and just populate
 * `steps`/`results`.
 */
export const WorkflowSnapshotSchema = Schema.Struct({
  cursor: Schema.NullOr(Schema.String),
  input: Schema.Unknown,
  name: Schema.String,
  steps: Schema.Array(WorkflowStepNodeSchema),
});
export type WorkflowSnapshot = Schema.Schema.Type<
  typeof WorkflowSnapshotSchema
>;

// ── Step record ──

/**
 * Per-step snapshot, flat by namespaced key (no nested children).
 * Suspension per-step allows suspended subtrees; identity layer
 * can reduce to root-level field if needed.
 */
export const StepSnapshotSchema = Schema.Struct({
  attempt: Schema.Number,
  bail: Schema.optional(Schema.Unknown),
  completedAt: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.String,
      name: Schema.String,
      stack: Schema.optional(Schema.String),
    })
  ),
  name: Schema.String,
  namespace: Schema.String,
  output: Schema.optional(Schema.Unknown),
  progress: Schema.optional(Schema.Number),
  startedAt: Schema.optional(Schema.String),
  status: StepStatusSchema,
  suspendedAt: Schema.optional(Schema.String),
  suspension: Schema.optional(
    Schema.Struct({
      meta: Schema.optional(
        Schema.Record({ key: Schema.String, value: Schema.Unknown })
      ),
      name: Schema.String,
      reason: Schema.String,
      suspendedAt: Schema.String,
    })
  ),
});
export type StepSnapshot = Schema.Schema.Type<typeof StepSnapshotSchema>;

// ── SnapshotState ──

export const SnapshotStateSchema = Schema.Struct({
  results: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  steps: Schema.Record({ key: Schema.String, value: StepSnapshotSchema }),
  updatedAt: Schema.String,
  workflow: Schema.NullOr(WorkflowSnapshotSchema),
});
export type SnapshotState = Schema.Schema.Type<typeof SnapshotStateSchema>;

const emptyState = (): SnapshotState => ({
  results: {},
  steps: {},
  updatedAt: new Date().toISOString(),
  workflow: null,
});

// ── Snapshot ──

export class Snapshot {
  readonly #state: SubscriptionRef.SubscriptionRef<SnapshotState>;

  private constructor(args: {
    state: SubscriptionRef.SubscriptionRef<SnapshotState>;
  }) {
    this.#state = args.state;
  }

  /**
   * @internal Effect-typed factory. Step.make / Workflow.create seed
   * snapshot under their scope. Consumers receive via parent.
   */
  static make(
    initial?: Partial<SnapshotState>
  ): Effect.Effect<Snapshot, never, Scope.Scope> {
    return Effect.gen(function* () {
      const seed: SnapshotState = { ...emptyState(), ...initial };
      const state = yield* SubscriptionRef.make<SnapshotState>(seed);
      return new Snapshot({ state });
    });
  }

  // ── Projection (pure) ──

  /**
   * Pure fold: `(state, event) → state`. Used by applyEventEffect and
   * exposed for replay/hydration without a live Snapshot. Compile-time
   * exhaustive via Match.exhaustive. Custom events are no-op.
   */
  static apply(state: SnapshotState, event: ChannelEvent): SnapshotState {
    return Match.value(event).pipe(
      Match.tag("step.started", (e) =>
        withStep(state, e.path, (prev) => ({
          ...(prev ?? blankStep(e.path)),
          attempt: e.attempt,
          name: e.name,
          namespace: namespaceOf(e.path),
          startedAt: e.at,
          status: "running",
        }))
      ),
      Match.tag("step.complete", (e) => {
        const key = keyOf(e.path);
        const stepped = withStep(state, e.path, (prev) => ({
          ...(prev ?? blankStep(e.path)),
          attempt: e.attempt,
          completedAt: e.at,
          durationMs: durationFrom(prev?.startedAt, e.at),
          name: e.name,
          namespace: namespaceOf(e.path),
          output: e.value,
          status: "complete",
        }));
        return clearCursorIf(
          { ...stepped, results: { ...stepped.results, [key]: e.value } },
          key
        );
      }),
      Match.tag("step.failed", (e) => {
        const stepped = withStep(state, e.path, (prev) => ({
          ...(prev ?? blankStep(e.path)),
          attempt: e.attempt,
          completedAt: e.at,
          durationMs: durationFrom(prev?.startedAt, e.at),
          error: e.error,
          name: e.name,
          namespace: namespaceOf(e.path),
          status: "failed",
        }));
        return clearCursorIf(stepped, keyOf(e.path));
      }),
      Match.tag("step.bailed", (e) => {
        const stepped = withStep(state, e.path, (prev) => ({
          ...(prev ?? blankStep(e.path)),
          attempt: e.attempt,
          bail: e.bail,
          completedAt: e.at,
          durationMs: durationFrom(prev?.startedAt, e.at),
          name: e.name,
          namespace: namespaceOf(e.path),
          status: "failed",
        }));
        return clearCursorIf(stepped, keyOf(e.path));
      }),
      Match.tag("step.suspended", (e) =>
        withStep(state, e.path, (prev) => ({
          ...(prev ?? blankStep(e.path)),
          attempt: e.attempt,
          name: e.name,
          namespace: namespaceOf(e.path),
          status: "suspended",
          suspendedAt: e.at,
          suspension: e.suspension,
        }))
      ),
      Match.tag("step.paused", (e) =>
        withStep(state, e.path, (prev) => ({
          ...(prev ?? blankStep(e.path)),
          attempt: e.attempt,
          name: e.name,
          namespace: namespaceOf(e.path),
          status: "paused",
        }))
      ),
      Match.tag("step.resumed", (e) =>
        withStep(state, e.path, (prev) => ({
          ...(prev ?? blankStep(e.path)),
          attempt: e.attempt,
          name: e.name,
          namespace: namespaceOf(e.path),
          status: "running",
        }))
      ),
      Match.tag("step.skipped", (e) => {
        const stepped = withStep(state, e.path, (prev) => ({
          ...(prev ?? blankStep(e.path)),
          attempt: e.attempt,
          completedAt: e.at,
          durationMs: durationFrom(prev?.startedAt, e.at),
          name: e.name,
          namespace: namespaceOf(e.path),
          status: "skipped",
        }));
        return clearCursorIf(stepped, keyOf(e.path));
      }),
      Match.tag("step.aborted", (e) => {
        const stepped = withStep(state, e.path, (prev) => ({
          ...(prev ?? blankStep(e.path)),
          attempt: e.attempt,
          completedAt: e.at,
          durationMs: durationFrom(prev?.startedAt, e.at),
          name: e.name,
          namespace: namespaceOf(e.path),
          status: "aborted",
        }));
        return clearCursorIf(stepped, keyOf(e.path));
      }),
      // step.resolved: transient marker. Clears suspension so consumers
      // don't see stale resolution. Follow-up replay fires step.started.
      Match.tag("step.resolved", (e) =>
        withStep(state, e.path, (prev) => {
          const next: StepSnapshot = {
            ...(prev ?? blankStep(e.path)),
            name: e.name,
            namespace: namespaceOf(e.path),
          };
          if (next.suspension !== undefined) {
            const { suspension: _omit, ...rest } = next;
            return rest;
          }
          return next;
        })
      ),
      // step.progress is non-status (snapshot updates progress only).
      Match.tag("step.progress", (e) =>
        withStep(state, e.path, (prev) => ({
          ...(prev ?? blankStep(e.path)),
          name: e.name,
          namespace: namespaceOf(e.path),
          progress: e.value,
        }))
      ),
      Match.tag("custom", () => state),
      Match.exhaustive
    );
  }

  // ── Apply ──

  /** Sync apply — called by Channels.events.push. */
  applyEvent(event: ChannelEvent): void {
    Effect.runSync(this.applyEventEffect(event));
  }

  /**
   * @internal Effect-typed apply for in-fiber composition.
   * Plain-JS callers use {@link applyEvent}.
   */
  applyEventEffect(event: ChannelEvent): Effect.Effect<void> {
    if (event._tag === "custom") {
      return Effect.void;
    }
    return SubscriptionRef.update(this.#state, (prev) =>
      Snapshot.apply({ ...prev, updatedAt: event.at }, event)
    );
  }

  /**
   * One-shot step overwrite for recovery (seeds from persisted
   * `runs.metadata.workflow.steps` before re-dispatch). Also derives
   * `results` from complete steps with output (idempotent).
   *
   * @internal Effect-typed write. Queue recovery uses this.
   */
  seed(steps: Record<string, StepSnapshot>): Effect.Effect<void> {
    return SubscriptionRef.update(this.#state, (prev) => {
      const mergedResults: Record<string, unknown> = { ...prev.results };
      for (const [key, step] of Object.entries(steps)) {
        if (step.status === "complete" && step.output !== undefined) {
          mergedResults[key] = step.output;
        }
      }
      return {
        ...prev,
        results: mergedResults,
        steps: { ...prev.steps, ...steps },
        updatedAt: new Date().toISOString(),
      };
    });
  }

  // ── Direct writes ──
  // @internal All four (setWorkflow, setCursor, markSkipped, markAborted)
  // return Effect. Step/Workflow wrap with Promise at consumer surface.

  /**
   * Seed structural plan + cursor at workflow dispatch. Also seeds
   * steps with `pending` entries so subscribers see full tree before
   * any step runs.
   */
  setWorkflow(workflow: WorkflowSnapshot): Effect.Effect<void> {
    return SubscriptionRef.update(this.#state, (prev) => {
      const seeded: Record<string, StepSnapshot> = { ...prev.steps };
      const at = new Date().toISOString();
      forEachLeaf(workflow.steps, (node, namespace) => {
        if (seeded[node.key]) {
          return;
        }
        seeded[node.key] = {
          attempt: 0,
          name: node.name,
          namespace,
          status: "pending",
        };
      });
      return { ...prev, steps: seeded, updatedAt: at, workflow };
    });
  }

  /** Move the cursor (workflow tree dispatcher writes this). */
  setCursor(key: string | null): Effect.Effect<void> {
    return SubscriptionRef.update(this.#state, (prev) =>
      prev.workflow === null
        ? prev
        : {
            ...prev,
            updatedAt: new Date().toISOString(),
            workflow: { ...prev.workflow, cursor: key },
          }
    );
  }

  /** Mark a step `skipped` (branch composer writes this for unchosen arms). */
  markSkipped(path: readonly string[]): Effect.Effect<void> {
    return SubscriptionRef.update(this.#state, (prev) =>
      withStep(
        { ...prev, updatedAt: new Date().toISOString() },
        path,
        (cur) => ({ ...(cur ?? blankStep(path)), status: "skipped" })
      )
    );
  }

  /** Mark a step `aborted` (cancel-handler writes this). */
  markAborted(path: readonly string[]): Effect.Effect<void> {
    return SubscriptionRef.update(this.#state, (prev) =>
      withStep(
        { ...prev, updatedAt: new Date().toISOString() },
        path,
        (cur) => ({ ...(cur ?? blankStep(path)), status: "aborted" })
      )
    );
  }

  // ── Fork ──

  /**
   * Snapshot is shared per Run (one state machine, all frames).
   * Returns `this` so uniform `slice.fork()` contract holds.
   */
  fork(): this {
    return this;
  }

  // ── Reads — full state ──
  // @internal Effect/Stream surface; Step/Workflow wrap to JS forms.

  get current(): Effect.Effect<SnapshotState> {
    return SubscriptionRef.get(this.#state);
  }

  get changes(): Stream.Stream<SnapshotState> {
    return this.#state.changes;
  }

  // ── Reads — per store ────────────────────────────────────────────────────

  get currentSteps(): Effect.Effect<Record<string, StepSnapshot>> {
    return Effect.map(SubscriptionRef.get(this.#state), (s) => s.steps);
  }
  get stepsChanges(): Stream.Stream<Record<string, StepSnapshot>> {
    return Stream.map(this.#state.changes, (s) => s.steps);
  }

  get currentWorkflow(): Effect.Effect<WorkflowSnapshot | null> {
    return Effect.map(SubscriptionRef.get(this.#state), (s) => s.workflow);
  }
  get workflowChanges(): Stream.Stream<WorkflowSnapshot | null> {
    return Stream.map(this.#state.changes, (s) => s.workflow);
  }

  get currentResults(): Effect.Effect<Record<string, unknown>> {
    return Effect.map(SubscriptionRef.get(this.#state), (s) => s.results);
  }
  get resultsChanges(): Stream.Stream<Record<string, unknown>> {
    return Stream.map(this.#state.changes, (s) => s.results);
  }
}

// ── Helpers ──

const keyOf = (path: readonly string[]): string => path.join(".");
const namespaceOf = (path: readonly string[]): string =>
  path.slice(0, -1).join(".");

const blankStep = (path: readonly string[]): StepSnapshot => ({
  attempt: 0,
  name: path[path.length - 1] ?? "",
  namespace: namespaceOf(path),
  status: "pending",
});

const withStep = (
  state: SnapshotState,
  path: readonly string[],
  fn: (prev: StepSnapshot | undefined) => StepSnapshot
): SnapshotState => {
  const key = keyOf(path);
  return { ...state, steps: { ...state.steps, [key]: fn(state.steps[key]) } };
};

const clearCursorIf = (state: SnapshotState, key: string): SnapshotState => {
  if (state.workflow?.cursor !== key) {
    return state;
  }
  return { ...state, workflow: { ...state.workflow, cursor: null } };
};

const durationFrom = (startedAt: string | undefined, endAt: string): number => {
  if (!startedAt) {
    return 0;
  }
  return new Date(endAt).getTime() - new Date(startedAt).getTime();
};

const forEachLeaf = (
  nodes: readonly WorkflowStepNode[],
  visit: (node: WorkflowStepNode, namespace: string) => void,
  parentNamespace = ""
): void => {
  for (const node of nodes) {
    if (node.children && node.children.length > 0) {
      forEachLeaf(node.children, visit, node.key);
    } else {
      visit(node, parentNamespace);
    }
  }
};
