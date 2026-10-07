import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorkspaceNotFoundError,
  WorkspaceSourceUnsupportedError,
} from "../errors";
import { MemoryWorkspaceStore } from "../memory-store";

import { directorySystem } from "./helpers/directory-system";
import { artifactWorkspace, seed } from "./helpers/fixtures";
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

/**
 * The system owns the instance lifecycle: one live instance per id, layers
 * composed at open, hooks run by the system alone.
 */
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
      name: "probe",
      wrap: (Base) =>
        class extends Base {
          protected override async start() {
            await super.start();
            events.push("start");
          }
          protected override async stop() {
            events.push("stop");
            await super.stop();
          }
        },
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
    // Nothing is cached for a failed open.
    await expect(system.open(record.id)).rejects.toBeInstanceOf(
      WorkspaceSourceUnsupportedError
    );
  });

  it("composes layers in registration order and lets a later layer see the earlier one", async () => {
    const root = await makeRoot({ "README.md": "hello" });
    const system = directorySystem().extend({
      applies: (registration) => registration.source.kind === "host",
      name: "labelled",
      wrap: (Base) =>
        class extends Base {
          readonly label = `dir:${this.source.path}`;
        },
    });

    const added = await system.load({ path: root });

    expect(added).toHaveProperty("label", `dir:${root}`);
    expect(added).toHaveProperty("root", root);
  });
});
