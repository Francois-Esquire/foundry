import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createContainers } from "../container/containers";
import { createMicrosandboxRuntime } from "../container/microsandbox-runtime";
import { createMemoryContainerStore } from "../container/store";
import { MODULE_GATEWAY_SERVER } from "./helpers/module-gateway-server";

const APPLICATION_CLOSE_TIMEOUT_MS = 1000;
const RAW_CLOSE_TIMEOUT_MS = 5000;
const healthSchema = z.object({
  bunRevision: z.string(),
  bunVersion: z.string(),
  closedSockets: z.array(z.object({ code: z.number(), reason: z.string() })),
  connection: z.string().nullable(),
  status: z.literal("ready"),
});
const CASES = [
  { probeConnection: "default", target: "host" },
  { probeConnection: "close", target: "host" },
  { probeConnection: "default", target: "vm" },
  { probeConnection: "close", target: "vm" },
] as const;

interface Endpoint extends AsyncDisposable {
  readonly origin: string;
}

async function startHost(): Promise<Endpoint> {
  const child = spawn("bun", ["-e", MODULE_GATEWAY_SERVER], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const dispose = async () => {
    lines.close();
    child.kill("SIGKILL");
    await exited;
  };
  try {
    const lineEvent: unknown = await once(lines, "line", {
      signal: AbortSignal.timeout(10_000),
    });
    const [line] = z.tuple([z.string()]).parse(lineEvent);
    const port = Number(line);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Invalid host gateway port: ${line}`);
    }
    return {
      origin: `http://127.0.0.1:${port}`,
      [Symbol.asyncDispose]: dispose,
    };
  } catch (cause) {
    await dispose();
    throw new Error(`Host gateway failed to start: ${stderr}`, { cause });
  }
}

async function startVm(bunVersion: string): Promise<Endpoint> {
  const runtime = createMicrosandboxRuntime();
  if (!(await runtime.isInstalled())) {
    throw new Error("Install MicroSandbox before running test:integration");
  }
  const containers = createContainers({
    instanceLabel: `gateway-comparison-${crypto.randomUUID()}`,
    runtime,
    store: createMemoryContainerStore(),
  });
  try {
    const container = await containers.start({
      format: "foundry.sandbox.container/1",
      image: `docker.io/oven/bun:${bunVersion}-slim`,
      network: "disabled",
      ports: [3000],
    });
    await container.services.start({
      argv: ["bun", "-e", MODULE_GATEWAY_SERVER],
      environment: { PORT: "3000" },
      id: "gateway",
      readiness: { kind: "tcp", port: 3000, timeoutMs: 60_000 },
    });
    const binding = await container.ports.hostPort(3000);
    if (binding === undefined) {
      throw new Error("Gateway port 3000 is not published");
    }
    return {
      origin: `http://${binding.host}:${binding.port}`,
      [Symbol.asyncDispose]: () => containers.shutdown(),
    };
  } catch (error) {
    await containers.shutdown();
    throw error;
  }
}

async function within<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function measureClose(socket: WebSocket) {
  const started = performance.now();
  const closed = new Promise<{
    code: number;
    elapsedMs: number;
    reason: string;
    wasClean: boolean;
  }>((resolve) => {
    socket.addEventListener(
      "close",
      (event) => {
        resolve({
          code: event.code,
          elapsedMs: Math.round(performance.now() - started),
          reason: event.reason,
          wasClean: event.wasClean,
        });
      },
      { once: true }
    );
  });
  socket.close(1000, "done");
  // Measure Studio's deadline without letting it satisfy the raw close check.
  const applicationClose = await within(closed, APPLICATION_CLOSE_TIMEOUT_MS);
  const rawClose = await within(
    closed,
    Math.max(0, RAW_CLOSE_TIMEOUT_MS - (performance.now() - started))
  );
  return {
    applicationClose:
      applicationClose === undefined ? "deadline" : "socket-event",
    rawClose: rawClose ?? "timed-out",
    readyState: socket.readyState,
  };
}

describe("Module Gateway WebSocket host/VM comparison", () => {
  let hostBunVersion: string;
  let hostBunRevision: string;
  beforeAll(async () => {
    await using host = await startHost();
    const response = await fetch(`${host.origin}/_foundry/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const metadata = healthSchema.parse(await response.json());
    hostBunVersion = metadata.bunVersion;
    hostBunRevision = metadata.bunRevision;
  });

  it.each(CASES)(
    "$target with $probeConnection health connection",
    async ({ target, probeConnection }) => {
      await using endpoint = await (target === "host"
        ? startHost()
        : startVm(hostBunVersion));
      const healthUrl = `${endpoint.origin}/_foundry/health`;
      let healthMetadata: unknown;
      await expect
        .poll(
          async () => {
            const health = await fetch(healthUrl, {
              headers:
                probeConnection === "close" ? { connection: "close" } : {},
              signal: AbortSignal.timeout(5000),
            });
            healthMetadata = await health.json();
            return health.status;
          },
          { timeout: 10_000 }
        )
        .toBe(200);
      const metadata = healthSchema.parse(healthMetadata);
      expect(metadata).toMatchObject({
        bunVersion: hostBunVersion,
        status: "ready",
      });
      expect(metadata.bunRevision).toBe(hostBunRevision);
      if (probeConnection === "close") {
        expect(metadata.connection).toBe("close");
      }

      const socket = new WebSocket(
        `${endpoint.origin.replace("http:", "ws:")}/_foundry/module-gateway`
      );
      const messages: unknown[] = [];
      socket.addEventListener("message", (event) => {
        messages.push(JSON.parse(String(event.data)));
      });
      try {
        await expect
          .poll(() => socket.readyState, { timeout: 5000 })
          .toBe(WebSocket.OPEN);
        socket.send(
          JSON.stringify({
            binding: {
              generation: 1,
              installationId: "installation-1",
              moduleId: "module-1",
              releaseId: "release-1",
              runtimeInstanceId: "runtime-1",
            },
            kind: "hello",
            mode: "runtime",
            protocol: 1,
          })
        );
        await expect
          .poll(() => messages[0], { timeout: 5000 })
          .toEqual({
            kind: "ready",
            mode: "runtime",
            protocol: 1,
          });
        for (const sequence of [1, 2, 3]) {
          const heartbeat = { kind: "heartbeat", sequence };
          socket.send(JSON.stringify(heartbeat));
          await expect
            .poll(() => messages[sequence], { timeout: 5000 })
            .toEqual(heartbeat);
        }
        const closure = await measureClose(socket);
        const diagnostics = await fetch(healthUrl, {
          signal: AbortSignal.timeout(5000),
        });
        const server = healthSchema.parse(await diagnostics.json());
        const result = {
          bunRevision: metadata.bunRevision,
          bunVersion: metadata.bunVersion,
          healthConnection: metadata.connection,
          node: process.versions.node,
          probeConnection,
          receivedFrames: messages.length,
          serverCloses: server.closedSockets,
          target,
          ...closure,
        };
        console.info(JSON.stringify(result));
        expect(server.closedSockets).toEqual([{ code: 1000, reason: "done" }]);
        expect(closure.rawClose, JSON.stringify(result)).toMatchObject({
          code: 1000,
          reason: "done",
          wasClean: true,
        });
        expect(socket.readyState).toBe(WebSocket.CLOSED);
      } finally {
        socket.close();
      }
    },
    120_000
  );
});
