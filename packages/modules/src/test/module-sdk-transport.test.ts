import { describe, expect, it } from "vitest";

import { type GatewayClient, importModuleSdk } from "./helpers/module-sdk";
import { type ScriptedHost, startScriptedHost } from "./helpers/scripted-host";

const HELLO = {
  binding: { developmentId: "transport-test" },
  kind: "hello",
  mode: "runtime",
  protocol: 1,
};

/** A Program-side SDK client on a real WebSocket, past the handshake. */
async function connect(host: ScriptedHost): Promise<{
  client: GatewayClient;
  socket: WebSocket;
}> {
  const sdk = await importModuleSdk();
  const socket = new WebSocket(host.url);
  const client = sdk.createGatewayClient(
    sdk.createWebSocketGatewayTransport(socket)
  );
  expect(await host.next()).toEqual({ event: "open" });
  host.send(HELLO);
  expect(await host.frame()).toEqual({
    kind: "ready",
    mode: "runtime",
    protocol: 1,
  });
  return { client, socket };
}

describe("Module SDK WebSocket transport", () => {
  it("streams events until complete", async () => {
    await using host = await startScriptedHost();
    const { client, socket } = await connect(host);
    const events = client.observe("theme", {})[Symbol.asyncIterator]();
    const pending = events.next();
    const invoke = await host.frame();
    expect(invoke).toMatchObject({
      alias: "theme",
      input: {},
      kind: "invoke",
      mode: "stream",
    });
    host.send({ event: { revision: 1 }, id: invoke.id, kind: "next" });
    host.send({ event: { revision: 2 }, id: invoke.id, kind: "next" });
    host.send({ id: invoke.id, kind: "complete" });
    expect(await pending).toEqual({ done: false, value: { revision: 1 } });
    expect(await events.next()).toEqual({
      done: false,
      value: { revision: 2 },
    });
    expect(await events.next()).toEqual({ done: true, value: undefined });
    socket.close();
  });

  it("rejects pending reads and calls when the socket closes", async () => {
    await using host = await startScriptedHost();
    const { client } = await connect(host);
    const events = client.observe("theme", {})[Symbol.asyncIterator]();
    const read = events.next();
    await host.frame();
    const call = client.call("weather", { city: "Oslo" });
    await host.frame();
    host.close(1011, "host failed");
    await expect(read).rejects.toMatchObject({ code: "transport-closed" });
    await expect(call).rejects.toMatchObject({ code: "transport-closed" });
    // Later requests on the closed transport fail at once.
    await expect(client.call("weather", {})).rejects.toMatchObject({
      code: "transport-closed",
    });
  });

  it("cancels a returned stream, ignores its late frames and keeps serving", async () => {
    await using host = await startScriptedHost();
    const { client, socket } = await connect(host);
    const events = client.observe("theme", {})[Symbol.asyncIterator]();
    const waiting = events.next();
    const invoke = await host.frame();
    await events.return?.();
    expect(await waiting).toEqual({ done: true, value: undefined });
    expect(await host.frame()).toEqual({ id: invoke.id, kind: "cancel" });

    // Frames the host sent before it saw the cancel change nothing.
    host.send({ event: { revision: 9 }, id: invoke.id, kind: "next" });
    host.send({ id: invoke.id, kind: "complete" });
    host.send({
      code: "cancelled",
      id: invoke.id,
      kind: "failure",
      message: "Gateway request was cancelled",
    });
    expect(await events.next()).toEqual({ done: true, value: undefined });

    const call = client.call("weather", {});
    const unary = await host.frame();
    host.send({ id: unary.id, kind: "result", output: { ok: true } });
    expect(await call).toEqual({ ok: true });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it("cancels a stream whose signal aborts", async () => {
    await using host = await startScriptedHost();
    const { client, socket } = await connect(host);
    const controller = new AbortController();
    const events = client
      .observe("theme", {}, { signal: controller.signal })
      [Symbol.asyncIterator]();
    const read = events.next();
    const invoke = await host.frame();
    controller.abort();
    await expect(read).rejects.toMatchObject({ code: "cancelled" });
    expect(await host.frame()).toEqual({ id: invoke.id, kind: "cancel" });
    socket.close();
  });

  it("reconnects on a new socket with a fresh handshake", async () => {
    await using host = await startScriptedHost();
    const first = await connect(host);
    const stale = first.client.observe("theme", {})[Symbol.asyncIterator]();
    const read = stale.next();
    await host.frame();
    first.socket.close();
    await expect(read).rejects.toMatchObject({ code: "transport-closed" });
    expect(await host.next()).toMatchObject({ event: "close" });

    const second = await connect(host);
    const events = second.client.observe("theme", {})[Symbol.asyncIterator]();
    const fresh = events.next();
    const invoke = await host.frame();
    host.send({ event: { revision: 1 }, id: invoke.id, kind: "next" });
    expect(await fresh).toEqual({ done: false, value: { revision: 1 } });
    second.socket.close();
  });
});
