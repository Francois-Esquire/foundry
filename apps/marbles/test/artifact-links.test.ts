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
import { Artifacts, artifactIdSchema } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import type { ArtifactStore } from "@foundry/artifacts/store";
import { MemoryArtifactStore } from "@foundry/artifacts/store/memory";
import { acquireFileLock } from "@foundry/lib/node/file-lock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "~/authoring/catalog";
import { createEngine } from "~/create";
import { keepingLinks } from "~/database/artifact-links";
import { linkName } from "~/database/links";
import { artifactBlobs } from "~/database/local-artifacts";
import { workspaceStores } from "~/database/stores";
import { WorkspaceRegistry } from "~/database/workspaces";
import { resourceLinks, workspaceLinks } from "~/layout";
import type { Engine } from "~/lib/engine";
import { artifactIdFor } from "~/lib/managers/artifacts";
import { insideState, workspaceState } from "~/lib/state/workspace";
import type { TestMachine } from "./helpers/records";
import { testMachine } from "./helpers/records";

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
    acceptWorkspace: (workspaceId) => insideState(machine.root, workspaceId),
    database: machine.database.database,
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
    unlinked: await workspace("three", false),
  };
}

function holdLinks(root: string): Promise<() => Promise<void>> {
  return acquireFileLock(join(workspaceLinks(root), ".lock"));
}

const REPAIRS = /\[links\] could not update/;

function temporaries(root: string): string[] {
  return readdirSync(workspaceLinks(root), { recursive: true })
    .map(String)
    .filter((path) => path.endsWith(".link"))
    .sort();
}

