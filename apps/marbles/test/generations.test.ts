import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { processAlive } from "@foundry/lib/process-identity";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLiveGenerations } from "~/database/generations";
import { readDatabase } from "~/database/open";
import { marblesExecutions, marblesGenerations } from "~/database/tables";
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
import { testHome } from "./helpers/home";

/**
 * Engine generations, as real processes: the daemon runs here, under the
 * test runner, and each generation it spawns runs under Bun. A step tells
 * which generation ran it by its pid (`where`, `hold<n>`, `asking`), and
 * each `hold<n>` waits for a gate file of its own, so a test decides when
 * the run it holds ends. Editing the source is what starts a switch. Only
 * the generations this test's daemon spawned are ever signalled.
 */

interface Fixture {
  readonly gates: string;
  /** What each step logs: `<step> <pid>`, a line each. */
  readonly log: string;
  readonly machine: Layout;
  readonly source: string;
}

const daemons: Daemon[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
});

const zodPath = createRequire(import.meta.url).resolve("zod");

/**
 * The workspace's source at `revision`: `broken` throws as it loads;
 * `ticking` adds a schedule; `strict` makes `picky` refuse the input its
 * earlier runs were given, so a parked one cannot be rebuilt by an engine
 * that starts with it.
 */
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

/**
 * A clock the test moves on by hand: a timer fires only once `advance`
 * passes its time, so a wait the daemon schedules ends when the test says.
 */
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

/** How many generations the daemon has ever numbered, live or not. */
async function numbered(fixture: Pick<Fixture, "machine">): Promise<number> {
  const rows = await readDatabase(
    stateDatabase(fixture.machine.state),
    (database) => database.select().from(marblesGenerations)
  );
  return rows?.length ?? 0;
}

/** Each `<step> <pid>` line the steps logged. */
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

/** Edit the source, and wait for a generation other than `before` to host the workspace. */
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

/** Wait until the workspace is ready on a generation whose pid `which` accepts; its pid. */
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

/** The id of the open question titled `title`, once the feed shows it. */
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

/** Every Execution Run of the workspace, its name and status, as stored. */
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

