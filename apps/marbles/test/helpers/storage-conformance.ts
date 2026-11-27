import { Tasks } from "@foundry/tasks";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { type MarblesStorage, resourceRefKey } from "~/storage/ports";

export function defineStorageConformanceTests(
  name: string,
  createStorage: () => Promise<{
    readonly storage: MarblesStorage;
    readonly cleanup?: () => Promise<void> | void;
  }>
): void {
  describe(`${name} storage conformance`, () => {
    const cleanups: (() => Promise<void> | void)[] = [];
    afterEach(async () => {
      for (const cleanup of cleanups.splice(0).reverse()) {
        await cleanup();
      }
    });
    async function open(): Promise<MarblesStorage> {
      const { storage, cleanup } = await createStorage();
      cleanups.push(async () => {
        try {
          await storage.close?.();
        } finally {
          await cleanup?.();
        }
      });
      for (const id of ["b", "a"]) {
        await storage.workspaces.touch({ id, root: `/workspace/${id}` }, null, {
          hosted: true,
        });
      }
      return storage;
    }
    it("registers, updates, sorts and unhosts workspaces", async () => {
      const storage = await open();
      const first = await storage.workspaces.get("a");
      expect(first).toMatchObject({
        cwd: "/workspace/a",
        hosted: true,
        id: "a",
      });
      expect(
        (await storage.workspaces.list()).map((record) => record.id)
      ).toEqual(["a", "b"]);
      await storage.workspaces.touch(
        { id: "a", root: "/workspace/a" },
        "config",
        { cwd: "/workspace/a/sub" }
      );
      expect(await storage.workspaces.get("a")).toMatchObject({
        config: "config",
        cwd: "/workspace/a/sub",
        firstSeen: first?.firstSeen,
        hosted: true,
      });
      expect(await storage.workspaces.unhost("a")).toBe(true);
      expect(await storage.workspaces.unhost("a")).toBe(false);
      expect(await storage.workspaces.get("missing")).toBeUndefined();
    });
    it("isolates domain tasks between workspaces", async () => {
      const storage = await open();
      const a = new Tasks({ store: (await storage.forWorkspace("a")).tasks });
      const b = new Tasks({ store: (await storage.forWorkspace("b")).tasks });
      const result = await a.change({
        operations: [
          { input: { title: "Work" }, key: "work", kind: "task.create" },
        ],
      });
      const [task] = result.tasks;
      expect(task).toBeDefined();
      expect((await a.list()).items).toHaveLength(1);
      expect(await a.get(task?.id ?? "")).toMatchObject({ title: "Work" });
      expect((await b.list()).items).toEqual([]);
      expect(await b.get(task?.id ?? "")).toBeNull();
    });
    it("lists artifacts and files and shares resource visibility", async () => {
      const storage = await open();
      const a = await storage.forWorkspace("a");
      const artifact = await a.artifacts.create({
        entries: { "hello.txt": { bytes: "hello" } },
        name: "file",
        type: "document",
      });
      const ref = { id: artifact.id, kind: "artifact" as const, owner: "a" };
      expect(
        (await storage.artifacts({ workspace: "a" })).map((item) => item.ref)
      ).toEqual([ref]);
      expect(await storage.artifacts({ workspace: "b" })).toEqual([]);
      expect(await storage.artifactFiles(ref)).toEqual([
        {
          blob: expect.toBeOneOf([null, expect.any(String)]),
          path: "hello.txt",
        },
      ]);
      await storage.share(ref, "b");
      await storage.share(ref, "b");
      expect(
        await storage.find({ workspace: "b" }, "artifact", artifact.id)
      ).toEqual([ref]);
      expect(
        await storage.find({ all: true }, "artifact", artifact.id)
      ).toEqual([ref]);
      expect(
        (await storage.artifacts({ workspace: "b" }))[0]?.workspaces
      ).toEqual(["a", "b"]);
      await storage.unshare(ref, "b");
      expect(
        await storage.find({ workspace: "b" }, "artifact", artifact.id)
      ).toEqual([]);
      expect(
        await storage.find({ workspace: "a" }, "artifact", artifact.id)
      ).toEqual([ref]);
      await expect(storage.share(ref, "a")).rejects.toThrow();
      await expect(storage.share(ref, "unregistered")).rejects.toThrow();
      await expect(
        storage.share({ id: "missing", kind: "artifact", owner: "a" }, "b")
      ).rejects.toThrow();
      await expect(
        storage.share({ id: "sb-1", kind: "sandbox", owner: "a" }, "b")
      ).rejects.toThrow();
    });
    it("lists sessions newest first and counts messages by resource key", async () => {
      const storage = await open();
      const a = await storage.forWorkspace("a");
      await a.sessions.commit({
        putMessages: [
          {
            createdAt: 1,
            id: "m1",
            parts: [],
            role: "summary",
            sessionId: "s1",
            status: "complete",
            updatedAt: 1,
          },
        ],
        putSessions: [1, 2].map((at) => ({
          createdAt: at,
          id: `s${at}`,
          parentMessageId: null,
          parentSessionId: null,
          status: "active",
          title: null,
          updatedAt: at,
        })),
      });
      expect(
        (await storage.sessions({ workspace: "a" })).map(
          (item) => item.value.id
        )
      ).toEqual(["s2", "s1"]);
      expect(await storage.sessions({ workspace: "b" })).toEqual([]);
      expect(await storage.sessions({ all: true })).toHaveLength(2);
      const ref = { id: "s1", kind: "session" as const, owner: "a" };
      expect(
        (await storage.messageTallies([ref])).get(resourceRefKey(ref))
      ).toEqual({ messages: 1, summarized: true });
      await storage.share(ref, "b");
      expect(await storage.sessions({ workspace: "b" })).toHaveLength(1);
      await storage.unshare(ref, "b");
      expect(await storage.sessions({ workspace: "b" })).toEqual([]);
    });
    it("lists sandboxes newest first within their workspace", async () => {
      const storage = await open();
      const a = await storage.forWorkspace("a");
      await a.containers.commit({
        putContainers: [1, 2].map((at) => ({
          createdAt: at,
          id: `box${at}`,
          nativeId: undefined,
          spec: "{}",
          status: "stopped",
          updatedAt: at,
        })),
      });
      expect(
        (await storage.sandboxes({ workspace: "a" })).map(
          (item) => item.value.id
        )
      ).toEqual(["box2", "box1"]);
      expect(await storage.sandboxes({ workspace: "b" })).toEqual([]);
      expect(await storage.sandboxes({ all: true })).toHaveLength(2);
    });
    it("projects queue runs newest first and limits each owner", async () => {
      const storage = await open();
      for (const owner of ["a", "b"]) {
        const stores = await storage.forWorkspace(owner);
        for (const at of [1, 2]) {
          const jobId = `jb-${owner}${at}` as const;
          await Effect.runPromise(
            stores.queue.commit({
              jobs: [
                {
                  createdAt: at,
                  handler: { name: "work" },
                  id: jobId,
                  input: null,
                  links: {},
                  policy: {},
                  pool: "default",
                  state: { kind: "pending" },
                },
              ],
              runs: [
                {
                  attempt: 1,
                  id: `rn-${owner}${at}`,
                  jobId,
                  pool: "default",
                  revision: 0,
                  state: { availableAt: at, kind: "queued", queuedAt: at },
                },
              ],
            })
          );
        }
      }
      expect(
        (await storage.runs({ workspace: "a" })).map(
          (item) => item.value.record.id
        )
      ).toEqual(["rn-a2", "rn-a1"]);
      expect(await storage.runs({ all: true })).toHaveLength(4);
      expect(await storage.runs({ all: true }, 1)).toHaveLength(2);
      expect(await storage.runs({ workspace: "a" }, 0)).toEqual([]);
      const ref = { id: "rn-a1", kind: "run" as const, owner: "a" };
      await storage.share(ref, "b");
      expect(await storage.find({ workspace: "b" }, "run", ref.id)).toEqual([
        ref,
      ]);
      await storage.unshare(ref, "b");
      expect(await storage.find({ workspace: "b" }, "run", ref.id)).toEqual([]);
    });
    it("appends, reads and removes independent run streams", async () => {
      const storage = await open();
      storage.output.append("one", { text: "hello", type: "text" });
      storage.output.append("one", { status: "completed", type: "end" });
      expect(storage.output.read("one")).toEqual([
        { text: "hello", type: "text" },
        { status: "completed", type: "end" },
      ]);
      expect(storage.output.read("two")).toEqual([]);
      storage.output.remove("one");
      expect(storage.output.read("one")).toEqual([]);
    });
  });
}
