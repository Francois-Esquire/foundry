import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { StorageSubscription } from "@foundry/core/storage";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  InvalidWorkspaceInputError,
  WorkspaceNotFoundError,
  WorkspaceSourceUnsupportedError,
} from "../errors";
import { directory, directorySource } from "../node";
import { MemoryWorkspaceStore } from "../store/memory";
import { artifactWorkspace, seed } from "../testing/records";
import type {
  CapabilitiesOf,
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

  it("refuses a stored source no registered extension claims, by name", async () => {
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

  it("composes extensions in registration order and lets a later extension see earlier capabilities", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const system = directorySystem().extend({
      applies: (registration) => registration.source.kind === "host",
      attach: ({ capabilities }) => {
        if (typeof capabilities.root !== "string") {
          throw new Error("expected the directory root capability");
        }
        return { capabilities: { label: `dir:${capabilities.root}` } };
      },
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
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
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

  it("lets an async start hook close its own workspace without deadlocking", async () => {
    const events: string[] = [];
    let starts = 0;
    const system = new WorkspaceSystem()
      .extend(memExtension())
      .extend({
        applies: () => true,
        attach: () => ({
          async start(workspace) {
            events.push("closer:start");
            starts += 1;
            if (starts === 1) {
              await system.close(workspace.id);
            }
          },
          stop() {
            events.push("closer:stop");
          },
        }),
        name: "closer",
      })
      .extend({
        applies: () => true,
        attach: () => ({
          start() {
            events.push("later:start");
          },
          stop() {
            events.push("later:stop");
          },
        }),
        name: "later",
      });

    const first = await system.load({ mem: "one" });
    expect(events).toEqual(["closer:start", "closer:stop"]);

    const reopened = await system.open(first.id);
    expect(reopened).not.toBe(first);
    expect(events.slice(2)).toEqual(["closer:start", "later:start"]);

    await system.closeAll();
    expect(events.slice(4)).toEqual(["later:stop", "closer:stop"]);
  });

  it("lets an async start hook remove its own workspace without deadlocking", async () => {
    const store = new MemoryWorkspaceStore();
    let stopped = 0;
    const system = new WorkspaceSystem({ store })
      .extend(memExtension())
      .extend({
        applies: () => true,
        attach: () => ({
          async start(workspace) {
            await workspace.remove();
          },
          stop() {
            stopped += 1;
          },
        }),
        name: "remover",
      });

    const loaded = await system.load({ mem: "gone" });

    expect(stopped).toBe(1);
    expect((await store.listWorkspaces()).items).toEqual([]);
    await expect(system.open(loaded.id)).rejects.toBeInstanceOf(
      WorkspaceNotFoundError
    );
  });

  it("skips startup hooks when close arrives before start begins", async () => {
    let attachGate:
      | {
          readonly entered: ReturnType<typeof Promise.withResolvers<void>>;
          readonly release: ReturnType<typeof Promise.withResolvers<void>>;
        }
      | undefined;
    let starts = 0;
    const system = new WorkspaceSystem().extend(memExtension()).extend({
      applies: () => true,
      async attach() {
        const gate = attachGate;
        if (gate) {
          attachGate = undefined;
          gate.entered.resolve();
          await gate.release.promise;
        }
        return {
          async start(workspace) {
            starts += 1;
            await system.close(workspace.id);
          },
        };
      },
      name: "gated",
    });

    const first = await system.load({ mem: "pre-close" });
    expect(starts).toBe(1);

    const gate = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    attachGate = gate;
    const reopening = system.open(first.id);
    await gate.entered.promise;
    const closing = system.close(first.id);
    gate.release.resolve();

    await Promise.all([reopening, closing]);
    expect(starts).toBe(1);
  });

  it("attaches once when two cold loads race for the same closed workspace", async () => {
    let attaches = 0;
    const system = new WorkspaceSystem().extend(memExtension()).extend({
      applies: () => true,
      attach: () => {
        attaches += 1;
        return {};
      },
      name: "counter",
    });
    const first = await system.load({ mem: "same" });
    await system.close(first.id);
    attaches = 0;

    const [left, right] = await Promise.all([
      system.load({ mem: "same" }),
      system.load({ mem: "same" }),
    ]);

    expect(left).toBe(right);
    expect(attaches).toBe(1);
    await system.closeAll();
  });

  it("skips an extension that declares a ref it cannot identify", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const system = new WorkspaceSystem()
      .extend({ applies: () => true, name: "lifecycle-only", ref: "path" })
      .extend(directory());

    const loaded = await system.load({ path: root });

    expect(loaded.root).toBe(root);
    await system.closeAll();
  });

  it("rejects capabilities that are not a plain object", async () => {
    class Greeter {
      readonly greeting = "hi";

      greet(): string {
        return this.greeting;
      }
    }
    const system = new WorkspaceSystem().extend(memExtension()).extend({
      applies: () => true,
      attach: () => ({ capabilities: new Greeter() }),
      name: "classy",
    });

    await expect(system.load({ mem: "classy" })).rejects.toBeInstanceOf(
      InvalidWorkspaceInputError
    );
  });

  it("keeps one extension's capability union intact", () => {
    const either: WorkspaceExtension<
      never,
      unknown,
      { readonly alpha: string } | { readonly beta: number },
      true
    > = {
      applies: () => true,
      attach: () => ({ capabilities: { alpha: "a" } }),
      name: "either",
    };
    type Either = CapabilitiesOf<[typeof either]>;

    expectTypeOf<Either>().toEqualTypeOf<
      { readonly alpha: string } | { readonly beta: number }
    >();
    const accept = (capabilities: Either) => capabilities;
    const readAlpha = (capabilities: Either) =>
      // @ts-expect-error -- alpha exists on only one alternative
      capabilities.alpha;
    expect(accept({ alpha: "a" })).toEqual({ alpha: "a" });
    expect(readAlpha({ beta: 1 })).toBeUndefined();

    const other: WorkspaceExtension<
      never,
      unknown,
      { readonly gamma: boolean },
      true
    > = {
      applies: () => true,
      attach: () => ({ capabilities: { gamma: true } }),
      name: "other",
    };
    type Both = CapabilitiesOf<[typeof either, typeof other]>;
    const acceptBoth = (capabilities: Both) => capabilities.gamma;
    const readBothAlpha = (capabilities: Both) =>
      // @ts-expect-error -- alpha exists on only one alternative
      capabilities.alpha;
    // @ts-expect-error -- gamma is required alongside either alternative
    const missingGamma: Both = { alpha: "a" };
    expect(acceptBoth({ alpha: "a", gamma: true })).toBe(true);
    expect(readBothAlpha({ beta: 1, gamma: false })).toBeUndefined();
    expect(missingGamma).toEqual({ alpha: "a" });
  });

  it("types a conditional extension's capabilities as optional", async () => {
    const system = new WorkspaceSystem().extend(memExtension()).extend({
      applies: (registration) => registration.source.kind === "x",
      attach: () => ({
        capabilities: { token: "t" } as { readonly token: string },
      }),
      name: "conditional",
    });

    const loaded = await system.load({ mem: "plain" });
    const opened = await system.open(loaded.id);
    const [listed] = (await system.list()).items;
    if (!listed) {
      throw new Error("expected a listed workspace");
    }

    expectTypeOf(loaded.token).toEqualTypeOf<string | undefined>();
    expectTypeOf(opened.token).toEqualTypeOf<string | undefined>();
    expectTypeOf(listed.token).toEqualTypeOf<string | undefined>();
    expect(loaded.token).toBeUndefined();
    await system.closeAll();
  });

  it("names the unsupported operation when a source adapter omits file I/O", async () => {
    const system = new WorkspaceSystem().extend({
      applies: (registration) => registration.source.kind === "readonly-index",
      identify: ({ id }: { readonly id: string }) => ({
        name: id,
        source: { kind: "readonly-index", path: `idx:${id}`, sourceId: null },
      }),
      name: "readonly-index",
      ref: "id",
      source: () => ({
        scan: () =>
          Promise.resolve([
            {
              bytes: 2,
              digest: "0".repeat(64),
              extension: "md",
              kind: "document",
              mime: "text/markdown",
              name: "note.md",
              path: "note.md",
              type: "file",
            },
          ]),
      }),
    });

    const workspace = await system.load({ id: "one" });
    const [file] = await workspace.files();
    if (!file) {
      throw new Error("expected indexed file");
    }

    await expect(workspace.read(file.id)).rejects.toThrow(
      'Workspace source "readonly-index" does not support reading files'
    );
    await expect(
      workspace.save({
        expectedDigest: file.digest,
        fileId: file.id,
        text: "next",
      })
    ).rejects.toThrow(
      'Workspace source "readonly-index" does not support writing files'
    );
    await expect(
      workspace.createFile({ path: "fresh.md", text: "hi" })
    ).rejects.toThrow(
      'Workspace source "readonly-index" does not support creating files'
    );
  });
});

function memExtension() {
  return {
    applies: () => true,
    identify: ({ mem }: { readonly mem: string }) => ({
      name: mem,
      source: { kind: "mem", path: `mem:${mem}`, sourceId: null },
    }),
    name: "mem",
    ref: "mem",
    source: (): WorkspaceSourceAdapter => ({ scan: () => Promise.resolve([]) }),
  };
}
