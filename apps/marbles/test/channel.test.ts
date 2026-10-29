import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Channel, socketTransport } from "~/process/channel";

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.splice(0)) {
    step();
  }
});

/** Both ends of one Unix socket connection. */
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
    // What a write after the other side hung up raises; unheard, it throws.
    const failure = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(() => server.emit("error", failure)).not.toThrow();
    client.destroy();
    // The request learns why, not just that the connection went.
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
    // A hang-up the kernel reports as end-of-stream is a clean close; a
    // write that fails first is a reason. Either way nothing throws.
    const reason = await channel.closed;
    expect(channel.open).toBe(false);
    if (reason !== undefined) {
      expect(reason).toHaveProperty("code");
    }
  });

  it("closes with no reason when a side hangs up on purpose", async () => {
    const { client, server } = await socketPair();
    const channel = new Channel(socketTransport(server));
    const pending = channel.request("hello");
    client.end();
    client.destroy();
    await expect(pending).rejects.toThrow("the connection closed");
    expect(await channel.closed).toBeUndefined();
  });
});
