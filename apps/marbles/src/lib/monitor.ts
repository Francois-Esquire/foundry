import { createHash } from "node:crypto";

import { globToRegExp } from "@foundry/lib/glob";
import { canonicalizeJson } from "@foundry/lib/json";
import { z } from "zod";

import type { HostBindings } from "~/lib/bindings";
import type { StepFn } from "~/lib/definition";
import { isLockedNode } from "~/lib/definition";
import type { Launch } from "~/lib/launch";
import { launchTarget } from "~/lib/launch";
import type { LocalWorkspaces } from "~/lib/managers/workspaces";
import { current } from "~/lib/run-scope";
import { isRecord, jsonData, storableJson } from "~/lib/state/json";
import type { MonitorState, TriggerStore } from "~/lib/trigger-store";
import { storedMonitorState } from "~/lib/trigger-store";
import type { Context } from "~/lib/types";

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
  readonly removed: readonly FileEntry[];
}

export interface HttpChange {
  readonly current: unknown;
  readonly kind: "http";
  readonly previous: unknown;
  readonly status: number;
}

export type Change = FileChange | HttpChange;

export type MonitorInput = Record<string, never>;

export interface MonitorContext extends Context<MonitorInput> {
  readonly change: Change;
  readonly files?: FileChange;
  readonly response?: Response;
}

export type MonitorHandler = (context: MonitorContext) => unknown;

export type MonitorResponse = (
  context: MonitorContext
) => Launch | undefined | Promise<Launch | undefined>;

export interface Detection {
  readonly changed: boolean;
  readonly launch?: Launch;
}

export const DEFAULT_EVERY = "60s";

export function describeMonitor(spec: MonitorSpec): string {
  return spec.kind === "files" ? `files ${spec.glob}` : `http ${spec.url}`;
}

function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface MonitorHost extends HostBindings {
  readonly root: string;
}

type MonitorRequestInit = Omit<RequestInit, "signal">;

export type MonitorRequest =
  | MonitorRequestInit
  | (() => MonitorRequestInit | Promise<MonitorRequestInit>);

export interface DetectorOptions {
  readonly fetch?: Fetch;
  readonly host?: () => MonitorHost;
  readonly request?: MonitorRequest;
}

interface Observation {
  readonly change: Change | undefined;
  readonly response?: Response;
  readonly state: Record<string, unknown>;
}

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

function triggersOf(key: string, host: MonitorHost): TriggerStore {
  if (!host.triggers) {
    throw new Error(`monitor "${key}" needs a host with a trigger store`);
  }
  return host.triggers;
}

function observer(
  key: string,
  spec: MonitorSpec,
  host: MonitorHost,
  options: DetectorOptions
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
      return (previous, signal) => observeHttp(spec, previous, options, signal);
    default:
      throw new Error(`unknown monitor ${String(spec satisfies never)}`);
  }
}

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
    const triggers = triggersOf(key, host);
    const kept = await triggers.monitorState(key);
    if (kept?.pending) {
      return { changed: true, launch: kept.pending };
    }
    const previous = kept?.observed;
    const observe = observer(key, spec, host, options);
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
    const { observed: seen } = storedMonitorState(key, {
      observed: observed.state,
    });
    const launch = await respond({
      ...context,
      change: observed.change,
      ...(observed.change.kind === "files" ? { files: observed.change } : {}),
      ...(observed.response === undefined
        ? {}
        : { response: observed.response }),
    });
    signal.throwIfAborted();
    let state: MonitorState;
    try {
      state = storedMonitorState(key, {
        observed: seen,
        ...(launch === undefined ? {} : { pending: launch }),
      });
    } catch (error) {
      await triggers.saveMonitorState(key, { observed: seen });
      throw error;
    }
    await triggers.saveMonitorState(key, state);
    return state.pending === undefined
      ? { changed: true }
      : { changed: true, launch: state.pending };
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
  catalogue: LocalWorkspaces,
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

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const TEXTUAL =
  /^(text\/|application\/(json|xml|javascript)|[^;]*\+(json|xml))/i;

function isTextual(contentType: string | null): boolean {
  return contentType === null || TEXTUAL.test(contentType);
}

function bodyOf(bytes: Uint8Array, contentType: string | null): unknown {
  if (!isTextual(contentType)) {
    return { bytes: bytes.byteLength, contentType };
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function observeHttp(
  spec: { readonly url: string },
  previous: unknown,
  options: DetectorOptions,
  signal?: AbortSignal
): Promise<Observation> {
  const { request } = options;
  const init = typeof request === "function" ? await request() : request;
  const response = await (options.fetch ?? fetch)(spec.url, {
    ...init,
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `HTTP ${String(response.status)} from ${spec.url}; check the credentials its request sends`
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("content-type");
  const body = storableJson(
    "the response body",
    jsonData(bodyOf(bytes, contentType))
  );
  const digest = isTextual(contentType)
    ? sha256(canonicalizeJson(jsonData(body)))
    : sha256(bytes);
  const hash = response.ok
    ? digest
    : sha256(`${String(response.status)}\0${digest}`);
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
    response: replay(response, bytes),
    state: { current: body, hash },
  };
}

function replay(response: Response, bytes: Uint8Array): Response {
  const copy = new Response(
    NULL_BODY_STATUSES.has(response.status) ? null : bytes,
    {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    }
  );
  Object.defineProperties(copy, {
    redirected: { value: response.redirected },
    url: { value: response.url },
  });
  return copy;
}
