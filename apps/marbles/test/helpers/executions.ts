import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ProcessIdentity,
  thisProcess,
} from "@foundry/lib/node/process-identity";
import type { Job, JobId, Run, RunId } from "@foundry/queue";
import { makeSqliteQueueStore } from "@foundry/queue/store/sqlite";
import { Effect } from "effect";
import { afterEach, beforeEach } from "vitest";
import { catalog } from "~/authoring/catalog";
import { readExecution } from "~/database/executions";
import type { StoreDatabase } from "~/database/open";
import { initializeDatabase, readDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";
import type { Engine } from "~/lib/engine";
import { linksOf } from "~/lib/execution-record";
import type { ExecutionStatus } from "~/lib/execution-statuses";
import type { ExecutionRun } from "~/lib/executions";
import { testEngine } from "./engine";
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

export async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function blockingTask(
  engine: Engine,
  name: string,
  started: string[],
  gates: Map<string, () => void>,
  pool?: string
): void {
  engine.task<{ label: string }, string>({
    name,
    ...(pool === undefined ? {} : { pool }),
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

export function exitedPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined) {
    throw new Error("could not spawn");
  }
  return pid;
}

export interface ExecutionSeeds {
  readonly database: StoreDatabase;
  readonly scope: string;
}

export type SeededRun = Partial<Omit<ExecutionRun, "owner" | "status">> & {
  readonly id: string;
  readonly owner?: ProcessIdentity;
  readonly status?: ExecutionStatus;
};

export async function withExecutions<T>(
  state: string,
  work: (seeds: ExecutionSeeds) => Promise<T>,
  scope = "test"
): Promise<T> {
  const opened = await initializeDatabase(stateDatabase(state));
  try {
    return await work({ database: opened.database, scope });
  } finally {
    opened.close();
  }
}

export async function storedExecution(
  state: string,
  id: string,
  scope = "test"
): Promise<ExecutionRun | undefined> {
  const stored = await readDatabase(stateDatabase(state), (database) =>
    readExecution(database, scope, id)
  );
  return stored ?? undefined;
}

export async function seedExecution(
  seeds: ExecutionSeeds,
  seeded: SeededRun
): Promise<void> {
  const { job, run } = seededJob(seeded);
  const store = makeSqliteQueueStore(seeds);
  await Effect.runPromise(
    store.commit({ deleteJobs: [job.id], deleteRuns: [run.id] })
  );
  await Effect.runPromise(store.commit({ jobs: [job], runs: [run] }));
}

function seededJob(seeded: SeededRun): {
  readonly job: Job;
  readonly run: Run;
} {
  const at = Date.parse(
    seeded.timestamps?.queuedAt ?? new Date().toISOString()
  );
  const started = seeded.timestamps?.startedAt;
  const startedAt = started === undefined ? at : Date.parse(started);
  const owner = { ...(seeded.owner ?? thisProcess()) };
  const runId = seeded.id as RunId;
  const jobId = (seeded.jobId ?? `jb-${seeded.id}`) as JobId;
  const status = seeded.status ?? "queued";
  const lease = { claimedAt: startedAt, owner };
  const error = {
    message: seeded.error?.message ?? "",
    name: seeded.error?.code ?? "Error",
  };
  const states: Record<
    ExecutionStatus,
    { readonly job: Job["state"]; readonly run: Run["state"] }
  > = {
    cancelled: {
      job: { cancelledAt: at, kind: "cancelled" },
      run: { cancelledAt: at, kind: "cancelled" },
    },
    complete: {
      job: { completedAt: at, kind: "complete", output: null, runId },
      run: { completedAt: at, kind: "complete", output: null },
    },
    failed: {
      job: { error, failedAt: at, kind: "failed", lastRunId: runId },
      run: { error, failedAt: at, kind: "failed", retryable: false },
    },
    interrupted: {
      job: { error, failedAt: at, kind: "failed", lastRunId: runId },
      run: {
        interruptedAt: at,
        kind: "interrupted",
        lease,
        reason: "owner gone",
      },
    },
    queued: {
      job: { kind: "pending" },
      run: { availableAt: at, kind: "queued", owner, queuedAt: at },
    },
    running: {
      job: { attempt: 1, kind: "active", runId },
      run: { kind: "running", lease },
    },
    suspended: {
      job: { kind: "suspended", runId, suspensionId: `su-${seeded.id}` },
      run: {
        kind: "suspended",
        suspendedAt: at,
        suspensionId: `su-${seeded.id}`,
      },
    },
  };
  const kind = seeded.kind ?? "task";
  const pool = seeded.pool ?? (kind === "task" ? "system" : "marbles");
  return {
    job: {
      createdAt: at,
      handler: { name: seeded.name ?? (kind === "task" ? "save" : "flow") },
      id: jobId,
      input: seeded.input ?? null,
      links: linksOf({
        ...(seeded.correlation === undefined
          ? {}
          : { correlation: seeded.correlation }),
        kind,
        ...(seeded.source === undefined ? {} : { source: seeded.source }),
      }),
      policy: {},
      pool,
      state: states[status].job,
    },
    run: {
      attempt: 1,
      id: runId,
      jobId,
      pool,
      revision: seeded.revision ?? 1,
      ...(status === "queued" ? {} : { startedAt }),
      state: states[status].run,
    },
  };
}

export async function leftBehind(
  state: string,
  pid: number,
  runs: readonly Partial<SeededRun>[]
): Promise<void> {
  await withExecutions(state, async (seeds) => {
    for (const [index, run] of runs.entries()) {
      const at = new Date(Date.now() - 1000 + index).toISOString();
      await seedExecution(seeds, {
        id: `rn-left-${index}`,
        owner: { pid, started: null },
        timestamps: { queuedAt: at, updatedAt: at },
        ...run,
      });
    }
  });
}

export async function orphan(
  seeds: ExecutionSeeds,
  run: SeededRun
): Promise<void> {
  const at = new Date().toISOString();
  await seedExecution(seeds, {
    kind: "workflow",
    name: "flow",
    owner: { pid: exitedPid(), started: null },
    pool: "marbles",
    revision: 3,
    status: "suspended",
    timestamps: { queuedAt: at, startedAt: at, updatedAt: at },
    ...run,
  });
}
