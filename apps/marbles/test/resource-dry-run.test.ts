import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { describe, expect, it } from "vitest";
import { initializeDatabase } from "~/database/open";
import { resourceAssociations } from "~/database/resources";
import { artifactBlobs } from "~/database/stores";
import { stateDatabase } from "~/layout";
import { workspaceState } from "~/lib/state/workspace";
import { cliArgs } from "./helpers/cli";
import { testHome } from "./helpers/home";
import { touchWorkspace } from "./helpers/registry";
import { temporaryDirectory } from "./helpers/temporary";

/**
 * `--dry-run` persists nothing, so the commands that change resources
 * refuse it, and the listings read without writing.
 */

const REFUSED = /takes no --dry-run/;

async function machine() {
  const home = testHome();
  const { artifacts, state } = home.layout;
  const top = await realpath(temporaryDirectory("marbles-dry-resources-"));
  const root = (name: string) => {
    const path = join(top, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "marbles.ts"), "export {};\n");
    return path;
  };
  const one = workspaceState(state, root("one"));
  const two = workspaceState(state, root("two"));
  await touchWorkspace(state, one, null);
  await touchWorkspace(state, two, null);
  const opened = await initializeDatabase(stateDatabase(state));
  const notes = await new ArtifactManager({
    files: blobFiles(artifactBlobs(artifacts, one.id)),
    store: new SqliteArtifactStore({
      database: opened.database,
      scope: one.id,
    }),
  }).create({
    entries: { "notes.md": { bytes: "# Notes\n", mime: "text/markdown" } },
    name: "notes",
    type: "text/markdown",
  });
  await resourceAssociations(opened.database, state).share(
    { id: notes.id, kind: "artifact", owner: one.id },
    two.id
  );
  opened.close();
  const marbles = (...args: string[]) =>
    spawnSync(
      "bun",
      cliArgs("--dry-run", ...args, "--source", join(one.root, "marbles.ts")),
      { cwd: one.root, encoding: "utf8", env: home.env, timeout: 60_000 }
    );
  return { home, marbles, notes, one, top, two };
}

/** Every file under `dirs`, by path, with a digest of its bytes. */
function contents(...dirs: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  for (const dir of dirs) {
    for (const entry of readdirSync(dir, {
      recursive: true,
      withFileTypes: true,
    })) {
      // SQLite's shared-memory index, which every reader maps read-write;
      // it keeps nothing.
      if (entry.name.endsWith("-shm")) {
        continue;
      }
      if (entry.isFile() || entry.isSymbolicLink()) {
        const path = join(entry.parentPath, entry.name);
        found[relative(dir, path)] = entry.isFile()
          ? createHash("sha256").update(readFileSync(path)).digest("hex")
          : "link";
      }
    }
  }
  return found;
}

describe("resource commands under --dry-run", { timeout: 120_000 }, () => {
  it("refuse to share, unshare or relink, and change nothing", async () => {
    const { home, marbles, notes, top } = await machine();
    const before = contents(home.path, top);
    for (const args of [
      ["share", "artifact", notes.id, "../two"],
      ["unshare", "artifact", notes.id, "../two"],
      ["relink", "--all"],
    ]) {
      const done = marbles(...args);
      expect(done.status, `${args.join(" ")}: ${done.stdout}`).toBe(1);
      expect(done.stderr).toMatch(REFUSED);
    }
    expect(contents(home.path, top)).toEqual(before);
  });

  it("list every kind and write nothing", async () => {
    const { home, marbles, top } = await machine();
    const before = contents(home.path, top);
    for (const kind of [
      "artifacts",
      "modules",
      "runs",
      "sandboxes",
      "sessions",
    ]) {
      const done = marbles(kind, "--all");
      expect(done.status, `${kind}: ${done.stderr}`).toBe(0);
    }
    expect(contents(home.path, top)).toEqual(before);
  });
});
