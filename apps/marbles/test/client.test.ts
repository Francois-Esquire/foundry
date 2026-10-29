import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { type Layout, layout } from "~/layout";
import { Channel, socketTransport } from "~/process/channel";
import {
  connect,
  NoProcessError,
  ProcessMismatchError,
  stopProcess,
} from "~/process/client";
import { type HelloResult, PROTOCOL } from "~/process/protocol";

/**
 * The client against daemons that misbehave: one that never answers, one
 * of another version, and one that is exiting when the client looks. The
 * state root sits in a short temp path for the socket's sake.
 */

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

function machine(): Layout {
  const home = mkdtempSync(join(tmpdir(), "mb-cl-"));
  cleanup.push(() => rmSync(home, { force: true, recursive: true }));
  const machineLayout = layout({ home });
  mkdirSync(machineLayout.state, { recursive: true });
  return machineLayout;
}

/** A listener at the layout's socket; `answer` handles each request, or never answers. */
async function fakeDaemon(
  at: Layout,
  answer?: (method: string, socket: Socket) => unknown
): Promise<string[]> {
  const asked: string[] = [];
  const server: Server = createServer((socket) => {
    const channel = new Channel(socketTransport(socket), {
      request(method) {
        asked.push(method);
        return answer === undefined
          ? new Promise(() => undefined)
          : Promise.resolve(answer(method, socket));
      },
    });
    cleanup.push(() => channel.close());
  });
  await new Promise<void>((resolve) => server.listen(at.socket, resolve));
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve()))
  );
  return asked;
}

function oldHello(at: Layout): HelloResult {
  return {
    artifacts: at.artifacts,
    pid: process.pid,
    protocol: PROTOCOL,
    startedAt: new Date().toISOString(),
    state: at.state,
    version: "0.0.0-old",
  };
}

describe("connecting to the Marbles process", () => {
  it("gives up on a daemon that accepts and never answers", async () => {
    const at = machine();
    const asked = await fakeDaemon(at);
    const began = Date.now();
    await expect(
      connect({ layout: at, start: false, timeoutMs: 500 })
    ).rejects.toThrow(NoProcessError);
    expect(Date.now() - began).toBeLessThan(3000);
    expect(asked).toEqual(["hello"]);
  });

  it("leaves a daemon of another version running unless asked to stop it", async () => {
    const at = machine();
    const asked = await fakeDaemon(at, (method, socket) => {
      if (method === "shutdown") {
        setImmediate(() => socket.destroy());
        return;
      }
      return oldHello(at);
    });
    const refused = connect({ layout: at, start: false });
    await expect(refused).rejects.toThrow(ProcessMismatchError);
    await expect(refused).rejects.toThrow("runs version 0.0.0-old");
    await expect(refused).rejects.toThrow("marbles stop");
    expect(asked).toEqual(["hello"]);

    // `marbles stop` stops whatever version it finds.
    expect((await stopProcess({ layout: at }))?.version).toBe("0.0.0-old");
    expect(asked).toEqual(["hello", "hello", "shutdown"]);
  });

  it("starts a fresh daemon when the one holding the claim exits meanwhile", async () => {
    const at = machine();
    // A daemon on its way out: it holds the claim, and its socket is gone.
    const leaving: ChildProcess = spawn("sleep", ["1.5"], { stdio: "ignore" });
    const pid = leaving.pid ?? 0;
    mkdirSync(join(at.state, "locks"), { recursive: true });
    writeFileSync(join(at.state, "locks", "process"), String(pid));
    writeFileSync(
      join(at.state, "process.json"),
      JSON.stringify({
        host: "daemon",
        pid,
        startedAt: new Date().toISOString(),
        version: 1,
      })
    );
    cleanup.push(async () => {
      await stopProcess({ layout: at }).catch(() => undefined);
    });
    const client = await connect({ layout: at, timeoutMs: 20_000 });
    expect(client.hello.pid).not.toBe(pid);
    client.close();
    await stopProcess({ layout: at });
  }, 60_000);
});
