import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Artifacts } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";
import { afterEach, expect, it } from "vitest";
import { CrashRecovery } from "~/lib/crash-recovery";
import { HarnessActivities } from "~/lib/sandbox/activities";
import { testEngine } from "../helpers/engine";

const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

it("removes, at start, an artifact file no record names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crash-artifacts-"));
  made.push(dir);
  const stray = join(dir, randomUUID());
  writeFileSync(stray, "bytes no record names");
  const engine = testEngine({
    artifacts: new Artifacts({
      files: blobFiles(dir),
      store: new MemoryArtifactStore(),
    }),
  });
  await engine.start();
  try {
    expect(existsSync(stray)).toBe(false);
  } finally {
    await engine.dispose();
  }
});

it("reports a part that fails and goes on to the next", async () => {
  const lines: string[] = [];
  const activities = new HarnessActivities();
  const recovery = new CrashRecovery({
    activities: {
      closeOut: (ended) => {
        lines.push(`ended: ${String(ended("gone"))}`);
        return activities.closeOut(ended);
      },
    } as HarnessActivities,
    artifacts: { recover: () => Promise.reject(new Error("disk is gone")) },
    containers: () => Promise.reject(new Error("never opened")),
    executions: () => [],
    print: (line) => lines.push(line),
  });
  const { report } = await recovery.recover(() => Promise.resolve([]));
  expect(lines).toEqual([
    "ended: true",
    "[recovery] artifacts: failed, Error: disk is gone",
  ]);
  expect(report.steps).toEqual([
    {
      detail: "no recovery records kept here",
      outcome: "skipped",
      step: "processes",
    },
    {
      detail: "no container holders kept here",
      outcome: "skipped",
      step: "containers",
    },
    { detail: "0 run(s) closed out", outcome: "done", step: "runs" },
    {
      detail: "0 harness activity(ies) closed out",
      outcome: "done",
      step: "activities",
    },
    { detail: "Error: disk is gone", outcome: "failed", step: "artifacts" },
  ]);
});
