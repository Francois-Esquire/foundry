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
  WorkspaceExtension,
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
      attach: ({ capabilities, registration }) => ({
        capabilities: {
          label: `dir:${String(capabilities.root ?? registration.source.path)}`,
        },
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

  it("reuses the prevalidated composition when a change listener opens the workspace during load", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    let attaches = 0;
    let openedFromListener: Promise<unknown> | undefined;
    const system = directorySystem().extend({
      applies: () => true,
      attach: ({ registration }) => {
        attaches += 1;
        return {
          capabilities: { tag: registration.id },
          async start(workspace) {
            expect((await workspace.registration()).id).toBe(registration.id);
          },
        };
      },
      name: "observer",
    });
    system.on("change", ({ entry }) => {
      openedFromListener ??= system.open(entry.workspaceId);
    });

    const loaded = await system.load({ path: root });
    expect(await openedFromListener).toBe(loaded);
    expect(attaches).toBe(1);
    await system.closeAll();
  });

  it("finishes rollback and preserves startup error even when stop and onError both throw", async () => {
    const events: string[] = [];
    const system = new WorkspaceSystem({
      onError() {
        events.push("report");
        throw new Error("reporter boom");
      },
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
            throw new Error("stop boom");
          },
        }),
        name: "second",
      });

    await expect(system.load({ mem: "x" })).rejects.toThrow("start boom");
    expect(events).toEqual([
      "first:start",
      "second:start",
      "second:stop",
      "first:stop",
      "report",
    ]);
  });

  it("preserves symbol-keyed capabilities and rejects floor mismatch without restarting or poisoning open", async () => {
    const tag = Symbol("tag");
    const starts: string[] = [];
    interface Gate {
      readonly entered: ReturnType<typeof Promise.withResolvers<void>>;
      readonly release: ReturnType<typeof Promise.withResolvers<void>>;
    }
    let appliesGate: Gate | undefined;
    let stopGate: Gate | undefined;
    const store = new MemoryWorkspaceStore();
    type Deferred = ReturnType<typeof Promise.withResolvers<void>>;
    let findPathResolved: Deferred | undefined;
    let commitResolved: Deferred | undefined;
    let getWorkspaceGate: Gate | undefined;
    const baseFind = store.findWorkspaceByPath.bind(store);
    store.findWorkspaceByPath = async (path) => {
      const found = await baseFind(path);
      findPathResolved?.resolve();
      return found;
    };
    const baseGet = store.getWorkspace.bind(store);
    store.getWorkspace = async (id) => {
      const gate = getWorkspaceGate;
      if (gate) {
        getWorkspaceGate = undefined;
        gate.entered.resolve();
        await gate.release.promise;
      }
      return baseGet(id);
    };
    const baseTransaction = store.transaction.bind(store);
    store.transaction = async (work) => {
      const result = await baseTransaction(work);
      commitResolved?.resolve();
      return result;
    };
    const system = new WorkspaceSystem({ store })
      .extend({
        async applies(registration) {
          const gate = appliesGate;
          if (gate) {
            appliesGate = undefined;
            gate.entered.resolve();
            await gate.release.promise;
          }
          return registration.source.kind === "alpha";
        },
        attach: () => ({
          capabilities: { [tag]: "alpha-cap" },
          start() {
            starts.push("alpha");
          },
          async stop() {
            const gate = stopGate;
            if (gate) {
              stopGate = undefined;
              gate.entered.resolve();
              await gate.release.promise;
            }
          },
        }),
        identify: ({ alpha }: { readonly alpha: string }) => ({
          name: alpha,
          source: { kind: "alpha", path: `shared:${alpha}`, sourceId: null },
        }),
        name: "alpha",
        ref: "alpha",
        source: () => ({ scan: () => Promise.resolve([]) }),
      })
      .extend({
        applies: (registration) => registration.source.kind === "beta",
        identify: ({ beta }: { readonly beta: string }) => ({
          name: beta,
          source: { kind: "beta", path: `shared:${beta}`, sourceId: null },
        }),
        name: "beta",
        ref: "beta",
        source: () => ({ scan: () => Promise.resolve([]) }),
      });

    const first = await system.load({ alpha: "same" });
    expect(Reflect.get(first, tag)).toBe("alpha-cap");
    expect(starts).toEqual(["alpha"]);

    // 1. Gated wrong-floor load reaching source matching before concurrent open(id).
    await system.close(first.id);
    const firstGate: Gate = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    appliesGate = firstGate;
    const wrongFloor = system.load({ beta: "same" });
    await firstGate.entered.promise;
    const directOpen = system.open(first.id);
    firstGate.release.resolve();
    await expect(wrongFloor).rejects.toBeInstanceOf(
      WorkspaceSourceUnsupportedError
    );
    expect((await directOpen).id).toBe(first.id);
    expect(starts).toEqual(["alpha", "alpha"]);

    // 2. Wrong-floor load arriving while close() is paused must not restart alpha.
    const secondGate: Gate = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    stopGate = secondGate;
    const closing = system.close(first.id);
    await secondGate.entered.promise;
    const lookupDone = Promise.withResolvers<void>();
    findPathResolved = lookupDone;
    let settledDuringClose = false;
    const duringClose = system.load({ beta: "same" }).finally(() => {
      settledDuringClose = true;
    });
    await lookupDone.promise;
    findPathResolved = undefined;
    await Promise.resolve();
    expect(settledDuringClose).toBe(false);
    secondGate.release.resolve();
    await closing;
    await expect(duringClose).rejects.toBeInstanceOf(
      WorkspaceSourceUnsupportedError
    );
    expect(starts).toEqual(["alpha", "alpha"]);

    // 3. Removing a workspace while a cold same-floor load is paused in tracked opening
    //    must not fail remove() or revive the workspace.
    const openingGetGate: Gate = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    let getCalls = 0;
    const origGet = store.getWorkspace;
    store.getWorkspace = (id) => {
      getCalls += 1;
      if (getCalls === 2) {
        getWorkspaceGate = openingGetGate;
      }
      return origGet(id);
    };
    const racingLoad = system.load({ alpha: "same" });
    await openingGetGate.entered.promise;
    store.getWorkspace = origGet;
    const removalCommitted = Promise.withResolvers<void>();
    commitResolved = removalCommitted;
    const removing = first.remove();
    await removalCommitted.promise;
    commitResolved = undefined;
    openingGetGate.release.resolve();
    await expect(removing).resolves.toBeUndefined();
    await expect(racingLoad).rejects.toBeInstanceOf(WorkspaceNotFoundError);
    await expect(system.open(first.id)).rejects.toBeInstanceOf(
      WorkspaceNotFoundError
    );

    // 4. A synchronous start() hook that requests close(id) stops the workspace cleanly.
    let closeRequested: Promise<void> | undefined;
    let stopped = 0;
    const selfClosing = new WorkspaceSystem().extend({
      applies: () => true,
      attach: () => ({
        start(workspace) {
          closeRequested = selfClosing.close(workspace.id);
        },
        stop() {
          stopped += 1;
        },
      }),
      identify: ({ id }: { readonly id: string }) => ({
        name: id,
        source: { kind: "self", path: `self:${id}`, sourceId: null },
      }),
      name: "self",
      ref: "id",
      source: () => ({ scan: () => Promise.resolve([]) }),
    });
    const once = await selfClosing.load({ id: "one" });
    await closeRequested;
    expect(stopped).toBe(1);
    // Cold same-floor reload also honors synchronous close() from start().
    closeRequested = undefined;
    await selfClosing.load({ id: "one" });
    await closeRequested;
    expect(stopped).toBe(2);
    expect(once.id).toBeTruthy();

    const missingRequired: WorkspaceExtension<
      never,
      unknown,
      { readonly token: string }
    > = {
      applies: () => true,
      // @ts-expect-error -- required capability `token` must be returned by attach()
      attach: () => ({}),
      name: "missing-required",
    };
    const missingUnionCapabilities: WorkspaceExtension<
      never,
      unknown,
      { readonly alpha: string } | { readonly beta: number }
    > = {
      applies: () => true,
      // @ts-expect-error -- disjoint union of required capabilities must be returned by attach()
      attach: () => ({}),
      name: "missing-union-cap",
    };
    // @ts-expect-error -- disjoint union of required capabilities must declare attach()
    const missingUnionAttach: WorkspaceExtension<
      never,
      unknown,
      { readonly alpha: string } | { readonly beta: number }
    > = {
      applies: () => true,
      name: "missing-union-attach",
    };
    expect([
      missingRequired.name,
      missingUnionCapabilities.name,
      missingUnionAttach.name,
    ]).toHaveLength(3);
  });
});
