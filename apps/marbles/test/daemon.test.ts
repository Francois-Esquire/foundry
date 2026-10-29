import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { connect as connectSocket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { type Layout, layout } from "~/layout";
import { readWorkspace } from "~/lib/state/workspace";
import type {
  DispatchOptions,
  WorkspaceState,
  WorkspaceSummary,
} from "~/model/connection";
import {
  connect,
  NoProcessError,
  ProcessMismatchError,
  stopProcess,
} from "~/process/client";
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

/** A greeter whose module takes `ms` to import: a worker that is slow to come up. */
function slowGreeter(name: string, ms: number): string {
  return `await new Promise((resolve) => setTimeout(resolve, ${String(ms)}));\n${greeter(name)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  it("hosts a workspace in a worker, answers for it, reloads on an edit, and detaches it", async () => {
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

    await client.detach(summary.id);
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

    // Attaching again after the fix starts a fresh worker; so does reload.
    writeFileSync(source, greeter("greet"));
    const summary = await client.attach(source);
    expect(summary.state).toBe("ready");
    expect((await client.reload(summary.id)).state).toBe("ready");
    client.close();
  }, 60_000);

  it("marks a workspace failed when its worker cannot be spawned, and keeps running", async () => {
    const { home, machine, root, source } = fixture();
    homes.push(home);
    writeFileSync(source, greeter("greet"));
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const summary = await client.attach(source);
    // The next worker's cwd is gone: spawning it fails with ENOENT.
    rmSync(root, { force: true, recursive: true });
    await expect(client.reload(summary.id)).rejects.toThrow(
      "the worker did not start"
    );
    const [failed] = await client.workspaces();
    expect(failed).toMatchObject({ id: summary.id, state: "failed" });
    expect(failed?.error).toContain("ENOENT");
    client.close();
  }, 60_000);

  it("makes an attach during a reload wait for the fresh worker", async () => {
    const { home, machine, source } = fixture();
    homes.push(home);
    writeFileSync(source, greeter("greet"));
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const first = await client.attach(source);
    const reloading = client.reload(first.id);
    // Asked while the first worker drains: answered by the one after it.
    const attached = await client.attach(source);
    expect(attached.state).toBe("ready");
    expect(attached.pid).not.toBe(first.pid);
    expect((await reloading).pid).toBe(attached.pid);
    const workspace = client.workspace(attached);
    expect(
      (await workspace.describe()).definitions.map((entry) => entry.name)
    ).toEqual(["greet"]);
    client.close();
  }, 60_000);

  it("reloads a worker that is still starting into a ready one", async () => {
    const { home, machine, source } = fixture();
    homes.push(home);
    writeFileSync(source, slowGreeter("greet", 2500));
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const attaching = client.attach(source);
    let starting: WorkspaceSummary | undefined;
    await vi.waitFor(
      async () => {
        [starting] = await client.workspaces();
        expect(starting?.pid).toBeGreaterThan(0);
      },
      { interval: 50, timeout: 10_000 }
    );
    // Long enough for the worker to register, well short of its import.
    await sleep(1000);
    const reloaded = await client.reload(starting?.id ?? "");
    expect(reloaded.state).toBe("ready");
    expect(reloaded.pid).not.toBe(starting?.pid);
    expect((await attaching).pid).toBe(reloaded.pid);
    expect(await client.workspaces()).toEqual([
      expect.objectContaining({ pid: reloaded.pid, state: "ready" }),
    ]);
    client.close();
  }, 60_000);

  it("stops at once a worker it spawned at boot that has not registered", async () => {
    const { home, machine, source } = fixture();
    homes.push(home);
    writeFileSync(source, greeter("greet"));
    const first = await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    await client.attach(source);
    client.close();
    await first.close();

    // Booting re-hosts the workspace; closing right away finds its worker unregistered.
    const again = await daemonFor(machine);
    const began = Date.now();
    await again.close();
    expect(Date.now() - began).toBeLessThan(10_000);
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

  it("stops itself once the claim at the state root is gone, leaving a successor's socket", async () => {
    const { home, machine } = fixture();
    homes.push(home);
    const daemon = await daemonFor(machine);
    rmSync(join(machine.state, "locks", "process"));
    // A successor took the path meanwhile: closing must not unlink it.
    rmSync(machine.socket);
    const successor = createServer((socket) => socket.end());
    await new Promise<void>((resolve) =>
      successor.listen(machine.socket, resolve)
    );
    try {
      await expect(
        Promise.race([
          daemon.closed.then(() => "closed"),
          new Promise((resolve) =>
            setTimeout(() => resolve("still up"), 12_000)
          ),
        ])
      ).resolves.toBe("closed");
      expect(existsSync(machine.socket)).toBe(true);
      await new Promise<void>((resolve, reject) => {
        const socket = connectSocket(machine.socket);
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
    } finally {
      await new Promise((resolve) => successor.close(resolve));
    }
  }, 20_000);

  it("refuses new work once asked to stop, and stop returns after it has exited", async () => {
    const { home, machine, source } = fixture();
    homes.push(home);
    writeFileSync(source, greeter("greet"));
    const daemon = await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const summary = await client.attach(source);
    const workspace = client.workspace(summary);
    // Written together: the daemon reads the shutdown before the others.
    const shutdown = client.shutdown();
    const attaching = client.attach(source);
    const describing = workspace.describe();
    await expect(attaching).rejects.toThrow("the Marbles process is stopping");
    await expect(describing).rejects.toThrow("the Marbles process is stopping");
    await shutdown;
    client.close();
    await daemon.closed;

    const again = await daemonFor(machine);
    let stopped = false;
    again.closed
      .then(() => {
        stopped = true;
      })
      .catch(() => undefined);
    const hello = await stopProcess({ layout: machine });
    expect(hello?.pid).toBe(process.pid);
    expect(stopped).toBe(true);
    expect(readProcess(machine.state)?.alive).not.toBe(true);
    expect(await stopProcess({ layout: machine })).toBeUndefined();
  }, 60_000);

  it("refuses a client that names another artifact store", async () => {
    const { home, machine } = fixture();
    homes.push(home);
    await daemonFor(machine);
    const elsewhere = layout({ artifacts: join(home, "elsewhere"), home });
    const refused = connect({ layout: elsewhere, start: false });
    await expect(refused).rejects.toThrow(ProcessMismatchError);
    await expect(refused).rejects.toThrow(
      `keeps artifacts in ${machine.artifacts}, not ${elsewhere.artifacts}`
    );
    await expect(refused).rejects.toThrow("marbles stop");
  });

  it("refuses a second source under a hosted root, and dispatch params it cannot parse", async () => {
    const { home, machine, root } = fixture();
    homes.push(home);
    const first = join(root, "first.ts");
    const second = join(root, "second.ts");
    writeFileSync(first, greeter("greet"));
    writeFileSync(second, greeter("other"));
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const summary = await client.attach(first);
    await expect(client.attach(second)).rejects.toThrow(
      `workspace ${summary.id} is hosted from ${first}; detach it first`
    );
    expect(await client.workspaces()).toEqual([
      expect.objectContaining({ config: first, state: "ready" }),
    ]);

    const workspace = client.workspace(summary);
    await expect(
      workspace.dispatchAgent({ prompt: 5 } as unknown as DispatchOptions)
    ).rejects.toThrow("prompt");
    client.close();
  }, 60_000);

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
