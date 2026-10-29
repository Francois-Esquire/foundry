import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { connect as connectSocket, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Layout } from "~/layout";
import type {
  DispatchInfo,
  DispatchOptions,
  RollResult,
  RunInfo,
  WorkspaceConfig,
  WorkspaceConnection,
  WorkspaceSummary,
} from "~/model/connection";
import type { DashboardSnapshot } from "~/model/dashboard";
import { Channel, socketTransport } from "~/process/channel";
import { readProcess } from "~/process/instance";
import {
  CLIENT_NOTIFICATIONS,
  DAEMON_METHODS,
  type HelloResult,
  helloResultSchema,
  lineParamsSchema,
  type SetupDraftParams,
  WORKSPACE_METHODS,
  WORKSPACE_PREFIX,
  type WorkspaceMethod,
  workspaceSummarySchema,
} from "~/process/protocol";
import { version } from "../../package.json";

/**
 * A client of the Marbles process. `connect` joins the one running for
 * the layout's state root, or starts it when none is: the lock at the
 * state root says whether one is alive, the socket is how to reach it. A
 * workspace the client attaches is hosted from then on, dashboard open or
 * not. `workspace(id)` is the `WorkspaceConnection` a host is written
 * against, each call a request to the worker behind the daemon.
 */

export interface ConnectOptions {
  /** The CLI entry a started daemon runs; the one beside this module when omitted. */
  readonly cliEntry?: string;
  readonly layout: Layout;
  /** Harness ids a started daemon's workers keep. */
  readonly only?: readonly string[];
  /** Start a daemon when none runs; `true` when omitted. */
  readonly start?: boolean;
  /** How long to wait for a daemon to answer, start, or stop. */
  readonly timeoutMs?: number;
}

export interface AttachOptions {
  /** The workspace root when the source has no files; this process's cwd when omitted. */
  readonly root?: string;
  readonly setup?: SetupDraftParams;
}

export interface SubscriptionHandlers {
  readonly line?: (line: string) => void;
  readonly workspace?: (summary: WorkspaceSummary) => void;
}

export interface MarblesClient {
  /**
   * Host `source`'s workspace; resolves once its worker is ready. With
   * `setup`, the starter the client just wrote gets its milestone posted.
   */
  attach(source: string, options?: AttachOptions): Promise<WorkspaceSummary>;
  close(): void;
  readonly closed: Promise<void>;
  /** Stop hosting a workspace; the Marbles process will not start it again at boot. */
  detach(id: string): Promise<void>;
  /** What the daemon said when the client connected. */
  readonly hello: HelloResult;
  /** Drain the workspace's worker and start a fresh one. */
  reload(id: string): Promise<WorkspaceSummary>;
  /** Ask the daemon to stop; resolves once it has answered. */
  shutdown(): Promise<void>;
  /** Status lines and state changes for one workspace, until unsubscribed. */
  subscribe(id: string, handlers: SubscriptionHandlers): () => void;
  workspace(
    summary: Pick<WorkspaceSummary, "config" | "id" | "root">
  ): WorkspaceConnection;
  workspaces(): Promise<readonly WorkspaceSummary[]>;
}

/** No daemon answered, and none was to be started. */
export class NoProcessError extends Error {
  override readonly name = "NoProcessError";
}

/** The daemon that runs does not match this command: another version, or another artifact store. */
export class ProcessMismatchError extends Error {
  override readonly name = "ProcessMismatchError";
}

/** The daemon did not answer, or did not stop, in time. */
export class ProcessTimeoutError extends Error {
  override readonly name = "ProcessTimeoutError";
}

const START_TIMEOUT_MS = 15_000;
/** How long a daemon gets to answer one of the requests `connect` makes itself. */
const ANSWER_TIMEOUT_MS = 5000;
const RETRY_MS = 100;
const LOG_FILE = "daemon.log";

/** The daemon runs under Bun; so does this client, except under a Node test runner. */
function runtime(): string {
  return "Bun" in globalThis ? process.execPath : "bun";
}

function cliEntry(): string {
  return fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "../cli.ts" : "./cli.js",
      import.meta.url
    )
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function within<T>(
  work: Promise<T>,
  ms: number,
  what: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProcessTimeoutError(`${what} timed out`)),
      ms
    );
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

