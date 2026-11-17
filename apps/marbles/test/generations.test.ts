import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { processAlive } from "@foundry/lib/process-identity";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationRecords, readLiveGenerations } from "~/database/generations";
import { readDatabase } from "~/database/open";
import { marblesExecutions, marblesGenerations } from "~/database/tables";
import { recordedWorkspaces, WorkspaceRegistry } from "~/database/workspaces";
import { type Layout, stateDatabase } from "~/layout";
import type { WorkspaceSummary } from "~/model/connection";
import { connect, type MarblesClient } from "~/process/client";
import {
  type Daemon,
  type DaemonClock,
  type DaemonOptions,
  startDaemon,
} from "~/process/daemon";
import { startedAt } from "~/process/spawned";
import { readStatus } from "~/status/model";
import { exitedPid, seedExecution, withExecutions } from "./helpers/executions";
import { testHome } from "./helpers/home";

interface Fixture {
  readonly gates: string;
  readonly log: string;
  readonly machine: Layout;
  readonly source: string;
}

const daemons: Daemon[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
});

const zodPath = createRequire(import.meta.url).resolve("zod");

function moduleText(
  fixture: Pick<Fixture, "gates" | "log">,
  revision: number,
  { broken = false, strict = false, ticking = false } = {}
): string {
  const holds = [1, 2]
    .map(
      (n) =>
        `export const hold${String(n)} = step("hold${String(n)}").do(async () => {
  note("hold${String(n)}");
  while (!existsSync(${JSON.stringify(join(fixture.gates, String(n)))})) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return process.pid;
});`
    )
    .join("\n");
  return [
    'import { appendFileSync, existsSync } from "node:fs";',
    'import { observe, schedule, step, tasks } from "@foundry.sh/marbles";',
    `import { z } from ${JSON.stringify(zodPath)};`,
    broken ? 'throw new Error("boom in revision");' : "",
    `const note = (what) => appendFileSync(${JSON.stringify(fixture.log)}, what + " " + process.pid + "\\n");`,
    'export const where = step("where").do(() => { note("where"); return process.pid; });',
    holds,
    `export const asking = step("asking").do(async ({ ask }) => {
  note("asking");
  const answer = await ask.question({ title: "Go on?", choices: ["yes", "no"] });
  note("answered");
  return answer;
});`,
    ticking
      ? `export const tick = step("tick").do(async () => {
  appendFileSync(${JSON.stringify(fixture.log)}, "tick " + process.pid + " " + Date.now() + "\\n");
  await new Promise((resolve) => setTimeout(resolve, 700));
  appendFileSync(${JSON.stringify(fixture.log)}, "tock " + process.pid + " " + Date.now() + "\\n");
});
schedule(tick).every("1s");`
      : "",
    'export const crash = step("crash").do(() => process.exit(1));',
    `export const late = step("late").do(async ({ ask }) => {
  note("late");
  while (!existsSync(${JSON.stringify(join(fixture.gates, "late"))})) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const answer = await ask.question({ title: "Late?", choices: ["yes", "no"] });
  note("answered-late");
  return answer;
});`,
    `export const picky = step("picky")
  .input(z.object({ n: ${strict ? "z.string()" : "z.number()"} }))
  .do(async ({ ask }) => {
    note("picky");
    return await ask.question({ title: "Picky?", choices: ["yes", "no"] });
  });`,
    `observe(tasks, (payload) => {
  for (const change of payload.tasks) {
    note("seen-" + (change.after?.title ?? "-"));
  }
});
export const add = step("add")
  .input(z.object({ title: z.string() }))
  .do(async ({ input }) => {
    await tasks.create({ title: input.title });
  });`,
    `// revision ${String(revision)}`,
    "",
  ].join("\n");
}

async function setUp({
  daemon = {},
  ticking = false,
}: {
  readonly daemon?: Partial<DaemonOptions>;
  readonly ticking?: boolean;
} = {}): Promise<
  Fixture & {
    readonly client: MarblesClient;
    readonly daemon: Daemon;
    readonly summary: WorkspaceSummary;
  }
> {
  const home = testHome({ providers: false });
  const root = join(home.path, "project");
  mkdirSync(root);
  const gates = join(home.path, "gates");
  mkdirSync(gates);
  const fixture = {
    gates,
    log: join(home.path, "steps.log"),
    machine: home.layout,
    source: join(root, "marbles.config.ts"),
  };
  writeFileSync(fixture.log, "");
  writeFileSync(fixture.source, moduleText(fixture, 0, { ticking }));
  const started = await startDaemon({
    layout: fixture.machine,
    print: () => undefined,
    ...daemon,
  });
  daemons.push(started);
  const client = await connect({ layout: fixture.machine, start: false });
  const summary = await client.attach(fixture.source);
  return { ...fixture, client, daemon: started, summary };
}

function handClock(): DaemonClock & { advance(ms: number): void } {
  let now = 0;
  const timers = new Map<
    number,
    { readonly at: number; readonly work: () => void }
  >();
  let next = 0;
  return {
    advance(ms) {
      now += ms;
      for (const [handle, timer] of [...timers].sort(
        ([, a], [, b]) => a.at - b.at
      )) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.work();
        }
      }
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    setTimeout(work, ms) {
      next += 1;
      timers.set(next, { at: now + ms, work });
      return next;
    },
  };
}

const failingStop = join(
  import.meta.dirname,
  "helpers",
  "generation-failing-stop.ts"
);

async function stored(
  fixture: Pick<Fixture, "machine">,
  id: string
): Promise<boolean | undefined> {
  return (await recordedWorkspaces(fixture.machine.state)).find(
    (each) => each.id === id
  )?.hosted;
}

async function crashableDaemon() {
  const home = testHome({ providers: false });
  const root = join(home.path, "project");
  mkdirSync(root);
  const gates = join(home.path, "gates");
  mkdirSync(gates);
  const fixture = {
    gates,
    log: join(home.path, "steps.log"),
    machine: home.layout,
    source: join(root, "marbles.config.ts"),
  };
  writeFileSync(fixture.log, "");
  writeFileSync(fixture.source, moduleText(fixture, 0));
  const lines: string[] = [];
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, "helpers", "daemon-process.ts")],
    { env: home.env, stdio: ["ignore", "pipe", "inherit"] }
  );
  home.track(child.pid, false);
  child.stdout.on("data", (chunk: Buffer) => {
    lines.push(...chunk.toString().split("\n").filter(Boolean));
  });
  await vi.waitFor(
    () => expect(lines.some((line) => line.startsWith("ready "))).toBe(true),
    { interval: 50, timeout: 60_000 }
  );
  return { child, fixture, lines };
}

async function crash(child: ReturnType<typeof spawn>): Promise<void> {
  const pid = child.pid ?? 0;
  expect(startedAt(pid)).not.toBeNull();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  process.kill(pid, "SIGKILL");
  await exited;
}

async function numbered(fixture: Pick<Fixture, "machine">): Promise<number> {
  const rows = await readDatabase(
    stateDatabase(fixture.machine.state),
    (database) => database.select().from(marblesGenerations)
  );
  return rows?.length ?? 0;
}

function logged(fixture: Pick<Fixture, "log">): string[] {
  return readFileSync(fixture.log, "utf8").split("\n").filter(Boolean);
}

async function whenLogged(
  fixture: Pick<Fixture, "log">,
  line: string
): Promise<void> {
  await vi.waitFor(() => expect(logged(fixture)).toContain(line), {
    interval: 50,
    timeout: 30_000,
  });
}

async function switchFrom(
  fixture: Fixture & { readonly client: MarblesClient },
  before: number,
  revision: number,
  options: Parameters<typeof moduleText>[2] = {}
): Promise<number> {
  writeFileSync(fixture.source, moduleText(fixture, revision, options));
  let pid = before;
  await vi.waitFor(
    async () => {
      const [summary] = await fixture.client.workspaces();
      expect(summary?.state).toBe("ready");
      expect(summary?.pid).not.toBe(before);
      pid = summary?.pid ?? before;
    },
    { interval: 100, timeout: 60_000 }
  );
  return pid;
}

function open(gate: number | string, fixture: Pick<Fixture, "gates">): void {
  writeFileSync(join(fixture.gates, String(gate)), "");
}

