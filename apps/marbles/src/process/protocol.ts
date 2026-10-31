import { z } from "zod";

import type { WorkspaceState } from "~/model/connection";

/**
 * What crosses the Marbles process's boundaries, as newline-delimited JSON:
 * clients to the daemon over its Unix socket, and the daemon to each worker
 * over the IPC channel it spawned it with. One shape serves both. A
 * request carries an id and is answered once; a notification carries none
 * and is not. Params are validated where they arrive from outside the
 * process (the socket); the daemon trusts its own workers.
 */

export const PROTOCOL = 1;

const requestSchema = z.object({
  id: z.number().int().nonnegative(),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type Request = z.infer<typeof requestSchema>;

const errorSchema = z.object({
  message: z.string(),
  name: z.string().optional(),
});
export type WireError = z.infer<typeof errorSchema>;

const responseSchema = z.object({
  error: errorSchema.optional(),
  id: z.number().int().nonnegative(),
  result: z.unknown().optional(),
});
export type Response = z.infer<typeof responseSchema>;

const notificationSchema = z.object({
  method: z.string().min(1),
  params: z.unknown().optional(),
});

const messageSchema = z.union([
  requestSchema,
  responseSchema,
  notificationSchema,
]);
export type Message = z.infer<typeof messageSchema>;

export function isResponse(message: Message): message is Response {
  return "id" in message && !("method" in message);
}

export function isRequest(message: Message): message is Request {
  return "id" in message && "method" in message;
}

/** Encode one message as a line. */
export function encode(message: Message): string {
  return `${JSON.stringify(message)}\n`;
}

/** Decode a line; `undefined` for one that is not a message. */
export function decode(line: string): Message | undefined {
  try {
    const parsed = messageSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Split a byte stream into complete lines, keeping the partial tail. */
export function lineSplitter(onLine: (line: string) => void) {
  let buffer = "";
  return (chunk: string): void => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        onLine(line);
      }
      newline = buffer.indexOf("\n");
    }
  };
}

/** `error` as a wire error: its message, and its name when it has one worth keeping. */
export function wireError(error: unknown): WireError {
  if (error instanceof Error) {
    return error.name === "Error"
      ? { message: error.message }
      : { message: error.message, name: error.name };
  }
  return { message: String(error) };
}

/** An error a response carried, rebuilt on the calling side. */
export class RemoteError extends Error {
  constructor(wire: WireError) {
    super(wire.message);
    this.name = wire.name ?? "RemoteError";
  }
}

// ── Daemon methods: what a client asks the Marbles process ──

export const DAEMON_METHODS = {
  attach: "attach",
  detach: "detach",
  hello: "hello",
  /** A worker's first request: the token it was spawned with. */
  register: "register",
  reload: "reload",
  shutdown: "shutdown",
  subscribe: "subscribe",
  unsubscribe: "unsubscribe",
  workspaces: "workspaces",
} as const;

export const helloResultSchema = z.object({
  artifacts: z.string(),
  pid: z.number(),
  protocol: z.number(),
  startedAt: z.string(),
  state: z.string(),
  version: z.string(),
});
export type HelloResult = z.infer<typeof helloResultSchema>;

/** A starter the client just wrote; the worker posts the setup milestone for it. */
const setupDraftSchema = z.object({
  harness: z.string(),
  instructions: z.string(),
  name: z.string(),
  template: z.string(),
});
export type SetupDraftParams = z.infer<typeof setupDraftSchema>;

export const attachParamsSchema = z.object({
  /** The workspace root when the source has no files: the client's cwd. */
  root: z.string().min(1).optional(),
  setup: setupDraftSchema.optional(),
  /** The authoring folder or module, resolved by the client. */
  source: z.string().min(1),
});

export const workspaceIdSchema = z.object({ id: z.string().min(1) });

export const registerParamsSchema = z.object({ token: z.string().min(1) });

const WORKSPACE_STATES: readonly WorkspaceState[] = [
  "starting",
  "ready",
  "reloading",
  "failed",
  "stopped",
];

export const workspaceSummarySchema = z.object({
  config: z.string().nullable(),
  error: z.string().optional(),
  id: z.string(),
  pid: z.number().optional(),
  root: z.string(),
  state: z.enum(WORKSPACE_STATES as [WorkspaceState, ...WorkspaceState[]]),
});

// ── Workspace methods: forwarded to the worker that hosts it ──

/** Params for a method on one workspace carry its id beside the arguments. */
export const WORKSPACE_PREFIX = "workspace.";

export const WORKSPACE_METHODS = {
  answer: "answer",
  cancel: "cancel",
  cancelRun: "cancelRun",
  deleteTrigger: "deleteTrigger",
  describe: "describe",
  dispatchAgent: "dispatchAgent",
  dispatchWorkflow: "dispatchWorkflow",
  getRun: "getRun",
  launch: "launch",
  pause: "pause",
  resume: "resume",
  roll: "roll",
  setTriggerEnabled: "setTriggerEnabled",
  snapshot: "snapshot",
  steer: "steer",
  stopActivity: "stopActivity",
} as const;
export type WorkspaceMethod =
  (typeof WORKSPACE_METHODS)[keyof typeof WORKSPACE_METHODS];

export function isWorkspaceMethod(name: string): name is WorkspaceMethod {
  return Object.values(WORKSPACE_METHODS).some((method) => method === name);
}

// ── Worker notifications: what a worker tells the daemon ──

export const WORKER_NOTIFICATIONS = {
  /** A status line the host printed. */
  line: "line",
  /** The engine is up; params describe the workspace. */
  ready: "ready",
  /** The authoring source changed on disk. */
  sourceChanged: "sourceChanged",
} as const;

/** What the daemon asks a worker beyond workspace methods. */
export const WORKER_METHODS = {
  /** Drain running work and exit. */
  stop: "stop",
} as const;

/**
 * How long a worker gets to answer `stop`, and then as long again to exit,
 * before the daemon kills it. A client waiting for the daemon to stop
 * budgets from this.
 */
export const WORKER_STOP_TIMEOUT_MS = 30_000;

export const readyParamsSchema = z.object({
  config: z.string().nullable(),
  configPath: z.string(),
  id: z.string(),
  root: z.string(),
});
export type ReadyParams = z.infer<typeof readyParamsSchema>;

export const lineParamsSchema = z.object({
  /** The workspace the line is about, added by the daemon when forwarding. */
  id: z.string().optional(),
  line: z.string(),
});

/** Notifications the daemon forwards to subscribed clients. */
export const CLIENT_NOTIFICATIONS = {
  line: "line",
  /** A workspace's state changed; params are its summary. */
  workspace: "workspace",
} as const;