function dial(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(path);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** Whether the lock at the state root names a live daemon. */
export function daemonAlive(layout: Layout): boolean {
  const status = readProcess(layout.state);
  return status?.alive === true && status.host === "daemon";
}

/** Start a daemon in the background, detached from this process, logging under the state root. */
function startDetachedDaemon(options: ConnectOptions): void {
  const { layout } = options;
  mkdirSync(layout.state, { recursive: true });
  const log = openSync(join(layout.state, LOG_FILE), "a");
  const child = spawn(
    runtime(),
    [
      options.cliEntry ?? cliEntry(),
      "daemon",
      "--state",
      layout.state,
      "--artifacts",
      layout.artifacts,
      ...(options.only ?? []).flatMap((id) => ["--harness", id]),
    ],
    { detached: true, env: process.env, stdio: ["ignore", log, log] }
  );
  child.unref();
}

interface Opened {
  readonly channel: Channel;
  readonly hello: HelloResult;
  readonly subscriptions: Map<string, Set<SubscriptionHandlers>>;
}

/** Deliver a daemon notification to the handlers subscribed to its workspace. */
function deliver(
  subscriptions: Map<string, Set<SubscriptionHandlers>>,
  method: string,
  params: unknown
): void {
  if (method === CLIENT_NOTIFICATIONS.line) {
    const parsed = lineParamsSchema.safeParse(params);
    if (parsed.success && parsed.data.id !== undefined) {
      for (const handler of subscriptions.get(parsed.data.id) ?? []) {
        handler.line?.(parsed.data.line);
      }
    }
    return;
  }
  if (method === CLIENT_NOTIFICATIONS.workspace) {
    const parsed = workspaceSummarySchema.safeParse(params);
    if (parsed.success) {
      for (const handler of subscriptions.get(parsed.data.id) ?? []) {
        handler.workspace?.(parsed.data);
      }
    }
  }
}

async function open(layout: Layout, timeoutMs: number): Promise<Opened> {
  const socket = await dial(layout.socket);
  const subscriptions = new Map<string, Set<SubscriptionHandlers>>();
  const channel = new Channel(socketTransport(socket), {
    notification: (method, params) => deliver(subscriptions, method, params),
  });
  try {
    // A daemon that accepts and never answers (one suspended with Ctrl-Z)
    // must not hold the command forever.
    const hello = helloResultSchema.parse(
      await within(
        channel.request(DAEMON_METHODS.hello),
        Math.min(timeoutMs, ANSWER_TIMEOUT_MS),
        "the Marbles process's hello"
      )
    );
    return { channel, hello, subscriptions };
  } catch (error) {
    channel.close();
    throw error;
  }
}

/**
 * Connect to the Marbles process for `layout`, starting one when none
 * runs. A starting connect asks a daemon of another version to stop and
 * replaces it, so the client and the process it talks to always agree on
 * the protocol; one that does not start refuses it instead. A daemon that
 * keeps its artifacts elsewhere than `layout` is refused either way.
 */
export async function connect(options: ConnectOptions): Promise<MarblesClient> {
  const { layout, start = true, timeoutMs = START_TIMEOUT_MS } = options;
  const found = await tryOpen(layout, timeoutMs);
  if (found?.hello.version === version) {
    return clientOver(sameStore(found, layout));
  }
  if (found && !start) {
    found.channel.close();
    throw new ProcessMismatchError(
      `the Marbles process for ${layout.state} runs version ${found.hello.version}, not ${version}; stop it with \`marbles stop\` first`
    );
  }
  if (found) {
    await stopOpened(found, layout, timeoutMs);
  } else if (!start) {
    if (daemonAlive(layout)) {
      throw new ProcessTimeoutError(
        `the Marbles process for ${layout.state} did not answer on ${layout.socket}`
      );
    }
    throw new NoProcessError(
      `no Marbles process runs for ${layout.state}; start one with \`marbles daemon\``
    );
  }
  return clientOver(sameStore(await dialUntil(options, timeoutMs), layout));
}

/**
 * Stop the Marbles process for `layout`, whatever its version, and wait
 * until it has exited. Resolves with what it said when it was asked;
 * `undefined` when none runs.
 */
export async function stopProcess(
  options: Pick<ConnectOptions, "layout" | "timeoutMs">
): Promise<HelloResult | undefined> {
  const { layout, timeoutMs = START_TIMEOUT_MS } = options;
  const found = await tryOpen(layout, timeoutMs);
  if (!found) {
    if (daemonAlive(layout)) {
      throw new ProcessTimeoutError(
        `the Marbles process for ${layout.state} did not answer on ${layout.socket}`
      );
    }
    return undefined;
  }
  await stopOpened(found, layout, timeoutMs);
  return found.hello;
}

/** The channel, when its daemon keeps the artifact store `layout` names. */
function sameStore(opened: Opened, layout: Layout): Opened {
  if (opened.hello.artifacts === layout.artifacts) {
    return opened;
  }
  opened.channel.close();
  throw new ProcessMismatchError(
    `the Marbles process for ${layout.state} keeps artifacts in ${opened.hello.artifacts}, not ${layout.artifacts}; stop it with \`marbles stop\` to start one with the other store`
  );
}

/** Ask the daemon behind `opened` to stop, and wait until it has exited. */
async function stopOpened(
  { channel }: Opened,
  layout: Layout,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const left = (): number => Math.max(0, deadline - Date.now());
  try {
    await within(
      channel.request(DAEMON_METHODS.shutdown),
      Math.min(timeoutMs, ANSWER_TIMEOUT_MS),
      "asking the Marbles process to stop"
    );
    // It hangs up on its clients once its workers have drained.
    await within(channel.closed, left(), "stopping the Marbles process");
  } finally {
    channel.close();
  }
  await waitUntil(
    () => !daemonAlive(layout),
    left(),
    "the Marbles process's exit"
  );
}

/**
 * Keep dialing until a daemon answers, or the deadline passes. One that
 * is gone, or that exits meanwhile (it was closing), is replaced once.
 */
async function dialUntil(
  options: ConnectOptions,
  timeoutMs: number
): Promise<Opened> {
  const { layout } = options;
  const deadline = Date.now() + timeoutMs;
  let started = false;
  for (;;) {
    const channel = await tryOpen(layout, timeoutMs);
    if (channel) {
      return channel;
    }
    if (!(started || daemonAlive(layout))) {
      startDetachedDaemon(options);
      started = true;
    }
    if (Date.now() > deadline) {
      throw new ProcessTimeoutError(
        `the Marbles process did not answer on ${layout.socket} (see ${join(layout.state, LOG_FILE)})`
      );
    }
    await sleep(RETRY_MS);
  }
}

async function tryOpen(
  layout: Layout,
  timeoutMs: number
): Promise<Opened | undefined> {
  try {
    return await open(layout, timeoutMs);
  } catch {
    return undefined;
  }
}

async function waitUntil(
  condition: () => boolean,
  timeoutMs: number,
  what: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new ProcessTimeoutError(`${what} timed out`);
    }
    await sleep(RETRY_MS);
  }
}

