import { describe, expect, it } from "vitest";

import type { ContainerSandboxConstraints } from "../container/constraints";

import { createContainers } from "../container/containers";
import { createMicrosandboxRuntime } from "../container/microsandbox-runtime";
import { createMemoryContainerStore } from "../container/store";

const SPEC: ContainerSandboxConstraints = {
  format: "foundry.sandbox.container/1",
  image: "docker.io/oven/bun:1-slim",
  network: "disabled",
  ports: [3000],
};

const ECHO_SERVER = `
Bun.serve({
  port: 3000,
  fetch(request, server) {
    if (server.upgrade(request)) return;
    return new Response("ok");
  },
  websocket: {
    message(socket, message) {
      socket.send(String(message));
    },
  },
});
`;

describe("real MicroSandbox port forward", () => {
  it("completes a host-initiated WebSocket close against a live guest", async () => {
    const runtime = createMicrosandboxRuntime();
    if (!(await runtime.isInstalled())) {
      throw new Error(
        "Install the MicroSandbox runtime before running test:integration"
      );
    }
    const containers = createContainers({
      instanceLabel: `itest-${crypto.randomUUID()}`,
      runtime,
      store: createMemoryContainerStore(),
    });
    const container = await containers.start(SPEC);
    try {
      await container.services.start({
        argv: ["bun", "-e", ECHO_SERVER],
        id: "echo",
        readiness: { kind: "tcp", port: 3000, timeoutMs: 60_000 },
      });
      const binding = await container.ports.hostPort(3000);
      if (binding === undefined) {
        throw new Error("port 3000 is not published");
      }

      await expect
        .poll(
          async () => {
            const response = await fetch(
              `http://${binding.host}:${String(binding.port)}/`
            );
            return response.text();
          },
          { timeout: 60_000 }
        )
        .toBe("ok");

      const socket = new WebSocket(
        `ws://${binding.host}:${String(binding.port)}/`
      );
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener(
          "open",
          () => {
            resolve();
          },
          { once: true }
        );
        socket.addEventListener(
          "error",
          (event) => {
            reject(
              new Error("WebSocket did not open", {
                cause: (event as ErrorEvent).error,
              })
            );
          },
          { once: true }
        );
      });
      const echoed = new Promise<unknown>((resolve) => {
        socket.addEventListener(
          "message",
          (event) => {
            resolve(event.data);
          },
          { once: true }
        );
      });
      socket.send("ping");
      expect(await echoed).toBe("ping");

      const closed = new Promise<"closed">((resolve) => {
        socket.addEventListener(
          "close",
          () => {
            resolve("closed");
          },
          { once: true }
        );
      });
      socket.close(1000, "done");
      const outcome = await Promise.race([
        closed,
        new Promise<"timed-out">((resolve) => {
          setTimeout(() => {
            resolve("timed-out");
          }, 5000);
        }),
      ]);
      expect(outcome).toBe("closed");
    } finally {
      await container.close();
      await containers.shutdown();
    }
  }, 180_000);
});
