import type { Scope } from "effect";

import { Effect, Match, Stream, SubscriptionRef } from "effect";
import { defineOwnEntry } from "../own-entry";
import type {
  SnapshotState,
  StepSnapshot,
  WorkflowSnapshot,
  WorkflowStepNode,
} from "../schema";
import type { ChannelEvent } from "./channels";

export type {
  SnapshotState,
  StepSnapshot,
  StepStatus,
  WorkflowSnapshot,
  WorkflowStepNode,
} from "../schema";

const emptyState = (): SnapshotState => ({
  results: {},
  steps: {},
  updatedAt: new Date().toISOString(),
  workflow: null,
});

export class Snapshot {
  readonly #seeded = new Map<string, unknown>();
  readonly #state: SubscriptionRef.SubscriptionRef<SnapshotState>;

  private constructor(args: {
    state: SubscriptionRef.SubscriptionRef<SnapshotState>;
  }) {
    this.#state = args.state;
  }

  /** @internal */
  static make(
    initial?: Partial<SnapshotState>
  ): Effect.Effect<Snapshot, never, Scope.Scope> {
    return Effect.gen(function* () {
      const seed: SnapshotState = { ...emptyState(), ...initial };
      const state = yield* SubscriptionRef.make<SnapshotState>(seed);
      return new Snapshot({ state });
    });
  }

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

  applyEvent(event: ChannelEvent): void {
    Effect.runSync(this.applyEventEffect(event));
  }

  /** @internal */
  applyEventEffect(event: ChannelEvent): Effect.Effect<void> {
    if (event._tag === "custom") {
      return Effect.void;
    }
    return SubscriptionRef.update(this.#state, (prev) =>
      Snapshot.apply({ ...prev, updatedAt: event.at }, event)
    );
  }

  /** @internal */
  seed(
    steps: Record<string, StepSnapshot>,
    options: { readonly memoize?: boolean } = {}
  ): Effect.Effect<void> {
    const memoize = options.memoize ?? true;
    return SubscriptionRef.update(this.#state, (prev) => {
      const mergedResults: Record<string, unknown> = { ...prev.results };
      for (const [key, step] of Object.entries(steps)) {
        if (step.status === "complete") {
          if (memoize) {
            this.#seeded.set(key, step.output);
          }
          if (step.output !== undefined) {
            defineOwnEntry(mergedResults, key, step.output);
          }
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

  /** @internal */
  consumeSeeded(
    key: string
  ):
    | { readonly found: true; readonly output: unknown }
    | { readonly found: false } {
    if (!this.#seeded.has(key)) {
      return { found: false };
    }
    const output = this.#seeded.get(key);
    this.#seeded.delete(key);
    return { found: true, output };
  }

  setWorkflow(workflow: WorkflowSnapshot): Effect.Effect<void> {
    return SubscriptionRef.update(this.#state, (prev) => {
      const seeded: Record<string, StepSnapshot> = { ...prev.steps };
      const at = new Date().toISOString();
      forEachLeaf(workflow.steps, (node, namespace) => {
        if (Object.hasOwn(seeded, node.key)) {
          return;
        }
        defineOwnEntry(seeded, node.key, {
          attempt: 0,
          name: node.name,
          namespace,
          status: "pending",
        });
      });
      return { ...prev, steps: seeded, updatedAt: at, workflow };
    });
  }

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

  markSkipped(path: readonly string[]): Effect.Effect<void> {
    return SubscriptionRef.update(this.#state, (prev) =>
      withStep(
        { ...prev, updatedAt: new Date().toISOString() },
        path,
        (cur) => ({ ...(cur ?? blankStep(path)), status: "skipped" })
      )
    );
  }

  markAborted(path: readonly string[]): Effect.Effect<void> {
    return SubscriptionRef.update(this.#state, (prev) =>
      withStep(
        { ...prev, updatedAt: new Date().toISOString() },
        path,
        (cur) => ({ ...(cur ?? blankStep(path)), status: "aborted" })
      )
    );
  }

  fork(): this {
    return this;
  }

  get current(): Effect.Effect<SnapshotState> {
    return SubscriptionRef.get(this.#state);
  }

  get changes(): Stream.Stream<SnapshotState> {
    return this.#state.changes;
  }

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

const keyOf = (path: readonly string[]): string => path.join(".");
const namespaceOf = (path: readonly string[]): string =>
  path.slice(0, -1).join(".");

const blankStep = (path: readonly string[]): StepSnapshot => ({
  attempt: 0,
  name: path.at(-1) ?? "",
  namespace: namespaceOf(path),
  status: "pending",
});

const withStep = (
  state: SnapshotState,
  path: readonly string[],
  fn: (prev: StepSnapshot | undefined) => StepSnapshot
): SnapshotState => {
  const key = keyOf(path);
  const prev = Object.hasOwn(state.steps, key) ? state.steps[key] : undefined;
  return { ...state, steps: { ...state.steps, [key]: fn(prev) } };
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
