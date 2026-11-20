import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceState } from "~/lib/state/workspace";
import { cliArgs } from "./helpers/cli";
import { type TestHome, testHome } from "./helpers/home";

vi.mock("bun", () => ({ plugin: vi.fn() }));

const USAGE_REFUSAL = /^tasks list: unknown option --tags\n\nmarbles/;
const TASK_LINE = /^tk-[0-9a-f]{8} {2}open {2}Write docs {2}\(task\)\n$/;

describe("tasks CLI", { timeout: 30_000 }, () => {
  let root: string;
  let home: TestHome;
  let state: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "marbles-tasks-"));
    home = testHome({ providers: false });
    ({ state } = home.layout);
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  function marbles(...argv: readonly string[]) {
    const result = spawnSync("bun", cliArgs(...argv), {
      cwd: root,
      encoding: "utf8",
      env: home.env,
      timeout: 15_000,
    });
    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }

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

  async function files(dir: string): Promise<string[]> {
    if (!existsSync(dir)) {
      return [];
    }
    const entries = await readdir(dir, {
      recursive: true,
      withFileTypes: true,
    });
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
    const stored = await files(state);
    expect(stored).toContain("marbles.db");
    expect(stored.filter((file) => file.includes("tasks"))).toEqual([]);
  });

  it("--dry-run keeps tasks in memory and leaves the workspace's untouched", async () => {
    expect(marbles("tasks", "create", "Dry first", "--dry-run").status).toBe(0);
    expect(await files(state)).toEqual([]);
    expect(marbles("tasks", "create", "Real").status).toBe(0);
    const [path] = await files(state);
    const before = await readFile(join(state, path ?? ""), "utf8");

    const dry = marbles("tasks", "create", "Dry", "--dry-run");
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toContain("Dry");
    expect(marbles("tasks", "list", "--dry-run").stdout).toBe(
      "no tasks (0 matching)\n"
    );
    expect(await readFile(join(state, path ?? ""), "utf8")).toBe(before);
    const real = JSON.parse(marbles("tasks", "list", "--json").stdout);
    expect(real.items.map((task: { title: string }) => task.title)).toEqual([
      "Real",
    ]);
  });

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
    expect(await readdir(root)).toEqual([".foundry"]);
    expect(existsSync(state)).toBe(false);
  });

  it("reads a database with tasks in it and creates or changes nothing", async () => {
    const [parent] = JSON.parse(
      marbles("tasks", "create", "Parent", "--json").stdout
    ).tasks;
    const child = marbles("tasks", "create", "Child", "--parent", parent.id);
    expect(child.status, child.stderr).toBe(0);
    const look = async () =>
      await Promise.all(
        (await files(state)).map(async (file) => {
          const path = join(state, file);
          const { ino, mtimeMs, size } = await stat(path);
          if (file.endsWith("-shm")) {
            return { file, ino, size };
          }
          const bytes = await readFile(path, "base64");
          return { bytes, file, ino, mtimeMs, size };
        })
      );
    const before = await look();
    const entries = async () =>
      (await readdir(state, { recursive: true })).sort();
    const directories = await entries();

    for (const argv of [
      ["tasks", "list", "--json"],
      ["tasks", "ready", "--json"],
      ["tasks", "get", parent.id, "--json"],
      ["tasks", "deps", parent.id, "--json"],
    ]) {
      const read = marbles(...argv);
      expect(read.status, `${argv.join(" ")}: ${read.stderr}`).toBe(0);
    }
    expect(
      JSON.parse(marbles("tasks", "list", "--json").stdout).items.map(
        (task: { title: string }) => task.title
      )
    ).toEqual(["Parent", "Child"]);

    expect(await look()).toEqual(before);
    expect(await entries()).toEqual(directories);
  });

  it("sets, filters, replaces, and clears tags", () => {
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
  });

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

  it("refuses the tasks when the workspace's state links out of the state root", async () => {
    const outside = join(root, "outside");
    await mkdir(state, { recursive: true });
    await mkdir(outside);
    await symlink(outside, workspaceState(state, root).dir);
    const refused = marbles("tasks", "create", "Outside");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("is not a directory inside");
    expect(await readdir(outside)).toEqual([]);
  });

  it("keeps two workspaces' tasks apart under one state root", async () => {
    const inProject = (project: string, ...argv: readonly string[]) =>
      spawnSync("bun", cliArgs(...argv), {
        cwd: project,
        encoding: "utf8",
        env: home.env,
        timeout: 15_000,
      });
    const [a, b] = [join(root, "a"), join(root, "b")];
    await mkdir(a);
    await mkdir(b);
    expect(inProject(a, "tasks", "create", "Only in A").status).toBe(0);
    expect(inProject(b, "tasks", "create", "Only in B").status).toBe(0);
    const titles = (project: string) =>
      JSON.parse(
        inProject(project, "tasks", "list", "--json").stdout
      ).items.map((task: { title: string }) => task.title);
    expect(titles(a)).toEqual(["Only in A"]);
    expect(titles(b)).toEqual(["Only in B"]);
  });

  it("lets several commands change the tasks at once with no Marbles process running", async () => {
    const titles = ["One", "Two", "Three", "Four"];
    const results = await Promise.all(
      titles.map(
        (title) =>
          new Promise<{ code: number | null; stderr: string }>((done) => {
            const child = spawn("bun", cliArgs("tasks", "create", title), {
              cwd: root,
              env: home.env,
            });
            home.track(child.pid, false);
            let stderr = "";
            child.stderr?.on("data", (chunk: Buffer) => {
              stderr += chunk.toString();
            });
            child.once("exit", (code) => done({ code, stderr }));
          })
      )
    );
    for (const result of results) {
      expect(result.code, result.stderr).toBe(0);
    }
    const listed = JSON.parse(marbles("tasks", "list", "--json").stdout);
    expect(
      listed.items.map((task: { title: string }) => task.title).sort()
    ).toEqual([...titles].sort());
  });

  it("makes the database with no Marbles process running, and leaves the state root free", () => {
    const created = marbles("tasks", "create", "First");
    expect(created.status, created.stderr).toBe(0);
    expect(existsSync(join(state, "marbles.db"))).toBe(true);
    expect(existsSync(join(state, "locks", "process"))).toBe(false);
  });

  it("lets a separate process read and change the tasks while another has them open", async () => {
    const { openHostDatabase } = await import("~/database/workspaces");
    const { DatabaseWorkspaceRecords } = await import("~/database/tasks");
    const { Tasks } = await import("@foundry/tasks");
    const source = join(root, ".foundry", "marbles");
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "index.ts"),
      'throw new Error("source must not run");\n'
    );
    const { id } = workspaceState(state, root);
    const database = await openHostDatabase(state);
    const records = new DatabaseWorkspaceRecords({
      database: database.database,
      scope: id,
    });
    try {
      const tasks = new Tasks({ store: records.taskStore });
      await tasks.create({ title: "Open here" });
      const added = marbles(
        "tasks",
        "create",
        "From the CLI",
        "--source",
        source
      );
      expect(added.status, added.stderr).toBe(0);
      const listed = marbles("tasks", "list", "--json", "--source", source);
      expect(listed.status, listed.stderr).toBe(0);
      const titles = ["Open here", "From the CLI"];
      expect(
        JSON.parse(listed.stdout).items.map(
          (task: { title: string }) => task.title
        )
      ).toEqual(titles);
      expect((await tasks.list()).items.map((task) => task.title)).toEqual(
        titles
      );
    } finally {
      await records.close();
      database.close();
    }
  });
});
