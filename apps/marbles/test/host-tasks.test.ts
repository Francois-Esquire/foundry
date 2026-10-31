/**
 * The builtin `tasks` under a real host, in real processes: source loaded
 * through `openWorkspace` (a Bun plugin, so each scenario runs in its own
 * `bun` process), the engine built by `hostEngine`, and the records owned by
 * one OS process at a time.
 */

import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WorkspaceRecords } from "~/lib/events/records";

const SRC = resolve("src");
const IN_USE_BY = /in use by pid (\d+)/;

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "marbles-host-tasks-"));
  roots.push(root);
  return root;
}

/**
 * A workspace whose source observes `tasks` (appending each payload's titles
 * to `seen.log`, or throwing while `MARBLES_TEST_FAIL` is set) and tries to
 * write a task while it loads.
 */
async function workspace(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  const source = join(dir, "marbles.ts");
  await mkdir(dir, { recursive: true });
  await writeFile(
    source,
    `import { appendFileSync } from "node:fs";
import { observe, tasks } from "@foundry.sh/marbles";
observe(tasks, (payload) => {
  if (process.env.MARBLES_TEST_FAIL) throw new Error("down");
  const titles = payload.tasks.map((change) => change.after?.title ?? "-");
  appendFileSync(${JSON.stringify(join(dir, "seen.log"))}, titles.join(",") + "\\n");
});
try {
  await tasks.create({ title: "during load" });
  globalThis.loadAccess = "accepted";
} catch (error) {
  globalThis.loadAccess = error.message;
}
`
  );
  return source;
}

