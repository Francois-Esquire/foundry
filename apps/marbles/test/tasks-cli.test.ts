import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cliArgs } from "./helpers/cli";

// The host loads sources through a Bun plugin; vitest runs under Node, and
// these tests load none.
vi.mock("bun", () => ({ plugin: vi.fn() }));

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "marbles-tasks-"));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

function marbles(...argv: readonly string[]) {
  const result = spawnSync(
    "bun",
    cliArgs(...argv, "--state", join(root, "state")),
    { cwd: root, encoding: "utf8", timeout: 15_000 }
  );
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

const USAGE_REFUSAL = /^tasks list: unknown option --tags\n\nmarbles/;
const TASKS_FILE = /^[0-9a-f]+\/tasks\.json$/;
const TASK_LINE = /^tk-[0-9a-f]{8} {2}open {2}Write docs {2}\(task\)\n$/;
const HELD =
  /^marbles: the tasks of this workspace .* are in use by pid \d+\n$/;

// These scenarios start five or more CLI processes in sequence. Budget their
// combined startup cost under parallel CI load, beyond each child's timeout.
const MULTI_PROCESS_TIMEOUT = 30_000;

it("prints a change as text, or as JSON with --json", () => {
  const text = marbles("tasks", "create", "Write docs");
  expect(text).toMatchObject({ status: 0, stderr: "" });
  expect(text.stdout).toMatch(TASK_LINE);

  const json = marbles(
    "tasks",
    "change",
    "--json",
    "--input",
    JSON.stringify({
      operations: [
        { input: { title: "A" }, key: "a", kind: "task.create" },
        {
          input: { title: "B" },
          key: "b",
          kind: "task.create",
          parent: { key: "a" },
        },
      ],
    })
  );
  expect(json.status, json.stderr).toBe(0);
  const result = JSON.parse(json.stdout);
  expect(result.changed.map((item: { key: string }) => item.key)).toEqual([
    "a",
    "b",
  ]);
  expect(result.tasks[1].parentId).toBe(result.tasks[0].id);
});

/** Every file under `dir`, relative to it; directories alone are not listed. */
async function files(dir: string): Promise<string[]> {
  if (!existsSync(dir)) {
    return [];
  }
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

it("keeps a change for the next process in the same workspace", async () => {
  const created = marbles("tasks", "create", "Persist me", "--json");
  expect(created.status, created.stderr).toBe(0);
  const { tasks } = JSON.parse(created.stdout);
  const listed = marbles("tasks", "list", "--json");
  expect(listed.status, listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout)).toEqual({ items: tasks, total: 1 });
  // One records document, and no lock left behind once the process ended.
  const stored = await files(join(root, "state"));
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatch(TASKS_FILE);
});

it(
  "--dry-run keeps tasks in memory and leaves the workspace's untouched",
  async () => {
    // Alone, a dry run writes no task state at all: no records, no lock.
    expect(marbles("tasks", "create", "Dry first", "--dry-run").status).toBe(0);
    expect(await files(join(root, "state"))).toEqual([]);
    expect(marbles("tasks", "create", "Real").status).toBe(0);
    const [path] = await files(join(root, "state"));
    const before = await readFile(join(root, "state", path ?? ""), "utf8");

    const dry = marbles("tasks", "create", "Dry", "--dry-run");
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("Dry");
    expect(marbles("tasks", "list", "--dry-run").stdout).toBe(
      "no tasks (0 matching)\n"
    );
    expect(await readFile(join(root, "state", path ?? ""), "utf8")).toBe(
      before
    );
    const real = JSON.parse(marbles("tasks", "list", "--json").stdout);
    expect(real.items.map((task: { title: string }) => task.title)).toEqual([
      "Real",
    ]);
  },
  MULTI_PROCESS_TIMEOUT
);

it("reads without executing source or writing a file", async () => {
  const source = join(root, ".foundry", "marbles");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "index.ts"),
    'throw new Error("source must not run");\n'
  );
  const listed = marbles("tasks", "list");
  expect(listed).toEqual({
    status: 0,
    stderr: "",
    stdout: "no tasks (0 matching)\n",
  });
  const ready = marbles("tasks", "ready", "--json");
  expect(JSON.parse(ready.stdout)).toEqual({ items: [], total: 0 });
  expect(await files(join(root, "state"))).toEqual([]);
  expect(await readdir(root)).toEqual([".foundry", "state"]);
});

