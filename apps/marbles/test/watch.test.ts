import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { thisProcess } from "@foundry/lib/process-identity";
import { expect, it, vi } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { watchRun } from "~/cli/watch";
import { DatabaseExecutionStore } from "~/database/executions";
import { initializeDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";
import type { ExecutionRun } from "~/lib/execution-record";
import {
  type OutputRecord,
  type RunHolding,
  RunOutput,
  RunOutputError,
  readRunOutput,
} from "~/lib/state/output";
import { BackgroundRuns } from "~/workspace/background-runs";
import { cliArgs } from "./helpers/cli";
import { testEngine } from "./helpers/engine";
import { testHome } from "./helpers/home";

it("replays existing output, follows live text, and waits for completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-watch-"));
  const output = new RunOutput(
    join(root, "workspace"),
    "rn-test",
    "greet",
    () => undefined
  );
  output.text("earlier ");
  let text = "";
  const watching = watchRun(root, "rn-test", {
    write: (chunk) => {
      text += chunk;
    },
  });
  try {
    await vi.waitFor(() => expect(text).toContain("earlier "));
    output.text("live 🌿");
    await vi.waitFor(() => expect(text).toContain("earlier live 🌿"));
    output.finish("completed", { greeting: "done" });
    expect(await watching).toBe("completed");
    expect(text).toContain("greeting: 'done'");
    expect(text).toContain("[run] rn-test completed");
  } finally {
    output.finish("cancelled");
    await watching;
    await rm(root, { force: true, recursive: true });
  }
});

it("uses real engine run IDs for agents and exposes their output to a separate CLI process", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-watch-agent-"));
  const home = testHome();
  const engine = testEngine({
    reply: () => "agent answer 🌿",
    state: join(home.layout.state, "workspace"),
  });
  const runs = new BackgroundRuns(engine, new Catalog());
  await engine.start();
  try {
    const started = await runs.start({ prompt: "Answer" });
    expect((await engine.runs()).some((run) => run.id === started.runId)).toBe(
      true
    );
    await vi.waitFor(async () =>
      expect((await runs.get(started.runId)).status).toBe("completed")
    );
    const stdout = execFileSync(
      "bun",
      cliArgs("watch", started.runId, "--source", join(root, "missing.ts")),
      {
        cwd: tmpdir(),
        encoding: "utf8",
        env: home.env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      }
    );
    expect(stdout).toContain("agent answer 🌿");
    expect(stdout).toContain(`[run] ${started.runId} completed`);
  } finally {
    await runs.close();
    await engine.dispose();
    await rm(root, { force: true, recursive: true });
  }
}, 20_000);