/**
 * Prove `pid` is the generation the database records in `state`, by its
 * start, right before this test signals it.
 */
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
    // The queue lets one run in at a time: this one waits behind hold1.
    await workspace.actions.launch("where", {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(logged(fixture)).not.toContain(`where ${String(first)}`);

    const second = await switchFrom(fixture, first, 1);
    // The queued run is the new generation's, and runs there at once.
    await whenLogged(fixture, `where ${String(second)}`);
    expect(logged(fixture)).not.toContain(`where ${String(first)}`);
    // The old one goes on with its run, whole.
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
    // Parked is not running: the old generation has nothing left, and goes.
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

    // The retired generation this test's daemon spawned dies mid-run:
    // proved to be that process, by its recorded start, right before.
    await provedGeneration(fixture, first, "retiring");
    process.kill(first, "SIGKILL");
    await expect(holding).rejects.toThrow();
    // A generation that starts after the death recovers its run.
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
    // Until the third generation has finished a tick of its own.
    await vi.waitFor(
      () =>
        expect(
          logged(fixture).some((line) =>
            line.startsWith(`tock ${String(third)} `)
          )
        ).toBe(true),
      { interval: 200, timeout: 60_000 }
    );
    // Each tick's start and end, in the order they started.
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
        // Never two at once, and each a cadence after the last finished,
        // whichever generation ran it: the stored finish is read again
        // under the tick's claim.
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
    // Its one run ended: the retired generation goes.
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
    // A run that keeps the old generation alive past the switch.
    const holding = workspace.roll("hold1");
    await whenLogged(fixture, `hold1 ${String(first)}`);
    const second = await switchFrom(fixture, first, 1);
    expect(processAlive(first)).toBe(true);

    await workspace.actions.answer(entry ?? "", "yes");
    await whenLogged(fixture, `answered ${String(second)}`);
    open(1, fixture);
    expect((await holding).value).toBe(first);
    await gone(first);
    // Answered once, by the generation that adopted it, and left complete
    // by the old one's stop.
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
    // The first attach, with no generation running yet.
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
    // The next generation loads every registered workspace: the broken
    // one is not among them.
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
    // It is still running on the retired generation: now it parks.
    open("late", fixture);
    // Answered the moment its question shows, whichever generation holds
    // it then: the answer waits for the handover rather than miss it.
    const entry = await openEntry(workspace, "Late?");
    await workspace.actions.answer(entry, "yes");
    await whenLogged(fixture, `answered-late ${String(second)}`);
    expect(
      logged(fixture).filter((line) => line.startsWith("answered-late "))
    ).toEqual([`answered-late ${String(second)}`]);
    // It held nothing parked, and nothing ran: it is gone.
    await gone(first);
    fixture.client.close();
  }, 150_000);

  it("replaces a candidate that fails to start after the previous one retired, once its source can start", async () => {
    const fixture = await setUp();
    const first = fixture.summary.pid ?? 0;
    const workspace = fixture.client.workspace(fixture.summary);
    await workspace.actions.launch("picky", { n: 1 });
    await openEntry(workspace, "Picky?");
    // The next source loads, but cannot rebuild the parked run it takes
    // over: its engine's start fails after the first generation retired.
    writeFileSync(fixture.source, moduleText(fixture, 1, { strict: true }));
    await vi.waitFor(
      async () => {
        const [summary] = await fixture.client.workspaces();
        expect(summary?.state).toBe("failed");
      },
      { interval: 200, timeout: 60_000 }
    );
    await gone(first);
    // With none current, the daemon goes on starting one, as after a
    // crash; once the source can start, one takes over and the run with it.
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
    // Within the stop's bounds: each is asked, then killed.
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
    // A third generation reads the same changes, and delivers none again.
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
    // The source is as it was: only what it imports changes.
    writeFileSync(helper, "export const value = 200;\n");
    const third = await readyOn(fixture, (pid) => pid !== second);
    writeFileSync(data, '{ "value": 200 }\n');
    await readyOn(fixture, (pid) => pid !== third);
    fixture.client.close();
  }, 180_000);

  it("starts no other generation after an attach when nothing changed", async () => {
    const fixture = await setUp();
    // Several polls of the fingerprint: none may see a change.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const generations = await readLiveGenerations(fixture.machine.state);
    expect(generations.map((generation) => generation.pid)).toEqual([
      fixture.summary.pid,
    ]);
    fixture.client.close();
  }, 60_000);

  it("starts exactly one generation for an idle reload, and one more for each after it", async () => {
    const clock = handClock();
    // What the daemon said, so a failure shows why it scheduled a switch.
    const lines: string[] = [];
    const fixture = await setUp({
      daemon: { clock, print: (line) => lines.push(line) },
    });
    const first = fixture.summary.pid ?? 0;
    const second = (await fixture.client.reload(fixture.summary.id)).pid ?? 0;
    expect(second).not.toBe(first);
    await gone(first);
    // Past every backoff a replacement could wait: nothing was scheduled.
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
    // Let go as it parks, and no one told: the daemon finds it stored.
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
      // Keeps the first generation, which holds the session, alive.
      const holding = workspace.roll("hold1");
      await whenLogged(fixture, `hold1 ${String(first)}`);
      await switchFrom(fixture, first, 1);
      await workspace.actions.runs.stopActivity("session", "activity");
      // Stopped once, by its holder; the current one refused, stopping nothing.
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
    // Evaluated already, edited before the load has finished.
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
    // Only the helper changes: the source is the one that was refused.
    writeFileSync(helper, "export const value = 200;\n");
    await readyOn(fixture, (pid) => pid !== first);
    const workspace = fixture.client.workspace(fixture.summary);
    expect((await workspace.roll("fixed")).value).toBe(200);
    fixture.client.close();
  }, 150_000);
});
