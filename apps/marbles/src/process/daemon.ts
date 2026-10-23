import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { lockHolder } from "@foundry/lib/file-lock";
import type { Layout } from "~/layout";
import { listWorkspaces } from "~/lib/state/workspace";
import type { WorkspaceSummary } from "~/model/connection";
import { Channel, socketTransport } from "~/process/channel";
import type { ProcessInstance } from "~/process/instance";
import { claimProcess } from "~/process/instance";
import {
  attachParamsSchema,
  CLIENT_NOTIFICATIONS,
  DAEMON_METHODS,
  type HelloResult,
  isWorkspaceMethod,
  lineParamsSchema,
  PROTOCOL,
  readyParamsSchema,
  registerParamsSchema,
  type SetupDraftParams,
  WORKER_METHODS,
  WORKER_NOTIFICATIONS,
  WORKSPACE_PREFIX,
  workspaceIdSchema,
} from "~/process/protocol";
import { resolveSource, sourceFiles, sourceRoot } from "~/workspace/source";
import { version } from "../../package.json";

/**
 * The Marbles process: one per machine, claimed at the state root, holding
 * no engine of its own. It hosts each workspace in a worker process it
 * spawns, answers clients over a Unix socket, and routes each workspace
 * method to the worker that has it. A worker dials the same socket and
 * registers with the token it was spawned with, so one transport carries
 * everything. The daemon never imports an authoring module: a source that
 * fails loads in its worker and fails there. When a worker says its source
 * changed, the daemon drains it and starts a fresh one.
 */

export interface DaemonOptions {
  readonly layout: Layout;
  /** Harness ids workers keep; empty keeps every detected one. */
  readonly only?: readonly string[];
  readonly print?: (line: string) => void;
  /** The worker entry to spawn; the one beside this module when omitted. */
  readonly workerEntry?: string;
}

export interface Daemon {
  close(): Promise<void>;
  readonly closed: Promise<void>;
  readonly pid: number;
  readonly socket: string;
}

/** How long a worker gets to drain before it is killed. */
const STOP_TIMEOUT_MS = 30_000;
/** How long a client waits for a worker to come up. */
const READY_TIMEOUT_MS = 120_000;
/** Source edits arrive in bursts; one restart serves them all. */
const RELOAD_DEBOUNCE_MS = 500;
/** Lines of a worker's stderr kept to explain a failure. */
const STDERR_TAIL = 20;
/** How often the daemon checks that the claim at the state root is still its own. */
const CLAIM_CHECK_MS = 5000;

function workerEntry(): string {
  return fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
      import.meta.url
    )
  );
}

/** Workers run under Bun; so does the daemon, except under a Node test runner. */
function runtime(): string {
  return "Bun" in globalThis ? process.execPath : "bun";
}

interface Worker {
  channel?: Channel;
  child?: ChildProcess;
  /** Resolves when the child exits; replaced with each spawn. */
  exited: Promise<void>;
  /** Handles what the running worker notifies; bound by each spawn. */
  onNotification?: (method: string, params: unknown) => void;
  /** What a client asking for the workspace waits on. */
  readyPromise: Promise<WorkspaceSummary>;
  reloadTimer?: ReturnType<typeof setTimeout>;
  /** Handed to the next worker spawned, once: it posts the setup milestone. */
  setup?: SetupDraftParams;
  readonly source: string;
  stopping?: Promise<void>;
  summary: WorkspaceSummary;
  /** Last lines of stderr, for a failure's explanation. */
  readonly tail: string[];
  /** What the worker spawned last says when it dials in. */
  token?: string;
  wanted: "running" | "stopped";
}

interface Client {
  readonly channel: Channel;
  readonly subscriptions: Set<string>;
}

function timeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

