import { existsSync, mkdirSync, readlinkSync } from "node:fs";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactManager, artifactIdSchema } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import { keepingLinks } from "~/database/artifact-links";
import { resourceAssociations } from "~/database/resources";
import { artifactBlobs, workspaceStores } from "~/database/stores";
import { WorkspaceRegistry } from "~/database/workspaces";
import { resourceLinks, workspaceLinks } from "~/layout";
import type { Engine } from "~/lib/engine";
import { artifactIdFor } from "~/lib/managers/artifacts";
import { workspaceState } from "~/lib/state/workspace";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

/**
 * After an artifact write commits, the links to that artifact follow it in
 * every linked workspace it belongs to; a workspace never linked gets
 * none, and a failure to link never fails the write.
 */

const machines: TestMachine[] = [];
const engines: Engine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    await engine.dispose();
  }
  for (const machine of machines.splice(0)) {
    machine.close();
  }
});

async function arranged() {
  const machine = await testMachine();
  machines.push(machine);
  const home = await realpath(await mkdtemp(join(tmpdir(), "marbles-links-")));
  const artifacts = join(home, "artifacts");
  const registry = new WorkspaceRegistry({
    database: machine.database.database,
    state: machine.root,
  });
  const workspace = async (name: string, linked: boolean) => {
    const root = join(home, name);
    mkdirSync(linked ? workspaceLinks(root) : root, { recursive: true });
    const state = workspaceState(machine.root, root);
    await registry.touch(state, null);
    return state;
  };
  return {
    artifacts,
    machine,
    one: await workspace("one", true),
    two: await workspace("two", true),
    unlinked: await workspace("three", false),
  };
}

const NOTES = {
  id: "artifact#notes",
  kind: "artifact",
  name: "notes",
  type: "text/markdown",
} as const;

describe("links that follow artifact writes", () => {
  it("link an engine's new artifact, and point a rewritten file at its new bytes", async () => {
    const { artifacts, machine, one, unlinked } = await arranged();
    const engine = createEngine({
      artifacts,
      catalog: new Catalog(),
      database: machine.database.database,
      dry: false,
      print: () => undefined,
      providers: [],
      root: one.root,
      stateRoot: machine.root,
      workspaceId: one.id,
    });
    engines.push(engine);
    await engine.start();
    await engine.artifacts.write(NOTES, { "a.md": "# First" });
    const link = join(
      resourceLinks(one.root, "artifact"),
      encodeURIComponent(artifactIdFor(one.id, NOTES.name)),
      "a.md"
    );
    await vi.waitFor(async () =>
      expect(await readFile(link, "utf8")).toBe("# First")
    );
    const first = readlinkSync(link);
    await engine.artifacts.write(NOTES, { "a.md": "# Second" });
    await vi.waitFor(async () =>
      expect(await readFile(link, "utf8")).toBe("# Second")
    );
    expect(readlinkSync(link)).not.toBe(first);
    expect(existsSync(workspaceLinks(unlinked.root))).toBe(false);
  });

  it("link a shared artifact where it is shared, and unlink it everywhere once it is deleted", async () => {
    const { artifacts, machine, one, two } = await arranged();
    const { database } = machine.database;
    const lines: string[] = [];
    const manager = new ArtifactManager({
      files: blobFiles(artifactBlobs(artifacts, one.id)),
      store: keepingLinks(workspaceStores(database, one.id).artifacts, {
        artifacts,
        database,
        owner: one.id,
        report: (line) => lines.push(line),
        state: machine.root,
      }),
    });
    const id = artifactIdSchema.parse("artifact#plan");
    await manager.create({
      entries: { "plan.md": { bytes: "# Plan\n", mime: "text/markdown" } },
      id,
      name: "plan",
      type: "text/markdown",
    });
    const linkIn = (root: string) =>
      join(resourceLinks(root, "artifact"), encodeURIComponent(id), "plan.md");
    await vi.waitFor(() => expect(existsSync(linkIn(one.root))).toBe(true));
    await resourceAssociations(database, machine.root).share(
      { id, kind: "artifact", owner: one.id },
      two.id
    );
    await manager.write({
      artifactId: id,
      changes: {
        put: { "plan.md": { bytes: "# Plan, again\n", mime: "text/markdown" } },
      },
    });
    await vi.waitFor(async () =>
      expect(await readFile(linkIn(two.root), "utf8")).toBe("# Plan, again\n")
    );
    await manager.delete(id);
    await vi.waitFor(() => {
      expect(existsSync(linkIn(one.root))).toBe(false);
      expect(existsSync(linkIn(two.root))).toBe(false);
    });
    expect(lines).toEqual([]);
  });

  it("report a link it cannot make, and keep the write", async () => {
    const { artifacts, machine, one } = await arranged();
    const { database } = machine.database;
    const lines: string[] = [];
    // A file where the artifacts directory goes.
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(resourceLinks(one.root, "artifact"), "not a directory")
    );
    const manager = new ArtifactManager({
      files: blobFiles(artifactBlobs(artifacts, one.id)),
      store: keepingLinks(workspaceStores(database, one.id).artifacts, {
        artifacts,
        database,
        owner: one.id,
        report: (line) => lines.push(line),
        state: machine.root,
      }),
    });
    const created = await manager.create({
      entries: { "a.md": { bytes: "# A\n", mime: "text/markdown" } },
      name: "a",
      type: "text/markdown",
    });
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    expect(lines[0]).toContain("marbles relink repairs them");
    expect(await manager.get(created.id)).not.toBeNull();
  });
});
