import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { describe, expect, it } from "vitest";
import { COMMANDS, dryRunRefusal } from "~/cli";
import { initializeDatabase } from "~/database/open";
import { resourceAssociations } from "~/database/resources";
import { artifactBlobs } from "~/database/stores";
import { stateDatabase } from "~/layout";
import { workspaceState } from "~/lib/state/workspace";
import { cliArgs } from "./helpers/cli";
import { type TestHome, testHome } from "./helpers/home";
import { touchWorkspace } from "./helpers/registry";
import { temporaryDirectory } from "./helpers/temporary";
import { snapshotTrees } from "./helpers/tree-snapshot";

/**
 * `--dry-run` persists nothing. Every command in the CLI's handler table
 * says what the flag means for it, and one without a dry mode refuses it
 * before it opens or writes anything, wherever the flag sits on the line:
 * nothing under the Foundry home, the workspaces, or the home and
 * temporary directory the CLI is given changes.
 */

const REFUSED = /takes no --dry-run/;

const SOURCE = `import { step, workflow } from "@foundry.sh/marbles";
const greet = step("greet").do(() => "hello");
workflow("hello").do(() => greet({}));
`;

interface Case {
  readonly args: readonly string[];
  /** The exit status a command that takes the flag ends with; any when absent. */
  readonly exits?: number;
  /** Stopped with SIGINT after this long: it runs until it is stopped. */
  readonly stopAfterMs?: number;
}

/**
 * How the test runs each command, doing what it would change. Kept by
 * command name, checked against the handler table at run time: a command
 * added there without a case here fails.
 */
function cases(artifact: string): Readonly<Record<string, Case>> {
  return {
    artifacts: { args: ["artifacts", "--all"], exits: 0 },
    attach: { args: ["attach"] },
    daemon: { args: ["daemon"] },
    detach: { args: ["detach"] },
    help: { args: ["help"], exits: 0 },
    init: { args: ["init", "developer"] },
    list: { args: ["list"] },
    mcp: { args: ["mcp"] },
    modules: { args: ["modules", "--all"], exits: 0 },
    relink: { args: ["relink", "--all"] },
    roll: { args: ["roll", "hello"] },
    run: { args: ["run"], stopAfterMs: 10_000 },
    runs: { args: ["runs", "--all"], exits: 0 },
    sandboxes: { args: ["sandboxes", "--all"], exits: 0 },
    sessions: { args: ["sessions", "--all"], exits: 0 },
    share: { args: ["share", "artifact", artifact, "../two"] },
    status: { args: ["status"], exits: 0 },
    stop: { args: ["stop"] },
    tasks: { args: ["tasks", "create", "Dry"], exits: 0 },
    unshare: { args: ["unshare", "artifact", artifact, "../two"] },
    watch: { args: ["watch", "rn-missing"] },
  };
}

/** A machine whose first workspace has a source, a database holding an artifact it shares, and is hosted. */
async function seeded(home: TestHome, top: string) {
  const { artifacts, state } = home.layout;
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
  try {
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
    return { artifact: notes.id, root: one.root };
  } finally {
    opened.close();
  }
}

/**
 * Run every command in the handler table with the flag at each of
 * `positions`, in the workspace at `root`, and prove that nothing under
 * the home, the workspaces or the CLI's own home and temporary directory
 * changed after any of them.
 */
function walk(
  home: TestHome,
  top: string,
  root: string,
  artifact: string,
  positions: readonly ("before" | "after")[]
): void {
  const table = cases(artifact);
  expect(Object.keys(table).sort()).toEqual(Object.keys(COMMANDS).sort());
  const own = temporaryDirectory("marbles-dry-own-");
  const env = {
    ...home.env,
    // Bun's own cache of what it transpiled, which is Bun's, not Marbles'.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    HOME: join(own, "home"),
    TMPDIR: join(own, "tmp"),
  };
  mkdirSync(env.HOME);
  mkdirSync(env.TMPDIR);
  const watched = [home.path, top, own];
  // SQLite's shared-memory file, which every reader maps read-write; it
  // keeps nothing.
  const ignored = new Set([`${stateDatabase(home.layout.state)}-shm`]);
  const before = snapshotTrees(watched, ignored);
  for (const command of Object.keys(COMMANDS)) {
    const how = table[command];
    if (how === undefined) {
      throw new Error(`no case for ${command}: say how to run it here`);
    }
    const refusal = dryRunRefusal(command);
    const line = [...how.args, "--source", join(root, "marbles.ts")];
    for (const position of positions) {
      const flagged =
        position === "before" ? ["--dry-run", ...line] : [...line, "--dry-run"];
      const done = spawnSync("bun", cliArgs(...flagged), {
        cwd: root,
        encoding: "utf8",
        env,
        input: "",
        killSignal: "SIGINT",
        timeout: how.stopAfterMs ?? 60_000,
      });
      const what = `marbles ${flagged.join(" ")}`;
      if (refusal === undefined) {
        expect(done.stderr, what).not.toMatch(REFUSED);
        if (how.exits !== undefined) {
          expect(done.status, `${what}: ${done.stderr}`).toBe(how.exits);
        }
      } else {
        expect(done.status, what).toBe(1);
        expect(done.stderr, what).toContain(refusal);
      }
      expect(snapshotTrees(watched, ignored), what).toEqual(before);
    }
  }
}

describe("every command under --dry-run", { timeout: 600_000 }, () => {
  it("refuses the flag for a command whose handler says nothing of it", () => {
    expect(dryRunRefusal("no-such-command")).toMatch(REFUSED);
    expect(dryRunRefusal("init")).toBe(
      "init writes a starter module; it takes no --dry-run"
    );
    expect(dryRunRefusal("tasks")).toBeUndefined();
  });

  it("has a dry mode, only reads, or refuses the flag before or after the command, and changes nothing", async () => {
    const home = testHome();
    const top = await realpath(temporaryDirectory("marbles-dry-resources-"));
    const { artifact, root } = await seeded(home, top);
    walk(home, top, root, artifact, ["before", "after"]);
  });

  it("keeps a dry task to itself while the Marbles process hosts the workspace", async () => {
    const home = testHome();
    const root = await realpath(temporaryDirectory("mdr-"));
    const source = join(root, "marbles.ts");
    writeFileSync(source, SOURCE);
    const marbles = (...args: string[]) =>
      spawnSync("bun", cliArgs(...args, "--source", source), {
        cwd: root,
        encoding: "utf8",
        env: home.env,
        input: "",
        timeout: 60_000,
      });
    const attached = marbles("attach");
    expect(attached.status, attached.stderr).toBe(0);
    const dry = marbles("tasks", "create", "Dry", "--dry-run");
    expect(dry.status, dry.stderr).toBe(0);
    // Asked of the generation that hosts it: the dry task never reached it.
    const listed = marbles("tasks", "list", "--json");
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout).not.toContain("Dry");
  });

  it("changes nothing on a first run either: no database and no source", async () => {
    const home = testHome({ providers: false });
    const top = await realpath(temporaryDirectory("marbles-dry-first-"));
    const root = join(top, "one");
    mkdirSync(root);
    walk(home, top, root, "artifact#missing", ["after"]);
  });
});
