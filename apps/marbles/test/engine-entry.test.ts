import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Tasks } from "@foundry/tasks";
import { afterEach, describe, expect, it } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import { fileIdentity, queuedFiles } from "~/database/client";
import { openWorkspaceRecords } from "~/database/managed";
import { Engine } from "~/entries/engine";
import { Engine as LibEntryEngine } from "~/entries/lib";
import { stateDatabase } from "~/layout";
import { MemoryWorkspaceRecords } from "~/lib/events/records";
import { workspaceState } from "~/lib/state/workspace";
import { claimProcess, readProcess } from "~/process/instance";
import { testInstances } from "./helpers/engine";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "marbles-entry-"));
  roots.push(root);
  return root;
}

/** An engine of the published class over `state`, as an embedder builds one. */
function published(
  state: string | undefined,
  workspaceId: string,
  extra: Partial<ConstructorParameters<typeof Engine>[0]> = {}
): Engine {
  const root = extra.root ?? scratch();
  return new Engine({
    ...testInstances({ root }),
    root,
    workspaceId,
    ...(state === undefined ? {} : { state }),
    ...extra,
  });
}

/** Create a task through one engine, dispose it, and read it through a new one. */
async function across(
  make: () => Engine
): Promise<{ readonly id: string; readonly read: string | undefined }> {
  const first = make();
  const { id } = await new Tasks({ store: first.taskStore }).create({
    title: "Kept",
  });
  await first.dispose();
  const second = make();
  try {
    const read = (await new Tasks({ store: second.taskStore }).get(id))?.title;
    return { id, read };
  } finally {
    await second.dispose();
  }
}

describe("the published Engine", () => {
  it("keeps the tasks of an engine given a state dir of its own in that dir's database", async () => {
    const state = join(scratch(), "app-state");
    const { read } = await across(() => published(state, "my-app"));
    expect(read).toBe("Kept");
    expect(existsSync(stateDatabase(state))).toBe(true);
  });

  it("keeps the tasks of an engine over a Marbles workspace dir in its state root's database, the CLI's", async () => {
    const stateRoot = join(scratch(), "marbles");
    const workspace = workspaceState(stateRoot, scratch());
    mkdirSync(workspace.dir, { recursive: true });
    const { read } = await across(() =>
      published(workspace.dir, workspace.id, { root: workspace.root })
    );
    expect(read).toBe("Kept");
    expect(existsSync(stateDatabase(stateRoot))).toBe(true);
    expect(existsSync(stateDatabase(workspace.dir))).toBe(false);
  });

  it("is the class the lib entry publishes too", async () => {
    expect(LibEntryEngine).toBe(Engine);
    const state = join(scratch(), "lib-state");
    const make = () => {
      const root = scratch();
      return new LibEntryEngine({
        ...testInstances({ root }),
        root,
        state,
        workspaceId: "lib-app",
      });
    };
    expect((await across(make)).read).toBe("Kept");
  });

  it("closes the database it opened when it is disposed", async () => {
    const state = join(scratch(), "closing");
    const engine = published(state, "closing");
    await new Tasks({ store: engine.taskStore }).create({ title: "Open" });
    const identity = fileIdentity(stateDatabase(state));
    expect(queuedFiles()).toContain(identity);
    await engine.dispose();
    expect(queuedFiles()).not.toContain(identity);
  });

  it("keeps its own database for a state dir merely named like its workspace id", async () => {
    const state = join(scratch(), "same-name");
    const { read } = await across(() => published(state, "same-name"));
    expect(read).toBe("Kept");
    expect(existsSync(stateDatabase(state))).toBe(true);
  });

  it("keeps tasks in memory when told to, or with no state", async () => {
    const state = join(scratch(), "memory");
    expect(
      (
        await across(() =>
          published(state, "memory", {
            records: new MemoryWorkspaceRecords(),
          })
        )
      ).read
    ).toBeUndefined();
    expect(existsSync(stateDatabase(state))).toBe(false);
    expect(
      (await across(() => published(undefined, "none"))).read
    ).toBeUndefined();
  });

  it("takes the records a host opens for a state root and workspace id", async () => {
    const stateRoot = join(scratch(), "host-root");
    const make = () =>
      published(undefined, "hosted", {
        records: openWorkspaceRecords({
          state: stateRoot,
          workspaceId: "hosted",
        }),
      });
    expect((await across(make)).read).toBe("Kept");
    expect(existsSync(stateDatabase(stateRoot))).toBe(true);
  });

  it("keeps its tasks while the host holds its state dir's claim, as the docs say to", async () => {
    const state = join(scratch(), "claimed");
    const claim = claimProcess(state, { config: null, host: "worker" });
    try {
      const started = Date.now();
      const { read } = await across(() => published(state, "claimed"));
      expect(read).toBe("Kept");
      // Its own lock: nothing waited for another process to make the database.
      expect(Date.now() - started).toBeLessThan(4000);
      expect(readProcess(state)?.pid).toBe(process.pid);
    } finally {
      claim.release();
    }
  });

  it("is the class a hosted workspace's engine is built from", async () => {
    const engine = createEngine({
      catalog: new Catalog(),
      dry: true,
      print: () => undefined,
      root: scratch(),
      workspaceId: "hosted-class",
    });
    try {
      expect(engine).toBeInstanceOf(Engine);
      expect(engine).toBeInstanceOf(LibEntryEngine);
    } finally {
      await engine.dispose();
    }
  });
});
