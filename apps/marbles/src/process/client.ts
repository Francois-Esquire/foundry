import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { connect as connectSocket, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskError } from "@foundry/tasks";

import type { Layout } from "~/layout";
import { runOutputStream } from "~/lib/state/output";
import type {
  DispatchInfo,
  DispatchOptions,
  RollResult,
  RunInfo,
  RunPage,
  WorkspaceConfig,
  WorkspaceConnection,
  WorkspaceSummary,
} from "~/model/connection";
import type { DashboardSnapshot } from "~/model/dashboard";
import type { TaskOutcome } from "~/model/tasks";
import { Channel, socketTransport } from "~/process/channel";
import { readProcess, STATE_MODE } from "~/process/instance";
import {
  CLIENT_NOTIFICATIONS,
  DAEMON_METHODS,
  GENERATION_STOP_TIMEOUT_MS,
  type HelloResult,
  helloResultSchema,
  lineParamsSchema,
  type SetupDraftParams,
  WORKSPACE_METHODS,
  WORKSPACE_PREFIX,
  type WorkspaceMethod,
  workspaceSummarySchema,
} from "~/process/protocol";
import { RUNTIME_FLAGS, runtime } from "~/process/runtime";
import { recordSpawned, SPAWN_RECOVERY_ENV } from "~/process/spawned";
import { version } from "../../package.json";

export interface ConnectOptions {
  readonly cliEntry?: string;
  readonly layout: Layout;
  readonly start?: boolean;
  readonly timeoutMs?: number;
}

export interface AttachOptions {
  readonly root?: string;
  readonly setup?: SetupDraftParams;
}

export interface SubscriptionHandlers {
  readonly line?: (line: string) => void;
  readonly workspace?: (summary: WorkspaceSummary) => void;
}

export interface MarblesClient {
  attach(source: string, options?: AttachOptions): Promise<WorkspaceSummary>;
  close(): void;
  readonly closed: Promise<Disconnect>;
  detach(id: string): Promise<void>;
  readonly hello: HelloResult;
  reload(id: string): Promise<WorkspaceSummary>;
  shutdown(): Promise<void>;
  subscribe(id: string, handlers: SubscriptionHandlers): () => void;
  workspace(
    summary: Pick<WorkspaceSummary, "config" | "id" | "root">
  ): WorkspaceConnection;
  workspaces(): Promise<readonly WorkspaceSummary[]>;
}

export class NoProcessError extends Error {
  override readonly name = "NoProcessError";
}

export class ProcessMismatchError extends Error {
  override readonly name = "ProcessMismatchError";
}

export class ProcessTimeoutError extends Error {
  override readonly name = "ProcessTimeoutError";
}

export type Disconnect =
  | { readonly kind: "closed" }
  | { readonly kind: "stopped" }
  | { readonly kind: "died"; readonly log: string; readonly pid: number }
  | { readonly kind: "hung-up"; readonly pid: number }
  | { readonly kind: "failed"; readonly error: Error };

export function describeDisconnect(disconnect: Disconnect): string {
  switch (disconnect.kind) {
    case "closed":
      return "the connection to the Marbles process was closed";
    case "stopped":
      return "the Marbles process stopped";
    case "died":
      return `the Marbles process (pid ${String(disconnect.pid)}) exited without stopping; see ${disconnect.log}`;
    case "hung-up":
      return `the Marbles process (pid ${String(disconnect.pid)}) closed the connection`;
    case "failed":
      return `the connection to the Marbles process failed: ${disconnect.error.message}`;
    default:
      throw new Error(
        `unknown disconnect ${String(disconnect satisfies never)}`
      );
  }
}

const RELEASE_GRACE_MS = 2000;

