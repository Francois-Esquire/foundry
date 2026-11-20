import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { recordChild } from "@foundry/lib/spawn-record";
import type { createCodexAppServer } from "ai-sdk-provider-codex-cli";
import { fromCodexListing } from "./catalog/codex";
import { environmentOverlay } from "./environment";
import { modelErrors } from "./errors";
import type { Provider } from "./provider";
import type { ModelKind, ProviderModelDefinition } from "./types";

export type {
  CodexDriverOptions,
  CodexSubscriptionTokens,
} from "./harness/codex";
// biome-ignore lint/performance/noBarrelFile: Existing provider subpath also exposes its native turn driver.
export { createCodexDriver } from "./harness/codex";

export interface CodexProviderConfig {
  available?: boolean;
  binPath?: string;
}

export interface CodexProviderOptions {
  config?: CodexProviderConfig;
  defaults?: Partial<Record<ModelKind, string>>;
  env: Readonly<Record<string, string>>;
  id?: string;
  models?: ProviderModelDefinition[];
}

const EXIT_GRACE_MS = 2000;
const KILL_GRACE_MS = 1000;
const RECORD_POLL_MS = 10;
const GPT_FAMILY =
  /^gpt-([1-9]\d*(?:\.(?:0|[1-9]\d*))*)-(?!(?:fast|preview|alpha|beta|experimental|latest|snapshot)$)([a-z]+)$/;

type AppServerClient = ReturnType<typeof createCodexAppServer>;
type ListedModels = Awaited<
  ReturnType<AppServerClient["listModels"]>
>["models"];

function appServer(
  create: typeof createCodexAppServer,
  binPath: string | undefined,
  env: Record<string, string>
): AppServerClient {
  return create({
    defaultSettings: {
      ...(binPath ? { codexPath: binPath } : {}),
      env,
      logger: false,
    },
  });
}

export async function codexModels({
  binPath,
  env,
  signal,
}: {
  readonly binPath: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}): Promise<readonly ProviderModelDefinition[]> {
  signal?.throwIfAborted();
  if (!(env.CODEX_HOME || env.HOME)) {
    throw new Error(
      "Codex discovery requires HOME or CODEX_HOME in the provider environment"
    );
  }
  const { createCodexAppServer: create } = await import(
    "ai-sdk-provider-codex-cli"
  );
  signal?.throwIfAborted();
  const client = appServer(create, binPath, environmentOverlay(env, ""));
  const cancelled = Promise.withResolvers<never>();
  const abort = () => cancelled.reject(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const { models } = await Promise.race([
      client.listModels(),
      cancelled.promise,
    ]);
    const preferred = models.find((model) => model.isDefault && model.id)?.id;
    const rows = fromCodexListing(models).sort(
      (a, b) => Number(b.id === preferred) - Number(a.id === preferred)
    );
    return [...rows, ...codexFamilies(models, rows)];
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error("Codex app-server could not list models", { cause: error });
  } finally {
    signal?.removeEventListener("abort", abort);
    await client.close();
  }
}

interface FamilyCandidate {
  readonly id: string;
  tied: boolean;
  readonly version: readonly bigint[];
}

function compareVersions(a: readonly bigint[], b: readonly bigint[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] ?? 0n;
    const right = b[index] ?? 0n;
    if (left !== right) {
      return left > right ? 1 : -1;
    }
  }
  return 0;
}

function codexFamilies(
  models: ListedModels,
  rows: readonly ProviderModelDefinition[]
): ProviderModelDefinition[] {
  const offered = new Map(rows.map((row) => [row.id, row]));
  const latest = new Map<string, FamilyCandidate>();
  for (const { hidden, id, model } of models) {
    if (!offered.has(id) || hidden || (model !== undefined && model !== id)) {
      continue;
    }
    const [, versionText, family] = GPT_FAMILY.exec(id) ?? [];
    if (!(versionText && family) || offered.has(family)) {
      continue;
    }
    const version = versionText.split(".").map(BigInt);
    const kept = latest.get(family);
    const order =
      kept === undefined ? 1 : compareVersions(version, kept.version);
    if (order > 0) {
      latest.set(family, { id, tied: false, version });
    } else if (order === 0 && kept && kept.id !== id) {
      kept.tied = true;
    }
  }
  return [...latest].flatMap(([id, { id: target, tied }]) => {
    const row = offered.get(target);
    return row && !tied ? [{ ...row, id }] : [];
  });
}

interface AppServer {
  calls: number;
  readonly client: AppServerClient;
  readonly connections: Set<object>;
  readonly key: string;
  retired: boolean;
  stopping?: Promise<void>;
  unobservable: boolean;
}