async function readyOn(
  fixture: { readonly client: MarblesClient },
  which: (pid: number) => boolean
): Promise<number> {
  return await vi.waitFor(
    async () => {
      const [summary] = await fixture.client.workspaces();
      expect(summary?.state).toBe("ready");
      expect(which(summary?.pid ?? 0)).toBe(true);
      return summary?.pid ?? 0;
    },
    { interval: 200, timeout: 90_000 }
  );
}

async function openEntry(
  workspace: ReturnType<MarblesClient["workspace"]>,
  title: string
): Promise<string> {
  return await vi.waitFor(
    async () => {
      const { feed } = await workspace.snapshot();
      const entry = feed.find(
        (each) => each.input?.status === "open" && each.body.includes(title)
      );
      expect(entry).toBeDefined();
      return entry?.id ?? "";
    },
    { interval: 100, timeout: 60_000 }
  );
}

async function gone(pid: number, timeout = 30_000): Promise<void> {
  await vi.waitFor(() => expect(processAlive(pid)).toBe(false), {
    interval: 100,
    timeout,
  });
}

async function executions(
  fixture: Pick<Fixture, "machine">,
  scope: string
): Promise<readonly { readonly name: string; readonly status: string }[]> {
  return (
    (await readDatabase(stateDatabase(fixture.machine.state), (database) =>
      database
        .select({
          name: marblesExecutions.name,
          status: marblesExecutions.status,
        })
        .from(marblesExecutions)
        .where(eq(marblesExecutions.scope, scope))
    )) ?? []
  );
}

async function provedGeneration(
  fixture: Pick<Fixture, "machine">,
  pid: number,
  state: "current" | "retiring"
): Promise<void> {
  const [record] = (await readLiveGenerations(fixture.machine.state)).filter(
    (generation) => generation.pid === pid
  );
  expect(record?.state).toBe(state);
  expect(record?.started).toBe(startedAt(pid));
}

