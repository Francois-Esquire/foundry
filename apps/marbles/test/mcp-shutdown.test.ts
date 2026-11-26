import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { cliArgs } from "./helpers/cli";
import { type TestHome, testHome } from "./helpers/home";
import {
  type RawMcpSession,
  rawMcpSession,
  serverPreload,
} from "./helpers/mcp-stdio";

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
  result: z.object({
    content: z
      .array(z.object({ text: z.string().optional(), type: z.string() }))
      .optional(),
    isError: z.boolean().optional(),
  }),
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

async function start(
  root: string,
  body: string,
  options: {
    readonly args?: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
    readonly home?: TestHome;
    readonly piped?: boolean;
  } = {}
): Promise<Started> {
  const home = options.home ?? testHome();
  const env = await serverPreload(
    home.path,
    `console.error("PIDS=" + process.pid + "," + process.ppid);\n${body}`,
    { ...home.env, ...options.env }
  );
  const marbles = [
    "--no-env-file",
    resolve("src/cli.ts"),
    "mcp",
    ...(options.args ?? []),
  ];
  const session = options.piped
    ? await rawMcpSession("sh", ["-c", 'cat | "$@"', "sh", "bun", ...marbles], {
        cwd: root,
        env,
      })
    : await rawMcpSession("bun", marbles, { cwd: root, env });
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
    expect(Date.now() - begun).toBeLessThan(2500);
    expect(alive(server)).toBe(false);
  } finally {
    kill(started?.relay);
    kill(started?.server);
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it("shuts down in order when the relay passes on SIGHUP", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-hangup-"));
  let started: Started | undefined;
  try {
    started = await start(root, "");
    const { relay, server, session } = started;
    process.kill(relay, "SIGHUP");
    const ended = await within(session.ended(), 10_000, "the exit");
    expect(ended.code, ended.stderr).toBe(0);
    expect(alive(server)).toBe(false);
  } finally {
    kill(started?.relay);
    kill(started?.server);
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it("removes the server's recovery record once the server exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-record-"));
  const recovery = await mkdtemp(join(tmpdir(), "marbles-mcp-recovery-"));
  let started: Started | undefined;
  try {
    started = await start(root, "", {
      args: [],
      env: { FOUNDRY_ROOT: recovery },
    });
    const { server, session } = started;
    const record = join(recovery, "processes", `${String(server)}.json`);
    expect(existsSync(record)).toBe(true);
    const ended = await within(session.close(), 10_000, "the exit");
    expect(ended.code, ended.stderr).toBe(0);
    expect(existsSync(record)).toBe(false);
  } finally {
    kill(started?.relay);
    kill(started?.server);
    await rm(root, { force: true, recursive: true });
    await rm(recovery, { force: true, recursive: true });
  }
}, 30_000);

it("shuts down in order when the protocol output fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-epipe-"));
  const home = testHome();
  const { VITEST: _vitest, ...env } = home.env;
  const server = spawn("bun", ["--no-env-file", resolve("src/cli.ts"), "mcp"], {
    cwd: root,
    env: { ...env, MARBLES_MCP_SERVER: "1" },
    stdio: ["pipe", "ignore", "pipe", "pipe", "pipe"],
  });
  let stderr = "";
  server.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const ended = new Promise<number | null>((settle) => {
    server.once("exit", (code) => settle(code));
  });
  try {
    const [input, protocol] = [server.stdin, server.stdio[3]];
    if (input === null || !(protocol instanceof Readable)) {
      throw new Error("the server's pipes did not open");
    }
    let frames = "";
    protocol.setEncoding("utf8");
    protocol.on("data", (chunk: string) => {
      frames += chunk;
    });
    input.write(
      `${JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
          protocolVersion: "2025-06-18",
        },
      })}\n`
    );
    await vi.waitFor(() => expect(frames).toContain('"id":1'), {
      timeout: 15_000,
    });
    protocol.destroy();
    input.write(
      `${JSON.stringify({ id: 2, jsonrpc: "2.0", method: "tools/list" })}\n`
    );
    const code = await within(ended, 10_000, "the exit");
    expect(code, stderr).toBe(0);
    expect(stderr).toContain("marbles mcp: the protocol output failed");
  } finally {
    kill(server.pid);
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it("exits when a shutdown outlives its deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "mm-"));
  const home = testHome();
  const source = join(root, "marbles.ts");
  const spinning = join(root, "spinning");
  let started: Started | undefined;
  try {
    await writeFile(
      source,
      `import { writeFileSync } from "node:fs";
import { step, workflow } from "@foundry.sh/marbles";
const spin = step("spinner").do(async () => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  writeFileSync(${JSON.stringify(spinning)}, "");
  const end = Date.now() + 15_000;
  while (Date.now() < end) {}
});
workflow("spin").do(() => spin({}));`
    );
    const attached = spawnSync(
      "bun",
      [...cliArgs("start"), "--source", source],
      { cwd: root, encoding: "utf8", env: home.env, timeout: 60_000 }
    );
    expect(attached.status, attached.stderr).toBe(0);
    started = await start(root, "", { args: ["--source", source], home });
    const { relay, server, session } = started;
    const dispatched = await call(session, "enqueue_workflow", {
      name: "spin",
    });
    const text = (dispatched.content ?? [])
      .map((part) => part.text ?? part.type)
      .join("\n");
    expect(dispatched.isError, text).not.toBe(true);
    await vi.waitFor(() => expect(existsSync(spinning)).toBe(true), {
      timeout: 15_000,
    });
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
    await session.request("tools/list");
    const begun = Date.now();
    process.kill(relay, "SIGTERM");
    const ended = await within(session.ended(), 10_000, "the exit");
    expect(ended.code).toBe(1);
    expect(ended.stderr).toContain(
      "marbles mcp: shutdown did not finish within 3000ms; exiting"
    );
    expect(Date.now() - begun).toBeLessThan(5000);
    expect(alive(server)).toBe(false);
  } finally {
    kill(started?.relay);
    kill(started?.server);
    await rm(root, { force: true, recursive: true });
  }
}, 90_000);

it("kills a server that does not stop after the relay's deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-blocked-"));
  let started: Started | undefined;
  try {
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
  const home = testHome();
  const { state } = home.layout;
  try {
    const session = await rawMcpSession(
      "bun",
      ["--no-env-file", resolve("src/cli.ts"), "mcp"],
      { cwd: root, env: home.env }
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
    for (const id of await readdir(state)) {
      expect(existsSync(join(state, id, "locks", "tasks")), id).toBe(false);
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
