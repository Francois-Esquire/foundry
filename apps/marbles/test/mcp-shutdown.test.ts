import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { type RawMcpSession, rawMcpSession } from "./helpers/mcp-stdio";

/**
 * `marbles mcp` is a relay and a server (`src/mcp/relay.ts`). These start
 * it under `--dry-run`, where the source loads in the server, so the source
 * can name both processes and misbehave on purpose. Every wait is bounded,
 * so a failure still reaches the cleanup that kills them.
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
 * Start `marbles mcp` with `body` as its source. With `piped`, its stdin
 * is a pipe `cat` writes for as long as the session's stdin is open.
 */
async function start(
  root: string,
  body: string,
  options: { readonly piped?: boolean } = {}
): Promise<Started> {
  const source = join(root, "marbles.ts");
  await writeFile(
    source,
    `console.error("PIDS=" + process.pid + "," + process.ppid);\n${body}`
  );
  const marbles = [
    "--no-env-file",
    resolve("src/cli.ts"),
    "mcp",
    "--source",
    source,
    "--state",
    join(root, "state"),
    "--dry-run",
  ];
  const session = options.piped
    ? await rawMcpSession("sh", ["-c", 'cat | "$@"', "sh", "bun", ...marbles], {
        cwd: root,
      })
    : await rawMcpSession("bun", marbles, {
        cwd: root,
      });
  const [, server, relay] = PIDS.exec(session.stderr()) ?? [];
  if (server === undefined || relay === undefined) {
    kill(session.pid);
    throw new Error(`the server gave no pids:\n${session.stderr()}`);
  }
  return { relay: Number(relay), server: Number(server), session };
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

it("exits once shutdown is done, though a cancelled step's timer is pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-pending-"));
  let started: Started | undefined;
  try {
    started = await start(
      root,
      `import { step, workflow } from "@foundry.sh/marbles";
const hang = step("hang").do(() => new Promise((settle) => setTimeout(settle, 60_000)));
workflow("stuck").do(() => hang({}));`
    );
    const { relay, server, session } = started;
    const dispatched = await call(session, "dispatch_workflow", {
      name: "stuck",
    });
    expect(dispatched.isError).not.toBe(true);
    await vi.waitFor(() =>
      expect(session.stderr()).toContain("[step] stuck started")
    );
    const begun = Date.now();
    process.kill(relay, "SIGTERM");
    const ended = await within(session.ended(), 10_000, "the exit");
    expect(ended.code).toBe(0);
    // Before the shutdown deadline: the step's timer did not hold it.
    expect(Date.now() - begun).toBeLessThan(2500);
    expect(alive(server)).toBe(false);
  } finally {
    kill(started?.relay);
    kill(started?.server);
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it("exits when a shutdown outlives its deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "marbles-mcp-stuck-"));
  let started: Started | undefined;
  try {
    // The engine stops after a running handler finishes, and this one never
    // does.
    started = await start(
      root,
      `import { observe, tasks } from "@foundry.sh/marbles";
observe(tasks, () => {
  console.error("OBSERVED");
  return new Promise(() => undefined);
});`
    );
    const { relay, server, session } = started;
    const changed = await call(session, "change_tasks", {
      operations: [{ input: { title: "Held" }, key: "h", kind: "task.create" }],
    });
    expect(changed.isError).not.toBe(true);
    await vi.waitFor(() => expect(session.stderr()).toContain("OBSERVED"));
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
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

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
