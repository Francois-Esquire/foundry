import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { DatabaseDeferredApprovalStore } from "~/database/approvals";
import { initializeDatabase, writeDatabase } from "~/database/open";
import { DeferredApprovals } from "~/lib/sandbox/deferred-approvals";

const source = { definition: "review", path: ["review"], runId: "run" };
const SRC = resolve("src");

/** A Marbles database of the test's own, kept open by it as a host keeps one. */
async function database() {
  const directory = await mkdtemp(join(tmpdir(), "marbles-approvals-"));
  const file = join(directory, "marbles.db");
  const opened = await initializeDatabase(file);
  onTestFinished(async () => {
    opened.close();
    await rm(directory, { force: true, recursive: true });
  });
  return { file, opened };
}

it("overlapping approval indexes preserve sessions, additions, and removals", async () => {
  const { opened } = await database();
  const approvals = () =>
    new DeferredApprovals(
      new DatabaseDeferredApprovalStore({
        database: opened.database,
        scope: "ws",
      })
    );
  const first = approvals();
  const second = approvals();
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
  const saved = await approvals().load();
  expect(saved.sessions.map((item) => item.sessionId).sort()).toEqual([
    "a",
    "b",
  ]);
  expect(saved.requests.map((item) => item.approvalId).sort()).toEqual([
    "approval-b",
    "approval-c",
  ]);
  expect(await first.load()).toEqual(saved);
  // Another workspace's are its own.
  const elsewhere = new DeferredApprovals(
    new DatabaseDeferredApprovalStore({
      database: opened.database,
      scope: "other",
    })
  );
  expect(await elsewhere.load()).toEqual({ requests: [], sessions: [] });
});

it("separate processes merge approval edits in the database's transactions", async () => {
  const { file } = await database();
  const execute = promisify(execFile);
  await Promise.all(
    ["a", "b", "c"].map(async (agentId) => {
      const script = `
        import { DatabaseDeferredApprovalStore } from ${JSON.stringify(join(SRC, "database/approvals.ts"))};
        import { writeDatabase } from ${JSON.stringify(join(SRC, "database/open.ts"))};
        import { DeferredApprovals } from ${JSON.stringify(join(SRC, "lib/sandbox/deferred-approvals.ts"))};
        await writeDatabase(${JSON.stringify(file)}, async (database) => {
          const store = new DeferredApprovals(new DatabaseDeferredApprovalStore({ database, scope: "ws" }));
          const session = { agentId: ${JSON.stringify(agentId)}, sessionId: ${JSON.stringify(agentId)}, source: ${JSON.stringify(source)} };
          await store.load();
          await store.register(session);
          for (let i = 0; i < 8; i += 1) {
            await store.put({ ...session, approvalId: session.agentId + i });
          }
        });
      `;
      await execute("bun", ["--eval", script], { cwd: resolve(".") });
    })
  );
  const saved = await writeDatabase(file, (handle) =>
    new DeferredApprovals(
      new DatabaseDeferredApprovalStore({ database: handle, scope: "ws" })
    ).load()
  );
  expect(saved?.sessions.map((session) => session.sessionId).sort()).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(new Set(saved?.requests.map((record) => record.approvalId)).size).toBe(
    24
  );
});
