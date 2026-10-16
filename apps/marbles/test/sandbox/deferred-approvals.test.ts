import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { DeferredApprovals } from "~/lib/sandbox/deferred-approvals";

const source = { definition: "review", path: ["review"], runId: "run" };

it("overlapping approval indexes preserve sessions, additions, and removals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marbles-approvals-"));
  try {
    const path = join(directory, "nested", "approvals.json");
    const first = new DeferredApprovals(path);
    const second = new DeferredApprovals(path);
    await Promise.all([first.load(), second.load()]);
    const a = { agentId: "a", sessionId: "a", source };
    const b = { agentId: "b", sessionId: "b", source };
    await Promise.all([first.register(a), second.register(b)]);
    await Promise.all([
      first.put({ ...a, approvalId: "approval-a" }),
      second.put({ ...b, approvalId: "approval-b" }),
    ]);
    await first.remove("approval-a");
    await second.put({ ...b, approvalId: "approval-c" });
    const saved = await new DeferredApprovals(path).load();
    expect(saved.sessions.map((item) => item.sessionId).sort()).toEqual([
      "a",
      "b",
    ]);
    expect(saved.requests.map((item) => item.approvalId).sort()).toEqual([
      "approval-b",
      "approval-c",
    ]);
    expect(await first.load()).toEqual(saved);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

it("separate processes merge approval edits under the shared file lock", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "marbles-approval-processes-")
  );
  const execute = promisify(execFile);
  try {
    const path = join(directory, "approvals.json");
    const modulePath = fileURLToPath(
      new URL("../../src/lib/sandbox/deferred-approvals.ts", import.meta.url)
    );
    await Promise.all(
      ["a", "b", "c"].map(async (agentId) => {
        const script = `
        import { DeferredApprovals } from ${JSON.stringify(modulePath)};
        const store = new DeferredApprovals(${JSON.stringify(path)});
        const session = { agentId: ${JSON.stringify(agentId)}, sessionId: ${JSON.stringify(agentId)}, source: ${JSON.stringify(source)} };
        await store.load();
        await store.register(session);
        for (let i = 0; i < 8; i += 1) {
          await store.put({ ...session, approvalId: session.agentId + i });
        }
      `;
        await execute("bun", ["--eval", script]);
      })
    );
    const saved = await new DeferredApprovals(path).load();
    expect(saved.sessions.map((session) => session.sessionId).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(
      new Set(saved.requests.map((record) => record.approvalId)).size
    ).toBe(24);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
