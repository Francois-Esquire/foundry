import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StorageSubscription } from "@foundry/core/storage";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidWorkspaceInputError,
  WorkspaceNotFoundError,
  WorkspaceSourceUnsupportedError,
} from "../errors";
import { directorySource } from "../node";
import { MemoryWorkspaceStore } from "../store/memory";
import { artifactWorkspace, seed } from "../testing/records";
import type {
  ObservedFacts,
  WorkspaceFile,
  WorkspaceSourceAdapter,
  WriteOutcome,
} from "../types";
import { WorkspaceSystem } from "../workspace-system";
import { directorySystem } from "./helpers/directory-system";
import { makeRoot } from "./helpers/temp-roots";

describe("remove", () => {
  it("deletes the rows and leaves every source File in place", async () => {
    const root = await makeRoot({ "README.md": "hi", "src/app.ts": "1" });
    const system = directorySystem();
    const added = await system.load({ path: root });

    await added.remove();

    expect((await system.list()).items).toEqual([]);
    await expect(system.open(added.id)).rejects.toBeInstanceOf(
      WorkspaceNotFoundError
    );
    expect(await readFile(join(root, "README.md"), "utf8")).toBe("hi");
    expect(await readFile(join(root, "src", "app.ts"), "utf8")).toBe("1");
  });

  it("removes a Workspace whose source is gone and reports a second removal", async () => {
    const root = await makeRoot({ "README.md": "hi" });
    const system = directorySystem();
    const added = await system.load({ path: root });
    await rm(root, { recursive: true });

    await added.remove();

    await expect(added.remove()).rejects.toBeInstanceOf(WorkspaceNotFoundError);
  });
});

