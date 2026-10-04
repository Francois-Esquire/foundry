import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HarnessActivityEvent,
  HarnessSession,
} from "@foundry/agents/harness";
import { afterEach, expect, it, vi } from "vitest";
import { HarnessActivities } from "~/lib/sandbox/activities";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});
const source = { definition: "review", path: ["review"], runId: "run-1" };
const event: HarnessActivityEvent = {
  actions: ["stop"],
  agentId: "reviewer",
  harness: "codex",
  id: "child-1",
  kind: "subagent",
  lifetime: "session",
  revision: 1,
  sessionId: "session-1",
  status: "running",
  title: "Review files",
};
function session(): HarnessSession {
  return {
    capabilities: { interruption: true, steering: false },
    close: vi.fn(async () => undefined),
    generate: async () => {
      throw new Error("unused");
    },
    interrupt: vi.fn(async () => undefined),
    route: { id: "test", provider: "test" },
    sessionId: "session-1",
    steer: async () => {
      throw new Error("unsupported");
    },
    stopActivity: vi.fn(async () => undefined),
    store: undefined,
    stream: () => {
      throw new Error("unused");
    },
  };
}
it("persists activity, ignores stale events, and revokes live controls after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "quirks-activities-"));
  roots.push(root);
  const host = new HarnessActivities({ state: root });
  host.attach(event.sessionId, session());
  await host.record(event, source);
  await host.record(
    { ...event, revision: 2, summary: "Checking tests" },
    source
  );
  await host.record({ ...event, revision: 1, status: "failed" }, source);
  expect(host.list()[0]?.event).toMatchObject({
    revision: 2,
    status: "running",
  });
  const restored = new HarnessActivities({ state: root });
  expect(restored.list()[0]?.event).toMatchObject({
    actions: [],
    revision: 2,
    status: "unknown",
  });
  await expect(restored.stop(event.sessionId, event.id)).rejects.toThrow(
    "cannot be stopped"
  );
  const reopened = session();
  restored.attach(event.sessionId, reopened);
  expect(restored.list()[0]?.event).toMatchObject({
    actions: [],
    status: "unknown",
  });
  await expect(restored.stop(event.sessionId, event.id)).rejects.toThrow(
    "cannot be stopped"
  );
  await restored.record({ ...event, id: "new-process-child" }, source);
  expect(
    restored.list().find((item) => item.event.id === "new-process-child")?.event
  ).toMatchObject({ actions: ["stop"], status: "running" });
  await restored.stop(event.sessionId, "new-process-child");
  expect(reopened.stopActivity).toHaveBeenCalledWith("new-process-child");
  await restored.record(
    { ...event, actions: [], revision: 3, status: "complete" },
    source
  );
  expect(restored.list()[0]?.event.status).toBe("complete");
});
it("stops only the selected live child and rejects stale actions after close", async () => {
  const host = new HarnessActivities();
  const child = session();
  host.attach(event.sessionId, child, event.id);
  await host.record(event, source);
  await host.stop(event.sessionId, event.id);
  expect(child.interrupt).toHaveBeenCalledOnce();
  await expect(host.stop(event.sessionId, "another-child")).rejects.toThrow();
  await child.close?.();
  expect(host.list()[0]?.event.status).toBe("unknown");
  await expect(host.stop(event.sessionId, event.id)).rejects.toThrow();
});
it("keeps identically named native children from separate sessions and runs distinct", async () => {
  const host = new HarnessActivities();
  await host.record(event, source);
  await host.record({ ...event, sessionId: "session-2" }, source);
  await host.record(event, { ...source, runId: "run-2" });
  expect(host.list()).toHaveLength(3);
});
