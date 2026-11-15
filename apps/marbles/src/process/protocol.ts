import { z } from "zod";

import type { WorkspaceState } from "~/model/connection";

/**
 * What crosses the Marbles process's boundaries, as newline-delimited JSON:
 * clients and engine generations to the daemon over its Unix socket. One
 * shape serves both. A request carries an id and is answered once; a
 * notification carries none and is not. Params are validated where they
 * arrive from outside the process (the socket); the daemon trusts its own
 * generations.
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

export const DAEMON_METHODS = {
  attach: "attach",
  detach: "detach",
  hello: "hello",
  /** A generation's first request: the token it was spawned with. */
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

/** A starter the client just wrote; the generation posts the setup milestone for it. */
export const setupDraftSchema = z.object({
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
  /** One task command; answered with a `TaskOutcome`, so a refusal keeps its code. */
  tasks: "tasks",
} as const;
export type WorkspaceMethod =
  (typeof WORKSPACE_METHODS)[keyof typeof WORKSPACE_METHODS];

export function isWorkspaceMethod(name: string): name is WorkspaceMethod {
  return Object.values(WORKSPACE_METHODS).some((method) => method === name);
}

/** What a generation tells the daemon unasked. */
export const GENERATION_NOTIFICATIONS = {
  /** A status line; params name the workspace's root, or none for the generation's own. */
  line: "line",
  /** A hosted workspace's authoring source changed on disk; params name it. */
  sourceChanged: "sourceChanged",
} as const;

/** What the daemon asks a generation beyond workspace methods. */
export const GENERATION_METHODS = {
  /** Host one more workspace at once, engine started: an attach. */
  host: "host",
  /**
   * Load every registered workspace up to engines not yet started, and
   * say how each went (`LoadResult`).
   */
  load: "load",
  /**
   * Stop admitting, and hand what is not running to the successor: no
   * tick, delivery or queued run starts here again, and parked runs are
   * let go. Answered once handed over; the generation then finishes the
   * runs still running here and exits.
   */
  retire: "retire",
  /** Start the engines `load` built, which takes over parked and queued work. */
  start: "start",
  /** Drain running work and exit. */
  stop: "stop",
  /** Stop hosting one workspace: its running work finishes, then it closes. */
  unhost: "unhost",
} as const;

/**
 * How long a generation gets to answer `stop`, and then as long again to
 * exit, before the daemon kills it and its process group. A client waiting
 * for the daemon to stop budgets from this.
 */
export const GENERATION_STOP_TIMEOUT_MS = 30_000;

const identitySchema = z.object({
  pid: z.number().int(),
  started: z.string().nullable(),
});

/** How one registered workspace's load or start went in a generation. */
const workspaceLoadSchema = z.object({
  error: z.string().optional(),
  id: z.string().optional(),
  root: z.string(),
});
export type WorkspaceLoadResult = z.infer<typeof workspaceLoadSchema>;

/** What `load` answers: the generation's process, and each workspace's load. */
export const loadResultSchema = z.object({
  identity: identitySchema,
  loads: z.array(workspaceLoadSchema),
});
export type LoadResult = z.infer<typeof loadResultSchema>;

export const startParamsSchema = z.object({
  /** Starters to post a setup milestone for, by workspace id. */
  setups: z.record(z.string(), setupDraftSchema).optional(),
});

export const startResultSchema = z.object({
  loads: z.array(workspaceLoadSchema),
});

export const hostParamsSchema = z.object({
  /** The source, or null when the workspace is its root alone. */
  config: z.string().nullable(),
  root: z.string(),
  setup: setupDraftSchema.optional(),
});

export const hostResultSchema = z.object({
  config: z.string().nullable(),
  id: z.string(),
  root: z.string(),
});

export const retireParamsSchema = z.object({
  /** The generation that takes over: queued runs become its own. */
  successor: identitySchema,
});

export const lineParamsSchema = z.object({
  /** The workspace the line is about, added by the daemon when forwarding. */
  id: z.string().optional(),
  line: z.string(),
  /** The root of the workspace a generation's line is about; none for its own. */
  root: z.string().optional(),
});

export const sourceChangedParamsSchema = z.object({ id: z.string() });

/** Notifications the daemon forwards to subscribed clients. */
export const CLIENT_NOTIFICATIONS = {
  line: "line",
  /** A workspace's state changed; params are its summary. */
  workspace: "workspace",
} as const;
