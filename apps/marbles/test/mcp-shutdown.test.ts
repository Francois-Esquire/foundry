import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { layout } from "~/layout";
import { daemonAlive } from "~/process/client";
import { cliArgs } from "./helpers/cli";
import { stopDaemon } from "./helpers/daemon";
import {
  type RawMcpSession,
  rawMcpSession,
  serverPreload,
} from "./helpers/mcp-stdio";

/**
 * `marbles mcp` is a relay and a server (`src/mcp/relay.ts`). The server
 * loads no source, so a Bun preload names both processes and misbehaves
 * on purpose in the server. Every wait is bounded, so a failure still
 * reaches the cleanup that kills them.
 */

const PIDS = /PIDS=(\d+),(\d+)/;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function kill(pid: number | undefined): void {
  if (pid !== undefined && alive(pid)) {
    process.kill(pid, "SIGKILL");
  }
}

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, fail) => {
      timer = setTimeout(
        () => fail(new Error(`${what} took over ${ms}ms`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

const resultSchema = z.object({
  result: z.object({ isError: z.boolean().optional() }),
});

async function call(
  session: RawMcpSession,
  name: string,
  args: Record<string, unknown>
) {
  const answered = resultSchema.parse(
    await session.request("tools/call", { arguments: args, name })
  );
  return answered.result;
}

interface Started {
  readonly relay: number;
  readonly server: number;
  readonly session: RawMcpSession;
}

/**
 * Start `marbles mcp` under `--dry-run`, or with `args` in its place, with
 * `body` run at the start of the server. With `piped`, its stdin is a pipe
 * `cat` writes for as long as the session's stdin is open.
 */
async function start(
  root: string,
  body: string,
  options: { readonly args?: readonly string[]; readonly piped?: boolean } = {}
): Promise<Started> {
  const env = await serverPreload(
    root,
    `console.error("PIDS=" + process.pid + "," + process.ppid);\n${body}`
  );
  const marbles = [
    "--no-env-file",
    resolve("src/cli.ts"),
    "mcp",
    ...(options.args ?? ["--state", join(root, "state"), "--dry-run"]),
  ];
  const session = options.piped
    ? await rawMcpSession("sh", ["-c", 'cat | "$@"', "sh", "bun", ...marbles], {
        cwd: root,
        env,
      })
    : await rawMcpSession("bun", marbles, { cwd: root, env });
  // Stderr is its own pipe, so it may trail the handshake's answer.
  const pids = await vi
    .waitFor(() => {
      const [, server, relay] = PIDS.exec(session.stderr()) ?? [];
      if (server === undefined || relay === undefined) {
        throw new Error(`the server gave no pids:\n${session.stderr()}`);
      }
      return { relay: Number(relay), server: Number(server) };
    })
    .catch((error: unknown) => {
      kill(session.pid);
      throw error;
    });
  return { ...pids, session };
}

it("stops the server when the relay is killed and stdin stays open", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-orphan-"));
  let started: Started | undefined;
  try {
    started = await start(root, "", { piped: true });
    const { relay, server } = started;
    process.kill(relay, "SIGKILL");
    // Well inside the server's own shutdown deadline: nothing waited it out.
    await vi.waitFor(() => expect(alive(server)).toBe(false), {
      interval: 50,
      timeout: 2000,
    });
  } finally {
    kill(started?.relay);
    kill(started?.server);
    await started?.session.close();
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it("exits once shutdown is done, though a timer is pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-pending-"));
  let started: Started | undefined;
  try {
    started = await start(root, "setTimeout(() => undefined, 60_000);");
    const { relay, server, session } = started;
    const begun = Date.now();
    process.kill(relay, "SIGTERM");
    const ended = await within(session.ended(), 10_000, "the exit");
    expect(ended.code).toBe(0);
    // Before the shutdown deadline: the timer did not hold it.
    expect(Date.now() - begun).toBeLessThan(2500);
    expect(alive(server)).toBe(false);
  } finally {
    kill(started?.relay);
    kill(started?.server);
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it("exits when a shutdown outlives its deadline", async () => {
  // Short on purpose: the state root holds a Unix socket, whose path is
  // limited to about a hundred bytes.
  const root = await mkdtemp(join(tmpdir(), "mm-"));
  const state = join(root, "s");
  const source = join(root, "marbles.ts");
  const spinning = join(root, "spinning");
  let started: Started | undefined;
  try {
    // A worker busy in a step answers no task call. Bounded, so a missed
    // cleanup still ends it.
    await writeFile(
      source,
      `import { writeFileSync } from "node:fs";
import { step, workflow } from "@foundry.sh/marbles";
const spin = step("spinner").do(() => {
  writeFileSync(${JSON.stringify(spinning)}, "");
  const end = Date.now() + 15_000;
  while (Date.now() < end) {}
});
workflow("spin").do(() => spin({}));`
    );
    const attached = spawnSync(
      "bun",
      [...cliArgs("attach"), "--source", source, "--state", state],
      { cwd: root, encoding: "utf8", timeout: 60_000 }
    );
    expect(attached.status, attached.stderr).toBe(0);
    started = await start(root, "", {
      args: ["--source", source, "--state", state],
    });
    const { relay, server, session } = started;
    const dispatched = await call(session, "dispatch_workflow", {
      name: "spin",
    });
    expect(dispatched.isError).not.toBe(true);
    await vi.waitFor(() => expect(existsSync(spinning)).toBe(true), {
      timeout: 15_000,
    });
    // The server holds the tasks for this call until the worker answers.
    session
      .request("tools/call", {
        arguments: {
          operations: [
            { input: { title: "Held" }, key: "h", kind: "task.create" },
          ],
        },
        name: "change_tasks",
      })
      .catch(() => undefined);
    // Answered in order, so the task call has begun by then.
    await session.request("tools/list");
    const begun = Date.now();
    process.kill(relay, "SIGTERM");
    const ended = await within(session.ended(), 10_000, "the exit");
    expect(ended.code).toBe(1);
    expect(ended.stderr).toContain(
      "marbles mcp: shutdown did not finish within 3000ms; exiting"
    );
    // The server's own deadline, before the relay's.
    expect(Date.now() - begun).toBeLessThan(5000);
    expect(alive(server)).toBe(false);
  } finally {
    kill(started?.relay);
    kill(started?.server);
    try {
      if (daemonAlive(layout({ state }))) {
        await stopDaemon(state);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }
}, 90_000);

it("kills a server that does not stop after the relay's deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-blocked-"));
  let started: Started | undefined;
  try {
    // A SIGTERM listener that blocks the event loop, so no timer the
    // server set can fire.
    started = await start(
      root,
      `process.on("SIGTERM", () => {
  const end = Date.now() + 30_000;
  while (Date.now() < end) {}
});`
    );
    const { relay, server, session } = started;
    process.kill(relay, "SIGTERM");
    const ended = await within(session.ended(), 10_000, "the exit");
    expect(ended.code).toBe(137);
    expect(ended.stderr).toContain(
      "marbles mcp: the server did not stop within 5000ms; killing it"
    );
    expect(alive(server)).toBe(false);
  } finally {
    kill(started?.relay);
    kill(started?.server);
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it("kills a server whose loop is blocked once stdin closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-spin-"));
  let started: Started | undefined;
  try {
    // Blocks the loop when the test asks. Bounded, so a missed cleanup
    // still ends it.
    started = await start(
      root,
      `const { writeSync } = await import("node:fs");
process.on("SIGUSR2", () => {
  writeSync(2, "SPINNING\\n");
  const end = Date.now() + 60_000;
  while (Date.now() < end) {}
});`
    );
    const { server, session } = started;
    process.kill(server, "SIGUSR2");
    await vi.waitFor(() => expect(session.stderr()).toContain("SPINNING"), {
      timeout: 15_000,
    });
    const ended = await within(session.close(), 15_000, "the exit");
    expect(ended.code).toBe(137);
    expect(ended.stderr).toContain(
      "marbles mcp: the server did not stop within 5000ms; killing it"
    );
    expect(alive(server)).toBe(false);
  } finally {
    kill(started?.relay);
    kill(started?.server);
    await rm(root, { force: true, recursive: true });
  }
}, 60_000);

it("lets a stored-task call finish before it exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-turn-"));
  const state = join(root, "state");
  try {
    const session = await rawMcpSession(
      "bun",
      ["--no-env-file", resolve("src/cli.ts"), "mcp", "--state", state],
      { cwd: root }
    );
    session.notify("notifications/initialized");
    for (const key of ["a", "b", "c"]) {
      session
        .request("tools/call", {
          arguments: {
            operations: [{ input: { title: key }, key, kind: "task.create" }],
          },
          name: "change_tasks",
        })
        .catch(() => undefined);
    }
    const ended = await within(session.close(), 10_000, "the exit");
    expect(ended.code).toBe(0);
    expect(ended.stderr).not.toContain("killing it");
    // No call was cut off holding the tasks.
    for (const id of await readdir(state)) {
      expect(existsSync(join(state, id, "locks", "tasks")), id).toBe(false);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
