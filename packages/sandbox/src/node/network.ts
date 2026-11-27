import { createConnection, createServer } from "node:net";
import { SandboxError } from "../errors";

export interface LoopbackPortMapping {
  readonly guestPort: number;
  readonly host: "127.0.0.1";
  readonly hostPort: number;
}

export async function reserveLoopbackPorts(
  guestPorts: readonly number[]
): Promise<readonly LoopbackPortMapping[]> {
  const mappings: LoopbackPortMapping[] = [];
  for (const guestPort of guestPorts) {
    mappings.push(
      Object.freeze({
        guestPort,
        host: "127.0.0.1",
        hostPort: await freeLoopbackPort(),
      })
    );
  }
  return Object.freeze(mappings);
}

export function probeTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host, port });
    const settle = (ready: boolean): void => {
      socket.destroy();
      resolveProbe(ready);
    };
    socket.once("connect", () => {
      settle(true);
    });
    socket.once("error", () => {
      settle(false);
    });
    socket.setTimeout(250, () => {
      settle(false);
    });
  });
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