/** Runs `body` in a fresh `bun` process with the host and `tasks` in scope; resolves its JSON report. */
async function inHost(
  root: string,
  body: string,
  env: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  const script = join(root, `host-${String(Date.now())}.ts`);
  await writeFile(
    script,
    `import { hostEngine, openWorkspace } from ${JSON.stringify(join(SRC, "host.ts"))};
import { tasks } from ${JSON.stringify(join(SRC, "authoring/tasks.ts"))};
const report = {};
const open = async (source, state, dry = false) => {
  const args = { artifacts: ${JSON.stringify(join(root, "artifacts"))}, config: source, dry, only: [], state };
  const opened = await openWorkspace(args, { print: () => undefined });
  const engine = await hostEngine(args, opened, { print: () => undefined });
  await engine.start();
  return { engine, opened };
};
const attempt = (work) => work.then(() => "accepted", (error) => error.message);
${body}
process.stdout.write(JSON.stringify(report) + "\\n");
process.exit(0);
`
  );
  const output = execFileSync("bun", [script], {
    cwd: resolve("."),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  const line = output.trim().split("\n").at(-1) ?? "{}";
  return JSON.parse(line);
}

function workspaceFile(state: string): string {
  const [id] = readdirSync(state).filter((entry) =>
    existsSync(join(state, entry, "tasks.json"))
  );
  if (id === undefined) {
    throw new Error(`no tasks.json under ${state}`);
  }
  return join(state, id, "tasks.json");
}

it("binds tasks to the loaded workspace, recovers its pending changes in the next process, and refuses access unbound", async () => {
  const root = await scratch();
  const source = await workspace(root, "first");
  const state = join(root, "state");

  // The handler fails in this process, so the change stays pending.
  const first = await inHost(
    root,
    `const { engine } = await open(${JSON.stringify(source)}, ${JSON.stringify(state)});
report.load = globalThis.loadAccess;
await tasks.create({ title: "hosted" });
report.listed = (await tasks.list()).items.map((task) => task.title);
await engine.dispose();
report.afterDispose = await attempt(tasks.create({ title: "late" }));`,
    { MARBLES_TEST_FAIL: "1" }
  );
  expect(first.load).toMatch("not available while its source loads");
  expect(first.listed).toEqual(["hosted"]);
  expect(first.afterDispose).toMatch("was disposed");
  const file = workspaceFile(state);
  const written = JSON.parse(readFileSync(file, "utf8"));
  expect(written.tasks.map((task: { title: string }) => task.title)).toEqual([
    "hosted",
  ]);
  expect(
    written.items.map((item: { delivered: string[] }) => item.delivered)
  ).toEqual([[]]);

  // A new process loads the same source: the task is there, and the pending
  // change is delivered to the same handler.
  const second = await inHost(
    root,
    `const { engine } = await open(${JSON.stringify(source)}, ${JSON.stringify(state)});
report.listed = (await tasks.list()).items.map((task) => task.title);
for (let i = 0; i < 500 && !(await Bun.file(${JSON.stringify(join(root, "first", "seen.log"))}).exists()); i += 1) {
  await new Promise((done) => setTimeout(done, 20));
}
await engine.dispose();`
  );
  expect(second.listed).toEqual(["hosted"]);
  expect(readFileSync(join(root, "first", "seen.log"), "utf8")).toBe(
    "hosted\n"
  );
  const delivered = JSON.parse(readFileSync(file, "utf8"));
  expect(
    delivered.items.map((item: { delivered: string[] }) => item.delivered)
  ).toEqual([[expect.any(String)]]);
}, 120_000);

it("rebinds to another workspace's engine in the same process", async () => {
  const root = await scratch();
  const one = await workspace(root, "one");
  const two = await workspace(root, "two");
  const report = await inHost(
    root,
    `const a = await open(${JSON.stringify(one)}, ${JSON.stringify(join(root, "state"))});
await tasks.create({ title: "in one" });
await a.engine.dispose();
report.unbound = await attempt(tasks.list());
const b = await open(${JSON.stringify(two)}, ${JSON.stringify(join(root, "state"))});
report.load = globalThis.loadAccess;
await tasks.create({ title: "in two" });
report.two = (await tasks.list()).items.map((task) => task.title);
await b.engine.dispose();`
  );
  expect(report.unbound).toMatch("was disposed");
  expect(report.load).toMatch("not available while its source loads");
  expect(report.two).toEqual(["in two"]);
}, 120_000);

it("keeps a dry run's tasks in memory and writes nothing to the state dir", async () => {
  const root = await scratch();
  const source = await workspace(root, "dry");
  const state = join(root, "state");
  const report = await inHost(
    root,
    `const { engine } = await open(${JSON.stringify(source)}, ${JSON.stringify(state)}, true);
await tasks.create({ title: "dry" });
report.listed = (await tasks.list()).items.map((task) => task.title);
await engine.dispose();`
  );
  expect(report.listed).toEqual(["dry"]);
  const files = existsSync(state)
    ? readdirSync(state, { recursive: true }).map(String)
    : [];
  expect(files.filter((file) => file.endsWith("tasks.json"))).toEqual([]);
  expect(files.filter((file) => file.includes("locks"))).toEqual([]);
}, 120_000);

it("refuses a second OS process the records, until the owner exits", async () => {
  const root = await scratch();
  const dir = join(root, "state");
  const script = join(root, "owner.ts");
  await writeFile(
    script,
    `import { WorkspaceRecords } from ${JSON.stringify(join(SRC, "lib/events/records.ts"))};
const records = new WorkspaceRecords({ dir: ${JSON.stringify(dir)} });
await records.taskStore.commit({ putTasks: [] });
process.stdout.write("ready\\n");
setInterval(() => undefined, 1000);
`
  );
  const owner = spawn("bun", [script], { cwd: resolve(".") });
  children.push(owner);
  await new Promise<void>((ready, failed) => {
    owner.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) {
        ready();
      }
    });
    owner.once("exit", (code) => failed(new Error(`owner exited ${code}`)));
  });

  const contender = new WorkspaceRecords({ dir });
  const refusal = await contender.taskStore.snapshot().then(
    () => "accepted",
    (error: Error) => error.message
  );
  expect(refusal).toMatch(IN_USE_BY);
  expect(IN_USE_BY.exec(refusal)?.[1]).toBe(String(owner.pid));

  // The owner dies without releasing; its lock is stale and is taken over.
  owner.kill("SIGKILL");
  await new Promise((done) => owner.once("exit", done));
  await expect(contender.taskStore.snapshot()).resolves.toEqual({
    dependencies: [],
    tasks: [],
  });
  await contender.close();
}, 60_000);
