import { runtimeInstanceIdSchema } from "../domain";
import type { ModuleTransport } from "../gateway/types";
import type {
  ModuleProgramRuntimeAdapter,
  ModuleProgramRuntimeHandle,
} from "./contracts";
import { rethrowAfterCleanup } from "./contracts";

export const MODULE_FILES_ROOT = "/foundry/files";
export const MODULE_PROGRAM_PORT = 3000;
export const MODULE_PROGRAM_ROOT = "/foundry/program";

const MODULE_PROGRAM_SERVICE_ID = "module-program";
const MODULE_GATEWAY_PATH = "/_foundry/module-gateway";
const MODULE_HEALTH_PATH = "/_foundry/health";

export interface ModuleProgramContainer {
  close(): Promise<void>;
  readonly id: string;
  readonly ports: {
    hostPort(
      port: number
    ): Promise<{ readonly host: string; readonly port: number } | undefined>;
  };
  readonly services: {
    start(input: {
      readonly id: string;
      readonly argv: readonly [string, ...string[]];
      readonly cwd: string;
      readonly environment: Readonly<Record<string, string>>;
      readonly readiness: {
        readonly kind: "tcp";
        readonly port: number;
        readonly timeoutMs: number;
        readonly intervalMs: number;
      };
      readonly terminationGraceMs: number;
    }): Promise<{
      readonly startedAt: number;
      wait(): Promise<{
        readonly exitCode: number;
        readonly stdout: string;
        readonly stderr: string;
        readonly finishedAt: number;
      }>;
    }>;
    stop(id: string): Promise<void>;
  };
}

export interface CreateModuleProgramRuntimeOptions {
  readonly acquire: (
    input: Parameters<ModuleProgramRuntimeAdapter["start"]>[0]
  ) => Promise<ModuleProgramContainer>;
  readonly fetch?: typeof globalThis.fetch;
  readonly healthCheckTimeoutMs?: number;
  readonly transport: {
    connect(input: {
      readonly url: URL;
      readonly signal?: AbortSignal;
    }): Promise<ModuleTransport>;
  };
}

export type ModuleProgramRuntimeErrorCode =
  | "mount-mismatch"
  | "port-unavailable"
  | "health-check-failed";

export class ModuleProgramRuntimeError extends Error {
  readonly code: ModuleProgramRuntimeErrorCode;

  constructor(
    code: ModuleProgramRuntimeErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
    this.name = "ModuleProgramRuntimeError";
  }
}

/**
 * Runs one Module Program in one registry container. The Installation keeps
 * its container id, so a restart reuses the row: the spec is refreshed for
 * the selected version's checkout and the VM boots again under the same
 * identity, never onto a mount a previous spec named.
 */
