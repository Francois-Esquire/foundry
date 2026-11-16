import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { afterEach, expect, it } from "vitest";
import { initializeDatabase } from "~/database/open";
import { artifactBlobs, workspaceStores } from "~/database/stores";
import { stateDatabase } from "~/layout";

/**
 * Separate processes keep one workspace's artifacts, sandbox containers and
 * workspace catalogue in one Marbles database file, as the Marbles process
 * and its workers do: every write each makes is kept, each in its own
 * process's commit, and what they write in common (a workspace both load)
 * is kept once. Each writer is `helpers/store-writer.ts` on a handle of its
 * own (`openDatabase`); the database is made and migrated here first, so no
 * writer migrates.
 */

const WRITERS = 2;
const EACH = 10;
const SCOPE = "ws";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

interface Exit {
  readonly code: number | null;
  readonly output: string;
}

/** Start every writer, let them in at once, and wait for each to exit. */
async function write(args: (name: string) => readonly string[], go: string) {
  const children = Array.from({ length: WRITERS }, (_, index) =>
    spawn(
      "bun",
      [
        "--no-env-file",
        resolve("test/helpers/store-writer.ts"),
        ...args(`w${String(index)}`),
      ],
      { cwd: resolve("."), stdio: ["ignore", "pipe", "pipe"] }
    )
  );
  const ready = children.map(
    (child) =>
      new Promise<void>((settle) => {
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString().includes("ready")) {
            settle();
          }
        });
      })
  );
  const exits = children.map(
    (child) =>
      new Promise<Exit>((settle) => {
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.once("exit", (code) => settle({ code, output }));
      })
  );
  // A writer that fails before it is ready exits instead.
  await Promise.race([Promise.all(ready), Promise.all(exits)]);
  writeFileSync(go, "");
  return await Promise.all(exits);
}

it("keeps every write of separate processes over one database file, and what they share once", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "marbles-stores-")));
  dirs.push(dir);
  const state = join(dir, "state");
  const artifacts = join(dir, "artifacts");
  const roots = join(dir, "roots");
  const shared = join(dir, "shared");
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, "shared.txt"), "shared");
  (await initializeDatabase(stateDatabase(state))).close();

  const exits = await write(
    (name) => [
      state,
      artifacts,
      name,
      String(EACH),
      roots,
      shared,
      join(dir, "go"),
    ],
    join(dir, "go")
  );
  for (const exit of exits) {
    expect(exit.code, exit.output).toBe(0);
  }

  const opened = await initializeDatabase(stateDatabase(state));
  try {
    const stores = workspaceStores(opened.database, SCOPE);
    const labels = Array.from({ length: WRITERS }, (_w, writer) =>
      Array.from(
        { length: EACH },
        (_i, index) => `w${String(writer)}-${String(index)}`
      )
    )
      .flat()
      .sort();

    // Every artifact, each with the bytes its writer put in its blob file.
    const manager = new ArtifactManager({
      files: blobFiles(artifactBlobs(artifacts, SCOPE)),
      store: stores.artifacts,
    });
    const listed = await manager.list({ limit: 100 });
    expect(listed.items.map((artifact) => artifact.name).sort()).toEqual(
      labels
    );
    for (const artifact of listed.items) {
      const { contentId } = artifact;
      expect(contentId, artifact.name).not.toBeNull();
      const file =
        contentId === null ? null : await manager.readFile(contentId, "a.txt");
      expect(new TextDecoder().decode(file?.blob), artifact.name).toBe(
        artifact.name
      );
    }

    // Every container's row, each stopped by the writer that started it.
    const rows = await stores.containers.list();
    expect(rows).toHaveLength(WRITERS * EACH);
    expect(new Set(rows.map((row) => row.id)).size).toBe(WRITERS * EACH);
    expect(rows.every((row) => row.status === "stopped")).toBe(true);

    // Every writer's own workspaces, and the one they all loaded, once.
    const registrations = await stores.workspaces.listWorkspaces({
      limit: 100,
    });
    expect(
      registrations.items.map((registration) => registration.source.path).sort()
    ).toEqual([...labels.map((label) => join(roots, label)), shared].sort());
    const common = await stores.workspaces.findWorkspaceByPath(shared);
    if (common === null) {
      throw new Error("the shared workspace was not registered");
    }
    expect(
      (await stores.workspaces.listEntries(common.id)).map(
        (entry) => entry.path
      )
    ).toEqual(["shared.txt"]);
  } finally {
    opened.close();
  }
}, 120_000);
