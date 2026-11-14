import { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { connect as connectSocket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processAlive } from "@foundry/lib/file-lock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileIdentity, queuedFiles } from "~/database/client";
import { WorkspaceRegistry } from "~/database/workspaces";
import { type Layout, layout } from "~/layout";
import type {
  DispatchOptions,
  WorkspaceState,
  WorkspaceSummary,
} from "~/model/connection";
import { Channel } from "~/process/channel";
import {
  connect,
  NoProcessError,
  ProcessMismatchError,
  stopProcess,
} from "~/process/client";
import { type Daemon, startDaemon } from "~/process/daemon";
import { ProcessHeldError, readProcess } from "~/process/instance";
import { RemoteError, WORKER_METHODS } from "~/process/protocol";
import { readWorkspace, touchWorkspace } from "./helpers/registry";

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
    expect(await readWorkspace(machine.state, summary.id)).toMatchObject({
      config: source,
      hosted: true,
    });
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
    expect((await readWorkspace(machine.state, summary.id))?.hosted).toBe(
      false
    );
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

  it("keeps the lines of overlapping rolls apart", async () => {
    const { home, machine, source } = fixture();
    homes.push(home);
    const waiting = (name: string, ms: number) =>
      `export const ${name} = step(${JSON.stringify(name)}).do(async () => {\n  await new Promise((resolve) => setTimeout(resolve, ${String(ms)}));\n  return ${JSON.stringify(name)};\n});\n`;
    writeFileSync(
      source,
      `import { step } from "@foundry.sh/marbles";\n${waiting("slow", 400)}${waiting("quick", 50)}`
    );
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const workspace = client.workspace(await client.attach(source));
    const [slow, quick] = await Promise.all([
      workspace.roll("slow"),
      workspace.roll("quick"),
    ]);
    expect(slow.value).toBe("slow");
    expect(quick.value).toBe("quick");
    expect(slow.lines).toContain("[step] slow complete");
    expect(quick.lines).toContain("[step] quick complete");
    expect(slow.lines.join("\n")).not.toContain("quick");
    expect(quick.lines.join("\n")).not.toContain("slow");
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

  it("hosts again at boot only the recorded workspaces kept under the state root", async () => {
    const { home, machine } = fixture();
    homes.push(home);
    const [kept, linked, dangling] = await Promise.all(
      ["kept", "linked", "dangling"].map(async (name) => {
        const root = join(home, name);
        mkdirSync(root);
        const config = join(root, "marbles.config.ts");
        writeFileSync(config, greeter(name));
        const workspace = machine.workspace(root);
        await touchWorkspace(machine.state, workspace, config, {
          hosted: true,
        });
        return workspace;
      })
    );
    if (!(kept && linked && dangling)) {
      throw new Error("the workspaces were not recorded");
    }
    // A worker would write its runs and claim through these links.
    const outside = join(home, "outside");
    mkdirSync(outside);
    symlinkSync(outside, linked.dir);
    symlinkSync(join(home, "missing"), dangling.dir);
    const lines: string[] = [];
    await daemonFor(machine, lines);
    const client = await connect({ layout: machine, start: false });
    try {
      await vi.waitFor(
        async () => {
          expect(await client.workspaces()).toEqual([
            expect.objectContaining({ id: kept.id, state: "ready" }),
          ]);
        },
        { interval: 250, timeout: 30_000 }
      );
      expect(readdirSync(outside)).toEqual([]);
      expect(existsSync(join(home, "missing"))).toBe(false);
      expect(lines.join("\n")).not.toContain(linked.id);
      expect(lines.join("\n")).not.toContain(dangling.id);
    } finally {
      client.close();
    }
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
    const rolling = workspace.roll("greet", { name: "late" });
    const describing = workspace.describe();
    await expect(attaching).rejects.toThrow("the Marbles process is stopping");
    await expect(rolling).rejects.toThrow("the Marbles process is stopping");
    // Reading is still answered: only starting work is refused.
    expect((await describing).definitions.map((entry) => entry.name)).toEqual([
      "greet",
    ]);
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

  it("allows task reads but refuses task changes after shutdown is acknowledged", async () => {
    const { home, machine, source } = fixture();
    homes.push(home);
    const held = join(home, "held");
    const release = join(home, "release");
    writeFileSync(
      source,
      `import { step } from "@foundry.sh/marbles";
import { existsSync, writeFileSync } from "node:fs";
export const hold = step("hold").do(async () => {
  writeFileSync(${JSON.stringify(held)}, "held");
  while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(25);
});`
    );
    const daemon = await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    try {
      const summary = await client.attach(source);
      const workspace = client.workspace(summary);
      const created = await workspace.tasks({
        change: {
          operations: [
            {
              input: { title: "Before shutdown" },
              key: "task",
              kind: "task.create",
            },
          ],
        },
        kind: "change",
      });
      const [task] = created.tasks;
      if (!task) {
        throw new Error("task creation returned no task");
      }
      const records = join(machine.state, summary.id, "tasks.json");
      const before = readFileSync(records, "utf8");
      const running = workspace.roll("hold").catch((error: unknown) => error);
      await vi.waitFor(() => expect(existsSync(held)).toBe(true), {
        timeout: 15_000,
      });
      await client.shutdown();

      expect((await workspace.tasks({ kind: "list", query: {} })).total).toBe(
        1
      );
      expect((await workspace.tasks({ kind: "ready", query: {} })).total).toBe(
        1
      );
      expect(await workspace.tasks({ id: task.id, kind: "get" })).toMatchObject(
        {
          id: task.id,
        }
      );
      await workspace.tasks({ id: task.id, kind: "dependencies" });
      await expect(
        workspace.tasks({
          change: {
            operations: [
              {
                input: { title: "After shutdown" },
                key: "late",
                kind: "task.create",
              },
            ],
          },
          kind: "change",
        })
      ).rejects.toThrow("the Marbles process is stopping");
      expect(readFileSync(records, "utf8")).toBe(before);
      writeFileSync(release, "release");
      expect(await running).not.toBeInstanceOf(Error);
      await daemon.closed;
      expect(readFileSync(records, "utf8")).toBe(before);
    } finally {
      writeFileSync(release, "release");
      client.close();
    }
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

  it("keeps a workspace that was attached again while it was being detached", async () => {
    const { home, machine, source } = fixture();
    homes.push(home);
    writeFileSync(
      source,
      `import { step } from "@foundry.sh/marbles";\nexport const slow = step("slow").do(async () => {\n  await new Promise((resolve) => setTimeout(resolve, 3000));\n  return "slow";\n});\n`
    );
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const summary = await client.attach(source);
    // A run in flight keeps the worker, and its claim on the workspace,
    // for longer than its replacement takes to come up and claim it.
    const rolling = client.workspace(summary).roll("slow");
    await sleep(200);
    // Written together: the attach lands while the detach drains the worker.
    const detaching = client.detach(summary.id);
    const attaching = client.attach(source);
    await expect(detaching).rejects.toThrow("attached again");
    const replaced = await attaching;
    expect(replaced.state).toBe("ready");
    expect(replaced.pid).not.toBe(summary.pid);
    expect((await rolling).value).toBe("slow");
    expect(await client.workspaces()).toEqual([
      expect.objectContaining({ id: summary.id, state: "ready" }),
    ]);
    expect((await readWorkspace(machine.state, summary.id))?.hosted).toBe(true);
    client.close();
  }, 60_000);

  it("keeps a workspace attached again while its detach is recording it", async () => {
    const { home, machine, source } = fixture();
    homes.push(home);
    writeFileSync(source, greeter("greet"));
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const summary = await client.attach(source);
    // The detach drains its worker, then waits here, in the record write.
    const writing = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const { touch } = WorkspaceRegistry.prototype;
    const paused = vi
      .spyOn(WorkspaceRegistry.prototype, "touch")
      .mockImplementation(async function (
        this: WorkspaceRegistry,
        workspace,
        config,
        options
      ) {
        if (options?.hosted === false) {
          writing.resolve();
          await gate.promise;
        }
        return touch.call(this, workspace, config, options);
      });
    try {
      const detaching = client.detach(summary.id);
      await writing.promise;
      const attaching = client.attach(source);
      // Long enough for the attach to reach the daemon and do what it may.
      await sleep(300);
      gate.resolve();
      await detaching;
      expect(await client.workspaces()).toEqual([
        expect.objectContaining({ id: summary.id }),
      ]);
      const again = await attaching;
      expect(again.state).toBe("ready");
      expect(again.pid).not.toBe(summary.pid);
      expect((await readWorkspace(machine.state, summary.id))?.hosted).toBe(
        true
      );
    } finally {
      gate.resolve();
      paused.mockRestore();
      client.close();
    }
  }, 60_000);

  it("refuses to host a workspace whose state links out of the state root", async () => {
    const { home, machine, root, source } = fixture();
    homes.push(home);
    writeFileSync(source, greeter("greet"));
    mkdirSync(machine.state, { recursive: true });
    const outside = join(home, "outside");
    mkdirSync(outside);
    symlinkSync(outside, machine.workspace(root).dir);
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    try {
      await expect(client.attach(source)).rejects.toThrow(
        "links out of the state root"
      );
      expect(await client.workspaces()).toEqual([]);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      client.close();
    }
  }, 30_000);

  it("lets two overlapping detaches of one workspace both succeed", async () => {
    const { home, machine, source } = fixture();
    homes.push(home);
    writeFileSync(source, greeter("greet"));
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    try {
      const summary = await client.attach(source);
      await Promise.all([client.detach(summary.id), client.detach(summary.id)]);
      expect(await client.workspaces()).toEqual([]);
      expect((await readWorkspace(machine.state, summary.id))?.hosted).toBe(
        false
      );
    } finally {
      client.close();
    }
  }, 60_000);

  it("lets go of everything it took when it cannot listen", async () => {
    const { home, machine } = fixture();
    homes.push(home);
    // The socket's directory is not there, so listening fails.
    const deaf: Layout = {
      ...machine,
      socket: join(home, "no-such-dir", "marbles.sock"),
    };
    const started = Date.now();
    await expect(startDaemon({ layout: deaf })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(readProcess(machine.state)?.alive).not.toBe(true);
    // Its database handle is closed: no client in this process holds it.
    expect(queuedFiles()).not.toContain(fileIdentity(machine.database));
    // Nothing is left that would refuse the next Marbles process.
    const daemon = await daemonFor(machine);
    expect(daemon.pid).toBe(process.pid);
  }, 30_000);

  it("lets go of everything when it cannot listen and printing fails as well", async () => {
    const { home, machine } = fixture();
    homes.push(home);
    const deaf: Layout = {
      ...machine,
      socket: join(home, "no-such-dir", "marbles.sock"),
    };
    const failure = await startDaemon({
      layout: deaf,
      print: () => {
        throw new Error("print failed");
      },
    }).then(
      () => undefined,
      (error: unknown) => error
    );
    // What is thrown is why it could not start, not the cleanup's failure.
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("print failed");
    expect(readProcess(machine.state)?.alive).not.toBe(true);
    expect(queuedFiles()).not.toContain(fileIdentity(machine.database));
    const daemon = await daemonFor(machine);
    expect(daemon.pid).toBe(process.pid);
  }, 30_000);

  it("lets go of everything when it is closed and printing fails", async () => {
    const { home, machine } = fixture();
    homes.push(home);
    const printing: { fails: boolean } = { fails: false };
    const daemon = await startDaemon({
      layout: machine,
      print: () => {
        if (printing.fails) {
          throw new Error("print failed");
        }
      },
    });
    printing.fails = true;
    await expect(daemon.close()).rejects.toThrow("print failed");
    await daemon.closed;
    expect(readProcess(machine.state)?.alive).not.toBe(true);
    expect(existsSync(machine.socket)).toBe(false);
    expect(queuedFiles()).not.toContain(fileIdentity(machine.database));
    const next = await daemonFor(machine);
    expect(next.pid).toBe(process.pid);
  }, 30_000);

  it("kills a worker that would not stop even when saying so fails", async () => {
    const { home, machine, source } = fixture();
    homes.push(home);
    writeFileSync(source, greeter("greet"));
    const printing: { fails: boolean } = { fails: false };
    const daemon = await startDaemon({
      layout: machine,
      print: () => {
        if (printing.fails) {
          throw new Error("print failed");
        }
      },
    });
    const client = await connect({ layout: machine, start: false });
    const { pid } = await client.attach(source);
    client.close();
    if (pid === undefined) {
      throw new Error("the worker has no pid");
    }
    // The worker does not answer the stop: the daemon has to kill it.
    const { request } = Channel.prototype;
    vi.spyOn(Channel.prototype, "request").mockImplementation(function (
      this: Channel,
      method,
      ...rest
    ) {
      return method === WORKER_METHODS.stop
        ? Promise.reject(new Error("the worker would not stop"))
        : request.call(this, method, ...rest);
    });
    // It may also leave once its connection drops; the kill must be sent anyway.
    const kill = vi.spyOn(ChildProcess.prototype, "kill");
    printing.fails = true;
    try {
      await expect(daemon.close()).rejects.toThrow("print failed");
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      await vi.waitFor(() => expect(processAlive(pid)).toBe(false), {
        timeout: 5000,
      });
      expect(readProcess(machine.state)?.alive).not.toBe(true);
    } finally {
      vi.restoreAllMocks();
      if (processAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
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
