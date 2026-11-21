import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { Channel, socketTransport, type Transport } from "~/process/channel";
import { encode, MAX_LINE_BYTES, type Message } from "~/process/protocol";

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.splice(0)) {
    step();
  }
});

async function socketPair(): Promise<{ client: Socket; server: Socket }> {
  const dir = mkdtempSync(join(tmpdir(), "mb-ch-"));
  const path = join(dir, "s.sock");
  let accepted: (socket: Socket) => void = () => undefined;
  const serverSide = new Promise<Socket>((resolve) => {
    accepted = resolve;
  });
  const server: Server = createServer((socket) => accepted(socket));
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const client = connect(path);
  await new Promise<void>((resolve) => client.once("connect", resolve));
  const server_ = await serverSide;
  cleanup.push(() => {
    client.destroy();
    server_.destroy();
    server.close();
    rmSync(dir, { force: true, recursive: true });
  });
  return { client, server: server_ };
}

describe("the socket transport", () => {
  it("survives a socket error and reports it as the reason the channel closed", async () => {
    const { client, server } = await socketPair();
    const channel = new Channel(socketTransport(server));
    const pending = channel.request("hello");
    const failure = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => server.emit("error", failure)).not.toThrow();
    client.destroy();
    await expect(pending).rejects.toThrow("the connection failed: write EPIPE");
    await expect(pending).rejects.toMatchObject({
      cause: failure,
      name: "ConnectionClosedError",
    });
    expect(await channel.closed).toBe(failure);
    expect(channel.open).toBe(false);
  });

  it("keeps sending to a peer that hung up without throwing", async () => {
    const { client, server } = await socketPair();
    const channel = new Channel(socketTransport(server));
    client.end();
    for (let index = 0; index < 50 && channel.open; index += 1) {
      channel.notify("line", { line: "x".repeat(65_536) });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    client.destroy();
    const reason = await channel.closed;
    expect(channel.open).toBe(false);
    if (reason !== undefined) {
      expect(reason).toHaveProperty("code");
    }
  });

  it("closes with no reason when the peer hangs up cleanly", async () => {
    const { client, server } = await socketPair();
    const channel = new Channel(socketTransport(server));
    client.end();
    expect(await channel.closed).toBeUndefined();
    expect(channel.open).toBe(false);
    await expect(channel.request("hello")).rejects.toThrow(
      "the connection closed"
    );
  });

  it("closes with no reason when this side hangs up on purpose", async () => {
    const { server } = await socketPair();
    const channel = new Channel(socketTransport(server));
    const pending = channel.request("hello");
    channel.close();
    await expect(pending).rejects.toThrow("the connection closed");
    expect(await channel.closed).toBeUndefined();
  });
});

function memoryTransport(): Transport & {
  readonly sent: Message[];
  deliver(message: Message): void;
} {
  let onMessage: (message: Message) => void = () => undefined;
  const sent: Message[] = [];
  return {
    close() {
      onMessage = () => undefined;
    },
    deliver(message) {
      onMessage(message);
    },
    onClose: () => undefined,
    onMessage(handler) {
      onMessage = handler;
    },
    send(message) {
      encode(message);
      sent.push(message);
    },
    sent,
  };
}

describe("the channel", () => {
  it("answers with an error a request whose result cannot be encoded", async () => {
    const transport = memoryTransport();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const channel = new Channel(transport, {
        request: () => Promise.resolve({ big: 1n }),
      });
      expect(channel.open).toBe(true);
      transport.deliver({ id: 7, method: "describe" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]).toMatchObject({
        error: {
          message: expect.stringContaining("the reply could not be encoded"),
        },
        id: 7,
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("the socket transport's line limit", () => {
  it("disconnects a peer that sends a line over the limit", async () => {
    const { client, server } = await socketPair();
    const seen: string[] = [];
    const channel = new Channel(socketTransport(server), {
      notification: (method) => seen.push(method),
    });
    client.write(`${JSON.stringify({ method: "first" })}\n`);
    client.write("x".repeat(MAX_LINE_BYTES / 2));
    client.write("x".repeat(MAX_LINE_BYTES / 2 + 1));
    const reason = await channel.closed;
    expect(reason?.message).toContain(String(MAX_LINE_BYTES));
    expect(channel.open).toBe(false);
    expect(seen).toEqual(["first"]);
  });

  it("keeps a peer whose line is exactly at the limit, split across chunks", async () => {
    const { client, server } = await socketPair();
    const seen: unknown[] = [];
    const channel = new Channel(socketTransport(server), {
      notification: (_method, params) => seen.push(params),
    });
    const filler = "é".repeat(
      (MAX_LINE_BYTES - JSON.stringify({ method: "big", params: "" }).length) /
        2
    );
    const line = JSON.stringify({ method: "big", params: filler });
    expect(Buffer.byteLength(line)).toBe(MAX_LINE_BYTES);
    const bytes = Buffer.from(`${line}\n`);
    client.write(bytes.subarray(0, 1001));
    client.write(bytes.subarray(1001));
    await vi.waitFor(() => expect(seen).toEqual([filler]));
    expect(channel.open).toBe(true);
  });
});
