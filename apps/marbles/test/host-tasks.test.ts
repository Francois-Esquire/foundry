import type { ChildProcess } from "node:child_process";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tasks } from "@foundry/tasks/store/tables";
import { max } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { readDatabase } from "~/database/open";
import { marblesChangeLogs, marblesObservers } from "~/database/tables";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { NODE_OWNER_LIVENESS } from "~/host/liveness";
import { stateDatabase } from "~/layout";
import { connect } from "~/process/client";
import type { Daemon } from "~/process/daemon";
import { startDaemon } from "~/process/daemon";
import { recordSpawned } from "~/process/spawned";
import { testHome } from "./helpers/home";

const SRC = resolve("src");

const roots: string[] = [];
const children: ChildProcess[] = [];
const daemons: Daemon[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "marbles-host-tasks-"));
  roots.push(root);
  return root;
}

async function workspace(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  const source = join(dir, "marbles.ts");
  await mkdir(dir, { recursive: true });
  await writeFile(
    source,
    `import { appendFileSync } from "node:fs";
import { observe, tasks } from "@foundry.sh/marbles";
export const seenTitles = observe(tasks, function seenTitles(payload) {
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

async function inHost(
  root: string,
  body: string,
  env: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  const script = join(root, `host-${String(Date.now())}.ts`);
  await writeFile(
    script,
    `import { hostEngine, openWorkspace } from ${JSON.stringify(join(SRC, "workspace/open.ts"))};
import { openHostDatabase } from ${JSON.stringify(join(SRC, "database/open.ts"))};
import { tasks } from ${JSON.stringify(join(SRC, "authoring/tasks.ts"))};
const report = {};
const open = async (source, state) => {
  const args = { artifacts: ${JSON.stringify(join(root, "artifacts"))}, config: source, state };
  const opened = await openWorkspace(args, { print: () => undefined });
  const database = await openHostDatabase(state);
  const engine = await hostEngine(args, opened, { database, print: () => undefined });
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

async function stored(state: string): Promise<{
  readonly head: number;
  readonly observers: readonly {
    readonly failing: boolean;
    readonly name: string;
    readonly position: number;
  }[];
  readonly titles: readonly string[];
}> {
  const read = await readDatabase(stateDatabase(state), async (database) => {
    const observers = await database
      .select({
        failures: marblesObservers.failures,
        name: marblesObservers.name,
        position: marblesObservers.position,
      })
      .from(marblesObservers)
      .orderBy(marblesObservers.scope, marblesObservers.name);
    const titles = await database
      .select({ title: tasks.title })
      .from(tasks)
      .orderBy(tasks.position);
    const [head] = await database
      .select({ position: max(marblesChangeLogs.position) })
      .from(marblesChangeLogs);
    return {
      head: head?.position ?? 0,
      observers: observers.map((row) => ({
        failing: row.failures > 0,
        name: row.name,
        position: row.position,
      })),
      titles: titles.map((row) => row.title),
    };
  });
  if (read === undefined) {
    throw new Error(`no Marbles database under ${state}`);
  }
  return read;
}

it("binds tasks to the loaded workspace, recovers its pending changes in the next process, and refuses access unbound", async () => {
  const root = await scratch();
  const source = await workspace(root, "first");
  const state = join(root, "state");

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
  const written = await stored(state);
  expect(written.titles).toEqual(["hosted"]);
  expect(written.observers).toEqual([
    { failing: expect.any(Boolean), name: "seenTitles", position: 0 },
  ]);

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
  const after = await stored(state);
  expect(after.observers).toEqual([
    { failing: false, name: "seenTitles", position: after.head },
  ]);
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

it("loses no update when two OS processes change one workspace's tasks at once", async () => {
  const root = await scratch();
  const state = join(root, "state");
  const rounds = 15;
  const seeded = await inHost(
    root,
    `import { changeTasks } from ${JSON.stringify(join(SRC, "database/open.ts"))};
report.id = (await changeTasks(${JSON.stringify(state)}, "shared", (tasks) => tasks.create({ metadata: { count: 0 }, title: "counter" }))).id;`
  );
  const counter = join(root, "counter.ts");
  await writeFile(
    counter,
    `import { changeTasks } from ${JSON.stringify(join(SRC, "database/open.ts"))};
const [name] = process.argv.slice(2);
let refused = 0;
for (let round = 0; round < ${String(rounds)}; round += 1) {
  for (;;) {
    try {
      await changeTasks(${JSON.stringify(state)}, "shared", async (tasks) => {
        const task = await tasks.get(${JSON.stringify(seeded.id)});
        await tasks.update(task.id, { metadata: { count: task.metadata.count + 1 } }, { expectedUpdatedAt: task.updatedAt });
        await tasks.create({ title: name + "-" + String(round) });
      });
      break;
    } catch (error) {
      if (error?.name !== "TaskError") throw error;
      refused += 1;
    }
  }
}
process.stdout.write(JSON.stringify({ refused }) + "\\n");
`
  );
  const run = (name: string) =>
    new Promise<string>((done, failed) => {
      const child = spawn("bun", [counter, name], { cwd: resolve(".") });
      recordSpawned(child.pid, false);
      children.push(child);
      let output = "";
      let errors = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        errors += chunk.toString();
      });
      child.once("exit", (code) =>
        code === 0 ? done(output) : failed(new Error(`${name}: ${errors}`))
      );
    });
  await Promise.all([run("a"), run("b")]);

  const after = await readDatabase(stateDatabase(state), async (database) => {
    const records = new DatabaseWorkspaceRecords({
      database,
      liveness: NODE_OWNER_LIVENESS,
      scope: "shared",
    });
    const { tasks: all } = await records.taskStore.snapshot();
    return {
      changes: (await records.log.read({ after: 0, source: "tasks" })).length,
      count: all.find((task) => task.title === "counter")?.metadata.count,
      tasks: all.length,
    };
  });
  expect(after).toEqual({
    changes: 1 + 2 * 2 * rounds,
    count: 2 * rounds,
    tasks: 1 + 2 * rounds,
  });
}, 120_000);

function generationSource(dir: string, revision: number): string {
  const zod = createRequire(import.meta.url).resolve("zod");
  return `import { appendFileSync } from "node:fs";
import { observe, step, tasks } from "@foundry.sh/marbles";
import { z } from ${JSON.stringify(zod)};
export const seenTitles = observe(tasks, function seenTitles(payload) {
  const revision = ${String(revision)};
  const titles = payload.tasks.map((change) => change.after?.title ?? "-");
  appendFileSync(${JSON.stringify(join(dir, "seen.log"))}, titles.join(",") + (revision > 0 ? "\\n" : ""));
});

const titles = async () => (await tasks.list()).items.map((task) => task.title);
export const add = step("add")
  .input(z.object({ title: z.string() }))
  .do(async ({ input }) => {
    await tasks.create({ title: input.title });
    return titles();
  });
export const list = step("list").do(titles);
// revision ${String(revision)}
`;
}

it("binds tasks to the workspace a generation hosts, and hands its records to the generation a reload starts", async () => {
  const home = testHome({ providers: false });
  const root = join(home.path, "project");
  await mkdir(root);
  const source = join(root, "marbles.config.ts");
  await writeFile(source, generationSource(root, 1));
  const machine = home.layout;
  daemons.push(await startDaemon({ layout: machine, print: () => undefined }));
  const client = await connect({ layout: machine, start: false });
  try {
    const summary = await client.attach(source);
    const hosted = client.workspace(summary);
    const first = summary.pid;

    expect((await hosted.roll("add", { title: "hosted" })).value).toEqual([
      "hosted",
    ]);
    const seen = join(root, "seen.log");
    await vi.waitFor(
      () => expect(readFileSync(seen, "utf8")).toBe("hosted\n"),
      {
        interval: 100,
        timeout: 30_000,
      }
    );
    await vi.waitFor(
      async () => {
        const now = await stored(machine.state);
        expect(now.observers).toEqual([
          { failing: false, name: "seenTitles", position: now.head },
        ]);
      },
      { interval: 100, timeout: 30_000 }
    );

    await writeFile(source, generationSource(root, 2));
    await vi.waitFor(
      async () => {
        const [now] = await client.workspaces();
        expect(now?.state).toBe("ready");
        expect(now?.pid).not.toBe(first);
      },
      { interval: 250, timeout: 30_000 }
    );
    await vi.waitFor(
      async () => {
        expect((await hosted.roll("list")).value).toEqual(["hosted"]);
      },
      { interval: 250, timeout: 30_000 }
    );
    expect((await hosted.roll("add", { title: "reloaded" })).value).toEqual([
      "hosted",
      "reloaded",
    ]);
    await vi.waitFor(
      () => expect(readFileSync(seen, "utf8")).toBe("hosted\nreloaded\n"),
      { interval: 100, timeout: 30_000 }
    );
    await client.detach(summary.id);
    expect(existsSync(join(machine.state, summary.id, "locks", "tasks"))).toBe(
      false
    );
    expect((await stored(machine.state)).titles).toEqual([
      "hosted",
      "reloaded",
    ]);
  } finally {
    client.close();
  }
}, 120_000);