export function codexProvider(options: CodexProviderOptions): Provider {
  const id = options.id ?? "codex";
  const config = options.config ?? {};
  let offline = false;
  const servers = new Set<AppServer>();
  let current: AppServer | undefined;

  const halt = async (server: AppServer): Promise<void> => {
    const processes = [...server.connections]
      .map((connection) => (connection as { child?: ChildProcess }).child)
      .filter((child): child is ChildProcess => child !== undefined);
    await server.client.close();
    if (server.unobservable) {
      throw new Error("the Codex SDK no longer exposes its app-server process");
    }
    await Promise.all(processes.map(exited));
    servers.delete(server);
  };

  const stop = (server: AppServer): Promise<void> => {
    server.retired = true;
    if (current === server) {
      current = undefined;
    }
    server.stopping ??= halt(server).catch((error: unknown) => {
      server.stopping = undefined;
      throw error;
    });
    return server.stopping;
  };

  const retire = (server: AppServer): void => {
    server.retired = true;
    if (server.calls === 0) {
      stop(server).catch(() => undefined);
    }
  };

  const serverFor = (
    create: typeof createCodexAppServer,
    env: Record<string, string>
  ): AppServer => {
    const key = JSON.stringify([config.binPath ?? null, sorted(env)]);
    if (current?.key === key && !current.retired) {
      return current;
    }
    for (const server of servers) {
      retire(server);
    }
    const server: AppServer = {
      calls: 0,
      client: appServer(create, config.binPath, env),
      connections: new Set(),
      key,
      retired: false,
      unobservable: false,
    };
    servers.add(server);
    current = server;
    return server;
  };

  const lease = async (modelId: string, cwd: string | undefined) => {
    if (offline) {
      throw modelErrors.PROVIDER_OFFLINE({ provider: id });
    }
    const { createCodexAppServer: create } = await import(
      "ai-sdk-provider-codex-cli"
    );
    if (offline) {
      throw modelErrors.PROVIDER_OFFLINE({ provider: id });
    }
    const server = serverFor(create, environmentOverlay(options.env, ""));
    const model = server.client.languageModel(modelId, cwd ? { cwd } : {});
    const connection = (model as { client?: unknown }).client;
    let released = false;
    if (
      typeof connection === "object" &&
      connection !== null &&
      "child" in connection
    ) {
      server.connections.add(connection);
      recordAppServer(connection as { child?: ChildProcess }, () => released);
    } else {
      server.unobservable = true;
    }
    server.calls += 1;
    return {
      model,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        server.calls -= 1;
        if (server.retired && server.calls === 0) {
          stop(server).catch(() => undefined);
        }
      },
    };
  };

  const stopAll = async (): Promise<void> => {
    const results = await Promise.allSettled(
      [...servers].map((server) => stop(server))
    );
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failed) {
      throw modelErrors.PROVIDER_OFFLINE_UNCONFIRMED({
        provider: id,
        reason: String(failed.reason),
      });
    }
  };

  return {
    get available() {
      return config.available ?? false;
    },
    ...(options.defaults ? { defaults: options.defaults } : {}),
    dispose: async () => {
      offline = true;
      await stopAll();
    },
    id,
    languageModel: (modelId, opts) =>
      leasedModel(modelId, () => lease(modelId, opts?.workingDirectory)),
    models: options.models ?? [],
    offline: false,
    setOffline: async (value) => {
      offline = value;
      if (value) {
        await stopAll();
      }
    },
    turnLimit: "unsupported",
  };
}

const recordedServers = new WeakSet<ChildProcess>();

function recordAppServer(
  connection: { readonly child?: ChildProcess },
  done: () => boolean
): void {
  const look = () => {
    const { child } = connection;
    if (child !== undefined) {
      if (!recordedServers.has(child)) {
        recordedServers.add(child);
        recordChild(child);
      }
      return;
    }
    if (!done()) {
      setTimeout(look, RECORD_POLL_MS).unref();
    }
  };
  look();
}

function sorted(env: Record<string, string>): [string, string][] {
  return Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
}

async function exited(child: ChildProcess): Promise<void> {
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  const exit = once(child, "exit").then(
    () => undefined,
    () => undefined
  );
  const within = (ms: number) =>
    Promise.race([exit, new Promise((resolve) => setTimeout(resolve, ms))]);
  if (!gone()) {
    await within(EXIT_GRACE_MS);
  }
  if (!gone()) {
    child.kill("SIGKILL");
    await within(KILL_GRACE_MS);
  }
  if (!gone()) {
    throw new Error(`codex app-server ${child.pid ?? "?"} did not exit`);
  }
}

const abandoned = new FinalizationRegistry<() => void>((release) => release());

function leasedModel(
  modelId: string,
  lease: () => Promise<{ model: LanguageModelV4; release(): void }>
): LanguageModelV4 {
  return {
    doGenerate: async (callOptions) => {
      const { model, release } = await lease();
      try {
        return await model.doGenerate(callOptions);
      } finally {
        release();
      }
    },
    doStream: async (callOptions) => {
      const { model, release } = await lease();
      try {
        const result = await model.doStream(callOptions);
        const stream = releasing(result.stream, release);
        abandoned.register(stream, release);
        return { ...result, stream };
      } catch (error) {
        release();
        throw error;
      }
    },
    modelId,
    provider: "codex-app-server",
    specificationVersion: "v4",
    supportedUrls: {},
  };
}

function releasing<T>(
  stream: ReadableStream<T>,
  release: () => void
): ReadableStream<T> {
  const reader = stream.getReader();
  return new ReadableStream<T>({
    cancel: async (reason) => {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
    pull: async (controller) => {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
  });
}
