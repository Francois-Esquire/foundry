import { describe, expect, it } from "vitest";
import { createContainers } from "../containers/containers";
import type { ContainerSpecInput } from "../containers/spec";
import { createMicrosandboxDriver } from "../providers/microsandbox";
import { MemoryContainerStore } from "../store/memory";

const SPEC: ContainerSpecInput = {
  expose: [{ port: 3000 }],
  image: "docker.io/oven/bun:1-slim",
  network: "none",
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
    const runtime = createMicrosandboxDriver();
    if (
      !(await (runtime.isInstalled
        ? runtime.isInstalled()
        : Promise.resolve(true)))
    ) {
      throw new Error(
        "Install the MicroSandbox runtime before running test:integration"
      );
    }
    const containers = createContainers({
      driver: runtime,
      instanceLabel: `itest-${crypto.randomUUID()}`,
      store: new MemoryContainerStore(),
    });
    const container = await containers.start(SPEC);
    try {
      await container.services?.start({
        argv: ["bun", "-e", ECHO_SERVER],
        id: "echo",
        readiness: { kind: "tcp", port: 3000, timeoutMs: 60_000 },
      });
      const binding = await container.ports?.endpoint(3000);
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
