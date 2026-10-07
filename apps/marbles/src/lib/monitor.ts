import { createHash } from "node:crypto";

import { globToRegExp } from "@foundry/lib/glob";
import { z } from "zod";

import type { HostBindings } from "~/lib/bindings";
import type { StepFn } from "~/lib/definition";
import { isLockedNode } from "~/lib/definition";
import type { Launch } from "~/lib/launch";
import { isLaunch, launchTarget } from "~/lib/launch";
import type { Catalogue } from "~/lib/managers/workspaces";
import { current } from "~/lib/run-scope";
import { isRecord, stableJson } from "~/lib/state/json";
import type { StateStore } from "~/lib/state/store";
import type { Context } from "~/lib/types";

/**
 * A monitor is a schedule whose step detects a change and hands it to the
 * config's handler. What it last saw is the `monitors` document under its
 * key in the engine's state store, so a launchd tick knows what changed
 * since the previous one.
 *
 * A launch the handler asked for is written into that document as
 * `pending` and handed back on every tick until the tick that started it
 * acknowledges it, so a crash between the observation and the start does
 * not lose the launch. Started is delivered: a target that then fails or is
 * cancelled is not started again, any more than a schedule's run would be.
 */

/** What a monitor watches: a glob under the workspace root, or a URL. */
export const monitorSpecSchema = z.discriminatedUnion("kind", [
  z.object({ glob: z.string().min(1), kind: z.literal("files") }),
  z.object({ kind: z.literal("http"), url: z.string().url() }),
]);

export type MonitorSpec = Readonly<z.infer<typeof monitorSpecSchema>>;

interface FileEntry {
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
  /** The body from the previous tick; `undefined` on the first. */
  readonly previous: unknown;
  readonly status: number;
}

export type Change = FileChange | HttpChange;

/** A monitor's step takes no input. */
export type MonitorInput = Record<string, never>;

/**
 * What a monitor's handler receives: the step context plus what changed.
 * `files` for a glob, `response` (a fresh `Response` over the polled body)
 * for HTTP. `change` carries the diff detail.
 */
export interface MonitorContext extends Context<MonitorInput> {
  readonly change: Change;
  /** A glob's diff, the same object as `change`, so a handler can destructure it without narrowing. */
  readonly files?: FileChange;
  readonly response?: Response;
}

export type MonitorHandler = (context: MonitorContext) => unknown;

/** What a detector does with a change: the launch to hand its tick, if any. */
export type MonitorResponse = (
  context: MonitorContext
) => Launch | undefined | Promise<Launch | undefined>;

/** The detector step's output; `launch` is what the handler asked to start. */
export interface Detection {
  readonly changed: boolean;
  readonly launch?: Launch;
}

export const DEFAULT_EVERY = "60s";