function clientOver({ channel, hello, subscriptions }: Opened): MarblesClient {
  const summaries = (value: unknown): readonly WorkspaceSummary[] =>
    workspaceSummarySchema.array().parse(value);
  return {
    async attach(source, options = {}) {
      return workspaceSummarySchema.parse(
        await channel.request(DAEMON_METHODS.attach, {
          root: options.root ?? process.cwd(),
          ...(options.setup === undefined ? {} : { setup: options.setup }),
          source,
        })
      );
    },
    close() {
      channel.close();
    },
    closed: channel.closed,
    async detach(id) {
      await channel.request(DAEMON_METHODS.detach, { id });
    },
    hello,
    async reload(id) {
      return workspaceSummarySchema.parse(
        await channel.request(DAEMON_METHODS.reload, { id })
      );
    },
    async shutdown() {
      await channel.request(DAEMON_METHODS.shutdown);
    },
    subscribe(id, handlers) {
      let set = subscriptions.get(id);
      if (!set) {
        set = new Set();
        subscriptions.set(id, set);
        channel
          .request(DAEMON_METHODS.subscribe, { id })
          .catch(() => undefined);
      }
      set.add(handlers);
      return () => {
        const current = subscriptions.get(id);
        current?.delete(handlers);
        if (current?.size === 0) {
          subscriptions.delete(id);
          channel
            .request(DAEMON_METHODS.unsubscribe, { id })
            .catch(() => undefined);
        }
      };
    },
    workspace: (summary) => remoteWorkspace(channel, summary),
    async workspaces() {
      return summaries(await channel.request(DAEMON_METHODS.workspaces));
    },
  };
}

function remoteWorkspace(
  channel: Channel,
  { config, id, root }: Pick<WorkspaceSummary, "config" | "id" | "root">
): WorkspaceConnection {
  const call = <T>(method: WorkspaceMethod, params: object = {}): Promise<T> =>
    channel.request(`${WORKSPACE_PREFIX}${method}`, {
      id,
      ...params,
    }) as Promise<T>;
  return {
    actions: {
      answer: (entryId, answer) =>
        call(WORKSPACE_METHODS.answer, { answer, entryId }),
      launch: (name, input) =>
        call<string>(WORKSPACE_METHODS.launch, { input, name }),
      runs: {
        cancel: (runId) => call(WORKSPACE_METHODS.cancel, { runId }),
        deleteTrigger: (triggerId) =>
          call(WORKSPACE_METHODS.deleteTrigger, { triggerId }),
        pause: (runId, stepId) =>
          call(WORKSPACE_METHODS.pause, { runId, stepId }),
        resume: (runId, stepId, prompt) =>
          call(WORKSPACE_METHODS.resume, { prompt, runId, stepId }),
        setTriggerEnabled: (triggerId, enabled) =>
          call(WORKSPACE_METHODS.setTriggerEnabled, { enabled, triggerId }),
        steer: (runId, stepId, prompt) =>
          call(WORKSPACE_METHODS.steer, { prompt, runId, stepId }),
        stopActivity: (sessionId, activityId) =>
          call(WORKSPACE_METHODS.stopActivity, { activityId, sessionId }),
      },
    },
    cancelRun: (runId) => call<RunInfo>(WORKSPACE_METHODS.cancelRun, { runId }),
    config,
    describe: () => call<WorkspaceConfig>(WORKSPACE_METHODS.describe),
    dispatchAgent: (options: DispatchOptions) =>
      call<DispatchInfo>(WORKSPACE_METHODS.dispatchAgent, options),
    dispatchWorkflow: (name, input) =>
      call<DispatchInfo>(WORKSPACE_METHODS.dispatchWorkflow, { input, name }),
    getRun: (runId) => call<RunInfo>(WORKSPACE_METHODS.getRun, { runId }),
    id,
    roll: (name, input) =>
      call<RollResult>(WORKSPACE_METHODS.roll, { input, name }),
    root,
    snapshot: () => call<DashboardSnapshot>(WORKSPACE_METHODS.snapshot),
  };
}