it(
  "sets, filters, replaces, and clears tags",
  () => {
    const tagged = marbles(
      "tasks",
      "create",
      "Tagged",
      "--tag",
      "review",
      "--tag",
      "api",
      "--json"
    );
    const [task] = JSON.parse(tagged.stdout).tasks;
    expect(task.tags).toEqual(["review", "api"]);
    expect(marbles("tasks", "create", "Plain").status).toBe(0);

    const titles = (...argv: string[]) =>
      JSON.parse(marbles("tasks", ...argv, "--json").stdout).items.map(
        (item: { title: string }) => item.title
      );
    expect(titles("list", "--tag", "review", "--tag", "api")).toEqual([
      "Tagged",
    ]);
    expect(titles("list", "--any-tag", "x", "--any-tag", "api")).toEqual([
      "Tagged",
    ]);
    expect(titles("ready", "--tag", "missing")).toEqual([]);
    expect(marbles("tasks", "list").stdout).toContain(
      `${task.id}  open  Tagged  [review, api]`
    );

    const replaced = marbles(
      "tasks",
      "update",
      task.id,
      "--tag",
      "done",
      "--json"
    );
    expect(JSON.parse(replaced.stdout).tasks[0].tags).toEqual(["done"]);
    const cleared = marbles(
      "tasks",
      "update",
      task.id,
      "--clear-tags",
      "--json"
    );
    expect(JSON.parse(cleared.stdout).tasks[0].tags).toEqual([]);
  },
  MULTI_PROCESS_TIMEOUT
);

it("reports a refusal or an unusable line on stderr and exits 1", () => {
  const missing = marbles("tasks", "get", "nope");
  expect(missing).toEqual({
    status: 1,
    stderr: "marbles: [tasks] Task nope not found (not_found)\n",
    stdout: "",
  });
  const rejected = marbles("tasks", "create", "Orphan", "--parent", "nope");
  expect(rejected.status).toBe(1);
  expect(rejected.stderr).toContain("(not_found)");
  expect(rejected.stdout).toBe("");

  const usage = marbles("tasks", "list", "--tags", "review");
  expect(usage.status).toBe(1);
  expect(usage.stdout).toBe("");
  expect(usage.stderr).toMatch(USAGE_REFUSAL);
  expect(usage.stderr).toContain("tasks change --input");
});

it("gives up the workspace's tasks when the engine is disposed", async () => {
  const { findWorkspace, hostTasks, workspaceEngine } = await import(
    "~/workspace/open"
  );
  const flags = {
    artifacts: join(root, "artifacts"),
    config: join(root, "missing.ts"),
    dry: false,
    only: [],
    state: join(root, "state"),
  };
  const opened = findWorkspace(flags);
  const engine = workspaceEngine(flags, opened, { print: () => undefined });
  const tasks = hostTasks(engine);
  await tasks.create({ tags: ["kept"], title: "Owned" });
  // While this engine owns them, another engine over the workspace is refused.
  const other = workspaceEngine(flags, opened, { print: () => undefined });
  await expect(hostTasks(other).list()).rejects.toThrow("in use by");
  await engine.dispose();
  // Afterwards the tasks are refused here, never answered from memory.
  await expect(tasks.list()).rejects.toThrow("workspace records are closed");
  // And the other engine can take them over.
  const page = await hostTasks(other).list();
  expect(page.items.map((task) => task.tags)).toEqual([["kept"]]);
  await other.dispose();
  expect(await files(join(root, "state"))).toHaveLength(1);
});

it("refuses a separate process the tasks another process owns, and lets go when it does", async () => {
  const { findWorkspace, hostTasks, workspaceEngine } = await import(
    "~/workspace/open"
  );
  // Never imported here or by the CLI: only its place names the workspace.
  const source = join(root, ".foundry", "marbles");
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, "index.ts"),
    'throw new Error("source must not run");\n'
  );
  const flags = {
    artifacts: join(root, "artifacts"),
    config: source,
    dry: false,
    only: [],
    state: join(root, "state"),
  };
  const engine = workspaceEngine(flags, findWorkspace(flags), {
    print: () => undefined,
  });
  try {
    await hostTasks(engine).create({ title: "Owned here" });
    const held = marbles("tasks", "list", "--json", "--source", source);
    expect(held.status, held.stderr).toBe(1);
    expect(held.stdout).toBe("");
    expect(held.stderr).toMatch(HELD);
  } finally {
    await engine.dispose();
  }
  const freed = marbles("tasks", "list", "--json", "--source", source);
  expect(freed.status, freed.stderr).toBe(0);
  expect(JSON.parse(freed.stdout)).toMatchObject({
    items: [{ title: "Owned here" }],
    total: 1,
  });
});
