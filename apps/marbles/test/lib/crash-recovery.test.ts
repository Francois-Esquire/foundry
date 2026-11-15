import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { InMemoryArtifactStore } from "@foundry/artifacts/store/memory";
import { afterEach, expect, it } from "vitest";
import { CrashRecovery } from "~/lib/crash-recovery";
import { MemoryRunStore } from "~/lib/run-store";
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
  // What a process that published bytes and died before its commit left.
  const stray = join(dir, randomUUID());
  writeFileSync(stray, "bytes no record names");
  const engine = testEngine({
    artifacts: new ArtifactManager({
      files: blobFiles(dir),
      store: new InMemoryArtifactStore(),
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
    executions: () => [],
    print: (line) => lines.push(line),
    runs: new MemoryRunStore(),
  });
  await recovery.recover({
    abandonRun: () => Promise.reject(new Error("never asked")),
    listRuns: () => Promise.reject(new Error("never asked")),
  });
  expect(lines).toEqual([
    "ended: true",
    "[recovery] artifacts not recovered: Error: disk is gone",
  ]);
});