describe("lifecycle", () => {
  it("opens one instance per id and shares it until closed", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const system = directorySystem();
    const added = await system.load({ path: root });

    expect(await system.open(added.id)).toBe(added);
    expect((await system.list()).items[0]).toBe(added);

    await system.close(added.id);
    const reopened = await system.open(added.id);
    expect(reopened).not.toBe(added);
    expect(reopened.id).toBe(added.id);
  });

  it("runs start once at open and stop once at close, through the chain", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const events: string[] = [];
    const system = directorySystem().extend({
      applies: () => true,
      attach: () => ({
        start() {
          events.push("start");
        },
        stop() {
          events.push("stop");
        },
      }),
      name: "probe",
    });

    const added = await system.load({ path: root });
    await system.open(added.id);
    expect(events).toEqual(["start"]);

    await system.closeAll();
    expect(events).toEqual(["start", "stop"]);
    expect(await system.open(added.id)).not.toBe(added);
  });

  it("evicts a removed Workspace so a later open refuses it", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const system = directorySystem();
    const added = await system.load({ path: root });

    await added.remove();

    await expect(system.open(added.id)).rejects.toBeInstanceOf(
      WorkspaceNotFoundError
    );
  });

  it("refuses a stored source no registered layer claims, by name", async () => {
    const store = new MemoryWorkspaceStore();
    const record = artifactWorkspace(
      crypto.randomUUID(),
      "foundry://abc.artifact"
    );
    await seed(store, record);
    const system = directorySystem({ store });

    await expect(system.open(record.id)).rejects.toThrow(
      new WorkspaceSourceUnsupportedError("artifact")
    );
    await expect(system.open(record.id)).rejects.toBeInstanceOf(
      WorkspaceSourceUnsupportedError
    );
  });

  it("composes layers in registration order and lets a later layer see the earlier one", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const system = directorySystem().extend({
      applies: (registration) => registration.source.kind === "host",
      attach: (workspace) => ({
        capabilities: { label: `dir:${workspace.source.path}` },
      }),
      name: "labelled",
    });

    const added = await system.load({ path: root });

    expect(added).toHaveProperty("label", `dir:${root}`);
    expect(added).toHaveProperty("root", root);
  });

  it("commits nothing when attach throws during load", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const store = new MemoryWorkspaceStore();
    const system = directorySystem({ store }).extend({
      applies: () => true,
      attach: () => {
        throw new Error("attach failed");
      },
      name: "broken-attach",
    });

    await expect(system.load({ path: root })).rejects.toThrow("attach failed");
    expect((await store.listWorkspaces()).items).toEqual([]);
  });

  it("rolls back partially started hooks and preserves the startup error", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const events: string[] = [];
    const reported: unknown[] = [];
    const store = new MemoryWorkspaceStore();
    const system = new WorkspaceSystem({
      onError: (error) => {
        reported.push(error);
      },
      store,
    })
      .extend({
        applies: () => true,
        identify: ({ mem }: { readonly mem: string }) => ({
          name: mem,
          source: { kind: "mem", path: `mem:${mem}`, sourceId: null },
        }),
        name: "mem",
        ref: "mem",
        source: () => ({ scan: () => Promise.resolve([]) }),
      })
      .extend({
        applies: () => true,
        attach: () => ({
          start() {
            events.push("first:start");
          },
          stop() {
            events.push("first:stop");
            throw new Error("cleanup boom");
          },
        }),
        name: "first",
      })
      .extend({
        applies: () => true,
        attach: () => ({
          start() {
            events.push("second:start");
            throw new Error("start boom");
          },
          stop() {
            events.push("second:stop");
          },
        }),
        name: "second",
      });

    await expect(system.load({ mem: root })).rejects.toThrow("start boom");
    expect(events).toEqual([
      "first:start",
      "second:start",
      "second:stop",
      "first:stop",
    ]);
    expect(reported.map((error) => (error as Error).message)).toEqual([
      "cleanup boom",
    ]);
  });

  it("rejects capability collisions with core Workspace members or earlier extensions", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const colliding = directorySystem().extend({
      applies: () => true,
      attach: () => ({ capabilities: { refresh: "nope" } }),
      name: "collider",
    });

    await expect(colliding.load({ path: root })).rejects.toBeInstanceOf(
      InvalidWorkspaceInputError
    );
  });

  it("preserves the adapter receiver on watch, writeFile, and insertFile", async () => {
    class StatefulAdapter implements WorkspaceSourceAdapter {
      readonly files = new Map<string, string>([["a.txt", "before"]]);
      watchCalls = 0;

      scan(): Promise<readonly ObservedFacts[]> {
        return Promise.resolve(
          [...this.files.entries()].map(([path, text]) => ({
            bytes: Buffer.byteLength(text),
            digest: "a".repeat(64),
            extension: ".txt",
            kind: "document" as const,
            mime: "text/plain",
            name: path,
            path,
            type: "file" as const,
          }))
        );
      }

      watch(): Promise<StorageSubscription> {
        this.watchCalls += 1;
        return Promise.resolve({ close: () => Promise.resolve() });
      }

      writeFile(
        target: WorkspaceFile,
        bytes: Uint8Array
      ): Promise<WriteOutcome> {
        this.files.set(target.path, new TextDecoder().decode(bytes));
        return Promise.resolve({ kind: "written" });
      }

      insertFile(path: string, bytes: Uint8Array): Promise<WriteOutcome> {
        this.files.set(path, new TextDecoder().decode(bytes));
        return Promise.resolve({ kind: "written" });
      }
    }

    const adapter = new StatefulAdapter();
    const system = new WorkspaceSystem().extend({
      applies: () => true,
      identify: ({ stateful }: { readonly stateful: string }) => ({
        name: stateful,
        source: {
          kind: "stateful",
          path: `stateful:${stateful}`,
          sourceId: null,
        },
      }),
      name: "stateful",
      ref: "stateful",
      source: () => adapter,
    });

    const workspace = await system.load({ stateful: "one" });
    expect(adapter.watchCalls).toBe(1);
    const [file] = await workspace.files();
    if (!file) {
      throw new Error("Expected file");
    }
    const saved = await workspace.save({
      expectedDigest: file.digest,
      fileId: file.id,
      text: "after",
    });
    expect(saved.kind).toBe("saved");
    const created = await workspace.createFile({
      path: "b.txt",
      text: "created",
    });
    expect(created.kind).toBe("saved");
    expect(adapter.files.get("a.txt")).toBe("after");
    expect(adapter.files.get("b.txt")).toBe("created");
    await system.closeAll();
  });

  it("rejects invalid paths passed directly to directorySource().insertFile", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const source = directorySource(root);
    const write = vi.spyOn(source, "insertFile");

    const outcome = await source.insertFile?.(
      "../escape.txt",
      new TextEncoder().encode("nope")
    );
    expect(write).toHaveBeenCalledOnce();
    expect(outcome).toEqual({
      kind: "failed",
      reason: "Invalid relative storage path",
    });
  });
});
