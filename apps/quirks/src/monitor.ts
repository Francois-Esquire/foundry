import { createHash } from "node:crypto";
import { join } from "node:path";

import { globToRegExp } from "@foundry/lib/glob";

import type { HostBindings } from "~/lib/bindings";
import { catalog } from "~/lib/catalog";
import type { StepFn } from "~/lib/definition";
import type { CalendarSlot } from "~/lib/triggers";
import type { Context } from "~/lib/types";

import { isRecord, readJson, writeJson } from "~/state/json";

/**
 * A monitor is a schedule whose step detects a change and hands it to the
 * config's handler. Last-seen state lives in `<workspace>/monitors/<name>.json`
 * so a launchd tick knows what changed since the previous one; under `--dry`
 * it lives in the closure and dies with the process.
 */

export interface FileMonitor {
  readonly every?: string | CalendarSlot;
  /** Matched against paths relative to `root`: `*`, `**`, `?` and `{a,b}`. */
  readonly glob: string;
  /** Defaults to the config's directory. */
  readonly root?: string;
}

export interface HttpMonitor {
  readonly body?: string;
  readonly every?: string | CalendarSlot;
  readonly headers?: Record<string, string>;
  readonly method?: string;
  /** Narrow the parsed body (JSON when it parses, else text) to what counts as a change. */
  readonly select?: (body: unknown) => unknown;
  readonly url: string;
}

/** Live under `run` only: each message is a change. `once` and launchd have nothing to poll. */
export interface WsMonitor {
  readonly headers?: Record<string, string>;
  readonly protocols?: string | string[];
  /** Narrow each message (JSON when it parses, else text). */
  readonly select?: (message: unknown) => unknown;
  /** Sent once the socket opens, e.g. a subscribe frame. */
  readonly send?: string;
  readonly url: string;
}

export type MonitorOptions = string | FileMonitor | HttpMonitor | WsMonitor;

export type MonitorSpec =
  | ({ readonly kind: "files" } & FileMonitor)
  | ({ readonly kind: "http" } & HttpMonitor)
  | ({ readonly kind: "ws" } & WsMonitor);

export interface FileEntry {
  readonly checksum: string;
  readonly path: string;
}

export interface FileChange {
  readonly added: readonly FileEntry[];
  readonly kind: "files";
  readonly modified: readonly FileEntry[];
  /** Carries the checksum last seen. */
  readonly removed: readonly FileEntry[];
}

export interface HttpChange {
  readonly current: unknown;
  readonly kind: "http";
  /** The selected value from the previous tick; `undefined` on the first. */
  readonly previous: unknown;
  readonly status: number;
}

export interface WsChange {
  readonly kind: "ws";
  readonly message: unknown;
}

export type Change = FileChange | HttpChange | WsChange;

/** `{}` is a poll; a message is what live mode hands a ws monitor. */
export interface MonitorInput {
  readonly message?: unknown;
}

/**
 * What a monitor's handler receives: the step context plus what changed.
 * `files` for a glob, `response` (a fresh `Response` over the polled body)
 * for HTTP, `message` for a socket. `change` carries the diff detail.
 */
export interface MonitorContext extends Context<MonitorInput> {
  readonly change: Change;
  readonly files?: FileChange;
  readonly message?: unknown;
  readonly response?: Response;
}

export type MonitorHandler = (context: MonitorContext) => unknown;

export interface Detection {
  readonly changed: boolean;
  /** What the handler returned, when it ran. */
  readonly handled?: unknown;
}

export const DEFAULT_EVERY = "60s";
const NETWORK_SOURCE = /^(https?|wss?):\/\//;
const WEBSOCKET_SOURCE = /^wss?:\/\//;

export function resolveMonitor(options: MonitorOptions): MonitorSpec {
  if (typeof options === "string") {
    return NETWORK_SOURCE.test(options)
      ? resolveMonitor({ url: options })
      : { glob: options, kind: "files" };
  }
  if (!("url" in options)) {
    return { kind: "files", ...options };
  }
  return WEBSOCKET_SOURCE.test(options.url)
    ? { kind: "ws", ...options }
    : { kind: "http", ...options };
}

