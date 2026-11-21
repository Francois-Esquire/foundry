import { RunRecordSchema } from "@foundry/workflows/schema";
import { z } from "zod";

import type { LiveWork } from "~/lib/step-work";
import type { WorkspaceState } from "~/model/connection";
import type { LiveRun } from "~/model/dashboard";

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

export function decode(line: string): Message | undefined {
  try {
    const parsed = messageSchema.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export const MAX_LINE_BYTES = 1024 * 1024;

export function lineSplitter(
  onLine: (line: string) => void,
  onOverflow: () => void
) {
  let buffer = "";
  let size = 0;
  let over = false;
  const overflow = (): void => {
    over = true;
    buffer = "";
    onOverflow();
  };
  return (chunk: string): void => {
    if (over) {
      return;
    }
    let start = 0;
    let newline = chunk.indexOf("\n");
    while (newline !== -1) {
      const piece = chunk.slice(start, newline);
      if (size + Buffer.byteLength(piece) > MAX_LINE_BYTES) {
        overflow();
        return;
      }
      const line = (buffer + piece).trim();
      buffer = "";
      size = 0;
      if (line.length > 0) {
        onLine(line);
      }
      start = newline + 1;
      newline = chunk.indexOf("\n", start);
    }
    const rest = chunk.slice(start);
    size += Buffer.byteLength(rest);
    if (size > MAX_LINE_BYTES) {
      overflow();
      return;
    }
    buffer += rest;
  };
}

export function wireError(error: unknown): WireError {
  if (error instanceof Error) {
    return error.name === "Error"
      ? { message: error.message }
      : { message: error.message, name: error.name };
  }
  return { message: String(error) };
}

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

const setupDraftSchema = z.object({
  instructions: z.string(),
  name: z.string(),
  template: z.string(),
});
export type SetupDraftParams = z.infer<typeof setupDraftSchema>;

export const attachParamsSchema = z.object({
  root: z.string().min(1).optional(),
  setup: setupDraftSchema.optional(),
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
  send: "send",
  setTriggerEnabled: "setTriggerEnabled",
  snapshot: "snapshot",
  steer: "steer",
  stopActivity: "stopActivity",
  tasks: "tasks",
} as const;
export type WorkspaceMethod =
  (typeof WORKSPACE_METHODS)[keyof typeof WORKSPACE_METHODS];

export function isWorkspaceMethod(name: string): name is WorkspaceMethod {
  return Object.values(WORKSPACE_METHODS).some((method) => method === name);
}

export const GENERATION_NOTIFICATIONS = {
  handed: "handed",
  line: "line",
  read: "read",
  released: "released",
} as const;

export const GENERATION_METHODS = {
  adopt: "adopt",
  host: "host",
  liveWork: "liveWork",
  load: "load",
  retire: "retire",
  start: "start",
  stop: "stop",
  takeQueued: "takeQueued",
  unhost: "unhost",
} as const;

export const GENERATION_STOP_TIMEOUT_MS = 30_000;

const liveWorkSchema: z.ZodType<LiveWork> = z.discriminatedUnion("kind", [
  z.object({
    agent: z.string().optional(),
    id: z.string(),
    input: z.literal("steer"),
    kind: z.literal("agent"),
    model: z.string().optional(),
    provider: z.string().optional(),
    sessionId: z.string(),
    stepId: z.string(),
  }),
  z.object({
    command: z.string(),
    id: z.string(),
    input: z.enum(["stdin", "none"]),
    kind: z.literal("command"),
    pid: z.number().int().optional(),
    stepId: z.string(),
  }),
]);

export const liveRunsSchema: z.ZodType<LiveRun[]> = z.array(
  z.object({ record: RunRecordSchema, work: z.array(liveWorkSchema) })
);

const identitySchema = z.object({
  pid: z.number().int(),
  started: z.string().nullable(),
});

const workspaceLoadSchema = z.object({
  error: z.string().optional(),
  id: z.string().optional(),
  root: z.string(),
});
export type WorkspaceLoadResult = z.infer<typeof workspaceLoadSchema>;

export const loadResultSchema = z.object({
  identity: identitySchema,
  loads: z.array(workspaceLoadSchema),
});
export type LoadResult = z.infer<typeof loadResultSchema>;

export const startParamsSchema = z.object({
  setups: z.record(z.string(), setupDraftSchema).optional(),
});

export const startResultSchema = z.object({
  loads: z.array(workspaceLoadSchema),
});

export const hostParamsSchema = z.object({
  config: z.string().nullable(),
  root: z.string(),
  setup: setupDraftSchema.optional(),
});

export const hostResultSchema = z.object({
  config: z.string().nullable(),
  id: z.string(),
  root: z.string(),
});

export const readParamsSchema = z.object({
  file: z.string(),
  readAt: z.number(),
  root: z.string(),
});

export const releasedParamsSchema = z.object({
  id: z.string(),
  runId: z.string(),
});

export const queuedParamsSchema = z.object({
  id: z.string(),
  owner: identitySchema,
  runId: z.string(),
});

export const queuedTakeSchema = z.discriminatedUnion("taken", [
  z.object({ taken: z.literal(true) }),
  z.object({ taken: z.literal(false), why: z.string() }),
]);

export const retireParamsSchema = z.object({
  successor: identitySchema,
});

export const lineParamsSchema = z.object({
  id: z.string().optional(),
  line: z.string(),
  root: z.string().optional(),
});

export const CLIENT_NOTIFICATIONS = {
  line: "line",
  workspace: "workspace",
} as const;
