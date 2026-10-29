import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { RunOutput, RunOutputError } from "~/lib/state/output";
import { watchRun } from "~/watch";
import { BackgroundRuns } from "~/workspace/background-runs";
import { cliArgs } from "./helpers/cli";
import { testEngine } from "./helpers/engine";

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
  const engine = testEngine({
    reply: () => "agent answer 🌿",
    state: join(root, "workspace"),
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
      cliArgs(
        "watch",
        started.runId,
        "--state",
        root,
        "--source",
        join(root, "missing.ts")
      ),
      {
        cwd: tmpdir(),
        encoding: "utf8",
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
  } finally {
    await runs.close();
    await engine.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

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