it("records workflow stream output including the last chunk before completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-watch-workflow-"));
  const engine = testEngine({ state: join(root, "workspace") });
  engine.define({
    fn: ({ stream }) => {
      for (let index = 0; index < 100; index += 1) {
        stream.write(`${index},`);
      }
      stream.write("last chunk 🌿");
      return "done";
    },
    kind: "step",
    name: "burst",
  });
  const runs = new BackgroundRuns(engine, new Catalog());
  await engine.start();
  try {
    const started = await runs.startWorkflow("burst", {});
    let text = "";
    expect(
      await watchRun(root, started.runId, {
        write: (chunk) => {
          text += chunk;
        },
      })
    ).toBe("completed");
    expect(text).toContain("0,1,2,");
    expect(text).toContain("98,99,last chunk 🌿");
    await vi.waitFor(() =>
      expect(engine.executions.get(started.runId)?.status).toBe("complete")
    );
    expect(engine.executions.get(started.runId)?.progress).toMatchObject({
      event: "step.complete",
      step: "burst",
    });
  } finally {
    await runs.close();
    await engine.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

it.each(["failed", "cancelled"] as const)(
  "keeps watched output and durable execution status aligned when a workflow is %s",
  async (status) => {
    const root = await mkdtemp(join(tmpdir(), "marbles-watch-terminal-"));
    const engine = testEngine({ state: join(root, "workspace") });
    const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
    engine.define({
      fn: async ({ signal, stream }) => {
        stream.write("before ending");
        enter();
        if (status === "cancelled") {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          signal.throwIfAborted();
        }
        throw new Error("workflow failed");
      },
      kind: "step",
      name: "ending",
    });
    await engine.start();
    try {
      const launched = await engine.launch("ending", {});
      const result = launched.result.catch(() => undefined);
      await entered;
      if (status === "cancelled") {
        await engine.cancel(launched.id);
      }
      await result;
      let text = "";
      expect(
        await watchRun(root, launched.id, {
          write: (chunk) => {
            text += chunk;
          },
        })
      ).toBe(status);
      expect(text).toContain("before ending");
      expect(engine.executions.get(launched.id)?.status).toBe(status);
    } finally {
      await engine.dispose();
      await rm(root, { force: true, recursive: true });
    }
  }
);

it("can stop watching without cancelling the run, and rejects unknown IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-watch-interrupt-"));
  const output = new RunOutput(
    join(root, "workspace"),
    "rn-test",
    "waiting",
    () => undefined
  );
  const controller = new AbortController();
  const watching = watchRun(root, "rn-test", {
    signal: controller.signal,
    write: () => undefined,
  });
  try {
    controller.abort();
    await expect(watching).rejects.toThrow();
    output.finish("completed", "still finished");
    expect(await watchRun(root, "rn-test", { write: () => undefined })).toBe(
      "completed"
    );
    await expect(
      watchRun(root, "unknown", { write: () => undefined })
    ).rejects.toThrow("no saved output");
    await expect(
      watchRun(root, "../escape", { write: () => undefined })
    ).rejects.toThrow("invalid run ID");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("reports an owner that disappeared without a terminal record", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-watch-lost-"));
  await mkdir(join(root, "workspace", "output"), { recursive: true });
  try {
    await writeFile(
      join(root, "workspace", "output", "rn-test.jsonl"),
      `${JSON.stringify({ name: "waiting", pid: 2_147_483_647, runId: "rn-test", type: "start" })}\n`
    );
    await expect(
      watchRun(root, "rn-test", { write: () => undefined })
    ).rejects.toThrow("lost its owner");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it("classifies corrupt journal data as a runtime output error", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-watch-corrupt-"));
  await mkdir(join(root, "workspace", "output"), { recursive: true });
  try {
    await writeFile(
      join(root, "workspace", "output", "rn-test.jsonl"),
      "{broken}\n"
    );
    await expect(
      watchRun(root, "rn-test", { write: () => undefined })
    ).rejects.toBeInstanceOf(RunOutputError);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

const GONE = { pid: 2_147_483_647, started: null } as const;

function journal(root: string): string {
  return join(root, "workspace", "output", "rn-test.jsonl");
}

function startLine(owner: { pid: number; started: string | null }): string {
  return `${JSON.stringify({ name: "held", runId: "rn-test", type: "start", ...owner })}\n`;
}

async function storedRun(
  root: string,
  record: Pick<ExecutionRun, "owner" | "status"> & Partial<ExecutionRun>
) {
  const opened = await initializeDatabase(stateDatabase(root));
  await new DatabaseExecutionStore({
    database: opened.database,
    scope: "workspace",
  }).create({
    correlation: {},
    id: "rn-test",
    kind: "workflow",
    name: "held",
    observations: [],
    queue: "marbles",
    revision: 1,
    sequence: 1,
    timestamps: {
      queuedAt: "2026-11-01T09:00:00.000Z",
      updatedAt: "2026-11-01T09:00:00.000Z",
    },
    ...record,
  });
  return opened;
}

it.each([
  ["an empty journal", ""],
  ["a torn first record", '{"name":"held","pid":1'],
])(
  "fails on %s whose writer stopped before its start record",
  async (_, content) => {
    const root = await mkdtemp(join(tmpdir(), "marbles-watch-no-start-"));
    await mkdir(join(root, "workspace", "output"), { recursive: true });
    try {
      await writeFile(journal(root), content);
      await expect(
        watchRun(root, "rn-test", { write: () => undefined })
      ).rejects.toThrow("no readable start record");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
  10_000
);

it("keeps following a suspended run handed over until its adopter writes its ending", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-watch-handover-"));
  await mkdir(join(root, "workspace", "output"), { recursive: true });
  const opened = await storedRun(root, { owner: GONE, status: "suspended" });
  try {
    await writeFile(journal(root), startLine(GONE));
    let text = "";
    let failure: unknown;
    const watching = watchRun(root, "rn-test", {
      write: (chunk) => {
        text += chunk;
      },
    }).catch((error: unknown) => {
      failure = error;
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(failure).toBeUndefined();
    const adopter = new RunOutput(
      join(root, "workspace"),
      "rn-test",
      "held",
      () => undefined
    );
    adopter.text("answered");
    adopter.finish("completed", "done");
    expect(await watching).toBe("completed");
    expect(text.match(/held running/g)).toHaveLength(2);
    expect(text).toContain("answered");
  } finally {
    opened.close();
    await rm(root, { force: true, recursive: true });
  }
}, 10_000);

it("keeps following a run whose record names a live owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-watch-live-record-"));
  await mkdir(join(root, "workspace", "output"), { recursive: true });
  const opened = await storedRun(root, {
    owner: thisProcess(),
    status: "running",
  });
  try {
    await writeFile(journal(root), startLine(GONE));
    let failure: unknown;
    const watching = watchRun(root, "rn-test", {
      write: () => undefined,
    }).catch((error: unknown) => {
      failure = error;
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(failure).toBeUndefined();
    await appendFile(
      journal(root),
      `${JSON.stringify({ status: "completed", type: "end" })}\n`
    );
    expect(await watching).toBe("completed");
  } finally {
    opened.close();
    await rm(root, { force: true, recursive: true });
  }
}, 10_000);

it("finishes with the stored status of a run that settled without a journal ending", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-watch-settled-"));
  await mkdir(join(root, "workspace", "output"), { recursive: true });
  const opened = await storedRun(root, {
    error: { code: "workflow_failed", message: "it broke" },
    owner: GONE,
    status: "failed",
  });
  try {
    await writeFile(journal(root), startLine(GONE));
    let text = "";
    expect(
      await watchRun(root, "rn-test", {
        write: (chunk) => {
          text += chunk;
        },
      })
    ).toBe("failed");
    expect(text).toContain("it broke");
    expect(text).toContain("[run] rn-test failed");
  } finally {
    opened.close();
    await rm(root, { force: true, recursive: true });
  }
});

it.each(["running", "interrupted"] as const)(
  "reports a lost owner when the stored record is %s under a gone owner",
  async (status) => {
    const root = await mkdtemp(join(tmpdir(), "marbles-watch-abandoned-"));
    await mkdir(join(root, "workspace", "output"), { recursive: true });
    const opened = await storedRun(root, { owner: GONE, status });
    try {
      await writeFile(journal(root), startLine(GONE));
      await expect(
        watchRun(root, "rn-test", { write: () => undefined })
      ).rejects.toThrow("lost its owner");
    } finally {
      opened.close();
      await rm(root, { force: true, recursive: true });
    }
  }
);

it("reads what the adopter appended while the stored record was read before using the stored ending", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-watch-settling-"));
  await mkdir(join(root, "workspace", "output"), { recursive: true });
  try {
    await writeFile(journal(root), startLine(GONE));
    const holder = (): Promise<RunHolding> => {
      const adopter = new RunOutput(
        join(root, "workspace"),
        "rn-test",
        "held",
        () => undefined
      );
      adopter.text("final text");
      adopter.finish("completed", "the result");
      return Promise.resolve({
        end: { status: "completed", type: "end" },
        kind: "settled",
      });
    };
    const records: OutputRecord[] = [];
    for await (const record of readRunOutput(
      root,
      "rn-test",
      undefined,
      holder
    )) {
      records.push(record);
    }
    expect(records.map((record) => record.type)).toEqual([
      "start",
      "start",
      "text",
      "end",
    ]);
    expect(records.at(-1)).toMatchObject({ output: "the result" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
