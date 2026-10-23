import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { type Layout, layout } from "~/layout";
import { readWorkspace } from "~/lib/state/workspace";
import type { WorkspaceState } from "~/model/connection";
import { connect, NoProcessError } from "~/process/client";
import { type Daemon, startDaemon } from "~/process/daemon";
import { ProcessHeldError, readProcess } from "~/process/instance";
import { RemoteError } from "~/process/protocol";

/**
 * The daemon runs here, under the test runner; the workers it spawns run
 * under Bun, as they always do. The state root sits in a short temp path:
 * a Unix socket path has about a hundred bytes to work with.
 */

const zodPath = createRequire(import.meta.url).resolve("zod");

interface Fixture {
  readonly home: string;
  readonly machine: Layout;
  readonly root: string;
  readonly source: string;
}

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "mb-"));
  const root = join(home, "project");
  mkdirSync(root);
  const source = join(root, "marbles.config.ts");
  return { home, machine: layout({ home }), root, source };
}

function greeter(name: string): string {
  return [
    'import { step } from "@foundry.sh/marbles";',
    `import { z } from ${JSON.stringify(zodPath)};`,
    `export const ${name} = step(${JSON.stringify(name)})`,
    "  .input(z.object({ name: z.string() }))",
    '  .do(({ input }) => ({ greeting: "Hello " + input.name }));',
    "",
  ].join("\n");
}

const daemons: Daemon[] = [];
const homes: string[] = [];

async function daemonFor(machine: Layout, lines: string[] = []) {
  const daemon = await startDaemon({
    layout: machine,
    print: (line) => {
      lines.push(line);
    },
  });
  daemons.push(daemon);
  return daemon;
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  for (const home of homes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

describe("the Marbles process", () => {
  it("hosts a workspace in a worker, answers for it, reloads on an edit, and forgets it", async () => {
    const { home, machine, root, source } = fixture();
    homes.push(home);
    writeFileSync(source, greeter("greet"));
    const lines: string[] = [];
    await daemonFor(machine, lines);
    expect(readProcess(machine.state)).toMatchObject({
      alive: true,
      host: "daemon",
      pid: process.pid,
      socket: machine.socket,
    });

    const client = await connect({ layout: machine, start: false });
    expect(client.hello.pid).toBe(process.pid);
    expect(await client.workspaces()).toEqual([]);

    const summary = await client.attach(source);
    expect(summary).toMatchObject({
      config: source,
      id: machine.workspace(root).id,
      state: "ready",
    });
    expect(readWorkspace(join(machine.state, summary.id))).toMatchObject({
      config: source,
      hosted: true,
    });
    // The worker claimed the workspace, and it is another process.
    const worker = readProcess(join(machine.state, summary.id));
    expect(worker).toMatchObject({ alive: true, host: "worker" });
    expect(worker?.pid).not.toBe(process.pid);

    const workspace = client.workspace(summary);
    expect(
      (await workspace.describe()).definitions.map((entry) => entry.name)
    ).toEqual(["greet"]);
    expect(
      (await workspace.snapshot()).definitions.map((entry) => entry.name)
    ).toEqual(["greet"]);
    const rolled = await workspace.roll("greet", { name: "Ada" });
    expect(rolled.value).toEqual({ greeting: "Hello Ada" });
    expect(rolled.lines).toContain("[step] greet complete");

    // An edit restarts the worker; the new source is what answers next.
    const states: WorkspaceState[] = [];
    const unsubscribe = client.subscribe(summary.id, {
      workspace: (next) => {
        states.push(next.state);
      },
    });
    writeFileSync(source, greeter("greet2"));
    await vi.waitFor(
      async () => {
        expect(
          (await workspace.describe()).definitions.map((entry) => entry.name)
        ).toEqual(["greet2"]);
      },
      { interval: 250, timeout: 30_000 }
    );
    unsubscribe();
    expect(states).toContain("reloading");
    expect(states.at(-1)).toBe("ready");
    expect(lines).toContain(`[${summary.id}] source changed · reloading`);
    expect(readProcess(join(machine.state, summary.id))?.pid).not.toBe(
      worker?.pid
    );

    await client.forget(summary.id);
    expect(await client.workspaces()).toEqual([]);
    expect(readWorkspace(join(machine.state, summary.id))?.hosted).toBe(false);
    expect(readProcess(join(machine.state, summary.id))?.alive).not.toBe(true);
    await expect(workspace.describe()).rejects.toThrow(RemoteError);
    client.close();
  }, 60_000);

  it("reports a source that fails to load and hosts it again once it is fixed", async () => {
    const { home, machine, source } = fixture();
    homes.push(home);
    writeFileSync(source, 'throw new Error("boom at load");\n');
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    await expect(client.attach(source)).rejects.toThrow("boom at load");
    const [failed] = await client.workspaces();
    expect(failed).toMatchObject({ state: "failed" });
    expect(failed?.error).toContain("boom at load");

    writeFileSync(source, greeter("greet"));
    const summary = await client.reload(failed?.id ?? "");
    expect(summary.state).toBe("ready");
    client.close();
  }, 60_000);

  it("hosts every workspace recorded as hosted when it starts again", async () => {
    const { home, machine, source } = fixture();
    homes.push(home);
    writeFileSync(source, greeter("greet"));
    const first = await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const summary = await client.attach(source);
    client.close();
    await first.close();
    expect(readProcess(machine.state)?.alive).not.toBe(true);

    await daemonFor(machine);
    const again = await connect({ layout: machine, start: false });
    await vi.waitFor(
      async () => {
        expect(await again.workspaces()).toEqual([
          expect.objectContaining({ id: summary.id, state: "ready" }),
        ]);
      },
      { interval: 250, timeout: 30_000 }
    );
    again.close();
  }, 60_000);

  it("stops itself once the claim at the state root is gone", async () => {
    const { home, machine } = fixture();
    homes.push(home);
    const daemon = await daemonFor(machine);
    rmSync(join(machine.state, "locks", "process"));
    await expect(
      Promise.race([
        daemon.closed.then(() => "closed"),
        new Promise((resolve) => setTimeout(() => resolve("still up"), 12_000)),
      ])
    ).resolves.toBe("closed");
  }, 20_000);

  it("refuses a second daemon on the same state root, and a client with none to start", async () => {
    const { home, machine } = fixture();
    homes.push(home);
    await expect(connect({ layout: machine, start: false })).rejects.toThrow(
      NoProcessError
    );
    await daemonFor(machine);
    await expect(startDaemon({ layout: machine })).rejects.toThrow(
      ProcessHeldError
    );
  });
});
