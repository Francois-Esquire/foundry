import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { connect as connectSocket, createServer } from "node:net";
import { join } from "node:path";
import {
  type lookProcesses,
  processAlive,
  startedAt,
} from "@foundry/lib/process-identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fileIdentity, queuedFiles } from "~/database/client";
import { readDatabase } from "~/database/open";
import { marblesGenerations } from "~/database/tables";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { WorkspaceRegistry } from "~/database/workspaces";
import { type Layout, layout, stateDatabase } from "~/layout";
import type {
  DispatchOptions,
  WorkspaceState,
  WorkspaceSummary,
} from "~/model/connection";
import { Channel, socketTransport } from "~/process/channel";
import {
  connect,
  NoProcessError,
  ProcessMismatchError,
  stopProcess,
} from "~/process/client";
import { type Daemon, startDaemon } from "~/process/daemon";
import { ProcessHeldError, readProcess } from "~/process/instance";
import {
  DAEMON_METHODS,
  GENERATION_METHODS,
  RemoteError,
} from "~/process/protocol";
import { testHome } from "./helpers/home";
import { readWorkspace, touchWorkspace } from "./helpers/registry";

const zodPath = createRequire(import.meta.url).resolve("zod");
const TOKEN_ARGUMENT = /--token (\S+)/;

const looking = vi.hoisted(() => ({
  fake: undefined as typeof lookProcesses | undefined,
}));
vi.mock("@foundry/lib/process-identity", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@foundry/lib/process-identity")>();
  return {
    ...actual,
    lookProcesses: (pids: readonly number[]) =>
      (looking.fake ?? actual.lookProcesses)(pids),
  };
});

interface Fixture {
  readonly home: string;
  readonly machine: Layout;
  readonly root: string;
  readonly source: string;
}

function fixture(): Fixture {
  const home = testHome({ providers: false });
  const root = join(home.path, "project");
  mkdirSync(root);
  const source = join(root, "marbles.config.ts");
  return { home: home.path, machine: home.layout, root, source };
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

async function storedTasks(machine: Layout, id: string) {
  return await readDatabase(stateDatabase(machine.state), async (database) => {
    const records = new DatabaseWorkspaceRecords({ database, scope: id });
    return {
      changes: (await records.log.read({ after: 0, source: "tasks" })).length,
      snapshot: await records.taskStore.snapshot(),
    };
  });
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
});