describe("engine generations", () => {
  it("terminates the old generation at once when it has no runs, and new work runs on the new one", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const second = await switchFrom(fixture, first, 1);
    await gone(first, 10_000);
    const workspace = fixture.client.workspace(fixture.summary);
    expect((await workspace.roll("where")).value).toBe(second);
    fixture.client.close();
  }, 90_000);

  it("lets the old generation finish the run it has, hands its queued run to the new one, then ends it", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    const holding = workspace.roll("hold1");
    await whenLogged(fixture, `hold1 ${String(first)}`);
    await workspace.actions.launch("where", {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(logged(fixture)).not.toContain(`where ${String(first)}`);

    const second = await switchFrom(fixture, first, 1);
    await whenLogged(fixture, `where ${String(second)}`);
    expect(logged(fixture)).not.toContain(`where ${String(first)}`);
    expect(processAlive(first)).toBe(true);
    expect((await workspace.roll("where")).value).toBe(second);

    open(1, fixture);
    expect((await holding).value).toBe(first);
    await gone(first);
    fixture.client.close();
  }, 120_000);

  it("hands a parked run to the new generation, which resumes it when answered", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    await workspace.actions.launch("asking", {});
    let entry: string | undefined;
    await vi.waitFor(
      async () => {
        const { feed } = await workspace.snapshot();
        entry = feed.find((each) => each.input?.status === "open")?.id;
        expect(entry).toBeDefined();
      },
      { interval: 100, timeout: 30_000 }
    );
    const second = await switchFrom(fixture, first, 1);
    await gone(first);
    await workspace.actions.answer(entry ?? "", "yes");
    await whenLogged(fixture, `answered ${String(second)}`);
    fixture.client.close();
  }, 120_000);

  it("keeps the current generation running when the candidate does not load, and switches once the source is fixed", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    writeFileSync(fixture.source, moduleText(fixture, 1, { broken: true }));
    await vi.waitFor(
      async () => {
        const [summary] = await fixture.client.workspaces();
        expect(summary?.error).toContain("boom in revision");
      },
      { interval: 100, timeout: 60_000 }
    );
    const [kept] = await fixture.client.workspaces();
    expect(kept).toMatchObject({ pid: first, state: "ready" });
    const workspace = fixture.client.workspace(fixture.summary);
    expect((await workspace.roll("where")).value).toBe(first);

    const second = await switchFrom(fixture, first, 2);
    expect((await workspace.roll("where")).value).toBe(second);
    const [fixed] = await fixture.client.workspaces();
    expect(fixed?.error).toBeUndefined();
    fixture.client.close();
  }, 120_000);

  it("recovers the runs of a retired generation that dies mid-run, through the next engine start", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    const holding = workspace.roll("hold1");
    holding.catch(() => undefined);
    await whenLogged(fixture, `hold1 ${String(first)}`);
    const second = await switchFrom(fixture, first, 1);
    expect(processAlive(first)).toBe(true);

    await provedGeneration(fixture, first, "retiring");
    process.kill(first, "SIGKILL");
    await expect(holding).rejects.toThrow();
    const third = await vi.waitFor(
      async () => {
        const [summary] = await fixture.client.workspaces();
        expect(summary?.state).toBe("ready");
        expect(summary?.pid).not.toBe(second);
        return summary?.pid ?? 0;
      },
      { interval: 100, timeout: 60_000 }
    );
    await vi.waitFor(
      async () => {
        const rows = await executions(fixture, fixture.summary.id);
        expect(rows.find((row) => row.name === "hold1")?.status).toBe(
          "interrupted"
        );
      },
      { interval: 200, timeout: 30_000 }
    );
    expect((await workspace.roll("where")).value).toBe(third);
    fixture.client.close();
  }, 150_000);

  it("keeps several generations alive through two switches in a row, each finishing its own run", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    const one = workspace.roll("hold1");
    await whenLogged(fixture, `hold1 ${String(first)}`);
    const second = await switchFrom(fixture, first, 1);
    const two = workspace.roll("hold2");
    await whenLogged(fixture, `hold2 ${String(second)}`);
    const third = await switchFrom(fixture, second, 2);
    expect([first, second, third].every((pid) => processAlive(pid))).toBe(true);
    expect((await workspace.roll("where")).value).toBe(third);

    open(2, fixture);
    expect((await two).value).toBe(second);
    await gone(second);
    expect(processAlive(first)).toBe(true);
    open(1, fixture);
    expect((await one).value).toBe(first);
    await gone(first);
    expect(existsSync(fixture.log)).toBe(true);
    fixture.client.close();
  }, 180_000);

  it("never ticks one schedule in two live generations at once, across switches", async () => {
    const fixture = await setUp({ ticking: true });
    const first = fixture.summary.pid ?? 0;
    await vi.waitFor(
      () =>
        expect(logged(fixture).some((line) => line.startsWith("tock "))).toBe(
          true
        ),
      { interval: 100, timeout: 30_000 }
    );
    const second = await switchFrom(fixture, first, 1, { ticking: true });
    const third = await switchFrom(fixture, second, 2, { ticking: true });
    await vi.waitFor(
      () =>
        expect(
          logged(fixture).some((line) =>
            line.startsWith(`tock ${String(third)} `)
          )
        ).toBe(true),
      { interval: 200, timeout: 60_000 }
    );
    const ticks = logged(fixture)
      .filter((line) => line.startsWith("tick ") || line.startsWith("tock "))
      .map((line) => line.split(" "));
    const runs: { pid: string; start: number; end?: number }[] = [];
    for (const [what, pid, at] of ticks) {
      if (what === "tick") {
        runs.push({ pid: pid ?? "", start: Number(at) });
      } else {
        const started = runs.find(
          (run) => run.pid === pid && run.end === undefined
        );
        if (started !== undefined) {
          started.end = Number(at);
        }
      }
    }
    runs.sort((a, b) => a.start - b.start);
    expect(new Set(runs.map((run) => run.pid)).size).toBeGreaterThan(1);
    for (const [index, run] of runs.entries()) {
      const before = runs[index - 1];
      if (before?.end !== undefined) {
        expect(run.start).toBeGreaterThanOrEqual(before.end);
        expect(run.start - before.end).toBeGreaterThanOrEqual(900);
      }
    }
    fixture.client.close();
  }, 150_000);

  it("starts the next generation when the current one dies", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    await provedGeneration(fixture, first, "current");
    process.kill(first, "SIGKILL");
    const second = await vi.waitFor(
      async () => {
        const [summary] = await fixture.client.workspaces();
        expect(summary?.state).toBe("ready");
        expect(summary?.pid).not.toBe(first);
        return summary?.pid ?? 0;
      },
      { interval: 100, timeout: 60_000 }
    );
    const workspace = fixture.client.workspace(fixture.summary);
    expect((await workspace.roll("where")).value).toBe(second);
    fixture.client.close();
  }, 120_000);

  it("cancels a run on the retired generation that owns it", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    const runId = await workspace.actions.launch("hold1", {});
    await whenLogged(fixture, `hold1 ${String(first)}`);
    await switchFrom(fixture, first, 1);
    await workspace.actions.runs.cancel(runId);
    await vi.waitFor(
      async () => {
        const rows = await executions(fixture, fixture.summary.id);
        expect(rows.find((row) => row.name === "hold1")?.status).toBe(
          "cancelled"
        );
      },
      { interval: 200, timeout: 30_000 }
    );
    await gone(first);
    fixture.client.close();
  }, 120_000);

  it("answers a question the new generation adopted while the old one still runs", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    await workspace.actions.launch("asking", {});
    let entry: string | undefined;
    await vi.waitFor(
      async () => {
        const { feed } = await workspace.snapshot();
        entry = feed.find((each) => each.input?.status === "open")?.id;
        expect(entry).toBeDefined();
      },
      { interval: 100, timeout: 30_000 }
    );
    const holding = workspace.roll("hold1");
    await whenLogged(fixture, `hold1 ${String(first)}`);
    const second = await switchFrom(fixture, first, 1);
    expect(processAlive(first)).toBe(true);

    await workspace.actions.answer(entry ?? "", "yes");
    await whenLogged(fixture, `answered ${String(second)}`);
    open(1, fixture);
    expect((await holding).value).toBe(first);
    await gone(first);
    expect(
      logged(fixture).filter((line) => line.startsWith("answered "))
    ).toEqual([`answered ${String(second)}`]);
    expect(
      (await executions(fixture, fixture.summary.id)).find(
        (row) => row.name === "asking"
      )?.status
    ).toBe("complete");
    fixture.client.close();
  }, 150_000);

  it("leaves a workspace whose first attach fails unregistered, so others still switch", async () => {
    const home = testHome({ providers: false });
    const broken = join(home.path, "broken");
    mkdirSync(broken);
    const brokenSource = join(broken, "marbles.config.ts");
    writeFileSync(brokenSource, 'throw new Error("never loads");\n');
    daemons.push(
      await startDaemon({ layout: home.layout, print: () => undefined })
    );
    const client = await connect({ layout: home.layout, start: false });
    await expect(client.attach(brokenSource)).rejects.toThrow("never loads");

    const root = join(home.path, "project");
    mkdirSync(root);
    const gates = join(home.path, "gates");
    mkdirSync(gates);
    const fixture = {
      client,
      gates,
      log: join(home.path, "steps.log"),
      machine: home.layout,
      source: join(root, "marbles.config.ts"),
    };
    writeFileSync(fixture.log, "");
    writeFileSync(fixture.source, moduleText(fixture, 0));
    const summary = await client.attach(fixture.source);
    const first = summary.pid ?? 0;
    writeFileSync(fixture.source, moduleText(fixture, 1));
    const second = await vi.waitFor(
      async () => {
        const now = (await client.workspaces()).find(
          (each) => each.id === summary.id
        );
        expect(now?.state).toBe("ready");
        expect(now?.pid).not.toBe(first);
        return now?.pid ?? 0;
      },
      { interval: 200, timeout: 60_000 }
    );
    expect((await client.workspace(summary).roll("where")).value).toBe(second);
    client.close();
  }, 120_000);

  it("replaces a current generation that crashes as soon as it is attached, and recovers its run", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    await expect(workspace.roll("crash")).rejects.toThrow();
    const second = await readyOn(fixture, (pid) => pid !== first);
    await vi.waitFor(
      async () => {
        const rows = await executions(fixture, fixture.summary.id);
        expect(rows.find((row) => row.name === "crash")?.status).toBe(
          "interrupted"
        );
      },
      { interval: 200, timeout: 30_000 }
    );
    expect((await workspace.roll("where")).value).toBe(second);
    fixture.client.close();
  }, 120_000);

  it("hands a run that parks after the switch to the current generation, and answers it there", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    await workspace.actions.launch("late", {});
    await whenLogged(fixture, `late ${String(first)}`);
    const second = await switchFrom(fixture, first, 1);
    open("late", fixture);
    const entry = await openEntry(workspace, "Late?");
    await workspace.actions.answer(entry, "yes");
    await whenLogged(fixture, `answered-late ${String(second)}`);
    expect(
      logged(fixture).filter((line) => line.startsWith("answered-late "))
    ).toEqual([`answered-late ${String(second)}`]);
    await gone(first);
    fixture.client.close();
  }, 150_000);

  it("replaces a candidate that fails to start after the previous one retired, once its source can start", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    await workspace.actions.launch("picky", { n: 1 });
    await openEntry(workspace, "Picky?");
    writeFileSync(fixture.source, moduleText(fixture, 1, { strict: true }));
    await vi.waitFor(
      async () => {
        const [summary] = await fixture.client.workspaces();
        expect(summary?.state).toBe("failed");
      },
      { interval: 200, timeout: 60_000 }
    );
    await gone(first);
    writeFileSync(fixture.source, moduleText(fixture, 2));
    const recovered = await readyOn(fixture, (pid) => pid !== first);
    const entry = await openEntry(workspace, "Picky?");
    await workspace.actions.answer(entry, "yes");
    await vi.waitFor(
      async () => {
        const rows = await executions(fixture, fixture.summary.id);
        expect(rows.find((row) => row.name === "picky")?.status).toBe(
          "complete"
        );
      },
      { interval: 200, timeout: 30_000 }
    );
    expect((await workspace.roll("where")).value).toBe(recovered);
    fixture.client.close();
  }, 180_000);

  it("stops every live generation when the daemon stops, the retired one with its run", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    const holding = workspace.roll("hold1");
    holding.catch(() => undefined);
    await whenLogged(fixture, `hold1 ${String(first)}`);
    const second = await switchFrom(fixture, first, 1);
    expect(processAlive(first)).toBe(true);
    fixture.client.close();
    const daemon = daemons.pop();
    await daemon?.close();
    expect(processAlive(first)).toBe(false);
    expect(processAlive(second)).toBe(false);
    expect(await readLiveGenerations(fixture.machine.state)).toEqual([]);
  }, 150_000);

  it("delivers each task change once and only once across a retirement", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    await workspace.roll("add", { title: "before" });
    await whenLogged(fixture, `seen-before ${String(first)}`);
    const second = await switchFrom(fixture, first, 1);
    await workspace.roll("add", { title: "after" });
    await whenLogged(fixture, `seen-after ${String(second)}`);
    await gone(first);
    const third = await switchFrom(fixture, second, 2);
    await workspace.roll("add", { title: "last" });
    await whenLogged(fixture, `seen-last ${String(third)}`);
    const seen = logged(fixture).filter((line) => line.startsWith("seen-"));
    expect(seen).toEqual([
      `seen-before ${String(first)}`,
      `seen-after ${String(second)}`,
      `seen-last ${String(third)}`,
    ]);
    fixture.client.close();
  }, 180_000);

  it("switches when a helper or a data file its source imports changes", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const shared = join(fixture.gates, "..", "shared");
    mkdirSync(shared);
    const helper = join(shared, "helper.ts");
    const data = join(shared, "values.json");
    writeFileSync(helper, "export const value = 1;\n");
    writeFileSync(data, '{ "value": 1 }\n');
    writeFileSync(
      fixture.source,
      `import { value } from ${JSON.stringify(helper)};\nimport values from ${JSON.stringify(data)};\n${moduleText(fixture, 1)}export const read = () => [value, values.value];\n`
    );
    const second = await readyOn(fixture, (pid) => pid !== first);
    writeFileSync(helper, "export const value = 200;\n");
    const third = await readyOn(fixture, (pid) => pid !== second);
    writeFileSync(data, '{ "value": 200 }\n');
    await readyOn(fixture, (pid) => pid !== third);
    fixture.client.close();
  }, 180_000);

  it("starts no other generation after an attach when nothing changed", async () => {
    const fixture = await setUp();
    for (let poll = 0; poll < 3; poll += 1) {
      await fixture.daemon.pollNow();
      expect(await fixture.daemon.idle()).toEqual({
        reasons: [],
        scheduled: false,
      });
    }
    const generations = await readLiveGenerations(fixture.machine.state);
    expect(generations.map((generation) => generation.pid)).toEqual([
      fixture.summary.pid,
    ]);
    fixture.client.close();
  }, 60_000);

  it("starts exactly one generation for an idle reload, and one more for each after it", async () => {
    const clock = handClock();
    const lines: string[] = [];
    const fixture = await setUp({
      daemon: { clock, print: (line) => lines.push(line) },
    });
    const first = fixture.summary.pid ?? 0;
    const second = (await fixture.client.reload(fixture.summary.id)).pid ?? 0;
    expect(second).not.toBe(first);
    await gone(first);
    expect(await fixture.daemon.idle(), lines.join("\n")).toEqual({
      reasons: [],
      scheduled: false,
    });
    clock.advance(10 * 60_000);
    await fixture.daemon.idle();
    expect(await numbered(fixture)).toBe(2);

    const third = (await fixture.client.reload(fixture.summary.id)).pid ?? 0;
    await gone(second);
    expect(await fixture.daemon.idle(), lines.join("\n")).toEqual({
      reasons: [],
      scheduled: false,
    });
    clock.advance(10 * 60_000);
    await fixture.daemon.idle();
    expect(await numbered(fixture)).toBe(3);
    const workspace = fixture.client.workspace(fixture.summary);
    expect((await workspace.roll("where")).value).toBe(third);
    fixture.client.close();
  }, 120_000);

  it("asks for no switch while one is under way, however long its load takes", async () => {
    const clock = handClock();
    const lines: string[] = [];
    const home = testHome({ providers: false });
    const root = join(home.path, "project");
    mkdirSync(root);
    const source = join(root, "marbles.config.ts");
    const loading = join(home.path, "loading");
    const loaded = join(home.path, "loaded");
    writeFileSync(
      source,
      `import { existsSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(loading)}, "");\nwhile (!existsSync(${JSON.stringify(loaded)})) await new Promise((resolve) => setTimeout(resolve, 20));\nimport { step } from "@foundry.sh/marbles";\nexport const where = step("where").do(() => process.pid);\n`
    );
    const daemon = await startDaemon({
      clock,
      layout: home.layout,
      print: (line) => lines.push(line),
    });
    daemons.push(daemon);
    const client = await connect({ layout: home.layout, start: false });
    const attaching = client.attach(source);
    await vi.waitFor(() => expect(existsSync(loading)).toBe(true), {
      interval: 20,
      timeout: 60_000,
    });
    expect(await daemon.pollNow()).toBe(false);
    expect(await daemon.pollNow()).toBe(false);
    writeFileSync(loaded, "");
    const attached = await attaching;
    expect(attached.state).toBe("ready");
    expect(await daemon.idle(), lines.join("\n")).toEqual({
      reasons: [],
      scheduled: false,
    });
    client.close();
  }, 120_000);

  it("starts the next generation, after the backoff, when a workspace's engine did not start, though nothing changed", async () => {
    const clock = handClock();
    const lines: string[] = [];
    const marker = join(testHome({ providers: false }).path, "fail-start");
    process.env.MARBLES_TEST_FAIL_START = marker;
    try {
      const fixture = await setUp({
        daemon: {
          clock,
          generationEntry: join(
            import.meta.dirname,
            "helpers",
            "generation-failing-start.ts"
          ),
          print: (line) => lines.push(line),
        },
      });
      const first = fixture.summary.pid ?? 0;
      writeFileSync(marker, "");
      await fixture.client.reload(fixture.summary.id).catch(() => undefined);
      const [failed] = await fixture.client.workspaces();
      expect(failed?.state).toBe("failed");
      const idle = await fixture.daemon.idle();
      expect(idle.scheduled, lines.join("\n")).toBe(true);
      expect(idle.reasons.join("\n")).toContain("did not start");

      rmSync(marker);
      clock.advance(1000);
      await fixture.daemon.idle();
      const [started] = await fixture.client.workspaces();
      expect(started?.state).toBe("ready");
      expect(started?.pid).not.toBe(first);
      expect(await fixture.daemon.idle()).toEqual({
        reasons: [],
        scheduled: false,
      });
      const workspace = fixture.client.workspace(fixture.summary);
      expect((await workspace.roll("where")).value).toBe(started?.pid);
      fixture.client.close();
    } finally {
      delete process.env.MARBLES_TEST_FAIL_START;
    }
  }, 150_000);

  it("runs a queued run on the current generation that its retired one handed over only after the current one started", async () => {
    const marker = join(testHome({ providers: false }).path, "fail-handover");
    process.env.MARBLES_TEST_FAIL_HANDOVER = marker;
    try {
      const fixture = await setUp({
        daemon: {
          generationEntry: join(
            import.meta.dirname,
            "helpers",
            "generation-failing-handover.ts"
          ),
        },
      });
      const first = fixture.summary.pid ?? 0;
      const workspace = fixture.client.workspace(fixture.summary);
      const holding = workspace.roll("hold1");
      await whenLogged(fixture, `hold1 ${String(first)}`);
      await workspace.actions.launch("where", {});
      writeFileSync(marker, "");
      const second = await switchFrom(fixture, first, 1);
      expect(logged(fixture)).not.toContain("where");
      rmSync(marker);
      await whenLogged(fixture, `where ${String(second)}`);
      expect(logged(fixture)).not.toContain(`where ${String(first)}`);
      open(1, fixture);
      expect((await holding).value).toBe(first);
      await gone(first);
      fixture.client.close();
    } finally {
      delete process.env.MARBLES_TEST_FAIL_HANDOVER;
    }
  }, 150_000);

  it("leaves a gone process's queued run the current generation cannot run, said once, and offers it only now and then", async () => {
    const lines: string[] = [];
    const fixture = await setUp({
      daemon: {
        generationEntry: join(
          import.meta.dirname,
          "helpers",
          "generation-counting-take.ts"
        ),
        print: (line) => lines.push(line),
      },
    });
    const at = new Date().toISOString();
    await withExecutions(
      fixture.machine.state,
      (store) =>
        seedExecution(store, {
          correlation: {},
          id: "rn-unrunnable",
          input: {},
          kind: "task",
          name: "gone-task",
          observations: [],
          owner: { pid: exitedPid(), started: null },
          queue: "marbles",
          revision: 1,
          sequence: 1,
          status: "queued",
          timestamps: { queuedAt: at, updatedAt: at },
        }),
      fixture.summary.id
    );
    for (let sweep = 0; sweep < 3; sweep += 1) {
      await fixture.daemon.sweepNow();
    }
    const asked = lines.filter((line) =>
      line.includes("take asked for rn-unrunnable")
    );
    expect(asked).toHaveLength(1);
    const left = lines.filter(
      (line) => line.includes("rn-unrunnable") && line.includes("left queued")
    );
    expect(left).toHaveLength(1);
    expect(left[0]).toContain('no task named "gone-task" is registered here');
    const rows = await executions(fixture, fixture.summary.id);
    expect(rows.find((row) => row.name === "gone-task")?.status).toBe("queued");
    fixture.client.close();
  }, 150_000);

  it("runs on the current generation a queued run whose retired generation died before handing it over", async () => {
    const lines: string[] = [];
    const marker = join(testHome({ providers: false }).path, "fail-handover");
    process.env.MARBLES_TEST_FAIL_HANDOVER = marker;
    try {
      const fixture = await setUp({
        daemon: {
          generationEntry: join(
            import.meta.dirname,
            "helpers",
            "generation-failing-handover.ts"
          ),
          print: (line) => lines.push(line),
        },
      });
      const first = fixture.summary.pid ?? 0;
      const workspace = fixture.client.workspace(fixture.summary);
      const holding = workspace.roll("hold1");
      holding.catch(() => undefined);
      await whenLogged(fixture, `hold1 ${String(first)}`);
      await workspace.actions.launch("where", {});
      writeFileSync(marker, "");
      const second = await switchFrom(fixture, first, 1);
      await provedGeneration(fixture, first, "retiring");
      process.kill(first, "SIGKILL");
      await gone(first);
      await vi.waitFor(
        () =>
          expect(
            logged(fixture).filter((line) => line.startsWith("where "))
          ).toHaveLength(1),
        { interval: 50, timeout: 30_000 }
      );
      expect(logged(fixture)).not.toContain(`where ${String(first)}`);
      expect(second).not.toBe(first);
      expect(
        lines.some((line) => line.includes("taken over from a gone process"))
      ).toBe(true);
      fixture.client.close();
    } finally {
      delete process.env.MARBLES_TEST_FAIL_HANDOVER;
    }
  }, 150_000);

  it("finds a queued run handed over late by the database sweep when its notice is lost", async () => {
    const marker = join(testHome({ providers: false }).path, "fail-handover");
    process.env.MARBLES_TEST_FAIL_HANDOVER = marker;
    process.env.MARBLES_TEST_DROP_HANDED = "1";
    try {
      const fixture = await setUp({
        daemon: {
          generationEntry: join(
            import.meta.dirname,
            "helpers",
            "generation-failing-handover.ts"
          ),
        },
      });
      const first = fixture.summary.pid ?? 0;
      const workspace = fixture.client.workspace(fixture.summary);
      const holding = workspace.roll("hold1");
      await whenLogged(fixture, `hold1 ${String(first)}`);
      await workspace.actions.launch("where", {});
      writeFileSync(marker, "");
      const second = await switchFrom(fixture, first, 1);
      rmSync(marker);
      await whenLogged(fixture, `where ${String(second)}`);
      open(1, fixture);
      expect((await holding).value).toBe(first);
      await gone(first);
      fixture.client.close();
    } finally {
      delete process.env.MARBLES_TEST_FAIL_HANDOVER;
      delete process.env.MARBLES_TEST_DROP_HANDED;
    }
  }, 150_000);

  it("hands a queued run over late to the generation current then, though another switch came after the one that retired it", async () => {
    const marker = join(testHome({ providers: false }).path, "fail-handover");
    process.env.MARBLES_TEST_FAIL_HANDOVER = marker;
    try {
      const fixture = await setUp({
        daemon: {
          generationEntry: join(
            import.meta.dirname,
            "helpers",
            "generation-failing-handover.ts"
          ),
        },
      });
      const first = fixture.summary.pid ?? 0;
      const workspace = fixture.client.workspace(fixture.summary);
      const holding = workspace.roll("hold1");
      await whenLogged(fixture, `hold1 ${String(first)}`);
      await workspace.actions.launch("where", {});
      writeFileSync(marker, "");
      const second = await switchFrom(fixture, first, 1);
      const third = await switchFrom(fixture, second, 2);
      rmSync(marker);
      await whenLogged(fixture, `where ${String(third)}`);
      expect(logged(fixture)).not.toContain(`where ${String(first)}`);
      expect(logged(fixture)).not.toContain(`where ${String(second)}`);
      open(1, fixture);
      expect((await holding).value).toBe(first);
      await gone(first);
      fixture.client.close();
    } finally {
      delete process.env.MARBLES_TEST_FAIL_HANDOVER;
    }
  }, 150_000);

  it("launches again on the current generation a launch a generation refused as retiring, recording it once", async () => {
    const marker = join(testHome({ providers: false }).path, "refuse-launch");
    process.env.MARBLES_TEST_REFUSE_LAUNCH = marker;
    try {
      const fixture = await setUp({
        daemon: {
          generationEntry: join(
            import.meta.dirname,
            "helpers",
            "generation-retiring-launch.ts"
          ),
        },
      });
      const workspace = fixture.client.workspace(fixture.summary);
      writeFileSync(marker, "");
      await workspace.actions.launch("where", {});
      expect(existsSync(marker)).toBe(false);
      await whenLogged(fixture, `where ${String(fixture.summary.pid ?? 0)}`);
      const rows = await executions(fixture, fixture.summary.id);
      expect(rows.filter((row) => row.name === "where")).toHaveLength(1);
      fixture.client.close();
    } finally {
      delete process.env.MARBLES_TEST_REFUSE_LAUNCH;
    }
  }, 150_000);

  it("switches when a text file its source imports under the root changes, though no tree covers it", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const prompt = join(fixture.gates, "..", "project", "prompt.md");
    writeFileSync(prompt, "Say hello.\n");
    writeFileSync(
      fixture.source,
      `import prompt from "./prompt.md" with { type: "text" };\n${moduleText(fixture, 1)}export const told = step("told").do(() => prompt);\n`
    );
    const second = await readyOn(fixture, (pid) => pid !== first);
    const workspace = fixture.client.workspace(fixture.summary);
    expect((await workspace.roll("told")).value).toBe("Say hello.\n");
    writeFileSync(prompt, "Say goodbye, at length.\n");
    await readyOn(fixture, (pid) => pid !== second);
    expect((await workspace.roll("told")).value).toBe(
      "Say goodbye, at length.\n"
    );
    fixture.client.close();
  }, 150_000);

  it("drains a detached workspace in the retired generation too, its runs reachable until they end", async () => {
    const lines: string[] = [];
    const fixture = await setUp({
      daemon: { print: (line) => lines.push(line) },
    });
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    const runId = await workspace.actions.launch("hold1", {});
    await whenLogged(fixture, `hold1 ${String(first)}`);
    const second = await switchFrom(fixture, first, 1);
    const detaching = fixture.client.detach(fixture.summary.id);
    const waitingOnRetired = vi.waitFor(
      () =>
        expect(
          lines.some((line) =>
            line.includes("detaching · waiting for engine generation 1")
          )
        ).toBe(true),
      { interval: 50, timeout: 60_000 }
    );
    const settled = await Promise.race([
      detaching.then(() => "detached" as const),
      waitingOnRetired.then(() => "waiting" as const),
    ]);
    expect(settled).toBe("waiting");
    await workspace.actions.runs.cancel(runId);
    await detaching;
    const rows = await executions(fixture, fixture.summary.id);
    expect(rows.find((row) => row.name === "hold1")?.status).toBe("cancelled");
    await gone(first);
    expect(processAlive(second)).toBe(true);
    expect(await fixture.client.workspaces()).toEqual([]);
    fixture.client.close();
  }, 150_000);

  it("lets other work through while a detach waits for a retired generation, refusing new work for the detaching workspace and holding its attaches until it ends", async () => {
    const lines: string[] = [];
    const fixture = await setUp({
      daemon: { print: (line) => lines.push(line) },
    });
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    const runId = await workspace.actions.launch("hold1", {});
    await whenLogged(fixture, `hold1 ${String(first)}`);
    await switchFrom(fixture, first, 1);
    const detaching = fixture.client.detach(fixture.summary.id);
    detaching.catch(() => undefined);
    await vi.waitFor(
      () =>
        expect(
          lines.some((line) =>
            line.includes("detaching · waiting for engine generation 1")
          )
        ).toBe(true),
      { interval: 50, timeout: 60_000 }
    );
    const listed = (await fixture.client.workspaces()).find(
      (each) => each.id === fixture.summary.id
    );
    expect(listed?.state).toBe("stopped");
    expect(listed?.error).toContain("detaching");
    await expect(workspace.actions.launch("hold2", {})).rejects.toThrow(
      "is detaching"
    );
    await expect(workspace.snapshot()).rejects.toThrow("is detaching");
    const order: string[] = [];
    const attaches = [1, 2].map((n) =>
      fixture.client.attach(fixture.source).then((summary) => {
        order.push(`attach ${String(n)}`);
        return summary;
      })
    );
    const detached = detaching.then(() => order.push("detach"));
    const otherRoot = join(fixture.gates, "..", "other");
    mkdirSync(otherRoot);
    const otherSource = join(otherRoot, "marbles.config.ts");
    writeFileSync(otherSource, moduleText(fixture, 0));
    const other = await fixture.client.attach(otherSource);
    expect(other.state).toBe("ready");
    await workspace.actions.runs.cancel(runId);
    await detached;
    await gone(first);
    const [again, twice] = await Promise.all(attaches);
    expect(order[0]).toBe("detach");
    expect(again?.state).toBe("ready");
    expect(twice?.id).toBe(again?.id);
    expect(again?.pid).not.toBe(first);
    expect(
      (await fixture.client.workspaces()).map((each) => each.id).sort()
    ).toEqual([other.id, fixture.summary.id].sort());
    fixture.client.close();
  }, 150_000);

  it("switches while a detach drains the current generation, which retires leaving that workspace's queue to the drain", async () => {
    const lines: string[] = [];
    const fixture = await setUp({
      daemon: { print: (line) => lines.push(line) },
    });
    const first = fixture.summary.pid ?? 0;
    const otherRoot = join(fixture.gates, "..", "other");
    mkdirSync(otherRoot);
    const otherSource = join(otherRoot, "marbles.config.ts");
    writeFileSync(otherSource, moduleText(fixture, 0));
    const other = await fixture.client.attach(otherSource);
    const workspace = fixture.client.workspace(fixture.summary);
    await workspace.actions.launch("hold1", {});
    await whenLogged(fixture, `hold1 ${String(first)}`);
    await workspace.actions.launch("where", {});
    const detaching = fixture.client.detach(fixture.summary.id);
    detaching.catch(() => undefined);
    await vi.waitFor(
      () =>
        expect(
          lines.some((line) =>
            line.includes(
              `[${fixture.summary.id}] detaching · waiting for engine generation 1`
            )
          )
        ).toBe(true),
      { interval: 50, timeout: 60_000 }
    );
    await fixture.client.reload(other.id);
    const now = (await fixture.client.workspaces()).find(
      (each) => each.id === other.id
    );
    expect(now?.state).toBe("ready");
    expect(now?.pid).not.toBe(first);
    open(1, fixture);
    await detaching;
    await gone(first);
    expect(logged(fixture)).toContain(`where ${String(first)}`);
    const rows = await executions(fixture, fixture.summary.id);
    expect(rows.find((row) => row.name === "hold1")?.status).toBe("complete");
    expect(rows.find((row) => row.name === "where")?.status).toBe("complete");
    expect((await fixture.client.workspaces()).map((each) => each.id)).toEqual([
      other.id,
    ]);
    fixture.client.close();
  }, 150_000);

  it("detaches nothing when the registration write of a detach fails", async () => {
    const fixture = await setUp();
    const unhosting = vi
      .spyOn(WorkspaceRegistry.prototype, "unhost")
      .mockRejectedValueOnce(new Error("injected registration failure"));
    try {
      await expect(fixture.client.detach(fixture.summary.id)).rejects.toThrow(
        "injected registration failure"
      );
    } finally {
      unhosting.mockRestore();
    }
    const [listed] = await fixture.client.workspaces();
    expect(listed?.state).toBe("ready");
    expect(await stored(fixture, fixture.summary.id)).toBe(true);
    const again = await fixture.client.attach(fixture.source);
    expect(again.state).toBe("ready");
    expect(await stored(fixture, fixture.summary.id)).toBe(true);
    fixture.client.close();
  }, 150_000);

  it("puts the registration back when a detach's drain fails, says it failed, and loads it afresh on the next attach", async () => {
    const marker = join(testHome({ providers: false }).path, "fail-stop");
    process.env.MARBLES_TEST_FAIL_STOP = marker;
    try {
      const fixture = await setUp({ daemon: { generationEntry: failingStop } });
      writeFileSync(marker, "");
      await expect(fixture.client.detach(fixture.summary.id)).rejects.toThrow(
        "the test refuses this drain"
      );
      const [listed] = await fixture.client.workspaces();
      expect(listed?.state).toBe("failed");
      expect(listed?.error).toContain("detach failed");
      expect(await stored(fixture, fixture.summary.id)).toBe(true);
      const generations = await numbered(fixture);
      await fixture.daemon.pollNow();
      expect(await fixture.daemon.idle()).toEqual({
        reasons: [],
        scheduled: false,
      });
      expect(await numbered(fixture)).toBe(generations);
      const [still] = await fixture.client.workspaces();
      expect(still?.state).toBe("failed");
      const again = await fixture.client.attach(fixture.source);
      expect(again.state).toBe("ready");
      expect(await stored(fixture, fixture.summary.id)).toBe(true);
      const workspace = fixture.client.workspace(again);
      expect((await workspace.roll("where")).value).toBe(again.pid);
      fixture.client.close();
    } finally {
      delete process.env.MARBLES_TEST_FAIL_STOP;
    }
  }, 150_000);

  it("says so when it cannot put the registration back after a failed drain, and the next attach repairs it", async () => {
    const marker = join(testHome({ providers: false }).path, "fail-stop");
    process.env.MARBLES_TEST_FAIL_STOP = marker;
    try {
      const fixture = await setUp({ daemon: { generationEntry: failingStop } });
      writeFileSync(marker, "");
      const touching = vi
        .spyOn(WorkspaceRegistry.prototype, "touch")
        .mockRejectedValueOnce(new Error("injected restore failure"));
      try {
        await expect(fixture.client.detach(fixture.summary.id)).rejects.toThrow(
          "the test refuses this drain"
        );
      } finally {
        touching.mockRestore();
      }
      const [listed] = await fixture.client.workspaces();
      expect(listed?.state).toBe("failed");
      expect(listed?.error).toContain("injected restore failure");
      expect(await stored(fixture, fixture.summary.id)).toBe(false);
      const again = await fixture.client.attach(fixture.source);
      expect(again.state).toBe("ready");
      expect(await stored(fixture, fixture.summary.id)).toBe(true);
      fixture.client.close();
    } finally {
      delete process.env.MARBLES_TEST_FAIL_STOP;
    }
  }, 150_000);

  it("leaves a workspace unregistered and unhosted when the daemon stops between a detach's steps", async () => {
    const lines: string[] = [];
    const fixture = await setUp({
      daemon: { print: (line) => lines.push(line) },
    });
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    await workspace.actions.launch("hold1", {});
    await whenLogged(fixture, `hold1 ${String(first)}`);
    const detaching = fixture.client.detach(fixture.summary.id);
    detaching.catch(() => undefined);
    await vi.waitFor(
      () =>
        expect(
          lines.some((line) =>
            line.includes("detaching · waiting for engine generation 1")
          )
        ).toBe(true),
      { interval: 50, timeout: 60_000 }
    );
    expect(await stored(fixture, fixture.summary.id)).toBe(false);
    fixture.client.close();
    await daemons.pop()?.close();
    expect(processAlive(first)).toBe(false);
    daemons.push(
      await startDaemon({ layout: fixture.machine, print: () => undefined })
    );
    const client = await connect({ layout: fixture.machine, start: false });
    expect(await client.workspaces()).toEqual([]);
    expect(await stored(fixture, fixture.summary.id)).toBe(false);
    client.close();
  }, 150_000);

  it("finishes a detach whose generation retires and closes its hosts while it drops the registration", async () => {
    const lines: string[] = [];
    const fixture = await setUp({
      daemon: {
        generationEntry: join(
          import.meta.dirname,
          "helpers",
          "generation-slow-unregister.ts"
        ),
        print: (line) => lines.push(line),
      },
    });
    const first = fixture.summary.pid ?? 0;
    const otherRoot = join(fixture.gates, "..", "other");
    mkdirSync(otherRoot);
    const otherSource = join(otherRoot, "marbles.config.ts");
    writeFileSync(otherSource, moduleText(fixture, 0));
    const other = await fixture.client.attach(otherSource);
    const workspace = fixture.client.workspace(fixture.summary);
    await workspace.actions.launch("hold1", {});
    await whenLogged(fixture, `hold1 ${String(first)}`);
    const detaching = fixture.client.detach(fixture.summary.id);
    detaching.catch(() => undefined);
    await vi.waitFor(
      () =>
        expect(
          lines.some((line) =>
            line.includes(
              `[${fixture.summary.id}] detaching · waiting for engine generation 1`
            )
          )
        ).toBe(true),
      { interval: 50, timeout: 60_000 }
    );
    await fixture.client.reload(other.id);
    open(1, fixture);
    await detaching;
    await gone(first);
    const said = lines.join("\n");
    expect(said).toContain("hosts closing with 0 unregister(s) under way");
    expect(said).not.toContain("hosts closing with 1 unregister(s) under way");
    expect((await fixture.client.workspaces()).map((each) => each.id)).toEqual([
      other.id,
    ]);
    expect(await stored(fixture, fixture.summary.id)).toBe(false);
    fixture.client.close();
  }, 150_000);

  it("when the daemon crashes with the workspace attached, the next hosts it afresh and leaves the orphaned generation its runs, queued ones too", async () => {
    const { child, fixture, lines } = await crashableDaemon();
    const client = await connect({ layout: fixture.machine, start: false });
    const summary = await client.attach(fixture.source);
    const first = summary.pid ?? 0;
    const workspace = client.workspace(summary);
    await workspace.actions.launch("hold1", {});
    await whenLogged(fixture, `hold1 ${String(first)}`);
    await workspace.actions.launch("where", {});
    await crash(child);
    client.close();
    expect(lines.some((line) => line.startsWith("ready "))).toBe(true);
    expect(processAlive(first)).toBe(true);

    const restarted = await startDaemon({
      layout: fixture.machine,
      print: () => undefined,
    });
    daemons.push(restarted);
    const next = await connect({ layout: fixture.machine, start: false });
    const second = await readyOn(
      { client: next },
      (pid) => pid !== first && pid > 0
    );
    expect(
      (await readLiveGenerations(fixture.machine.state)).find(
        (generation) => generation.pid === first
      )?.state
    ).toBe("retiring");
    await restarted.sweepNow();
    const rows = await executions(fixture, summary.id);
    expect(rows.find((row) => row.name === "hold1")?.status).toBe("running");
    expect(rows.find((row) => row.name === "where")?.status).toBe("queued");

    open(1, fixture);
    await whenLogged(fixture, `where ${String(first)}`);
    await gone(first, 60_000);
    expect(logged(fixture)).not.toContain(`where ${String(second)}`);
    const settled = await executions(fixture, summary.id);
    expect(settled.find((row) => row.name === "hold1")?.status).toBe(
      "complete"
    );
    expect(settled.find((row) => row.name === "where")?.status).toBe(
      "complete"
    );
    await restarted.sweepNow();
    expect(
      (await readLiveGenerations(fixture.machine.state)).map(
        (generation) => generation.pid
      )
    ).not.toContain(first);
    expect((await next.workspace(summary).roll("where")).value).toBe(second);
    next.close();
  }, 180_000);

  it("when the daemon crashes between a detach's steps, the next leaves the workspace detached and the generation finishing its run", async () => {
    const { child, fixture, lines } = await crashableDaemon();
    const client = await connect({ layout: fixture.machine, start: false });
    const summary = await client.attach(fixture.source);
    const first = summary.pid ?? 0;
    const workspace = client.workspace(summary);
    const runId = await workspace.actions.launch("hold1", {});
    await whenLogged(fixture, `hold1 ${String(first)}`);
    const detaching = client.detach(summary.id);
    detaching.catch(() => undefined);
    await vi.waitFor(
      () =>
        expect(
          lines.some((line) =>
            line.includes("detaching · waiting for engine generation 1")
          )
        ).toBe(true),
      { interval: 50, timeout: 60_000 }
    );
    expect(await stored(fixture, summary.id)).toBe(false);
    await crash(child);
    client.close();
    expect(processAlive(first)).toBe(true);
    const restarted = await startDaemon({
      layout: fixture.machine,
      print: () => undefined,
    });
    daemons.push(restarted);
    const next = await connect({ layout: fixture.machine, start: false });
    expect(await next.workspaces()).toEqual([]);
    expect(await stored(fixture, summary.id)).toBe(false);
    expect(processAlive(first)).toBe(true);
    expect(
      (await readLiveGenerations(fixture.machine.state)).find(
        (generation) => generation.pid === first
      )?.state
    ).toBe("retiring");
    open(1, fixture);
    await gone(first, 60_000);
    const rows = await executions(fixture, summary.id);
    expect(rows.find((row) => row.name === "hold1")?.status).toBe("complete");
    expect(runId).toBeDefined();
    await restarted.sweepNow();
    expect(
      (await readLiveGenerations(fixture.machine.state)).map(
        (generation) => generation.pid
      )
    ).not.toContain(first);
    next.close();
  }, 180_000);

  it("completes a daemon stop while a detach waits for a retired generation, refusing the attach that waited on it", async () => {
    const lines: string[] = [];
    const fixture = await setUp({
      daemon: { print: (line) => lines.push(line) },
    });
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    await workspace.actions.launch("hold1", {});
    await whenLogged(fixture, `hold1 ${String(first)}`);
    const second = await switchFrom(fixture, first, 1);
    const detaching = fixture.client.detach(fixture.summary.id);
    const settled = detaching.then(
      () => "detached",
      () => "refused"
    );
    await vi.waitFor(
      () =>
        expect(
          lines.some((line) =>
            line.includes("detaching · waiting for engine generation 1")
          )
        ).toBe(true),
      { interval: 50, timeout: 60_000 }
    );
    const attaching = fixture.client.attach(fixture.source).then(
      () => "attached",
      () => "refused"
    );
    await daemons.pop()?.close();
    expect(processAlive(first)).toBe(false);
    expect(processAlive(second)).toBe(false);
    expect(["detached", "refused"]).toContain(await settled);
    expect(await attaching).toBe("refused");
    fixture.client.close();
  }, 150_000);

  it("reports a workspace that did not load at boot as not running, and the one that did with its generation", async () => {
    const fixture = await setUp();
    const otherRoot = join(fixture.gates, "..", "other");
    mkdirSync(otherRoot);
    const otherSource = join(otherRoot, "marbles.config.ts");
    writeFileSync(otherSource, moduleText(fixture, 0));
    const other = await fixture.client.attach(otherSource);
    fixture.client.close();
    await daemons.pop()?.close();
    writeFileSync(otherSource, 'throw new Error("never loads");\n');
    daemons.push(
      await startDaemon({ layout: fixture.machine, print: () => undefined })
    );
    const client = await connect({ layout: fixture.machine, start: false });
    const pid = await vi.waitFor(
      async () => {
        const now = await client.workspaces();
        const healthy = now.find((each) => each.id === fixture.summary.id);
        expect(healthy?.state).toBe("ready");
        expect(now.find((each) => each.id === other.id)?.state).toBe("failed");
        return healthy?.pid ?? 0;
      },
      { interval: 200, timeout: 60_000 }
    );
    const status = await readStatus(fixture.machine.state);
    expect(
      status.workspaces.find((each) => each.id === fixture.summary.id)
    ).toMatchObject({ alive: true, host: "generation", pid });
    expect(
      status.workspaces.find((each) => each.id === other.id)
    ).toMatchObject({ alive: false, host: null, pid: null });
    client.close();
  }, 150_000);

  it("starts a generation whose record as current failed, and writes it again with its hosts", async () => {
    const lines: string[] = [];
    const original = GenerationRecords.prototype.mark;
    let failures = 0;
    GenerationRecords.prototype.mark = function (number, state, error) {
      if (state === "current") {
        GenerationRecords.prototype.mark = original;
        failures += 1;
        return Promise.reject(new Error("injected current write failure"));
      }
      return original.call(this, number, state, error);
    };
    let fixture: Awaited<ReturnType<typeof setUp>>;
    try {
      fixture = await setUp({
        daemon: { print: (line) => lines.push(line) },
      });
    } finally {
      GenerationRecords.prototype.mark = original;
    }
    expect(failures).toBe(1);
    expect(lines.join("\n")).toContain("injected current write failure");
    expect(await fixture.daemon.idle()).toEqual({
      reasons: [],
      scheduled: false,
    });
    expect(
      (await readStatus(fixture.machine.state)).workspaces.find(
        (each) => each.id === fixture.summary.id
      )
    ).toMatchObject({
      alive: true,
      host: "generation",
      pid: fixture.summary.pid,
    });
    fixture.client.close();
  }, 150_000);

  it("switches to the next generation when recording the previous one as retiring failed", async () => {
    const lines: string[] = [];
    const fixture = await setUp({
      daemon: { print: (line) => lines.push(line) },
    });
    const original = GenerationRecords.prototype.mark;
    GenerationRecords.prototype.mark = function (number, state, error) {
      if (state === "retiring") {
        GenerationRecords.prototype.mark = original;
        return Promise.reject(new Error("injected retiring write failure"));
      }
      return original.call(this, number, state, error);
    };
    try {
      const first = fixture.summary.pid ?? 0;
      const second = await switchFrom(fixture, first, 1);
      expect(second).not.toBe(first);
    } finally {
      GenerationRecords.prototype.mark = original;
    }
    expect(lines.join("\n")).toContain("injected retiring write failure");
    fixture.client.close();
  }, 150_000);

  it("writes which workspaces a generation hosts again, after the backoff, when the write failed", async () => {
    const clock = handClock();
    const lines: string[] = [];
    const original = GenerationRecords.prototype.hosting;
    let failures = 0;
    GenerationRecords.prototype.hosting = () => {
      GenerationRecords.prototype.hosting = original;
      failures += 1;
      return Promise.reject(new Error("injected hosts write failure"));
    };
    let fixture: Awaited<ReturnType<typeof setUp>>;
    try {
      fixture = await setUp({
        daemon: { clock, print: (line) => lines.push(line) },
      });
    } finally {
      GenerationRecords.prototype.hosting = original;
    }
    expect(failures).toBe(1);
    const status = async () =>
      (await readStatus(fixture.machine.state)).workspaces.find(
        (each) => each.id === fixture.summary.id
      );
    const idle = await fixture.daemon.idle();
    expect(idle.scheduled, lines.join("\n")).toBe(true);
    expect(idle.reasons.join("\n")).toContain("hosts");
    expect(await status()).toMatchObject({ alive: false });

    clock.advance(1000);
    expect(await fixture.daemon.idle()).toEqual({
      reasons: [],
      scheduled: false,
    });
    expect(await status()).toMatchObject({
      alive: true,
      host: "generation",
      pid: fixture.summary.pid,
    });
    fixture.client.close();
  }, 150_000);

  it("schedules no write of the hosts again once a later one landed", async () => {
    const clock = handClock();
    const original = GenerationRecords.prototype.hosting;
    GenerationRecords.prototype.hosting = () => {
      GenerationRecords.prototype.hosting = original;
      return Promise.reject(new Error("injected hosts write failure"));
    };
    let fixture: Awaited<ReturnType<typeof setUp>>;
    try {
      fixture = await setUp({ daemon: { clock } });
    } finally {
      GenerationRecords.prototype.hosting = original;
    }
    expect((await fixture.daemon.idle()).scheduled).toBe(true);
    const otherRoot = join(fixture.gates, "..", "other");
    mkdirSync(otherRoot);
    const otherSource = join(otherRoot, "marbles.config.ts");
    writeFileSync(otherSource, moduleText(fixture, 0));
    const other = await fixture.client.attach(otherSource);
    expect(await fixture.daemon.idle()).toEqual({
      reasons: [],
      scheduled: false,
    });
    const report = await readStatus(fixture.machine.state);
    for (const id of [fixture.summary.id, other.id]) {
      expect(report.workspaces.find((each) => each.id === id)).toMatchObject({
        alive: true,
      });
    }
    fixture.client.close();
  }, 150_000);

  it("hands a released run to the current generation from the database when the notice is lost", async () => {
    const fixture = await setUp({
      daemon: {
        generationEntry: join(
          import.meta.dirname,
          "helpers",
          "generation-dropping-released.ts"
        ),
      },
    });
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    await workspace.actions.launch("late", {});
    await whenLogged(fixture, `late ${String(first)}`);
    const second = await switchFrom(fixture, first, 1);
    open("late", fixture);
    const entry = await openEntry(workspace, "Late?");
    await workspace.actions.answer(entry, "yes");
    await whenLogged(fixture, `answered-late ${String(second)}`);
    await gone(first);
    fixture.client.close();
  }, 150_000);

  it("stops an activity through the generation that holds its session, the other refusing with no effect", async () => {
    const home = testHome({ providers: false });
    const marker = join(home.path, "standin");
    process.env.MARBLES_TEST_STANDIN = marker;
    try {
      const fixture = await setUp({
        daemon: {
          generationEntry: join(
            import.meta.dirname,
            "helpers",
            "generation-with-standin.ts"
          ),
        },
      });
      const first = fixture.summary.pid ?? 0;
      expect(readFileSync(marker, "utf8")).toBe(String(first));
      const workspace = fixture.client.workspace(fixture.summary);
      const holding = workspace.roll("hold1");
      await whenLogged(fixture, `hold1 ${String(first)}`);
      await switchFrom(fixture, first, 1);
      await workspace.actions.runs.stopActivity("session", "activity");
      expect(readFileSync(`${marker}.log`, "utf8")).toBe(
        `stop ${String(first)}\n`
      );
      open(1, fixture);
      await holding;
      fixture.client.close();
    } finally {
      delete process.env.MARBLES_TEST_STANDIN;
    }
  }, 150_000);

  it("switches to an edit a helper got while the first generation loaded it", async () => {
    const home = testHome({ providers: false });
    const root = join(home.path, "project");
    mkdirSync(root);
    const helper = join(root, "helper.ts");
    const loading = join(home.path, "loading");
    const go = join(home.path, "go");
    writeFileSync(helper, "export const value = 1;\n");
    const source = join(root, "marbles.config.ts");
    writeFileSync(
      source,
      `import { value } from "./helper.ts";
import { existsSync, writeFileSync } from "node:fs";
import { step } from "@foundry.sh/marbles";
writeFileSync(${JSON.stringify(loading)}, "");
while (!existsSync(${JSON.stringify(go)})) await new Promise((resolve) => setTimeout(resolve, 20));
export const read = step("read").do(() => value);
`
    );
    daemons.push(
      await startDaemon({ layout: home.layout, print: () => undefined })
    );
    const client = await connect({ layout: home.layout, start: false });
    const attaching = client.attach(source);
    await vi.waitFor(() => expect(existsSync(loading)).toBe(true), {
      interval: 20,
      timeout: 60_000,
    });
    writeFileSync(helper, "export const value = 200;\n");
    writeFileSync(go, "");
    const first = await attaching;
    const workspace = client.workspace(first);
    await vi.waitFor(
      async () => expect((await workspace.roll("read")).value).toBe(200),
      { interval: 250, timeout: 60_000 }
    );
    client.close();
  }, 120_000);

  it("switches to an edit of a helper a run imported after the load", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const helper = join(fixture.gates, "..", "project", "runtime-helper.ts");
    writeFileSync(helper, "export const value = 1;\n");
    writeFileSync(
      fixture.source,
      `${moduleText(fixture, 1)}export const runtime = step("runtime").do(async () => (await import("./runtime-helper.ts")).value);\n`
    );
    const second = await readyOn(fixture, (pid) => pid !== first);
    const workspace = fixture.client.workspace(fixture.summary);
    expect((await workspace.roll("runtime")).value).toBe(1);
    writeFileSync(helper, "export const value = 200;\n");
    await readyOn(fixture, (pid) => pid !== second);
    expect((await workspace.roll("runtime")).value).toBe(200);
    fixture.client.close();
  }, 150_000);

  it("switches once a broken helper that kept a candidate from loading is fixed", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const helper = join(fixture.gates, "..", "project", "broken-helper.ts");
    writeFileSync(
      helper,
      'throw new Error("broken helper");\nexport const value = 2;\n'
    );
    writeFileSync(
      fixture.source,
      `import { value } from "./broken-helper.ts";\n${moduleText(fixture, 1)}export const fixed = step("fixed").do(() => value);\n`
    );
    await vi.waitFor(
      async () => {
        const [summary] = await fixture.client.workspaces();
        expect(summary?.error).toContain("broken helper");
      },
      { interval: 200, timeout: 60_000 }
    );
    expect((await fixture.client.workspaces())[0]?.pid).toBe(first);
    writeFileSync(helper, "export const value = 200;\n");
    await readyOn(fixture, (pid) => pid !== first);
    const workspace = fixture.client.workspace(fixture.summary);
    expect((await workspace.roll("fixed")).value).toBe(200);
    fixture.client.close();
  }, 150_000);
});
