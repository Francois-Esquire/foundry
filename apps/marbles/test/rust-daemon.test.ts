import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { connect as connectSocket, createServer } from "node:net";
import { join } from "node:path";
import { processAlive } from "@foundry/lib/node/process-identity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readDatabase } from "~/database/open";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { type Layout, stateDatabase } from "~/layout";
import type { WorkspaceState } from "~/model/connection";
import { connect, stopProcess } from "~/process/client";
import { ProcessHeldError, readProcess } from "~/process/instance";
import { RemoteError } from "~/process/protocol";
import {
  DAEMON_BIN_ENV,
  resolveDaemonBinary,
  runRustDaemon,
} from "~/process/rust-daemon";
import { testHome } from "./helpers/home";
import { readWorkspace } from "./helpers/registry";
import { type RustDaemon, startRustDaemon } from "./helpers/rust-daemon";

const zodPath = createRequire(import.meta.url).resolve("zod");
const daemonBinary = resolveDaemonBinary();

interface Fixture {
  readonly env: Record<string, string>;
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
  return {
    env: home.env,
    home: home.path,
    machine: home.layout,
    root,
    source,
  };
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

async function storedTasks(machine: Layout, id: string) {
  return await readDatabase(stateDatabase(machine.state), async (database) => {
    const records = new DatabaseWorkspaceRecords({ database, scope: id });
    return {
      changes: (await records.log.read({ after: 0, source: "tasks" })).length,
      snapshot: await records.taskStore.snapshot(),
    };
  });
}

const daemons: RustDaemon[] = [];

async function daemonFor(
  setup: Pick<Fixture, "env" | "machine">,
  options: {
    readonly binary?: string;
    readonly lines?: string[];
    readonly selfRecycle?: boolean;
  } = {}
): Promise<RustDaemon> {
  const daemon = await startRustDaemon({
    binary: options.binary ?? daemonBinary,
    env: setup.env,
    layout: setup.machine,
    print: (line) => {
      options.lines?.push(line);
    },
    selfRecycle: options.selfRecycle ?? false,
  });
  daemons.push(daemon);
  return daemon;
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
});

