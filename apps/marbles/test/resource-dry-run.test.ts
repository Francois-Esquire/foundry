import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { describe, expect, it } from "vitest";
import { type Command, DRY_RUN } from "~/args";
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
 * `--dry-run` persists nothing. Every command decides what the flag means
 * for it (`DRY_RUN`), and one without a dry mode refuses it before it
 * opens or writes anything, wherever the flag sits on the line.
 */

const REFUSED = /takes no --dry-run/;

const SOURCE = `import { step, workflow } from "@foundry.sh/marbles";
const greet = step("greet").do(() => "hello");
workflow("hello").do(() => greet({}));
`;

async function machine() {
  const home = testHome();
  const { artifacts, state } = home.layout;
  const top = await realpath(temporaryDirectory("marbles-dry-resources-"));
  const root = (name: string) => {
    const path = join(top, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "marbles.ts"), SOURCE);
    return path;
  };
  const one = workspaceState(state, root("one"));
  const two = workspaceState(state, root("two"));
  // Hosted, so a detach would have something to change.
  await touchWorkspace(state, one, null, { hosted: true });
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
  return { home, notes, one, top };
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

interface Case {
  readonly args: readonly string[];
  /** The exit status a command with a dry mode ends with; any when absent. */
  readonly exits?: number;
  /** Stopped with SIGINT after this long: it runs until it is stopped. */
  readonly stopAfterMs?: number;
}

/**
 * How the test runs each command, one of everything it can change: a
 * command added without a decision and a case here fails.
 */
function cases(
  notes: { readonly id: string },
  root: string
): {
  readonly [C in Command]: Case;
} {
  return {
    artifacts: { args: ["artifacts", "--all"], exits: 0 },
    attach: { args: ["attach"] },
    daemon: { args: ["daemon"] },
    detach: { args: ["detach"] },
    help: { args: ["help"], exits: 0 },
    init: { args: ["init", "developer", "--config", join(root, "starter")] },
    list: { args: ["list"], exits: 0 },
    mcp: { args: ["mcp"] },
    modules: { args: ["modules", "--all"], exits: 0 },
    relink: { args: ["relink", "--all"] },
    roll: { args: ["roll", "hello"], exits: 0 },
    run: { args: ["run"], stopAfterMs: 10_000 },
    runs: { args: ["runs", "--all"], exits: 0 },
    sandboxes: { args: ["sandboxes", "--all"], exits: 0 },
    sessions: { args: ["sessions", "--all"], exits: 0 },
    share: { args: ["share", "artifact", notes.id, "../two"] },
    status: { args: ["status"], exits: 0 },
    stop: { args: ["stop"] },
    tasks: { args: ["tasks", "create", "Dry"], exits: 0 },
    unshare: { args: ["unshare", "artifact", notes.id, "../two"] },
    watch: { args: ["watch", "rn-missing"] },
  };
}

describe("every command under --dry-run", { timeout: 600_000 }, () => {
  it("has a dry mode, only reads, or refuses the flag, and changes nothing under the home or the workspaces", async () => {
    const { home, notes, one, top } = await machine();
    const table = cases(notes, one.root);
    expect(Object.keys(table).sort()).toEqual(Object.keys(DRY_RUN).sort());
    const before = contents(home.path, top);
    for (const [command, dry] of Object.entries(DRY_RUN)) {
      const { args, exits, stopAfterMs } = table[command as Command];
      const line = [...args, "--source", join(one.root, "marbles.ts")];
      for (const flagged of [
        ["--dry-run", ...line],
        [...line, "--dry-run"],
      ]) {
        const done = spawnSync("bun", cliArgs(...flagged), {
          cwd: one.root,
          encoding: "utf8",
          env: home.env,
          input: "",
          killSignal: "SIGINT",
          timeout: stopAfterMs ?? 60_000,
        });
        const what = `marbles ${flagged.join(" ")}`;
        if (typeof dry === "object") {
          expect(done.status, what).toBe(1);
          expect(done.stderr, what).toContain(
            `${dry.refused}; it takes no --dry-run`
          );
        } else {
          expect(done.stderr, what).not.toMatch(REFUSED);
          if (exits !== undefined) {
            expect(done.status, `${what}: ${done.stderr}`).toBe(exits);
          }
        }
        expect(contents(home.path, top), what).toEqual(before);
      }
    }
  });
});
