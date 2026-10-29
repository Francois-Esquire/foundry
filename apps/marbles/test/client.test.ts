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
  explainDisconnect,
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

    // `marbles stop` stops whatever version it finds, and says it is
    // stopping once the daemon has agreed to, not before it was asked.
    const agreed: string[][] = [];
    const stopped = await stopProcess({
      layout: at,
      onStopping: () => agreed.push([...asked]),
    });
    expect(stopped?.version).toBe("0.0.0-old");
    expect(agreed).toEqual([["hello", "hello", "shutdown"]]);
  });

  it("does not report a stop the daemon never agreed to", async () => {
    const at = machine();
    const asked = await fakeDaemon(at, (method) =>
      method === "hello" ? oldHello(at) : new Promise(() => undefined)
    );
    let agreed = false;
    await expect(
      stopProcess({
        layout: at,
        onStopping: () => {
          agreed = true;
        },
        timeoutMs: 500,
      })
    ).rejects.toThrow("asking the Marbles process to stop");
    expect(agreed).toBe(false);
    expect(asked).toEqual(["hello", "shutdown"]);
  });

  it("refuses another artifact store before it would replace an older daemon", async () => {
    const at = machine();
    const elsewhere = layout({
      artifacts: join(at.home, "elsewhere"),
      home: at.home,
    });
    const asked = await fakeDaemon(at, () => oldHello(at));
    // A starting connect replaces an older daemon, but not one that keeps
    // another store: that would stop it and start one on the wrong store.
    const refused = connect({ layout: elsewhere, timeoutMs: 2000 });
    await expect(refused).rejects.toThrow(ProcessMismatchError);
    await expect(refused).rejects.toThrow(`keeps artifacts in ${at.artifacts}`);
    await expect(refused).rejects.toThrow(elsewhere.artifacts);
    expect(asked).toEqual(["hello"]);
  });

  it("tells a daemon that stopped from one that died from one that hung up", async () => {
    const at = machine();
    const hello = { ...oldHello(at), pid: 2_147_483_647 };
    const lock = join(at.state, "locks", "process");
    mkdirSync(join(at.state, "locks"), { recursive: true });
    const record = (pid: number) =>
      writeFileSync(
        join(at.state, "process.json"),
        JSON.stringify({
          host: "daemon",
          pid,
          startedAt: new Date().toISOString(),
          version: 1,
        })
      );

    // The socket failed: that is the reason, whatever the state root says.
    const failure = new Error("read ECONNRESET");
    expect(await explainDisconnect(at, hello, failure, false)).toEqual({
      error: failure,
      kind: "failed",
    });
    // We hung up ourselves.
    expect(await explainDisconnect(at, hello, undefined, true)).toEqual({
      kind: "closed",
    });
    // Nothing at the state root names the daemon: it stopped and released.
    expect(await explainDisconnect(at, hello, undefined, false)).toEqual({
      kind: "stopped",
    });
    // Its claim still names a pid that no longer runs: it died.
    writeFileSync(lock, String(hello.pid));
    record(hello.pid);
    expect(await explainDisconnect(at, hello, undefined, false)).toEqual({
      kind: "died",
      log: join(at.state, "daemon.log"),
      pid: hello.pid,
    });
    // Its claim names a live pid: it is up, and closed this connection.
    const alive = { ...hello, pid: process.pid };
    writeFileSync(lock, String(process.pid));
    record(process.pid);
    expect(await explainDisconnect(at, alive, undefined, false)).toEqual({
      kind: "hung-up",
      pid: process.pid,
    });
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