export async function explainDisconnect(
  layout: Layout,
  hello: HelloResult,
  reason: Error | undefined,
  closedByUs: boolean
): Promise<Disconnect> {
  if (reason !== undefined) {
    return { error: reason, kind: "failed" };
  }
  if (closedByUs) {
    return { kind: "closed" };
  }
  const deadline = Date.now() + RELEASE_GRACE_MS;
  for (;;) {
    const status = readProcess(layout.state);
    const ours = status?.pid === hello.pid;
    if (!ours) {
      return { kind: "stopped" };
    }
    if (!status.alive) {
      return {
        kind: "died",
        log: join(layout.state, LOG_FILE),
        pid: hello.pid,
      };
    }
    if (Date.now() > deadline) {
      return { kind: "hung-up", pid: hello.pid };
    }
    await sleep(RETRY_MS);
  }
}

const START_TIMEOUT_MS = 15_000;
const ANSWER_TIMEOUT_MS = 5000;
const STOP_PROCESS_TIMEOUT_MS =
  2 * GENERATION_STOP_TIMEOUT_MS + START_TIMEOUT_MS;
const RETRY_MS = 100;
const LOG_FILE = "daemon.log";

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

export function daemonAlive(layout: Layout): boolean {
  const status = readProcess(layout.state);
  return status?.alive === true && status.host === "daemon";
}

function startDetachedDaemon(options: ConnectOptions): void {
  const { layout } = options;
  mkdirSync(dirname(layout.state), { recursive: true });
  mkdirSync(layout.state, { mode: STATE_MODE, recursive: true });
  const log = openSync(join(layout.state, LOG_FILE), "a");
  let child: ChildProcess;
  try {
    child = spawn(
      runtime(),
      [...RUNTIME_FLAGS, options.cliEntry ?? cliEntry(), "daemon"],
      {
        detached: true,
        env: { ...process.env, FOUNDRY_HOME: layout.home },
        stdio: ["ignore", log, log],
      }
    );
  } finally {
    closeSync(log);
  }
  child.unref();
  recordSpawned(child.pid, true, {
    ...process.env,
    [SPAWN_RECOVERY_ENV]: undefined,
  });
}

interface Opened {
  readonly channel: Channel;
  readonly hello: HelloResult;
  readonly subscriptions: Map<string, Set<SubscriptionHandlers>>;
}

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

