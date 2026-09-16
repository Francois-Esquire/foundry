import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { directory } from "../directory";
import { InMemoryWorkspaceStore } from "../in-memory-workspace-store";
import { WorkspaceSystem } from "../workspace-system";
import {
  describeWorkspaceSystemConformance,
  hostWorkspace,
  newRoot,
} from "./helpers/workspace-system-conformance";

describeWorkspaceSystemConformance("in-memory", () => {
  const store = new InMemoryWorkspaceStore();
  return { store, system: new WorkspaceSystem({ store }).extend(directory()) };
});

describe("WorkspaceSystem construction", () => {
  /**
   * The default is asserted through behavior rather than by reading the store
   * back off the system — a zero-configuration system that answers is the
   * claim, and the store stays private.
   */
  it("runs the whole lifecycle with no store and no database setup", async () => {
    const zeroConfig = new WorkspaceSystem();

    expect(await zeroConfig.list()).toEqual([]);
  });

  it("reads through an injected store instead of its own default", async () => {
    const store = new InMemoryWorkspaceStore();
    const system = new WorkspaceSystem({ store }).extend(directory());
    const workspace = hostWorkspace({ path: newRoot("injected") });
    await store.commitCreate({ files: [], workspace });

    expect((await system.list()).map((w) => w.id)).toEqual([workspace.id]);
  });
});

describe("@foundry/workspaces dependencies", () => {
  /**
   * The package is composed by Studio's main process but must run outside it,
   * so a dependency pointing back at persistence, the Electron host, or the app
   * is a design failure rather than a lint preference.
   */
  it("names no database, Electron, or app dependency", () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json"),
        "utf8"
      )
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];

    expect(
      declared.filter(
        (name) =>
          name === "@foundry/db" ||
          name === "electron" ||
          name.startsWith("apps/") ||
          name.includes("studio")
      )
    ).toEqual([]);
  });
});