export function describeMonitor(spec: MonitorSpec): string {
  if (spec.kind === "files") {
    return `files ${spec.glob}`;
  }
  if (spec.kind === "http") {
    return `http ${spec.url}`;
  }
  return `ws ${spec.url} live`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface DetectorOptions {
  /** Stub for tests; `globalThis.fetch` otherwise. */
  readonly fetch?: Fetch;
}

/** One tick's reading: the change to hand on (none when nothing moved) and the state to keep. */
interface Observation {
  readonly change: Change | undefined;
  /** For HTTP: the polled body as a `Response` the handler can read. */
  readonly response?: Response;
  readonly state: Record<string, unknown>;
}

function requireHost(name: string): HostBindings {
  const { host } = catalog.bindings();
  if (!host) {
    throw new Error(
      `monitor "${name}" needs a host with a workspace catalogue`
    );
  }
  return host;
}

function handlerContext(
  context: Context<MonitorInput>,
  change: Change,
  response?: Response
): MonitorContext {
  return {
    ...context,
    change,
    ...(change.kind === "files" ? { files: change } : {}),
    ...(change.kind === "ws" ? { message: change.message } : {}),
    ...(response === undefined ? {} : { response }),
  };
}

/**
 * The step body a monitor registers: read what is there, diff it against the
 * last tick, run the handler only when something changed. State is written
 * after the handler resolves, so a throwing handler sees the same change
 * again next tick. A failed poll logs and keeps the last state. A ws monitor
 * has nothing to poll: live mode hands each message in as the input.
 */
export function detector(
  name: string,
  spec: MonitorSpec,
  handler: MonitorHandler,
  options: DetectorOptions = {}
): StepFn<MonitorInput, Detection> {
  let memory: unknown;
  const file = (state: string) => join(state, "monitors", `${name}.json`);

  return async (context) => {
    const { input, log, signal } = context;
    signal.throwIfAborted();
    if (input.message !== undefined) {
      const change: WsChange = { kind: "ws", message: input.message };
      const handled = await handler(handlerContext(context, change));
      return { changed: true, handled };
    }
    if (spec.kind === "ws") {
      log(`[monitor] ${name} is live-only; run \`quirks run\``);
      return { changed: false };
    }
    const host = requireHost(name);
    const previous =
      host.state === undefined ? memory : readJson(file(host.state));
    let observed: Observation;
    try {
      observed =
        spec.kind === "files"
          ? await observeFiles(host, catalog.bindings().root, spec, previous)
          : await observeHttp(spec, previous, options.fetch ?? fetch, signal);
    } catch (error) {
      log(`[monitor] ${name} poll failed: ${String(error)}`);
      return { changed: false };
    }
    signal.throwIfAborted();
    if (observed.change === undefined) {
      return { changed: false };
    }
    const handled = await handler(
      handlerContext(context, observed.change, observed.response)
    );
    signal.throwIfAborted();
    if (host.state === undefined) {
      memory = observed.state;
    } else {
      writeJson(file(host.state), { version: 1, ...observed.state });
    }
    return { changed: true, handled };
  };
}

function storedFiles(state: unknown): Map<string, string> {
  const files = isRecord(state) && isRecord(state.files) ? state.files : {};
  return new Map(
    Object.entries(files).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

async function observeFiles(
  host: HostBindings,
  root: string,
  spec: FileMonitor,
  previous: unknown
): Promise<Observation> {
  const workspace = await host.catalogue.load({ path: spec.root ?? root });
  const { entries } = await workspace.refresh();
  const pattern = globToRegExp(spec.glob);
  const current = new Map(
    entries
      .filter((entry) => entry.type === "file")
      .filter((entry) => pattern.test(entry.path))
      .map((entry) => [entry.path, entry.digest])
  );
  const last = storedFiles(previous);

  const added: FileEntry[] = [];
  const modified: FileEntry[] = [];
  for (const [path, checksum] of current) {
    const seen = last.get(path);
    if (seen === undefined) {
      added.push({ checksum, path });
    } else if (seen !== checksum) {
      modified.push({ checksum, path });
    }
  }
  const removed = [...last]
    .filter(([path]) => !current.has(path))
    .map(([path, checksum]) => ({ checksum, path }));

  const moved = added.length + modified.length + removed.length > 0;
  return {
    change: moved ? { added, kind: "files", modified, removed } : undefined,
    state: { files: Object.fromEntries(current) },
  };
}

async function observeHttp(
  spec: HttpMonitor,
  previous: unknown,
  fetchImpl: Fetch,
  signal?: AbortSignal
): Promise<Observation> {
  const response = await fetchImpl(spec.url, {
    body: spec.body,
    headers: spec.headers,
    method: spec.method,
    signal,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON; the text is the body.
  }
  const current = spec.select ? spec.select(body) : body;
  const hash = sha256(stableJson(current));
  const last = isRecord(previous) ? previous : undefined;
  return {
    change:
      last?.hash === hash
        ? undefined
        : {
            current,
            kind: "http",
            previous: last?.current,
            status: response.status,
          },
    response: new Response(text, {
      headers: response.headers,
      status: response.status,
    }),
    state: { current, hash },
  };
}
