/**
 * A host whose usage cannot be read still snapshots its runs, Logs and Feed,
 * and says every usage total may be incomplete instead of showing nothing.
 * Source loads through `openWorkspace` (a Bun plugin), so each host runs in
 * its own `bun` process, as in `host-tasks.test.ts`.
 */

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const SRC = resolve("src");
const HOST_TIMEOUT = 60_000;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

/** Runs `body` with a host over `root`'s workspace in scope; resolves its JSON report. */
async function inHost(
  root: string,
  body: string
): Promise<Record<string, unknown>> {
  const script = join(root, `host-${String(Date.now())}.ts`);
  await writeFile(
    script,
    `import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostWorkspace } from ${JSON.stringify(join(SRC, "workspace/host.ts"))};
const report = {};
const state = ${JSON.stringify(join(root, "state"))};
const host = await hostWorkspace({
  artifacts: ${JSON.stringify(join(root, "artifacts"))},
  only: [],
  prepare(engine) {
    const read = engine.readUsage.bind(engine);
    engine.readUsage = () =>
      globalThis.usageDown ? Promise.reject(new Error("transcripts down")) : read();
  },
  source: ${JSON.stringify(join(root, "workspace", "marbles.ts"))},
  state,
});
/** What a snapshot shows of runs, Logs, Feed and every usage total. */
const shown = (snapshot) => {
  const run = snapshot.runs[0];
  return {
    feed: Array.isArray(snapshot.feed),
    outsideRuns: snapshot.usage?.outsideRuns,
    run: run && { id: run.id, status: run.status, usage: run.usage },
    step: run?.steps[0]?.usage,
    total: snapshot.usage?.total,
    unreadable: snapshot.usage?.unreadable,
    usageLines: (snapshot.diagnostics ?? [])
      .filter((entry) => entry.message.startsWith("[usage]"))
      .map((entry) => [entry.level, entry.message]),
    workflow: snapshot.usage?.byWorkflow.find((group) => group.id === "plain")?.total,
  };
};
${body}
await host.close();
process.stdout.write(JSON.stringify(report) + "\\n");
process.exit(0);
`
  );
  const output = execFileSync("bun", [script], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: HOST_TIMEOUT,
  });
  const line = output.trim().split("\n").at(-1) ?? "{}";
  return JSON.parse(line);
}

it(
  "a usage read that fails leaves runs, Logs and Feed in the snapshot, and qualifies every usage total instead of reading as none",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "marbles-host-usage-"));
    roots.push(root);
    await mkdir(join(root, "workspace"), { recursive: true });
    await writeFile(
      join(root, "workspace", "marbles.ts"),
      `import { step } from "@foundry.sh/marbles";
step("plain").do(() => 1);
`
    );

    const first = await inHost(
      root,
      `const launched = await host.engine.launch("plain", {});
await launched.result;
// A saved turn for the run, as the agents manager records one.
host.engine.usage.record({
  agentId: "reviewer",
  completedAt: Date.now(),
  cost: { amount: 0.5, currency: "USD", kind: "reported", reference: "provider" },
  definitionId: "plain",
  path: ["plain"],
  runId: launched.id,
  scope: "run",
  sessionId: "s",
  tokens: { input: 10, output: 5, total: 15 },
  turnId: "t1",
  version: 1,
  workspaceId: host.id,
});
report.healthy = shown(await host.snapshot());
globalThis.usageDown = true;
await host.snapshot();
report.recoveryDown = shown(await host.snapshot());
globalThis.usageDown = false;
await host.snapshot();
// Failing again after a read succeeded: logged again.
globalThis.usageDown = true;
report.downAgain = shown(await host.snapshot());
globalThis.usageDown = false;
// The usage collection's directory replaced by a file: listing it fails.
const usage = join(state, host.id, "usage");
rmSync(usage, { force: true, recursive: true });
writeFileSync(usage, "not a directory");
report.listingDown = shown(await host.snapshot());`
    );

    const healthy = first.healthy as Record<string, any>;
    expect(healthy.run.status).toBe("complete");
    // Session `s` has no transcript to check: an unowned unreadable record.
    expect(healthy.run.usage).toMatchObject({ turns: 1, unreadable: 1 });
    expect(healthy.usageLines).toEqual([]);

    // Recovery fails: the saved fact stays, and every total says it may be incomplete.
    const recoveryDown = first.recoveryDown as Record<string, any>;
    expect(recoveryDown.run).toMatchObject({
      id: healthy.run.id,
      status: "complete",
      usage: { reported: [{ amount: 0.5, currency: "USD" }], turns: 1 },
    });
    expect(recoveryDown.feed).toBe(true);
    expect(recoveryDown.unreadable).toBe(1);
    for (const total of [
      recoveryDown.run.usage,
      recoveryDown.step.inclusive,
      recoveryDown.workflow,
      recoveryDown.outsideRuns,
      recoveryDown.total,
    ]) {
      expect(total.unreadable).toBe(1);
    }
    // Two failing polls, one line in Logs.
    expect(recoveryDown.usageLines).toEqual([
      ["error", "[usage] could not be read: Error: transcripts down"],
    ]);

    expect((first.downAgain as Record<string, any>).usageLines).toHaveLength(2);

    // Nothing can be listed: no facts, yet no total reads as none or zero.
    const listingDown = first.listingDown as Record<string, any>;
    expect(listingDown.run.id).toBe(healthy.run.id);
    expect(listingDown.unreadable).toBe(1);
    for (const total of [
      listingDown.run.usage,
      listingDown.step.inclusive,
      listingDown.workflow,
      listingDown.outsideRuns,
      listingDown.total,
    ]) {
      expect(total).toMatchObject({ turns: 0, unreadable: 1 });
    }
    expect(listingDown.usageLines).toHaveLength(3);

    // A new host over the corrupted state: its first snapshot still renders.
    const second = await inHost(
      root,
      "report.firstFrame = shown(await host.snapshot());"
    );
    const firstFrame = second.firstFrame as Record<string, any>;
    expect(firstFrame.run).toMatchObject({
      id: healthy.run.id,
      status: "complete",
      usage: { turns: 0, unreadable: 1 },
    });
    expect(firstFrame.workflow).toMatchObject({ turns: 0, unreadable: 1 });
    expect(firstFrame.usageLines).toHaveLength(1);
  },
  HOST_TIMEOUT * 2
);