function lines(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      onLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  };
}

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { layout } = options;
  const print = options.print ?? (() => undefined);
  const entry = options.workerEntry ?? workerEntry();
  mkdirSync(layout.state, { recursive: true });
  const claim: ProcessInstance = claimProcess(layout.state, {
    artifacts: layout.artifacts,
    host: "daemon",
    socket: layout.socket,
    version,
  });
  const workers = new Map<string, Worker>();
  const clients = new Set<Client>();
  /** Every open connection, clients and workers alike: closing destroys them. */
  const sockets = new Set<Socket>();
  const { startedAt } = claim;
  let closing: Promise<void> | undefined;

  const hello: HelloResult = {
    artifacts: layout.artifacts,
    pid: process.pid,
    protocol: PROTOCOL,
    startedAt,
    state: layout.state,
    version,
  };

  function publish(worker: Worker): void {
    for (const client of clients) {
      if (client.subscriptions.has(worker.summary.id)) {
        client.channel.notify(CLIENT_NOTIFICATIONS.workspace, worker.summary);
      }
    }
  }

  function setState(
    worker: Worker,
    state: WorkspaceSummary["state"],
    error?: string
  ): void {
    const { error: _dropped, ...rest } = worker.summary;
    worker.summary = {
      ...rest,
      ...(error === undefined ? {} : { error }),
      state,
    };
    publish(worker);
  }

  function forwardLine(worker: Worker, line: string): void {
    print(`[${worker.summary.id}] ${line}`);
    for (const client of clients) {
      if (client.subscriptions.has(worker.summary.id)) {
        client.channel.notify(CLIENT_NOTIFICATIONS.line, {
          id: worker.summary.id,
          line,
        });
      }
    }
  }

  /** The worker spawned for `token` dialed in: bind its channel. */
  function register(token: string, channel: Channel): Worker {
    const worker = [...workers.values()].find(
      (candidate) => candidate.token === token
    );
    if (!worker) {
      throw new Error("no worker was spawned with this token");
    }
    worker.channel = channel;
    return worker;
  }

  function onWorkerNotification(
    worker: Worker,
    settle: (summary: WorkspaceSummary) => void,
    method: string,
    params: unknown
  ): void {
    if (method === WORKER_NOTIFICATIONS.line) {
      const parsed = lineParamsSchema.safeParse(params);
      if (parsed.success) {
        forwardLine(worker, parsed.data.line);
      }
      return;
    }
    if (method === WORKER_NOTIFICATIONS.ready) {
      const parsed = readyParamsSchema.safeParse(params);
      if (!parsed.success) {
        return;
      }
      worker.summary = {
        ...worker.summary,
        config: parsed.data.config,
        id: parsed.data.id,
        root: parsed.data.root,
      };
      setState(worker, "ready");
      settle(worker.summary);
      return;
    }
    if (method === WORKER_NOTIFICATIONS.sourceChanged) {
      scheduleReload(worker);
    }
  }

  function onWorkerExit(
    worker: Worker,
    child: ChildProcess,
    reject: (error: Error) => void,
    code: number | null,
    signalCode: string | null
  ): void {
    if (worker.child !== child) {
      return;
    }
    worker.child = undefined;
    worker.channel = undefined;
    if (worker.wanted === "stopped") {
      setState(worker, "stopped");
      reject(new Error("the worker was stopped"));
      return;
    }
    if (worker.summary.state === "reloading") {
      // A drained worker exits; the fresh one takes over.
      start(worker).catch(() => undefined);
      return;
    }
    const why =
      worker.tail.length > 0
        ? worker.tail.join("\n")
        : `exit ${code === null ? `signal ${String(signalCode)}` : String(code)}`;
    print(`[${worker.summary.id}] worker failed: ${why}`);
    setState(worker, "failed", why);
    reject(new Error(why));
  }

  function start(worker: Worker): Promise<WorkspaceSummary> {
    worker.tail.length = 0;
    setState(worker, "starting");
    let settle: {
      resolve: (summary: WorkspaceSummary) => void;
      reject: (error: Error) => void;
    } = { reject: () => undefined, resolve: () => undefined };
    const ready = new Promise<WorkspaceSummary>((resolve, reject) => {
      settle = { reject, resolve };
    });
    // A failure nobody awaits must not be an unhandled rejection.
    ready.catch(() => undefined);
    const token = crypto.randomUUID();
    const child = spawn(
      runtime(),
      [
        entry,
        "--state",
        layout.state,
        "--artifacts",
        layout.artifacts,
        "--source",
        worker.source,
        "--socket",
        layout.socket,
        "--token",
        token,
        ...(options.only ?? []).flatMap((id) => ["--harness", id]),
        ...(worker.setup === undefined
          ? []
          : ["--setup", JSON.stringify(worker.setup)]),
      ],
      {
        cwd: worker.summary.root,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    worker.setup = undefined;
    worker.child = child;
    worker.token = token;
    worker.readyPromise = ready;
    worker.summary = { ...worker.summary, pid: child.pid ?? -1 };
    worker.exited = new Promise<void>((resolve) => {
      child.once("exit", (code, signalCode) => {
        resolve();
        onWorkerExit(worker, child, settle.reject, code, signalCode);
      });
    });
    child.stderr?.on(
      "data",
      lines((line) => {
        worker.tail.push(line);
        if (worker.tail.length > STDERR_TAIL) {
          worker.tail.shift();
        }
        forwardLine(worker, line);
      })
    );
    child.stdout?.on(
      "data",
      lines((line) => forwardLine(worker, line))
    );
    worker.onNotification = (method, params) =>
      onWorkerNotification(worker, settle.resolve, method, params);
    return ready;
  }

  function scheduleReload(worker: Worker): void {
    if (worker.wanted === "stopped") {
      return;
    }
    clearTimeout(worker.reloadTimer);
    worker.reloadTimer = setTimeout(() => {
      worker.reloadTimer = undefined;
      restart(worker).catch(() => undefined);
    }, RELOAD_DEBOUNCE_MS);
  }

  /** Drain the running worker; its exit starts the next one. */
  async function restart(worker: Worker): Promise<WorkspaceSummary> {
    if (worker.wanted === "stopped") {
      throw new Error(`workspace ${worker.summary.id} is stopped`);
    }
    if (!worker.child) {
      return start(worker);
    }
    if (worker.summary.state === "reloading") {
      return worker.readyPromise;
    }
    print(`[${worker.summary.id}] source changed · reloading`);
    setState(worker, "reloading");
    await drain(worker);
    // The exit handler has spawned the fresh worker by now.
    return worker.readyPromise;
  }

  async function drain(worker: Worker): Promise<void> {
    const { channel, child } = worker;
    if (!child) {
      return;
    }
    try {
      if (channel?.open) {
        // The worker exits right after it answers; either is a clean stop.
        await timeout(
          Promise.race([channel.request(WORKER_METHODS.stop), worker.exited]),
          STOP_TIMEOUT_MS,
          "stopping the worker"
        );
      }
      await timeout(worker.exited, STOP_TIMEOUT_MS, "the worker's exit");
    } catch (error) {
      print(
        `[${worker.summary.id}] ${error instanceof Error ? error.message : String(error)}; killing it`
      );
      // SIGTERM would only ask it to drain again.
      child.kill("SIGKILL");
      await worker.exited;
    }
  }

  async function stopWorker(worker: Worker): Promise<void> {
    worker.wanted = "stopped";
    clearTimeout(worker.reloadTimer);
    worker.stopping ??= drain(worker);
    await worker.stopping;
    setState(worker, "stopped");
  }

  function workerFor(
    source: string,
    setup?: SetupDraftParams,
    root?: string
  ): Worker {
    const configPath = resolveSource(source);
    const found = sourceFiles(configPath) !== undefined;
    const workspace = layout.workspace(
      found ? sourceRoot(configPath) : (root ?? process.cwd())
    );
    const existing = workers.get(workspace.id);
    if (existing && existing.wanted === "running") {
      // A new starter restarts it; so does attaching after its source failed.
      if (setup !== undefined) {
        existing.setup = setup;
        restart(existing).catch(() => undefined);
      } else if (existing.summary.state === "failed") {
        restart(existing).catch(() => undefined);
      }
      return existing;
    }
    workspace.touch(found ? configPath : null, { hosted: true });
    const worker: Worker = {
      exited: Promise.resolve(),
      readyPromise: Promise.reject(new Error("not started")),
      ...(setup === undefined ? {} : { setup }),
      source: configPath,
      summary: {
        config: found ? configPath : null,
        id: workspace.id,
        root: workspace.root,
        state: "starting",
      },
      tail: [],
      wanted: "running",
    };
    worker.readyPromise.catch(() => undefined);
    workers.set(workspace.id, worker);
    start(worker).catch(() => undefined);
    return worker;
  }

  function knownWorker(id: string): Worker {
    const worker = workers.get(id);
    if (!worker) {
      throw new Error(`no workspace "${id}" is hosted`);
    }
    return worker;
  }

  async function answer(
    client: Client,
    method: string,
    params: unknown
  ): Promise<unknown> {
    switch (method) {
      case DAEMON_METHODS.hello:
        return hello;
      case DAEMON_METHODS.workspaces:
        return [...workers.values()].map((worker) => worker.summary);
      case DAEMON_METHODS.attach: {
        const { root, setup, source } = attachParamsSchema.parse(params);
        const worker = workerFor(source, setup, root);
        return timeout(
          worker.readyPromise,
          READY_TIMEOUT_MS,
          "starting the workspace"
        );
      }
      case DAEMON_METHODS.reload: {
        const { id } = workspaceIdSchema.parse(params);
        return timeout(
          restart(knownWorker(id)),
          READY_TIMEOUT_MS,
          "reloading the workspace"
        );
      }
      case DAEMON_METHODS.forget: {
        const { id } = workspaceIdSchema.parse(params);
        const worker = knownWorker(id);
        await stopWorker(worker);
        workers.delete(id);
        layout.workspace(worker.summary.root).touch(worker.summary.config, {
          hosted: false,
        });
        return undefined;
      }
      case DAEMON_METHODS.subscribe: {
        const { id } = workspaceIdSchema.parse(params);
        client.subscriptions.add(id);
        return undefined;
      }
      case DAEMON_METHODS.unsubscribe: {
        const { id } = workspaceIdSchema.parse(params);
        client.subscriptions.delete(id);
        return undefined;
      }
      case DAEMON_METHODS.shutdown:
        setImmediate(() => {
          close().catch(() => undefined);
        });
        return undefined;
      default:
        break;
    }
    if (method.startsWith(WORKSPACE_PREFIX)) {
      const name = method.slice(WORKSPACE_PREFIX.length);
      const { id, ...rest } = workspaceIdSchema.passthrough().parse(params);
      const worker = knownWorker(id);
      if (!isWorkspaceMethod(name)) {
        throw new Error(`no workspace method "${name}"`);
      }
      if (worker.summary.state !== "ready" || !worker.channel) {
        throw new Error(
          `workspace ${id} is ${worker.summary.state}${worker.summary.error ? `: ${worker.summary.error}` : ""}`
        );
      }
      return worker.channel.request(name, rest);
    }
    throw new Error(`no method "${method}"`);
  }

  /**
   * A connection is a client until it registers as a worker; from then on
   * its notifications are the worker's and its requests are refused.
   */
  function onConnection(socket: Socket): void {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let worker: Worker | undefined;
    const client: Client = {
      channel: new Channel(socketTransport(socket), {
        notification(method, params) {
          worker?.onNotification?.(method, params);
        },
        request(method, params) {
          if (worker) {
            return Promise.reject(new Error("a worker only notifies"));
          }
          if (method === DAEMON_METHODS.register) {
            const { token } = registerParamsSchema.parse(params);
            worker = register(token, client.channel);
            clients.delete(client);
            return Promise.resolve();
          }
          return answer(client, method, params);
        },
      }),
      subscriptions: new Set(),
    };
    clients.add(client);
    client.channel.closed
      .then(() => clients.delete(client))
      .catch(() => undefined);
  }

  if (existsSync(layout.socket)) {
    // We hold the lock, so whoever listened here is gone.
    rmSync(layout.socket, { force: true });
  }
  const server: Server = createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(layout.socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Whoever can connect can run workflows and agents as this user.
  chmodSync(layout.socket, 0o600);
  print(`[daemon] pid ${String(process.pid)} · ${layout.socket}`);

  for (const record of listWorkspaces(layout.state)) {
    if (
      record.hosted &&
      record.config !== null &&
      sourceFiles(record.config) !== undefined
    ) {
      workerFor(record.config);
    }
  }

  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  // The claim is the daemon's reason to run: a state root that was removed,
  // or a lock someone else now holds, means this process answers for nothing.
  const claimCheck = setInterval(() => {
    if (lockHolder(join(layout.state, "locks", "process")) !== process.pid) {
      print("[daemon] the claim at the state root is gone; stopping");
      close().catch(() => undefined);
    }
  }, CLAIM_CHECK_MS);
  claimCheck.unref();

  function close(): Promise<void> {
    closing ??= (async () => {
      clearInterval(claimCheck);
      print("[daemon] stopping");
      try {
        await Promise.all(
          [...workers.values()].map((worker) => stopWorker(worker))
        );
      } finally {
        for (const client of clients) {
          client.channel.close();
        }
        // `server.close` waits for every connection; a worker that would not
        // stop, or a client that never hung up, must not hold the exit.
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(layout.socket, { force: true });
        claim.release();
        resolveClosed();
      }
    })();
    return closing;
  }

  return { close, closed, pid: process.pid, socket: layout.socket };
}