describe.skipIf(
  daemonBinary === undefined && !process.env.CI && !process.env[DAEMON_BIN_ENV]
)("Rust marbles-daemon parity with Bun engine generations", () => {
  it("hosts workspaces in real Bun generations, rolls steps, selectively reloads on edit, and detaches", async () => {
    const setup = fixture();
    const otherRoot = join(setup.home, "other");
    mkdirSync(otherRoot);
    const otherSource = join(otherRoot, "marbles.config.ts");
    writeFileSync(setup.source, greeter("greet"));
    writeFileSync(otherSource, greeter("other"));

    const lines: string[] = [];
    const daemon = await daemonFor(setup, { lines });
    expect(existsSync(setup.machine.database)).toBe(true);
    expect(readProcess(setup.machine.state)).toMatchObject({
      alive: true,
      host: "daemon",
      pid: daemon.pid,
      socket: setup.machine.socket,
    });

    const client = await connect({ layout: setup.machine, start: false });
    try {
      expect(client.hello.pid).toBe(daemon.pid);
      expect(await client.workspaces()).toEqual([]);

      const alpha = await client.attach(setup.source);
      const beta = await client.attach(otherSource);
      expect(alpha).toMatchObject({
        config: setup.source,
        id: setup.machine.workspace(setup.root).id,
        state: "ready",
      });
      expect(beta).toMatchObject({
        config: otherSource,
        id: setup.machine.workspace(otherRoot).id,
        state: "ready",
      });
      expect(await readWorkspace(setup.machine.state, alpha.id)).toMatchObject({
        config: setup.source,
        hosted: true,
      });
      expect(alpha.pid).toBeGreaterThan(0);
      expect(alpha.pid).not.toBe(daemon.pid);
      expect(processAlive(alpha.pid ?? 0)).toBe(true);

      const workspace = client.workspace(alpha);
      expect(
        (await workspace.describe()).definitions.map((entry) => entry.name)
      ).toEqual(["greet"]);
      expect(
        (await workspace.snapshot()).definitions.map((entry) => entry.name)
      ).toEqual(["greet"]);
      const rolled = await workspace.roll("greet", { name: "Ada" });
      expect(rolled.value).toEqual({ greeting: "Hello Ada" });
      expect(rolled.lines).toContain("[step] greet complete");

      const alphaStates: WorkspaceState[] = [];
      const betaStates: WorkspaceState[] = [];
      const stopAlpha = client.subscribe(alpha.id, {
        workspace: (next) => alphaStates.push(next.state),
      });
      const stopBeta = client.subscribe(beta.id, {
        workspace: (next) => betaStates.push(next.state),
      });
      writeFileSync(setup.source, greeter("greet2"));
      await vi.waitFor(
        async () => {
          expect(
            (await workspace.describe()).definitions.map((entry) => entry.name)
          ).toEqual(["greet2"]);
        },
        { interval: 250, timeout: 30_000 }
      );
      stopAlpha();
      stopBeta();
      expect(alphaStates).toContain("reloading");
      expect(alphaStates.at(-1)).toBe("ready");
      expect(betaStates).not.toContain("reloading");
      expect(lines).toContain(`[${alpha.id}] source changed · reloading`);

      const current = await client.workspaces();
      const reloadedAlpha = current.find((entry) => entry.id === alpha.id);
      expect(reloadedAlpha?.pid).not.toBe(alpha.pid);

      await client.detach(alpha.id);
      await client.detach(beta.id);
      expect(await client.workspaces()).toEqual([]);
      expect((await readWorkspace(setup.machine.state, alpha.id))?.hosted).toBe(
        false
      );
      await expect(workspace.describe()).rejects.toThrow(RemoteError);
    } finally {
      client.close();
    }
  }, 60_000);

  it("refuses broken initial sources, keeps the running generation on broken reload, and recovers when fixed", async () => {
    const setup = fixture();
    writeFileSync(setup.source, 'throw new Error("boom at load");\n');
    await daemonFor(setup);

    const client = await connect({ layout: setup.machine, start: false });
    try {
      await expect(client.attach(setup.source)).rejects.toThrow("boom at load");
      expect(await client.workspaces()).toEqual([]);

      writeFileSync(setup.source, greeter("greet"));
      const summary = await client.attach(setup.source);
      expect(summary.state).toBe("ready");

      rmSync(setup.root, { force: true, recursive: true });
      await expect(client.reload(summary.id)).rejects.toThrow("did not load");
      const [kept] = await client.workspaces();
      expect(kept).toMatchObject({
        id: summary.id,
        pid: summary.pid,
        state: "ready",
      });
      expect(kept?.error).toContain("the previous load still runs");
      const rolled = await client
        .workspace(summary)
        .roll("greet", { name: "Ada" });
      expect(rolled.value).toEqual({ greeting: "Hello Ada" });
    } finally {
      client.close();
    }
  }, 60_000);

  it("re-hosts persisted workspaces and keeps tasks across a daemon restart", async () => {
    const setup = fixture();
    writeFileSync(setup.source, greeter("greet"));
    const first = await daemonFor(setup);
    const client = await connect({ layout: setup.machine, start: false });
    const summary = await client.attach(setup.source);
    await client.workspace(summary).tasks({
      change: {
        operations: [
          {
            input: { title: "Survives Rust restart" },
            key: "t",
            kind: "task.create",
          },
        ],
      },
      kind: "change",
    });
    client.close();
    await first.close();
    expect(readProcess(setup.machine.state)?.alive).not.toBe(true);

    await daemonFor(setup);
    const again = await connect({ layout: setup.machine, start: false });
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
      expect(listed.items.map((node) => node.title)).toEqual([
        "Survives Rust restart",
      ]);
    } finally {
      again.close();
    }
  }, 60_000);

  it("refuses mutations after shutdown while letting reads and in-flight work finish", async () => {
    const setup = fixture();
    const held = join(setup.home, "held");
    const release = join(setup.home, "release");
    writeFileSync(
      setup.source,
      `import { step } from "@foundry.sh/marbles";
import { existsSync, writeFileSync } from "node:fs";
export const hold = step("hold").do(async () => {
  writeFileSync(${JSON.stringify(held)}, "held");
  while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(25);
});`
    );
    const daemon = await daemonFor(setup);
    const client = await connect({ layout: setup.machine, start: false });
    try {
      const summary = await client.attach(setup.source);
      const workspace = client.workspace(summary);
      await workspace.tasks({
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
      const before = await storedTasks(setup.machine, summary.id);
      const running = workspace.roll("hold").catch((error: unknown) => error);
      await vi.waitFor(() => expect(existsSync(held)).toBe(true), {
        timeout: 15_000,
      });

      await client.shutdown();
      await expect(client.attach(setup.source)).rejects.toThrow(
        "the Marbles process is stopping"
      );
      await expect(workspace.roll("hold")).rejects.toThrow(
        "the Marbles process is stopping"
      );
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
      expect((await workspace.tasks({ kind: "list", query: {} })).total).toBe(
        1
      );
      expect(
        (await workspace.describe()).definitions.map((entry) => entry.name)
      ).toEqual(["hold"]);

      writeFileSync(release, "release");
      expect(await running).not.toBeInstanceOf(Error);
      await daemon.closed;
      expect(await storedTasks(setup.machine, summary.id)).toEqual(before);
    } finally {
      writeFileSync(release, "release");
      client.close();
    }
  }, 60_000);

  it("enforces single-instance claim, tightens state root permissions, refuses escaping symlinks, and stops on claim loss", async () => {
    const setup = fixture();
    // biome-ignore lint/suspicious/noBitwiseOperators: permission bits of a stat mode.
    const mode = (path: string) => statSync(path).mode & 0o777;

    mkdirSync(setup.machine.state, { recursive: true });
    chmodSync(setup.machine.state, 0o755);

    const daemon = await daemonFor(setup);
    expect(mode(setup.machine.state)).toBe(0o700);
    expect(mode(setup.machine.socket)).toBe(0o600);
    const held = await daemonFor(setup).catch((error: unknown) => error);
    expect(held).toBeInstanceOf(ProcessHeldError);
    const heldMessage = (held as Error).message;
    expect(
      heldMessage.split("a Marbles process already runs here")
    ).toHaveLength(2);

    const outside = join(setup.home, "outside");
    mkdirSync(outside);
    writeFileSync(setup.source, greeter("greet"));
    symlinkSync(outside, setup.machine.workspace(setup.root).dir);
    const client = await connect({ layout: setup.machine, start: false });
    try {
      await expect(client.attach(setup.source)).rejects.toThrow(
        "links out of the state root"
      );
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      client.close();
    }

    rmSync(join(setup.machine.state, "locks", "process"));
    rmSync(setup.machine.socket);
    const successor = createServer((socket) => socket.end());
    await new Promise<void>((resolveListen) =>
      successor.listen(setup.machine.socket, resolveListen)
    );
    try {
      await expect(
        Promise.race([
          daemon.closed.then(() => "closed"),
          new Promise((resolveTimeout) =>
            setTimeout(() => resolveTimeout("still up"), 12_000)
          ),
        ])
      ).resolves.toBe("closed");
      expect(existsSync(setup.machine.socket)).toBe(true);
      await new Promise<void>((resolveDial, rejectDial) => {
        const socket = connectSocket(setup.machine.socket);
        socket.once("connect", () => {
          socket.destroy();
          resolveDial();
        });
        socket.once("error", rejectDial);
      });
    } finally {
      await new Promise((resolveClose) => successor.close(resolveClose));
    }
  }, 45_000);

  it("self-recycles in place when the daemon executable changes while preserving hosted Bun workspaces", async () => {
    const setup = fixture();
    writeFileSync(setup.source, greeter("greet"));
    const binDir = join(setup.home, "bin");
    mkdirSync(binDir);
    const installed = join(binDir, "marbles-daemon");
    if (daemonBinary === undefined) {
      throw new Error("marbles-daemon binary is required");
    }
    copyFileSync(daemonBinary, installed);
    chmodSync(installed, 0o755);

    const lines: string[] = [];
    const daemon = await daemonFor(setup, {
      binary: installed,
      lines,
      selfRecycle: true,
    });
    const originalPid = daemon.pid;

    const before = await connect({ layout: setup.machine, start: false });
    const summary = await before.attach(setup.source);
    const beforeRoll = await before
      .workspace(summary)
      .roll("greet", { name: "Before" });
    expect(beforeRoll.value).toEqual({ greeting: "Hello Before" });
    before.close();

    const replacement = join(binDir, "marbles-daemon.next");
    writeFileSync(
      replacement,
      `#!/bin/sh\nexec ${JSON.stringify(daemonBinary)} "$@"\n`
    );
    chmodSync(replacement, 0o755);
    renameSync(replacement, installed);

    await vi.waitFor(
      () => {
        expect(lines.some((line) => line.includes("recycling"))).toBe(true);
      },
      { interval: 100, timeout: 15_000 }
    );

    let after: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      await vi.waitFor(
        async () => {
          after?.close();
          after = undefined;
          const next = await connect({
            layout: setup.machine,
            start: false,
            timeoutMs: 2000,
          });
          const hosted = await next.workspaces();
          const ready = hosted.find(
            (entry) => entry.id === summary.id && entry.state === "ready"
          );
          if (ready === undefined || ready.pid === summary.pid) {
            next.close();
            throw new Error("waiting for recycled generation");
          }
          after = next;
        },
        { interval: 250, timeout: 30_000 }
      );
      expect(after?.hello.pid).toBe(originalPid);
      const afterRoll = await after
        ?.workspace(summary)
        .roll("greet", { name: "After" });
      expect(afterRoll?.value).toEqual({ greeting: "Hello After" });
    } finally {
      after?.close();
    }
  }, 60_000);

  it("auto-starts the detached Rust daemon via connect() and stops cleanly via stopProcess()", async () => {
    const setup = fixture();
    writeFileSync(setup.source, greeter("greet"));
    vi.stubEnv("FOUNDRY_HOME", setup.home);
    vi.stubEnv("MARBLES_SPAWN_RECORD", setup.env.MARBLES_SPAWN_RECORD);
    try {
      const client = await connect({
        layout: setup.machine,
        timeoutMs: 20_000,
      });
      try {
        const summary = await client.attach(setup.source);
        const rolled = await client
          .workspace(summary)
          .roll("greet", { name: "Detached" });
        expect(rolled.value).toEqual({ greeting: "Hello Detached" });
      } finally {
        client.close();
      }
      const stopped = await stopProcess({ layout: setup.machine });
      expect(stopped).toBeDefined();
      expect(readProcess(setup.machine.state)?.alive).not.toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);
  it("does not shut down a successor when closing a daemon that lost its claim", async () => {
    const setup = fixture();
    const first = await daemonFor(setup);

    rmSync(join(setup.machine.state, "locks", "process"));
    rmSync(setup.machine.socket);
    const second = await daemonFor(setup);
    expect(second.pid).not.toBe(first.pid);

    await first.close();

    await expect(
      Promise.race([
        second.closed.then(() => "closed"),
        new Promise((resolveTimeout) =>
          setTimeout(() => resolveTimeout("still up"), 1500)
        ),
      ])
    ).resolves.toBe("still up");
    expect(processAlive(second.pid)).toBe(true);
    const client = await connect({ layout: setup.machine, start: false });
    try {
      expect(client.hello.pid).toBe(second.pid);
    } finally {
      client.close();
    }
    await second.close();
  }, 60_000);
});

describe("explicit Rust daemon binary", () => {
  it("rejects connect() cleanly when MARBLES_DAEMON_BIN is missing or not executable", async () => {
    const setup = fixture();
    const missing = join(setup.home, "no-such-daemon");
    const plain = join(setup.home, "plain-file");
    writeFileSync(plain, "not executable");
    chmodSync(plain, 0o644);
    try {
      for (const configured of [missing, plain]) {
        vi.stubEnv(DAEMON_BIN_ENV, configured);
        await expect(
          connect({ layout: setup.machine, timeoutMs: 5000 })
        ).rejects.toThrow(new RegExp(`${DAEMON_BIN_ENV}.*${configured}`));
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("validates MARBLES_DAEMON_BIN and resolves the workspace binary when built", () => {
    expect(resolveDaemonBinary({})).toBe(daemonBinary);
    expect(resolveDaemonBinary({ [DAEMON_BIN_ENV]: "" })).toBe(daemonBinary);
    expect(() =>
      resolveDaemonBinary({ [DAEMON_BIN_ENV]: "/no/such/marbles-daemon" })
    ).toThrow(DAEMON_BIN_ENV);
  });

  it("reports a daemon killed by a signal as a nonzero exit status", async () => {
    const setup = fixture();
    const stub = join(setup.home, "killed-daemon");
    writeFileSync(stub, "#!/bin/sh\nkill -KILL $$\n");
    chmodSync(stub, 0o755);
    vi.stubEnv(DAEMON_BIN_ENV, stub);
    const previous = process.exitCode;
    try {
      expect(await runRustDaemon({ layout: setup.machine })).toBe(true);
      expect(process.exitCode).toBe(137);
    } finally {
      process.exitCode = previous;
      vi.unstubAllEnvs();
    }
  });
});