describe("the Marbles process", () => {
  it("hosts a workspace in an engine generation, answers for it, reloads on an edit, and detaches it", async () => {
    const { machine, root, source } = fixture();
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
    expect(summary.pid).toBeGreaterThan(0);
    expect(summary.pid).not.toBe(process.pid);
    expect(processAlive(summary.pid ?? 0)).toBe(true);

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
    const [reloaded] = await client.workspaces();
    expect(reloaded?.pid).not.toBe(summary.pid);

    await client.detach(summary.id);
    expect(await client.workspaces()).toEqual([]);
    expect((await readWorkspace(machine.state, summary.id))?.hosted).toBe(
      false
    );
    await expect(workspace.describe()).rejects.toThrow(RemoteError);
    client.close();
  }, 60_000);

  it("reports a source that fails to load and hosts it again once it is fixed", async () => {
    const { machine, source } = fixture();
    writeFileSync(source, 'throw new Error("boom at load");\n');
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    await expect(client.attach(source)).rejects.toThrow("boom at load");
    expect(await client.workspaces()).toEqual([]);

    writeFileSync(source, greeter("greet"));
    const summary = await client.attach(source);
    expect(summary.state).toBe("ready");
    expect((await client.reload(summary.id)).state).toBe("ready");
    client.close();
  }, 60_000);

  it("keeps the current generation running when a reload does not load, and says why", async () => {
    const { machine, root, source } = fixture();
    writeFileSync(source, greeter("greet"));
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const summary = await client.attach(source);
    rmSync(root, { force: true, recursive: true });
    await expect(client.reload(summary.id)).rejects.toThrow("did not load");
    const [kept] = await client.workspaces();
    expect(kept).toMatchObject({
      id: summary.id,
      pid: summary.pid,
      state: "ready",
    });
    expect(kept?.error).toContain("the previous load still runs");
    const rolled = await client.workspace(summary).roll("greet", {
      name: "Ada",
    });
    expect(rolled.value).toEqual({ greeting: "Hello Ada" });
    client.close();
  }, 60_000);

  it("makes an attach during a reload wait for the next generation", async () => {
    const { machine, source } = fixture();
    writeFileSync(source, greeter("greet"));
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const first = await client.attach(source);
    const reloading = client.reload(first.id);
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

  it("reloads a workspace that is still starting into a ready one", async () => {
    const { machine, source } = fixture();
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
    await sleep(1000);
    const reloaded = await client.reload(starting?.id ?? "");
    expect(reloaded.state).toBe("ready");
    expect(reloaded.pid).not.toBe(starting?.pid);
    expect((await attaching).state).toBe("ready");
    expect(await client.workspaces()).toEqual([
      expect.objectContaining({ pid: reloaded.pid, state: "ready" }),
    ]);
    client.close();
  }, 60_000);

  it("stops at once a generation it spawned at boot that has not registered", async () => {
    const { machine, source } = fixture();
    writeFileSync(source, greeter("greet"));
    const first = await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    await client.attach(source);
    client.close();
    await first.close();

    const again = await daemonFor(machine);
    const began = Date.now();
    await again.close();
    expect(Date.now() - began).toBeLessThan(10_000);
  }, 60_000);

  it("keeps the lines of overlapping rolls apart", async () => {
    const { machine, source } = fixture();
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
    const { machine, source } = fixture();
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

  it("keeps a workspace's tasks across a restart of the Marbles process", async () => {
    const { machine, source } = fixture();
    writeFileSync(source, greeter("greet"));
    const first = await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const summary = await client.attach(source);
    await client.workspace(summary).tasks({
      change: {
        operations: [
          { input: { title: "Survives" }, key: "t", kind: "task.create" },
        ],
      },
      kind: "change",
    });
    client.close();
    await first.close();

    await daemonFor(machine);
    const again = await connect({ layout: machine, start: false });
    try {
      await vi.waitFor(
        async () => {
          expect(await again.workspaces()).toEqual([
            expect.objectContaining({ id: summary.id, state: "ready" }),
          ]);
        },
        { interval: 250, timeout: 30_000 }
      );
      const listed = await again
        .workspace(summary)
        .tasks({ kind: "list", query: {} });
      expect(listed.items.map((node) => node.title)).toEqual(["Survives"]);
    } finally {
      again.close();
    }
  }, 60_000);

  it("hosts again at boot only the recorded workspaces kept under the state root", async () => {
    const { home, machine } = fixture();
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
    const { machine } = fixture();
    const daemon = await daemonFor(machine);
    rmSync(join(machine.state, "locks", "process"));
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
    const { machine, source } = fixture();
    writeFileSync(source, greeter("greet"));
    const daemon = await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const summary = await client.attach(source);
    const workspace = client.workspace(summary);
    const shutdown = client.shutdown();
    const attaching = client.attach(source);
    const rolling = workspace.roll("greet", { name: "late" });
    const describing = workspace.describe();
    await expect(attaching).rejects.toThrow("the Marbles process is stopping");
    await expect(rolling).rejects.toThrow("the Marbles process is stopping");
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
      const before = await storedTasks(machine, summary.id);
      expect(before?.snapshot.tasks).toHaveLength(1);
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
      expect(await storedTasks(machine, summary.id)).toEqual(before);
      writeFileSync(release, "release");
      expect(await running).not.toBeInstanceOf(Error);
      await daemon.closed;
      expect(await storedTasks(machine, summary.id)).toEqual(before);
    } finally {
      writeFileSync(release, "release");
      client.close();
    }
  }, 60_000);

  it("refuses a client that names another artifact store", async () => {
    const { home, machine } = fixture();
    await daemonFor(machine);
    const elsewhere = {
      ...layout({ home }),
      artifacts: join(home, "elsewhere"),
    };
    const refused = connect({ layout: elsewhere, start: false });
    await expect(refused).rejects.toThrow(ProcessMismatchError);
    await expect(refused).rejects.toThrow(
      `keeps artifacts in ${machine.artifacts}, not ${elsewhere.artifacts}`
    );
    await expect(refused).rejects.toThrow("marbles stop");
  });

  it("refuses a second source under a hosted root, and dispatch params it cannot parse", async () => {
    const { machine, root } = fixture();
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

  it("hosts a workspace attached again while it was being detached", async () => {
    const { machine, source } = fixture();
    writeFileSync(
      source,
      `import { step } from "@foundry.sh/marbles";\nexport const slow = step("slow").do(async () => {\n  await new Promise((resolve) => setTimeout(resolve, 3000));\n  return "slow";\n});\n`
    );
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const summary = await client.attach(source);
    const rolling = client.workspace(summary).roll("slow");
    await sleep(200);
    const detaching = client.detach(summary.id);
    const attaching = client.attach(source);
    await detaching;
    const replaced = await attaching;
    expect(replaced.state).toBe("ready");
    expect((await rolling).value).toBe("slow");
    expect(await client.workspaces()).toEqual([
      expect.objectContaining({ id: summary.id, state: "ready" }),
    ]);
    expect((await readWorkspace(machine.state, summary.id))?.hosted).toBe(true);
    client.close();
  }, 60_000);

  it("keeps a workspace attached again while its detach is recording it", async () => {
    const { machine, source } = fixture();
    writeFileSync(source, greeter("greet"));
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const summary = await client.attach(source);
    const writing = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const { unhost } = WorkspaceRegistry.prototype;
    const paused = vi
      .spyOn(WorkspaceRegistry.prototype, "unhost")
      .mockImplementation(async function (this: WorkspaceRegistry, id) {
        writing.resolve();
        await gate.promise;
        return unhost.call(this, id);
      });
    try {
      const detaching = client.detach(summary.id);
      await writing.promise;
      const attaching = client.attach(source);
      await sleep(300);
      gate.resolve();
      await detaching;
      const again = await attaching;
      expect(again.state).toBe("ready");
      expect(await client.workspaces()).toEqual([
        expect.objectContaining({ id: summary.id, state: "ready" }),
      ]);
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
    const { machine, source } = fixture();
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
    const deaf: Layout = {
      ...machine,
      socket: join(home, "no-such-dir", "marbles.sock"),
    };
    const started = Date.now();
    await expect(startDaemon({ layout: deaf })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(readProcess(machine.state)?.alive).not.toBe(true);
    expect(queuedFiles()).not.toContain(fileIdentity(machine.database));
    const daemon = await daemonFor(machine);
    expect(daemon.pid).toBe(process.pid);
  }, 30_000);

  it("lets go of everything when it cannot listen and printing fails as well", async () => {
    const { home, machine } = fixture();
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
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain("print failed");
    expect(readProcess(machine.state)?.alive).not.toBe(true);
    expect(queuedFiles()).not.toContain(fileIdentity(machine.database));
    const daemon = await daemonFor(machine);
    expect(daemon.pid).toBe(process.pid);
  }, 30_000);

  it("lets go of everything when it is closed and printing fails", async () => {
    const { machine } = fixture();
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

  it("rejects a close with its first failure when a later step fails too", async () => {
    const { home, machine } = fixture();
    const sockets = join(home, "s");
    mkdirSync(sockets);
    const printing: { fails: boolean } = { fails: false };
    const daemon = await startDaemon({
      layout: { ...machine, socket: join(sockets, "m.sock") },
      print: () => {
        if (printing.fails) {
          throw new Error("print failed");
        }
      },
    });
    printing.fails = true;
    chmodSync(sockets, 0o500);
    try {
      await expect(daemon.close()).rejects.toThrow("print failed");
    } finally {
      chmodSync(sockets, 0o700);
    }
    await daemon.closed;
    expect(readProcess(machine.state)?.alive).not.toBe(true);
    expect(queuedFiles()).not.toContain(fileIdentity(machine.database));
  }, 30_000);

  it("kills a generation and its group that would not stop even when saying so fails", async () => {
    const { machine, source } = fixture();
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
      throw new Error("the generation has no pid");
    }
    const { request } = Channel.prototype;
    vi.spyOn(Channel.prototype, "request").mockImplementation(function (
      this: Channel,
      method,
      ...rest
    ) {
      return method === GENERATION_METHODS.stop
        ? Promise.reject(new Error("the generation would not stop"))
        : request.call(this, method, ...rest);
    });
    const kill = vi.spyOn(process, "kill");
    printing.fails = true;
    try {
      await expect(daemon.close()).rejects.toThrow("print failed");
      expect(kill).toHaveBeenCalledWith(-pid, "SIGKILL");
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

  it("sends no signal to a generation whose pid it cannot prove is the one it spawned", async () => {
    const { machine, source } = fixture();
    writeFileSync(source, greeter("greet"));
    const lines: string[] = [];
    const daemon = await startDaemon({
      layout: machine,
      print: (line) => {
        lines.push(line);
      },
    });
    const client = await connect({ layout: machine, start: false });
    const { pid } = await client.attach(source);
    client.close();
    if (pid === undefined) {
      throw new Error("the generation has no pid");
    }
    const real = startedAt(pid);
    if (typeof real !== "string") {
      throw new Error("the generation's start cannot be read");
    }
    const { request } = Channel.prototype;
    vi.spyOn(Channel.prototype, "request").mockImplementation(function (
      this: Channel,
      method,
      ...rest
    ) {
      return method === GENERATION_METHODS.stop
        ? Promise.reject(new Error("the generation would not stop"))
        : request.call(this, method, ...rest);
    });
    looking.fake = (pids) =>
      new Map(pids.map((each) => [each, { pgid: each, started: `${real}0` }]));
    const kill = vi.spyOn(process, "kill");
    try {
      await daemon.close();
      expect(kill).not.toHaveBeenCalledWith(-pid, expect.anything());
      expect(kill).not.toHaveBeenCalledWith(pid, expect.anything());
      expect(
        lines.some((line) => line.includes("is another process now"))
      ).toBe(true);
    } finally {
      looking.fake = undefined;
      vi.restoreAllMocks();
    }
    await vi.waitFor(() => expect(processAlive(pid)).toBe(false), {
      timeout: 30_000,
    });
  }, 90_000);

  it("refuses a second daemon on the same state root, and a client with none to start", async () => {
    const { machine } = fixture();
    await expect(connect({ layout: machine, start: false })).rejects.toThrow(
      NoProcessError
    );
    await daemonFor(machine);
    await expect(startDaemon({ layout: machine })).rejects.toThrow(
      ProcessHeldError
    );
  });

  it("keeps its state root private, creating it so and tightening one that is not", async () => {
    const { machine } = fixture();
    // biome-ignore lint/suspicious/noBitwiseOperators: the permission bits of a mode.
    const mode = (path: string) => statSync(path).mode & 0o777;
    const daemon = await daemonFor(machine);
    expect(mode(machine.state)).toBe(0o700);
    await daemon.close();
    chmodSync(machine.state, 0o755);
    await daemonFor(machine);
    expect(mode(machine.state)).toBe(0o700);
    expect(mode(machine.socket)).toBe(0o600);
  });

  it("refuses a second registration for a generation that registered already", async () => {
    const { machine, source } = fixture();
    writeFileSync(source, greeter("greet"));
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const summary = await client.attach(source);
    const args = execFileSync("ps", [
      "-o",
      "args=",
      "-p",
      String(summary.pid),
    ]).toString();
    const token = TOKEN_ARGUMENT.exec(args)?.[1];
    expect(token).toBeDefined();
    const socket = connectSocket(machine.socket);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const intruder = new Channel(socketTransport(socket));
    await expect(
      intruder.request(DAEMON_METHODS.register, { token })
    ).rejects.toThrow("has registered already");
    const rolled = await client
      .workspace(summary)
      .roll("greet", { name: "Ada" });
    expect(rolled.value).toEqual({ greeting: "Hello Ada" });
    intruder.close();
    client.close();
  }, 60_000);

  it("records a generation's start as soon as it is spawned, before it loads", async () => {
    const { home, machine, source } = fixture();
    const loading = join(home, "loading");
    const loaded = join(home, "loaded");
    writeFileSync(
      source,
      `import { existsSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(loading)}, "");
while (!existsSync(${JSON.stringify(loaded)})) await new Promise((resolve) => setTimeout(resolve, 20));
${greeter("greet")}`
    );
    await daemonFor(machine);
    const client = await connect({ layout: machine, start: false });
    const attaching = client.attach(source);
    await vi.waitFor(() => expect(existsSync(loading)).toBe(true), {
      interval: 20,
      timeout: 60_000,
    });
    const rows = await readDatabase(stateDatabase(machine.state), (database) =>
      database.select().from(marblesGenerations)
    );
    expect(rows).toHaveLength(1);
    const [row] = rows ?? [];
    expect(row?.state).toBe("loading");
    expect(row?.started).not.toBeNull();
    expect(row?.started).toBe(startedAt(row?.pid ?? 0));
    writeFileSync(loaded, "");
    expect((await attaching).state).toBe("ready");
    client.close();
  }, 90_000);
});