export function describeMonitor(spec: MonitorSpec): string {
  return spec.kind === "files" ? `files ${spec.glob}` : `http ${spec.url}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Where a detector reads the tree and keeps what it last saw. */
export interface MonitorHost extends HostBindings {
  /** The config's directory; a glob is matched beneath it. */
  readonly root: string;
}

export interface DetectorOptions {
  /** Stub for tests; `globalThis.fetch` otherwise. */
  readonly fetch?: Fetch;
  /** For a detector called outside a run; inside one, the run scope's host is used. */
  readonly host?: () => MonitorHost;
}

/** One tick's reading: the change to hand on (none when nothing moved) and the state to keep. */
interface Observation {
  readonly change: Change | undefined;
  /** For HTTP: the polled body as a `Response` the handler can read. */
  readonly response?: Response;
  readonly state: Record<string, unknown>;
}

/** The host a detector body runs against: the one given, else its run's. */
function hostOf(key: string, options: DetectorOptions): MonitorHost {
  const given = options.host?.();
  if (given) {
    return given;
  }
  const store = current.getStore();
  if (!store) {
    throw new Error(
      `monitor "${key}" needs a host; it is not running in a step`
    );
  }
  return { ...store.scope.host, root: store.scope.cwd };
}

/** A config handler as a detector's response: a locked node it returns is started. */
export function handlerResponse(
  key: string,
  handler: MonitorHandler
): MonitorResponse {
  return async (context) => {
    const handled = await handler(context);
    return isLockedNode(handled)
      ? launchTarget(handled, `monitor "${key}"`)
      : undefined;
  };
}

function pendingLaunch(previous: unknown): Launch | undefined {
  return isRecord(previous) && isLaunch(previous.pending)
    ? previous.pending
    : undefined;
}

/**
 * The tick that started (or gave up on) a monitor's pending launch clears
 * it, so the next poll reads the source again.
 */
export function acknowledgeLaunch(store: StateStore, key: string): void {
  const previous = store.read("monitors", key);
  if (isRecord(previous) && "pending" in previous) {
    const { pending: _, ...rest } = previous;
    store.write("monitors", key, rest);
  }
}

function storeOf(key: string, host: MonitorHost): StateStore {
  if (!host.store) {
    throw new Error(`monitor "${key}" needs a host with a state store`);
  }
  return host.store;
}

/** Read the source; a files monitor without a catalogue is the host's mistake, not a failed poll. */
function observer(
  key: string,
  spec: MonitorSpec,
  host: MonitorHost,
  fetchImpl: Fetch
): (previous: unknown, signal: AbortSignal) => Promise<Observation> {
  switch (spec.kind) {
    case "files": {
      const { catalogue } = host;
      if (!catalogue) {
        throw new Error(
          `monitor "${key}" needs a host with a workspace catalogue`
        );
      }
      return (previous) => observeFiles(catalogue, host.root, spec, previous);
    }
    case "http":
      return (previous, signal) =>
        observeHttp(spec, previous, fetchImpl, signal);
    default:
      throw new Error(`unknown monitor ${String(spec satisfies never)}`);
  }
}

/**
 * The step body a monitor registers: read what is there, diff it against the
 * last tick, respond only when something changed. State is written after
 * the response resolves, so a throwing handler sees the same change again
 * next tick. A failed poll logs and keeps the last state.
 */
export function detector(
  key: string,
  spec: MonitorSpec,
  respond: MonitorResponse,
  options: DetectorOptions = {}
): StepFn<MonitorInput, Detection> {
  return async (context) => {
    const { log, signal } = context;
    signal.throwIfAborted();
    const host = hostOf(key, options);
    const store = storeOf(key, host);
    const previous = store.read("monitors", key);
    // A launch from an earlier tick that was never started goes out again
    // before anything is polled.
    const pending = pendingLaunch(previous);
    if (pending) {
      return { changed: true, launch: pending };
    }
    const observe = observer(key, spec, host, options.fetch ?? fetch);
    let observed: Observation;
    try {
      observed = await observe(previous, signal);
    } catch (error) {
      log(`[monitor] ${key} poll failed: ${String(error)}`);
      return { changed: false };
    }
    signal.throwIfAborted();
    if (observed.change === undefined) {
      return { changed: false };
    }
    const launch = await respond({
      ...context,
      change: observed.change,
      ...(observed.change.kind === "files" ? { files: observed.change } : {}),
      ...(observed.response === undefined
        ? {}
        : { response: observed.response }),
    });
    signal.throwIfAborted();
    store.write("monitors", key, {
      version: 1,
      ...observed.state,
      ...(launch === undefined ? {} : { pending: launch }),
    });
    return launch === undefined ? { changed: true } : { changed: true, launch };
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
  catalogue: Catalogue,
  root: string,
  spec: { readonly glob: string },
  previous: unknown
): Promise<Observation> {
  const workspace = await catalogue.load({ path: root });
  const { entries } = await workspace.refresh();
  const pattern = globToRegExp(spec.glob);
  const found = new Map(
    entries
      .filter((entry) => entry.type === "file")
      .filter((entry) => pattern.test(entry.path))
      .map((entry) => [entry.path, entry.digest])
  );
  const last = storedFiles(previous);

  const added: FileEntry[] = [];
  const modified: FileEntry[] = [];
  for (const [path, checksum] of found) {
    const seen = last.get(path);
    if (seen === undefined) {
      added.push({ checksum, path });
    } else if (seen !== checksum) {
      modified.push({ checksum, path });
    }
  }
  const removed = [...last]
    .filter(([path]) => !found.has(path))
    .map(([path, checksum]) => ({ checksum, path }));

  const moved = added.length + modified.length + removed.length > 0;
  return {
    change: moved ? { added, kind: "files", modified, removed } : undefined,
    state: { files: Object.fromEntries(found) },
  };
}

async function observeHttp(
  spec: { readonly url: string },
  previous: unknown,
  fetchImpl: Fetch,
  signal?: AbortSignal
): Promise<Observation> {
  const response = await fetchImpl(spec.url, { signal });
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
  const hash = sha256(stableJson(body));
  const last = isRecord(previous) ? previous : undefined;
  return {
    change:
      last?.hash === hash
        ? undefined
        : {
            current: body,
            kind: "http",
            previous: last?.current,
            status: response.status,
          },
    response: new Response(text, {
      headers: response.headers,
      status: response.status,
    }),
    state: { current: body, hash },
  };
}
