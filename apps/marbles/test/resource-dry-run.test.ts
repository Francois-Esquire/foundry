import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { describe, expect, it } from "vitest";
import { parseArgs } from "~/cli/args";
import { COMMANDS, dryRunRefusal } from "~/cli/command-line";
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

const REFUSED = /takes no --dry-run/;

const SOURCE = `import { step, workflow } from "@foundry.sh/marbles";
const greet = step("greet").do(() => "hello");
workflow("hello").do(() => greet({}));
`;

interface Case {
  readonly args: readonly string[];
  readonly exits?: number;
  readonly stopAfterMs?: number;
}

function cases(artifact: string): Readonly<Record<string, readonly Case[]>> {
  return {
    artifacts: [
      { args: ["artifacts", "--all"], exits: 0 },
      { args: ["artifacts", "list", "--all"], exits: 0 },
      { args: ["artifacts", "relink", "--all"] },
      { args: ["artifacts", "share", artifact, "../two"] },
      { args: ["artifacts", "unshare", artifact, "../two"] },
    ],
    daemon: [
      { args: ["daemon"] },
      { args: ["daemon", "stop"] },
      { args: ["daemon", "attach"] },
      { args: ["daemon", "detach"] },
    ],
    dashboard: [{ args: [], stopAfterMs: 10_000 }],
    enqueue: [{ args: ["enqueue", "hello", "--key", "dry"] }],
    help: [{ args: ["help"], exits: 0 }],
    init: [{ args: ["init", "developer"] }],
    list: [{ args: ["list"] }],
    mcp: [{ args: ["mcp"] }],
    run: [{ args: ["run", "hello"] }],
    runs: [
      { args: ["runs", "--all"], exits: 0 },
      { args: ["runs", "share", "rn-missing", "../two"] },
    ],
    sandboxes: [{ args: ["sandboxes", "--all"], exits: 0 }],
    sessions: [
      { args: ["sessions", "--all"], exits: 0 },
      { args: ["sessions", "unshare", "ses-missing", "../two"] },
    ],
    status: [{ args: ["status"], exits: 0 }],
    tasks: [{ args: ["tasks", "create", "Dry"], exits: 0 }],
    theme: [
      { args: ["theme"], exits: 0 },
      { args: ["theme", "list"], exits: 0 },
      { args: ["theme", "light"] },
    ],
    watch: [{ args: ["watch", "rn-missing"] }],
  };
}

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

function walk(
  home: TestHome,
  top: string,
  root: string,
  artifact: string,
  positions: readonly ("before" | "after")[],
  options: {
    readonly only?: (command: string) => boolean;
    readonly after?: (what: string) => void;
  } = {}
): void {
  const table = cases(artifact);
  expect(Object.keys(table).sort()).toEqual(Object.keys(COMMANDS).sort());
  const own = temporaryDirectory("marbles-dry-own-");
  const env = {
    ...home.env,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    HOME: join(own, "home"),
    TMPDIR: join(own, "tmp"),
  };
  mkdirSync(env.HOME);
  mkdirSync(join(env.TMPDIR, "marbles"), { recursive: true });
  const watched = [home.path, top, own];
  const ignored = new Set([
    `${stateDatabase(home.layout.state)}-shm`,
    join(env.TMPDIR, "marbles"),
  ]);
  const snapshot = () => snapshotTrees(watched, ignored, env.TMPDIR);
  const before = snapshot();
  for (const command of Object.keys(COMMANDS).filter(
    options.only ?? (() => true)
  )) {
    const ways = table[command];
    if (ways === undefined) {
      throw new Error(`no case for ${command}: say how to run it here`);
    }
    for (const how of ways) {
      const refusal = dryRunRefusal(parseArgs([...how.args]));
      const line = [...how.args, "--source", join(root, "marbles.ts")];
      for (const position of positions) {
        const flagged =
          position === "before"
            ? ["--dry-run", ...line]
            : [...line, "--dry-run"];
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
        expect(snapshot(), what).toEqual(before);
        options.after?.(what);
      }
    }
  }
}

