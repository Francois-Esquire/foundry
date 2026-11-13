import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { catalog } from "~/authoring/catalog";
import type { Engine } from "~/lib/engine";
import type { ExecutionRun } from "~/lib/executions";
import { JsonStateStore, type StateStore } from "~/lib/state/store";
import { testEngine } from "./engine";
/** Each suite owns its engines and directory; close engines before removing watched files. */
export function executionFixture() {
  let root: string;
  const engines: Engine[] = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "marbles-executions-"));
  });
  afterEach(async () => {
    catalog.reset();
    await Promise.allSettled(
      engines.splice(0).map((engine) => engine.dispose())
    );
    await rm(root, { force: true, recursive: true });
  });
  return {
    engine(options: Parameters<typeof testEngine>[0] = {}): Engine {
      const engine = testEngine({ root, ...options });
      engines.push(engine);
      return engine;
    },
    get root() {
      return root;
    },
  };
}

export function gate() {
  const { promise: opened, resolve: open } = Promise.withResolvers<void>();
  return { open: () => open(), opened };
}

/** Resolves once `check` holds, polling briefly. */
export async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A task that records when it starts and waits for its gate. */
export function blockingTask(
  engine: Engine,
  name: string,
  started: string[],
  gates: Map<string, () => void>,
  queue?: string
): void {
  engine.task<{ label: string }, string>({
    name,
    ...(queue === undefined ? {} : { queue }),
    run: async ({ label }, { signal }) => {
      started.push(label);
      const { open, opened } = gate();
      gates.set(label, open);
      signal.addEventListener("abort", open, { once: true });
      await opened;
      return label;
    },
  });
}

/** A pid that has certainly exited. */
export function exitedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined) {
    throw new Error("could not spawn");
  }
  return pid;
}

/** Records as a crashed process would have left them. */
export function leftBehind(
  state: string,
  pid: number,
  runs: readonly Partial<ExecutionRun>[]
): void {
  const store = new JsonStateStore(state);
  for (const [index, run] of runs.entries()) {
    const at = new Date(Date.now() - 1000 + index).toISOString();
    store.write("executions", run.id ?? `rn-left-${index}`, {
      correlation: {},
      id: `rn-left-${index}`,
      kind: "task",
      name: "save",
      observations: [],
      owner: { pid },
      queue: "system",
      revision: 2,
      sequence: 1000 + index,
      status: "queued",
      timestamps: { queuedAt: at, updatedAt: at },
      ...run,
    });
  }
}

/** An unsettled run an exited process left, written straight to `store`. */
export function orphan(
  store: StateStore,
  run: Partial<ExecutionRun> & { readonly id: string }
): void {
  const at = new Date().toISOString();
  store.write("executions", run.id, {
    correlation: {},
    kind: "workflow",
    name: "flow",
    owner: { pid: exitedPid() },
    queue: "marbles",
    revision: 3,
    sequence: 1,
    status: "suspended",
    timestamps: { queuedAt: at, startedAt: at, updatedAt: at },
    ...run,
  });
}
