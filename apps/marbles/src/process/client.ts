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
  /** How long to wait for a started daemon to answer. */
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

const START_TIMEOUT_MS = 15_000;
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

async function open(layout: Layout): Promise<Opened> {
  const socket = await dial(layout.socket);
  const subscriptions = new Map<string, Set<SubscriptionHandlers>>();
  const channel = new Channel(socketTransport(socket), {
    notification: (method, params) => deliver(subscriptions, method, params),
  });
  const hello = helloResultSchema.parse(
    await channel.request(DAEMON_METHODS.hello)
  );
  return { channel, hello, subscriptions };
}

/**
 * Connect to the Marbles process for `layout`, starting one when none
 * runs. A daemon of another version is asked to stop and replaced, so the
 * client and the process it talks to always agree on the protocol.
 */
export async function connect(options: ConnectOptions): Promise<MarblesClient> {
  const { layout, start = true, timeoutMs = START_TIMEOUT_MS } = options;
  const running = await currentVersionOnly(
    await tryOpen(layout),
    layout,
    timeoutMs
  );
  if (running) {
    return clientOver(running);
  }
  if (!start) {
    throw new NoProcessError(
      `no Marbles process runs for ${layout.state}; start one with \`marbles daemon\``
    );
  }
  if (!daemonAlive(layout)) {
    startDetachedDaemon(options);
  }
  return clientOver(await dialUntil(layout, timeoutMs));
}

/** The channel when its daemon runs this version; an older one is stopped first. */
async function currentVersionOnly(
  channel: Opened | undefined,
  layout: Layout,
  timeoutMs: number
): Promise<Opened | undefined> {
  if (!channel || channel.hello.version === version) {
    return channel;
  }
  await channel.channel.request(DAEMON_METHODS.shutdown);
  channel.channel.close();
  await channel.channel.closed;
  await waitUntil(
    () => !daemonAlive(layout),
    timeoutMs,
    "the old daemon's exit"
  );
  return undefined;
}

/** Keep dialing until the daemon answers, or the deadline passes. */
async function dialUntil(layout: Layout, timeoutMs: number): Promise<Opened> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const channel = await tryOpen(layout);
    if (channel) {
      return channel;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the Marbles process did not answer on ${layout.socket} (see ${join(layout.state, LOG_FILE)})`
      );
    }
    await sleep(RETRY_MS);
  }
}

async function tryOpen(layout: Layout): Promise<Opened | undefined> {
  try {
    return await open(layout);
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
      throw new Error(`${what} timed out`);
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
