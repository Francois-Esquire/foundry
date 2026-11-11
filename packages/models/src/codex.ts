import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createCodexAppServer } from "ai-sdk-provider-codex-cli";
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
  /**
   * Whether the CLI is installed and the user has this harness switched on.
   * The host owns detection; this package never probes the machine. Defaults
   * false so an unconfigured registration fails closed.
   */
  available?: boolean;
  /**
   * Absolute path to the `codex` binary, resolved by the host. A GUI-launched
   * app on macOS inherits only the system PATH, so the SDK's bare `codex`
   * fallback finds nothing in exactly the case that matters.
   */
  binPath?: string;
}

export interface CodexProviderOptions {
  config?: CodexProviderConfig;
  /** Catalog id to prefer per kind when the caller names none. */
  defaults?: Partial<Record<ModelKind, string>>;
  /**
   * The only environment the app-server may see. The SDK accepts only
   * strings, so a name outside it arrives empty rather than absent.
   */
  env: Readonly<Record<string, string>>;
  id?: string;
  models?: ProviderModelDefinition[];
}

/**
 * The catalog Codex serves. The CLI's list follows the user's account, so
 * this stays minimal; a host supplies a fuller catalog when it has one.
 */
export const CODEX_DEFAULT_MODELS: ProviderModelDefinition[] = [
  {
    capabilities: { functionCalling: true },
    id: "gpt-5.5",
    kind: "text",
    label: "GPT-5.5",
    modelId: "gpt-5.5",
    vendor: "openai",
  },
];

/** How long a signalled app-server gets to exit before SIGKILL, and after it. */
const EXIT_GRACE_MS = 2000;
const KILL_GRACE_MS = 1000;

type AppServerClient = ReturnType<typeof createCodexAppServer>;

/** One vendor client, and so one app-server per working directory, for one environment. */
interface AppServer {
  calls: number;
  readonly client: AppServerClient;
  /** The vendor's per-process RPC clients, read only to wait for their processes. */
  readonly connections: Set<object>;
  readonly key: string;
  retired: boolean;
  /** Set while stopping; cleared if the stop fails, so it can be retried. */
  stopping?: Promise<void>;
  /** A model came back without the process handle this provider waits on. */
  unobservable: boolean;
}

/**
 * Codex as a provider: the CLI runs the turn, spoken to over its app-server
 * JSON-RPC transport. The transport is a persistent child process, which is
 * why `dispose` exists — without it a `codex app-server` outlives the app.
 *
 * Each call takes the app-server for the environment it needs now. One whose
 * environment was superseded closes once its calls finish, and going
 * offline closes them all and waits for their processes to exit.
 */
export function codexProvider(options: CodexProviderOptions): Provider {
  const id = options.id ?? "codex";
  const config = options.config ?? {};
  let offline = false;
  /** Every app-server until its process is known to have exited. */
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

  const serverFor = (env: Record<string, string>): AppServer => {
    const key = JSON.stringify([config.binPath ?? null, sorted(env)]);
    if (current?.key === key && !current.retired) {
      return current;
    }
    for (const server of servers) {
      retire(server);
    }
    const server: AppServer = {
      calls: 0,
      client: createCodexAppServer({
        defaultSettings: {
          ...(config.binPath ? { codexPath: config.binPath } : {}),
          env,
          // The CLI's own logging would otherwise land on the host's stdout.
          logger: false,
        },
      }),
      connections: new Set(),
      key,
      retired: false,
      unobservable: false,
    };
    servers.add(server);
    current = server;
    return server;
  };

  const lease = (modelId: string, cwd: string | undefined) => {
    if (offline) {
      throw modelErrors.PROVIDER_OFFLINE({ provider: id });
    }
    const server = serverFor(environmentOverlay(options.env, ""));
    const model = server.client.languageModel(modelId, cwd ? { cwd } : {});
    const connection = (model as { client?: unknown }).client;
    if (
      typeof connection === "object" &&
      connection !== null &&
      "child" in connection
    ) {
      server.connections.add(connection);
    } else {
      server.unobservable = true;
    }
    server.calls += 1;
    let released = false;
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
    dispose: stopAll,
    id,
    languageModel: (modelId, opts) =>
      leasedModel(modelId, () => lease(modelId, opts?.workingDirectory)),
    models: options.models ?? CODEX_DEFAULT_MODELS,
    offline: false,
    setOffline: async (value) => {
      offline = value;
      if (value) {
        await stopAll();
      }
    },
    // The CLI runs its own tool loop inside one call and takes no limit.
    turnLimit: "unsupported",
  };
}

function sorted(env: Record<string, string>): [string, string][] {
  return Object.entries(env).sort(([a], [b]) => a.localeCompare(b));
}

/** Resolves once `child` has exited, sending SIGKILL when SIGTERM was not enough. */
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

/** A stream dropped without being read to its end or cancelled still releases its lease. */
const abandoned = new FinalizationRegistry<() => void>((release) => release());

/** A model whose every call leases a delegate, released when the call or its stream ends. */
function leasedModel(
  modelId: string,
  lease: () => { model: LanguageModelV4; release(): void }
): LanguageModelV4 {
  return {
    doGenerate: async (callOptions) => {
      const { model, release } = lease();
      try {
        return await model.doGenerate(callOptions);
      } finally {
        release();
      }
    },
    doStream: async (callOptions) => {
      const { model, release } = lease();
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
