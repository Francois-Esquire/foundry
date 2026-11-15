import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "@foundry/lib/process-identity";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLiveGenerations } from "~/database/generations";
import { readDatabase } from "~/database/open";
import { marblesExecutions } from "~/database/tables";
import { type Layout, stateDatabase } from "~/layout";
import type { WorkspaceSummary } from "~/model/connection";
import { connect, type MarblesClient } from "~/process/client";
import { type Daemon, startDaemon } from "~/process/daemon";
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

function moduleText(
  fixture: Pick<Fixture, "gates" | "log">,
  revision: number,
  { broken = false, ticking = false } = {}
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
    'import { schedule, step } from "@foundry.sh/marbles";',
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
    `// revision ${String(revision)}`,
    "",
  ].join("\n");
}

async function setUp({ ticking = false } = {}): Promise<
  Fixture & {
    readonly client: MarblesClient;
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
  daemons.push(
    await startDaemon({ layout: fixture.machine, print: () => undefined })
  );
  const client = await connect({ layout: fixture.machine, start: false });
  const summary = await client.attach(fixture.source);
  return { ...fixture, client, summary };
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
  { ticking = false } = {}
): Promise<number> {
  writeFileSync(fixture.source, moduleText(fixture, revision, { ticking }));
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

function open(gate: number, fixture: Pick<Fixture, "gates">): void {
  writeFileSync(join(fixture.gates, String(gate)), "");
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
    await switchFrom(fixture, second, 2, { ticking: true });
    await new Promise((resolve) => setTimeout(resolve, 3000));
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
    // Past the time a generation that dies as it starts is left down.
    await new Promise((resolve) => setTimeout(resolve, 5500));
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
    const second = await vi.waitFor(
      async () => {
        writeFileSync(fixture.source, moduleText(fixture, 1));
        const now = (await client.workspaces()).find(
          (each) => each.id === summary.id
        );
        expect(now?.state).toBe("ready");
        expect(now?.pid).not.toBe(first);
        return now?.pid ?? 0;
      },
      { interval: 2000, timeout: 60_000 }
    );
    expect((await client.workspace(summary).roll("where")).value).toBe(second);
    client.close();
  }, 120_000);
});
