import {
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactManager, artifactIdSchema } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { acquireFileLock } from "@foundry/lib/file-lock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import { keepingLinks } from "~/database/artifact-links";
import { artifactPlace, linkName } from "~/database/links";
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

/** Links follow a write after it lands; give a loaded machine time. */
function settled<T>(check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(check, { interval: 20, timeout: 10_000 });
}

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

/** Hold a workspace's links lock, as another process's rebuild would. */
function holdLinks(root: string): Promise<() => Promise<void>> {
  return acquireFileLock(join(workspaceLinks(root), ".lock"));
}

const REPAIRS = /marbles relink repairs it/;

const NOTES = {
  id: "artifact#notes",
  kind: "artifact",
  name: "notes",
  type: "text/markdown",
} as const;

describe("links that follow artifact writes", { timeout: 30_000 }, () => {
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
      linkName(artifactIdFor(one.id, NOTES.name)),
      "a.md"
    );
    await settled(async () =>
      expect(await readFile(link, "utf8")).toBe("# First")
    );
    const first = readlinkSync(link);
    await engine.artifacts.write(NOTES, { "a.md": "# Second" });
    await settled(async () =>
      expect(await readFile(link, "utf8")).toBe("# Second")
    );
    expect(readlinkSync(link)).not.toBe(first);
    expect(existsSync(workspaceLinks(unlinked.root))).toBe(false);
  });

  it("link a shared artifact where it is shared, and unlink it everywhere once it is deleted", async () => {
    const { artifacts, machine, one, two } = await arranged();
    const { database } = machine.database;
    const lines: string[] = [];
    const kept = new ArtifactManager({
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
    await kept.create({
      entries: { "plan.md": { bytes: "# Plan\n", mime: "text/markdown" } },
      id,
      name: "plan",
      type: "text/markdown",
    });
    const ref = { id, kind: "artifact", owner: one.id } as const;
    const linkIn = ({ id: workspace, root }: typeof one) =>
      join(
        resourceLinks(root, "artifact"),
        ...artifactPlace(ref, workspace),
        "plan.md"
      );
    await settled(() => expect(existsSync(linkIn(one))).toBe(true));
    await resourceAssociations(database, machine.root).share(
      { id, kind: "artifact", owner: one.id },
      two.id
    );
    await kept.write({
      artifactId: id,
      changes: {
        put: { "plan.md": { bytes: "# Plan, again\n", mime: "text/markdown" } },
      },
    });
    await settled(async () =>
      expect(await readFile(linkIn(two), "utf8")).toBe("# Plan, again\n")
    );
    await kept.delete(id);
    await settled(() => {
      expect(existsSync(linkIn(one))).toBe(false);
      expect(existsSync(linkIn(two))).toBe(false);
    });
    expect(lines).toEqual([]);
  });

  it("report a workspace it cannot link, and still link the others, keeping the write", async () => {
    const { artifacts, machine, one, two } = await arranged();
    const { database } = machine.database;
    const lines: string[] = [];
    const id = artifactIdSchema.parse("artifact#both");
    await manager(machine, artifacts, one, lines).create({
      entries: { "a.md": { bytes: "# A\n", mime: "text/markdown" } },
      id,
      name: "both",
      type: "text/markdown",
    });
    const ref = { id, kind: "artifact", owner: one.id } as const;
    await resourceAssociations(database, machine.root).share(ref, two.id);
    // The workspace relinked first is the one that cannot be.
    const [broken, healthy] = [one, two].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (broken === undefined || healthy === undefined) {
      throw new Error("two workspaces");
    }
    await settled(() =>
      expect(
        existsSync(
          join(
            resourceLinks(broken.root, "artifact"),
            ...artifactPlace(ref, broken.id)
          )
        )
      ).toBe(true)
    );
    await rm(resourceLinks(broken.root, "artifact"), {
      force: true,
      recursive: true,
    });
    await writeFile(resourceLinks(broken.root, "artifact"), "not a directory");
    const written = manager(machine, artifacts, one, lines);
    await written.write({
      artifactId: id,
      changes: {
        put: { "a.md": { bytes: "# A, again\n", mime: "text/markdown" } },
      },
    });
    const healthyLink = join(
      resourceLinks(healthy.root, "artifact"),
      ...artifactPlace(ref, healthy.id),
      "a.md"
    );
    await settled(async () =>
      expect(await readFile(healthyLink, "utf8")).toBe("# A, again\n")
    );
    // Link work the create started may still be under way when the
    // workspace breaks, so it may be reported more than once, as a failed
    // update or a refused link; only the broken workspace is.
    await settled(() => expect(lines.length).toBeGreaterThan(0));
    for (const line of lines) {
      expect(line).toContain(broken.root);
      expect(line).not.toContain(healthy.root);
    }
    expect(await written.get(id)).not.toBeNull();
  });

  it("wait, when drained, for a link update held up by the links lock", async () => {
    const { artifacts, machine, one } = await arranged();
    const lines: string[] = [];
    const store = keeping(machine, artifacts, one, lines);
    const kept = new ArtifactManager({
      files: blobFiles(artifactBlobs(artifacts, one.id)),
      store,
    });
    const id = artifactIdSchema.parse("artifact#held");
    const ref = { id, kind: "artifact", owner: one.id } as const;
    const link = join(
      resourceLinks(one.root, "artifact"),
      ...artifactPlace(ref, one.id),
      "a.md"
    );
    await kept.create({
      entries: { "a.md": { bytes: "# First\n", mime: "text/markdown" } },
      id,
      name: "held",
      type: "text/markdown",
    });
    await settled(async () =>
      expect(await readFile(link, "utf8")).toBe("# First\n")
    );
    const first = readlinkSync(link);
    const release = await holdLinks(one.root);
    await kept.write({
      artifactId: id,
      changes: {
        put: { "a.md": { bytes: "# Second\n", mime: "text/markdown" } },
      },
    });
    const drained = store.drainLinks(30_000);
    // Nothing moves into place while the lock is held.
    expect(readlinkSync(link)).toBe(first);
    await release();
    await drained;
    expect(await readFile(link, "utf8")).toBe("# Second\n");
    expect(lines).toEqual([]);
  });

  it("give up a drain on a links lock that does not free, reporting what relink repairs", async () => {
    const { artifacts, machine, one } = await arranged();
    const lines: string[] = [];
    const store = keeping(machine, artifacts, one, lines);
    const release = await holdLinks(one.root);
    try {
      await new ArtifactManager({
        files: blobFiles(artifactBlobs(artifacts, one.id)),
        store,
      }).create({
        entries: { "a.md": { bytes: "# A\n", mime: "text/markdown" } },
        name: "stuck",
        type: "text/markdown",
      });
      await store.drainLinks(50);
      expect(lines).toEqual([expect.stringMatching(REPAIRS)]);
    } finally {
      await release();
    }
    // The update under way still finishes before the database closes.
    await store.drainLinks(30_000);
  });

  it("drain an engine's link updates as it is disposed, giving up on a lock that does not free", async () => {
    const { artifacts, machine, one } = await arranged();
    const lines: string[] = [];
    const engine = createEngine({
      artifacts,
      catalog: new Catalog(),
      database: machine.database.database,
      dry: false,
      print: (line) => lines.push(line),
      providers: [],
      root: one.root,
      stateRoot: machine.root,
      workspaceId: one.id,
    });
    await engine.start();
    const release = await holdLinks(one.root);
    try {
      await engine.artifacts.write(NOTES, { "a.md": "# First" });
      await engine.dispose();
      expect(lines.filter((line) => REPAIRS.test(line))).toHaveLength(1);
    } finally {
      await release();
    }
  });

  it("refuse an artifact directory that is a link, making nothing through it", async () => {
    const { artifacts, machine, one } = await arranged();
    const lines: string[] = [];
    const id = artifactIdSchema.parse("notes");
    const outside = join(one.root, "..", "outside");
    mkdirSync(outside);
    mkdirSync(resourceLinks(one.root, "artifact"), { recursive: true });
    symlinkSync(outside, join(resourceLinks(one.root, "artifact"), "notes"));
    await manager(machine, artifacts, one, lines).create({
      entries: {
        "nested/file.txt": { bytes: "hello", mime: "text/plain" },
      },
      id,
      name: "notes",
      type: "text/plain",
    });
    await settled(() => expect(lines).toHaveLength(1));
    expect(lines[0]).toContain(
      ".marbles/artifacts/notes goes through a link, a file or a path outside .marbles"
    );
    expect(readdirSync(outside)).toEqual([]);
  });
});

function keeping(
  machine: TestMachine,
  artifacts: string,
  owner: { readonly id: string },
  lines: string[]
) {
  const { database } = machine.database;
  return keepingLinks(workspaceStores(database, owner.id).artifacts, {
    artifacts,
    database,
    owner: owner.id,
    report: (line) => lines.push(line),
    state: machine.root,
  });
}

function manager(
  machine: TestMachine,
  artifacts: string,
  owner: { readonly id: string },
  lines: string[]
): ArtifactManager {
  return new ArtifactManager({
    files: blobFiles(artifactBlobs(artifacts, owner.id)),
    store: keeping(machine, artifacts, owner, lines),
  });
}