export function createModuleProgramRuntime(
  options: CreateModuleProgramRuntimeOptions
): ModuleProgramRuntimeAdapter {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? 5000;
  if (
    !Number.isSafeInteger(healthCheckTimeoutMs) ||
    healthCheckTimeoutMs <= 0
  ) {
    throw new TypeError(
      "Module health-check timeout must be a positive integer"
    );
  }
  return Object.freeze({
    async start(
      input: Parameters<ModuleProgramRuntimeAdapter["start"]>[0]
    ): Promise<ModuleProgramRuntimeHandle> {
      const container = await options.acquire(input);

      let serviceStarted = false;
      try {
        input.signal?.throwIfAborted();

        const { services } = container;
        const service = await services.start({
          argv: ["bun", input.version.manifest.program.entry],
          cwd: MODULE_PROGRAM_ROOT,
          environment: {
            FOUNDRY_FILES_PATH: MODULE_FILES_ROOT,
            // Versions built before the files directory read only this name.
            FOUNDRY_MODULE_DATA_PATH: `${MODULE_FILES_ROOT}/data.sqlite`,
            NODE_ENV: "production",
            PORT: String(MODULE_PROGRAM_PORT),
          },
          id: MODULE_PROGRAM_SERVICE_ID,
          readiness: {
            intervalMs: 50,
            kind: "tcp",
            port: MODULE_PROGRAM_PORT,
            timeoutMs: 30_000,
          },
          terminationGraceMs: 5000,
        });
        serviceStarted = true;

        const binding = await container.ports.hostPort(MODULE_PROGRAM_PORT);
        if (binding === undefined) {
          throw runtimeError(
            "port-unavailable",
            "Module Program guest port 3000 has no loopback host binding"
          );
        }
        const origin = loopbackOrigin(binding.host, binding.port);
        await probeProgramHealth(
          fetchImplementation,
          origin,
          healthCheckTimeoutMs,
          input.signal
        );
        const gatewayUrl = new URL(MODULE_GATEWAY_PATH, origin);
        gatewayUrl.protocol = "ws:";
        const transport = await options.transport.connect({
          url: gatewayUrl,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
        let stopping = false;
        let stopPromise: Promise<void> | undefined;
        // `finally`, not `then`: a wait that rejects (an exec session lost
        // with its VM) still means the Program is gone, and an unobserved
        // rejection here would surface as an unhandled rejection at shutdown.
        service
          .wait()
          .then(
            (exit) => {
              if (stopping) {
                return;
              }
              console.warn(
                `[module-program] ${container.id} exited on its own: code ${String(exit.exitCode)} after ${exit.finishedAt - service.startedAt}ms\n` +
                  `stderr tail: ${exit.stderr.slice(-2000)}\nstdout tail: ${exit.stdout.slice(-2000)}`
              );
            },
            (error: unknown) => {
              if (stopping) {
                return;
              }
              console.warn(
                `[module-program] ${container.id} exec session lost:`,
                error
              );
            }
          )
          .finally(() => {
            if (!stopping) {
              transport.close("Module Program exited").catch(() => undefined);
            }
          });

        return Object.freeze({
          programOrigin: origin.toString(),
          runtimeInstanceId: runtimeInstanceIdSchema.parse(container.id),
          stop(): Promise<void> {
            if (stopPromise !== undefined) {
              return stopPromise;
            }
            stopping = true;
            stopPromise = stopProgramRuntime(services, container).catch(
              (error: unknown) => {
                stopPromise = undefined;
                throw error;
              }
            );
            return stopPromise;
          },
          transport,
        });
      } catch (error) {
        return rethrowAfterCleanup(
          error,
          () =>
            stopProgramRuntime(container.services, container, serviceStarted),
          "Module startup and cleanup failed"
        );
      }
    },
  });
}

async function probeProgramHealth(
  fetchImplementation: typeof globalThis.fetch,
  origin: URL,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  const healthUrl = new URL(MODULE_HEALTH_PATH, origin);
  const deadline = Date.now() + timeoutMs;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const fetchSignal =
    signal === undefined
      ? timeoutSignal
      : AbortSignal.any([signal, timeoutSignal]);
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const response = await fetchImplementation(healthUrl, {
        // The guest port forward multiplexes one relay slot. A pooled
        // keep-alive probe socket left open here contends with the Gateway
        // WebSocket that dials the same origin next, bumping it mid-upgrade.
        headers: { connection: "close" },
        method: "GET",
        redirect: "error",
        signal: fetchSignal,
      });
      if (response.ok) {
        return;
      }
      lastFailure = new Error(
        `Module Program health endpoint returned HTTP ${String(response.status)}`
      );
    } catch (error) {
      signal?.throwIfAborted();
      lastFailure = error;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(50, remainingMs))
      );
    }
  }
  throw runtimeError(
    "health-check-failed",
    "Module Program did not answer its private health endpoint",
    lastFailure
  );
}

async function stopProgramRuntime(
  services: ModuleProgramContainer["services"],
  container: ModuleProgramContainer,
  serviceStarted = true
): Promise<void> {
  const failures: unknown[] = [];
  if (serviceStarted) {
    await services.stop(MODULE_PROGRAM_SERVICE_ID).catch((error: unknown) => {
      failures.push(error);
    });
  }
  try {
    await container.close();
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: AggregateError accepts ErrorOptions as its third argument.
    throw new AggregateError(
      [...failures, error],
      "Module Program runtime cleanup failed",
      { cause: error }
    );
  }
}

function loopbackOrigin(host: string, port: number): URL {
  if (!isLoopbackHost(host)) {
    throw runtimeError(
      "port-unavailable",
      "Module Program host binding must be private loopback ingress"
    );
  }
  const origin = new URL("http://127.0.0.1");
  origin.hostname = host;
  origin.port = String(port);
  return origin;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function runtimeError(
  code: ModuleProgramRuntimeErrorCode,
  message: string,
  cause?: unknown
): ModuleProgramRuntimeError {
  return new ModuleProgramRuntimeError(
    code,
    message,
    cause === undefined ? undefined : { cause }
  );
}