export async function connect(options: ConnectOptions): Promise<MarblesClient> {
  const { layout, start = true, timeoutMs = START_TIMEOUT_MS } = options;
  const found = await tryOpen(layout, timeoutMs).then(
    (opened) => opened && sameStore(opened, layout)
  );
  if (found?.hello.version === version) {
    return clientOver(found, layout);
  }
  if (found && !start) {
    found.channel.close();
    throw new ProcessMismatchError(
      `the Marbles process for ${layout.state} runs version ${found.hello.version}, not ${version}; stop it with \`marbles daemon stop\` first`
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
  return clientOver(
    sameStore(await dialUntil(options, timeoutMs), layout),
    layout
  );
}

export async function stopProcess(
  options: StopProcessOptions
): Promise<HelloResult | undefined> {
  const { layout, timeoutMs = STOP_PROCESS_TIMEOUT_MS } = options;
  const found = await tryOpen(layout, Math.min(timeoutMs, ANSWER_TIMEOUT_MS));
  if (!found) {
    if (daemonAlive(layout)) {
      throw new ProcessTimeoutError(
        `the Marbles process for ${layout.state} did not answer on ${layout.socket}`
      );
    }
    return undefined;
  }
  await stopOpened(found, layout, timeoutMs, () =>
    options.onStopping?.(found.hello)
  );
  return found.hello;
}

export interface StopProcessOptions {
  readonly layout: Layout;
  readonly onStopping?: (hello: HelloResult) => void;
  readonly timeoutMs?: number;
}

function sameStore(opened: Opened, layout: Layout): Opened {
  if (opened.hello.artifacts === layout.artifacts) {
    return opened;
  }
  opened.channel.close();
  throw new ProcessMismatchError(
    `the Marbles process for ${layout.state} keeps artifacts in ${opened.hello.artifacts}, not ${layout.artifacts}; stop it with \`marbles daemon stop\` to start one with the other store`
  );
}

async function stopOpened(
  { channel }: Opened,
  layout: Layout,
  timeoutMs: number,
  onAgreed?: () => void
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const left = (): number => Math.max(0, deadline - Date.now());
  try {
    await within(
      channel.request(DAEMON_METHODS.shutdown),
      Math.min(timeoutMs, ANSWER_TIMEOUT_MS),
      "asking the Marbles process to stop"
    );
    onAgreed?.();
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

async function dialUntil(
  options: ConnectOptions,
  timeoutMs: number
): Promise<Opened> {
  const { layout } = options;
  const deadline = Date.now() + timeoutMs;
  let started = false;
  for (;;) {
    const channel = await tryOpen(
      layout,
      Math.max(RETRY_MS, deadline - Date.now())
    );
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

function clientOver(
  { channel, hello, subscriptions }: Opened,
  layout: Layout
): MarblesClient {
  const summaries = (value: unknown): readonly WorkspaceSummary[] =>
    workspaceSummarySchema.array().parse(value);
  let closedByUs = false;
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
      closedByUs = true;
      channel.close();
    },
    closed: channel.closed.then((reason) =>
      explainDisconnect(layout, hello, reason, closedByUs)
    ),
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
    workspace: (summary) => remoteWorkspace(channel, summary, layout),
    async workspaces() {
      return summaries(await channel.request(DAEMON_METHODS.workspaces));
    },
  };
}

function remoteWorkspace(
  channel: Channel,
  { config, id, root }: Pick<WorkspaceSummary, "config" | "id" | "root">,
  layout: Layout
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
        send: (runId, stepId, input) =>
          call(WORKSPACE_METHODS.send, { ...input, runId, stepId }),
        setTriggerEnabled: (triggerId, enabled) =>
          call(WORKSPACE_METHODS.setTriggerEnabled, { enabled, triggerId }),
        steer: (runId, stepId, prompt) =>
          call(WORKSPACE_METHODS.steer, { prompt, runId, stepId }),
        stopActivity: (sessionId, activityId) =>
          call(WORKSPACE_METHODS.stopActivity, { activityId, sessionId }),
        stream: (runId, signal) => runOutputStream(layout.state, runId, signal),
      },
    },
    cancelRun: (runId) => call<RunInfo>(WORKSPACE_METHODS.cancelRun, { runId }),
    config,
    describe: () => call<WorkspaceConfig>(WORKSPACE_METHODS.describe),
    dispatchAgent: (options: DispatchOptions) =>
      call<DispatchInfo>(WORKSPACE_METHODS.dispatchAgent, options),
    dispatchWorkflow: (name, input, options) =>
      call<DispatchInfo>(WORKSPACE_METHODS.dispatchWorkflow, {
        input,
        name,
        ...(options?.key === undefined ? {} : { key: options.key }),
      }),
    getRun: (runId) => call<RunInfo>(WORKSPACE_METHODS.getRun, { runId }),
    id,
    listRuns: (query = {}) =>
      call<RunPage>(WORKSPACE_METHODS.listRuns, { query }),
    roll: (name, input) =>
      call<RollResult>(WORKSPACE_METHODS.roll, { input, name }),
    root,
    snapshot: () => call<DashboardSnapshot>(WORKSPACE_METHODS.snapshot),
    async tasks(command) {
      const outcome = await call<TaskOutcome<(typeof command)["kind"]>>(
        WORKSPACE_METHODS.tasks,
        { command }
      );
      if ("result" in outcome) {
        return outcome.result;
      }
      const { code, message } = outcome.refusal;
      const refusal = new TaskError(code, "");
      refusal.message = message;
      throw refusal;
    },
  };
}
