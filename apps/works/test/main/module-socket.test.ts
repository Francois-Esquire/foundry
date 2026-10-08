import { afterEach, expect, it, vi } from "vitest";
import { connectModuleSocket } from "~/main/modules/runtime/websocket";

class Socket extends EventTarget {
  static readonly OPEN = 1;
  static current: Socket;
  readyState = 0;
  bufferedAmount = 0;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  });
  constructor(url: string | URL) {
    super();
    Socket.current = this;
    if (!new URL(url).searchParams.has("stall")) {
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("transports JSON frames and closes pending reads", async () => {
  vi.stubGlobal("WebSocket", Socket);
  const transport = await connectModuleSocket({
    url: new URL("ws://127.0.0.1:3000"),
  });
  Socket.current.message('{"kind":"ready"}');
  const read = await transport.incoming[Symbol.asyncIterator]().next();
  expect(read.value).toEqual({ kind: "ready" });
  await transport.send({ kind: "hello" });
  expect(Socket.current.send).toHaveBeenCalledWith('{"kind":"hello"}');
  await transport.close("test");
  await transport.closed;
  expect(Socket.current.close).toHaveBeenCalled();
});

it("rejects an aborted connection before it opens", async () => {
  vi.stubGlobal("WebSocket", Socket);
  const controller = new AbortController();
  const connection = connectModuleSocket({
    signal: controller.signal,
    url: new URL("ws://127.0.0.1:3000/?stall"),
  });
  controller.abort();
  await expect(connection).rejects.toThrow();
  expect(Socket.current.close).toHaveBeenCalled();
});

it("closes on malformed JSON and overloaded queues instead of dropping frames", async () => {
  vi.stubGlobal("WebSocket", Socket);
  const malformed = await connectModuleSocket({
    url: new URL("ws://127.0.0.1:3000"),
  });
  Socket.current.message("invalid");
  expect(Socket.current.close).toHaveBeenCalledWith(1007);
  await malformed.close("test");
  const overloaded = await connectModuleSocket({
    url: new URL("ws://127.0.0.1:3000"),
  });
  for (let index = 0; index < 33; index += 1) {
    Socket.current.message('{"kind":"ready"}');
  }
  expect(Socket.current.close).toHaveBeenCalledWith(1009);
  await overloaded.close("test");
});
