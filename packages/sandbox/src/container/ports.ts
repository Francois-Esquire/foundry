import { createServer } from "node:net";

import { SandboxError } from "../errors";
import type { ContainerPortMapping } from "./types";

const MAX_TCP_PORT = 65_535;

export function isTcpPort(port: number): boolean {
  return Number.isSafeInteger(port) && port >= 1 && port <= MAX_TCP_PORT;
}

export function assertGuestPorts(guestPorts: readonly number[]): void {
  const seen = new Set<number>();
  for (const port of guestPorts) {
    if (!isTcpPort(port)) {
      throw new SandboxError(
        "invalid-contract",
        "guest ports must be integers from 1 through 65535",
        { details: { port } }
      );
    }
    if (seen.has(port)) {
      throw new SandboxError("invalid-contract", "guest ports must be unique", {
        details: { port },
      });
    }
    seen.add(port);
  }
}

/**
 * Pick a free loopback port per requested guest port. The microVM runtime
 * wants the host port up front, so it is chosen here. The listener is closed
 * before the VM binds it, which leaves a small window where another process
 * could take the port — the boot then fails loudly rather than silently
 * mis-binding.
 */
export async function reserveHostPorts(
  guestPorts: readonly number[]
): Promise<readonly ContainerPortMapping[]> {
  const mappings: ContainerPortMapping[] = [];
  for (const guestPort of guestPorts) {
    mappings.push({
      guestPort,
      host: "127.0.0.1",
      hostPort: await freeLoopbackPort(),
    });
  }
  return mappings;
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => {
        if (port > 0) {
          resolve(port);
        } else {
          reject(
            new SandboxError("provider-failed", "could not reserve a host port")
          );
        }
      });
    });
  });
}
