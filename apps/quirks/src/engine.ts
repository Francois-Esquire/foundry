import { Config } from "@foundry/lib/config";
import { contributeQueueConfig } from "@foundry/workflows/config";
import type { Orchestrator as OrchestratorType } from "@foundry/workflows/orchestrator";
import { Orchestrator } from "@foundry/workflows/orchestrator";
import type { RunRecord } from "@foundry/workflows/store";
import { InMemoryOrchestratorStore } from "@foundry/workflows/store";
import type { WorkflowState } from "@foundry/workflows/workflow";

import { observeSteps } from "~/observe";
import { loadRuns, saveRun } from "~/state/runs";

/**
 * The execution engine: a real Orchestrator over the in-memory store.
 *
 * Every workflow is dispatched as a Run through the queue, so Runs, Jobs and
 * frames all exist and are inspectable. Given a state dir, the store hydrates
 * from `runs/*.json` at start and each Run is written back once it settles;
 * without one, nothing survives the process.
 */

export interface Engine {
  launch<O>(
    name: string,
    input: unknown,
    triggerId?: string
  ): Promise<{ readonly id: string; readonly result: Promise<O> }>;
  /**
   * Dispatch a registered definition and wait for its value. `input` is
   * `unknown` because names, not types, address the registry — the caller
   * states the output type it expects.
   */
  run<O>(name: string, input: unknown, triggerId?: string): Promise<O>;
  /** Every Run this process dispatched. */
  runs(): Promise<readonly RunRecord[]>;
  stop(options?: { readonly cancel?: boolean }): Promise<void>;
}

/**
 * Definitions register through a callback rather than a map: `register` is
 * generic per definition, and a map would collapse every factory to the same
 * `Factory<unknown, unknown>` and lose the input type at the call site.
 */
export type RegisterDefinitions = (orchestrator: OrchestratorType) => void;

export interface EngineOptions {
  readonly print: (line: string) => void;
  /** Workspace state dir. Omit for in-memory, which `--dry` always is. */
  readonly state?: string;
}

export async function startEngine(
  register: RegisterDefinitions,
  { print, state }: EngineOptions
): Promise<Engine> {
  const store = new InMemoryOrchestratorStore(
    state === undefined ? {} : { snapshot: loadRuns(state, print) }
  );
  const config = new Config();
  contributeQueueConfig(config, { concurrency: 1, defaultName: "quirks" });

  const orchestrator = new Orchestrator({ config, store });
  await orchestrator.setup();
  register(orchestrator);
  await orchestrator.start();

  // Runs this process dispatched and has not written yet. Persisting is not
  // the run: a failed write warns and the value still returns.
  const unsaved = new Set<string>();
  const active = new Map<string, () => WorkflowState>();
  const dispatching = new Set<Promise<unknown>>();
  let stopping = false;
  const save = (runId: string) => {
    unsaved.delete(runId);
    if (state === undefined) {
      return;
    }
    try {
      saveRun(state, store.snapshot(), runId);
    } catch (error) {
      print(`[state] run ${runId} not saved: ${String(error)}`);
    }
  };

  const engine: Engine = {
    async launch<O>(name: string, input: unknown, triggerId?: string) {
      if (stopping) {
        throw new Error("engine is stopping");
      }
      const dispatch = orchestrator.run<unknown, O>(name, input, {
        extensions: triggerId === undefined ? {} : { triggerId },
      });
      dispatching.add(dispatch);
      const dispatched = await dispatch.finally(() =>
        dispatching.delete(dispatch)
      );
      active.set(dispatched.id, () => dispatched.workflow.state);
      unsaved.add(dispatched.id);
      const observed = observeSteps(name, dispatched.workflow, print);
      // The queue handle settles once its side effects are applied; the
      // workflow's own result carries the typed value.
      const complete = async () => {
        await dispatched.result();
        const settled = await dispatched.workflow.result();
        await observed;
        active.delete(dispatched.id);
        save(dispatched.id);
        if (settled.status !== "complete") {
          throw new Error(
            settled.status === "failed"
              ? `run "${name}" failed: ${settled.error.message}`
              : `run "${name}" was cancelled: ${settled.reason ?? "no reason"}`
          );
        }
        return settled.value;
      };
      const result = complete();
      // The host may attach after the first snapshot refresh.
      result.catch(() => undefined);
      return { id: dispatched.id, result };
    },
    async run<O>(name: string, input: unknown, triggerId?: string): Promise<O> {
      const launched = await this.launch<O>(name, input, triggerId);
      return launched.result;
    },

    async runs() {
      return store.snapshot().runs.map((record) => {
        const current = active.get(record.id)?.();
        return current
          ? {
              ...record,
              metadata: { ...record.metadata, workflow: current },
              snapshot: current.tree ?? record.snapshot,
            }
          : record;
      });
    },

    async stop(options) {
      stopping = true;
      await Promise.allSettled([...dispatching]);
      if (options?.cancel) {
        await Promise.all(
          store
            .snapshot()
            .runs.filter((run) =>
              ["queued", "running", "suspended"].includes(run.status)
            )
            .map((run) => orchestrator.cancelRun(run.id))
        );
      }
      await orchestrator.drain();
      for (const runId of [...unsaved]) {
        save(runId);
      }
      await orchestrator.stop();
    },
  };
  return engine;
}