function heldUntil<T extends object>(query: T, gate: Promise<void>): T {
  return new Proxy(query, {
    get(target, property) {
      if (property === "then") {
        return (
          resolved: (value: unknown) => unknown,
          rejected: (reason: unknown) => unknown
        ) =>
          Promise.resolve(target)
            .then(async (rows) => {
              await gate;
              return rows;
            })
            .then(resolved, rejected);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function"
        ? (...args: unknown[]) =>
            heldUntil(Reflect.apply(value, target, args) as object, gate)
        : value;
    },
  }) as T;
}

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

  it("unlink an artifact once it is deleted", async () => {
    const { artifacts, machine, one } = await arranged();
    const lines: string[] = [];
    const kept = manager(machine, artifacts, one, lines);
    const id = artifactIdSchema.parse("artifact#plan");
    await kept.create({
      entries: { "plan.md": { bytes: "# Plan\n", mime: "text/markdown" } },
      id,
      name: "plan",
      type: "text/markdown",
    });
    const link = join(
      resourceLinks(one.root, "artifact"),
      linkName(id),
      "plan.md"
    );
    await settled(() => expect(existsSync(link)).toBe(true));
    await kept.delete(id);
    await settled(() => expect(existsSync(link)).toBe(false));
    expect(lines).toEqual([]);
  });

  it("report a workspace it cannot link, keeping the write", async () => {
    const { artifacts, machine, one } = await arranged();
    const lines: string[] = [];
    const id = artifactIdSchema.parse("artifact#both");
    const written = manager(machine, artifacts, one, lines);
    await written.create({
      entries: { "a.md": { bytes: "# A\n", mime: "text/markdown" } },
      id,
      name: "both",
      type: "text/markdown",
    });
    await settled(() =>
      expect(
        existsSync(join(resourceLinks(one.root, "artifact"), linkName(id)))
      ).toBe(true)
    );
    await rm(resourceLinks(one.root, "artifact"), {
      force: true,
      recursive: true,
    });
    await writeFile(resourceLinks(one.root, "artifact"), "not a directory");
    await written.write({
      artifactId: id,
      changes: {
        put: { "a.md": { bytes: "# A, again\n", mime: "text/markdown" } },
      },
    });
    await settled(() => expect(lines.length).toBeGreaterThan(0));
    for (const line of lines) {
      expect(line).toContain(one.root);
    }
    expect(await written.get(id)).not.toBeNull();
  });

  it("wait, when drained, for a link update held up by the links lock", async () => {
    const { artifacts, machine, one } = await arranged();
    const lines: string[] = [];
    const store = keeping(machine, artifacts, one, lines);
    const kept = new Artifacts({
      files: blobFiles(artifactBlobs(artifacts, one.id)),
      store,
    });
    const id = artifactIdSchema.parse("artifact#held");
    const link = join(
      resourceLinks(one.root, "artifact"),
      linkName(id),
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
      await new Artifacts({
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
    await store.drainLinks(30_000);
    expect(lines).toHaveLength(1);
  });

  it("read the database no more once a drain gave up, ending the update under way quietly", async () => {
    const { artifacts, machine, one } = await arranged();
    machines.splice(machines.indexOf(machine), 1);
    const lines: string[] = [];
    const readsAfterClose: string[] = [];
    let closed = false;
    const database = new Proxy(machine.database.database, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") {
          return value;
        }
        if (closed) {
          readsAfterClose.push(String(property));
        }
        return value.bind(target);
      },
    });
    const store = keepingLinks(workspaceStores(database, one.id).artifacts, {
      artifacts,
      database,
      owner: one.id,
      report: (line) => lines.push(line),
      state: machine.root,
    });
    const release = await holdLinks(one.root);
    try {
      await new Artifacts({
        files: blobFiles(artifactBlobs(artifacts, one.id)),
        store,
      }).create({
        entries: { "a.md": { bytes: "# A\n", mime: "text/markdown" } },
        name: "late",
        type: "text/markdown",
      });
      await store.drainLinks(50);
      expect(lines).toEqual([expect.stringMatching(REPAIRS)]);
      closed = true;
      machine.close();
    } finally {
      await release();
    }
    await store.drainLinks(30_000);
    expect(readsAfterClose).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it("report giving up once, however many drains give up at once", async () => {
    const { artifacts, machine, one } = await arranged();
    const lines: string[] = [];
    const store = keeping(machine, artifacts, one, lines);
    const release = await holdLinks(one.root);
    try {
      await new Artifacts({
        files: blobFiles(artifactBlobs(artifacts, one.id)),
        store,
      }).create({
        entries: { "a.md": { bytes: "# A\n", mime: "text/markdown" } },
        name: "twice",
        type: "text/markdown",
      });
      await Promise.all([store.drainLinks(50), store.drainLinks(50)]);
    } finally {
      await release();
    }
    expect(lines).toEqual([expect.stringMatching(REPAIRS)]);
  });

  it("wait, when a drain gives up, for a read of the database under way, and begin none once it resolves", async () => {
    const { artifacts, machine, one } = await arranged();
    machines.splice(machines.indexOf(machine), 1);
    const lines: string[] = [];
    const callsAfterDrain: string[] = [];
    let drained = false;
    let hold = false;
    let open = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let entered = (): void => undefined;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const database = new Proxy(machine.database.database, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") {
          return value;
        }
        if (drained) {
          callsAfterDrain.push(String(property));
        }
        if (property === "select" && hold) {
          hold = false;
          return (...args: unknown[]) => {
            entered();
            return heldUntil(Reflect.apply(value, target, args), gate);
          };
        }
        return value.bind(target);
      },
    });
    const store = keepingLinks(
      workspaceStores(machine.database.database, one.id).artifacts,
      {
        artifacts,
        database,
        owner: one.id,
        report: (line) => lines.push(line),
        state: machine.root,
      }
    );
    hold = true;
    await new Artifacts({
      files: blobFiles(artifactBlobs(artifacts, one.id)),
      store,
    }).create({
      entries: { "a.md": { bytes: "# A\n", mime: "text/markdown" } },
      name: "reading",
      type: "text/markdown",
    });
    await reading;
    const drain = store.drainLinks(10).then(() => {
      drained = true;
    });
    await vi.waitFor(() => expect(lines).toHaveLength(1));
    expect(drained).toBe(false);
    open();
    await drain;
    machine.close();
    await store.drainLinks(1000);
    expect(callsAfterDrain).toEqual([]);
    expect(lines).toEqual([expect.stringMatching(REPAIRS)]);
  });

  it("leave no link half made when a drain stops an update waiting on the lock", async () => {
    const { artifacts, machine, one } = await arranged();
    const lines: string[] = [];
    const store = keeping(machine, artifacts, one, lines);
    const kept = new Artifacts({
      files: blobFiles(artifactBlobs(artifacts, one.id)),
      store,
    });
    const id = artifactIdSchema.parse("artifact#halfway");
    const place = join(resourceLinks(one.root, "artifact"), linkName(id));
    await kept.create({
      entries: { "a.md": { bytes: "# First\n", mime: "text/markdown" } },
      id,
      name: "halfway",
      type: "text/markdown",
    });
    await settled(async () =>
      expect(await readFile(join(place, "a.md"), "utf8")).toBe("# First\n")
    );
    const first = readlinkSync(join(place, "a.md"));
    const release = await holdLinks(one.root);
    try {
      await kept.write({
        artifactId: id,
        changes: {
          put: {
            "a.md": { bytes: "# Second\n", mime: "text/markdown" },
            "b.md": { bytes: "# B\n", mime: "text/markdown" },
          },
        },
      });
      await settled(() => expect(temporaries(one.root)).toHaveLength(2));
      await store.drainLinks(50);
      expect(temporaries(one.root)).toEqual([]);
      expect(readlinkSync(join(place, "a.md"))).toBe(first);
      expect(existsSync(join(place, "b.md"))).toBe(false);
      expect(lines).toEqual([expect.stringMatching(REPAIRS)]);
    } finally {
      await release();
    }
  });

  it.each(["commit", "transaction"] as const)(
    "take no new work once a drain has begun: a %s that lands after it is left to relink, reported once, and calls nothing",
    async (shape) => {
      let land = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        land = resolve;
      });
      const memory = new MemoryArtifactStore();
      const held = new Proxy(memory, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (
            (property === "commit" || property === "transaction") &&
            typeof value === "function"
          ) {
            return async (...args: unknown[]) => {
              await gate;
              return Reflect.apply(value, target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as ArtifactStore;
      const closed: { drained: boolean } = { drained: false };
      const callsAfterDrain: string[] = [];
      const database = new Proxy(
        {},
        {
          get: (_target, property) => () => {
            if (closed.drained) {
              callsAfterDrain.push(String(property));
            }
            throw new Error("the database is closed");
          },
        }
      ) as never;
      const lines: string[] = [];
      const kept = keepingLinks(held, {
        artifacts: "/nonexistent/artifacts",
        database,
        owner: "one",
        report: (line) => lines.push(line),
        state: "/nonexistent/state",
      });
      const id = artifactIdSchema.parse("artifact#late");
      const written =
        shape === "commit"
          ? kept.commit({ deleteArtifacts: [id] })
          : kept.transaction?.((view) =>
              view.commit({ deleteArtifacts: [id] })
            );
      await kept.drainLinks(1000);
      closed.drained = true;
      land();
      await written;
      await kept.drainLinks(1000);
      expect(callsAfterDrain).toEqual([]);
      expect(lines).toEqual([expect.stringMatching(REPAIRS)]);
    }
  );

  it("drain an engine's link updates as it is disposed, giving up on a lock that does not free", async () => {
    const { artifacts, machine, one } = await arranged();
    const lines: string[] = [];
    const engine = createEngine({
      artifacts,
      catalog: new Catalog(),
      database: machine.database.database,
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
): Artifacts {
  return new Artifacts({
    files: blobFiles(artifactBlobs(artifacts, owner.id)),
    store: keeping(machine, artifacts, owner, lines),
  });
}