const AT_LOAD = `import { agent, artifact, sandbox, step, tasks, workspace } from "@foundry.sh/marbles";
const repo = workspace({ path: "." });
const writer = agent({ name: "writer", prompt: "Write." });
const notes = artifact({ name: "notes", type: "text/markdown" });
const box = sandbox({});
step("hello").do(() => "hi");
const attempt = async (what, work) => {
  try {
    await work();
  } catch (error) {
    console.error("[at load] " + what + ": " + String(error));
  }
};
await attempt("git", () => repo.git.worktree({ base: "HEAD", branch: "made-at-load" }));
await attempt("model", () => writer.generate("Hello"));
await attempt("artifact", () => notes.write({ "a.md": "# At load" }));
await attempt("sandbox", () => box.exec(["true"]));
await attempt("task", () => tasks.create({ title: "At load" }));
`;

function repository(root: string): string {
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).stdout;
  return `${git("branch", "--format=%(refname:short)")}${git("worktree", "list", "--porcelain")}`;
}

describe("every command under --dry-run", { timeout: 600_000 }, () => {
  it("refuses the flag for each action that writes, and only for those", () => {
    const refusal = (...args: string[]) => dryRunRefusal(parseArgs(args));
    expect(refusal("init")).toBe(
      "init writes a starter module; it takes no --dry-run"
    );
    expect(refusal("tasks", "list")).toBeUndefined();
    expect(refusal()).toBeUndefined();
    expect(refusal("run", "hello")).toBeUndefined();
    expect(refusal("enqueue", "hello")).toMatch(REFUSED);
    for (const action of ["start", "stop", "attach", "detach"]) {
      expect(refusal("daemon", action), action).toMatch(REFUSED);
    }
    expect(refusal("runs")).toBeUndefined();
    expect(refusal("artifacts", "list", "--all")).toBeUndefined();
    expect(refusal("artifacts", "relink")).toBe(
      "artifacts relink rebuilds links from the Marbles database; it takes no --dry-run"
    );
    expect(refusal("sessions", "share", "ses-1", "../two")).toBe(
      "sessions share changes what the Marbles database keeps; it takes no --dry-run"
    );
    expect(refusal("theme")).toBeUndefined();
    expect(refusal("theme", "list")).toBeUndefined();
    expect(refusal("theme", "light")).toBe(
      "theme <name> saves the theme; it takes no --dry-run"
    );
  });

  it("has a dry mode, only reads, or refuses the flag before or after the command, and changes nothing", async () => {
    const home = testHome();
    const top = await realpath(temporaryDirectory("marbles-dry-resources-"));
    const { artifact, root } = await seeded(home, top);
    walk(home, top, root, artifact, ["before", "after"]);
  });

  it("keeps a definition used while the source loads dry too, under every command that loads it, the repository included", async () => {
    const home = testHome();
    const top = await realpath(temporaryDirectory("marbles-dry-load-"));
    const root = join(top, "one");
    mkdirSync(root);
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git(
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "user.name=test",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init"
    );
    writeFileSync(join(root, "marbles.ts"), AT_LOAD);
    const repositoryBefore = repository(root);
    const loads = (command: string) => {
      const { needs } = COMMANDS[command as keyof typeof COMMANDS];
      return needs === "triggers" || needs === "connection";
    };
    expect(Object.keys(COMMANDS).filter(loads).sort()).toEqual([
      "dashboard",
      "enqueue",
      "list",
      "run",
    ]);
    walk(home, top, root, "artifact#missing", ["after"], {
      after: (what) => expect(repository(root), what).toBe(repositoryBefore),
      only: loads,
    });
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
    const attached = marbles("daemon", "attach");
    expect(attached.status, attached.stderr).toBe(0);
    const dry = marbles("tasks", "create", "Dry", "--dry-run");
    expect(dry.status, dry.stderr).toBe(0);
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
