import type { ModuleTransport } from "@foundry/modules/gateway/types";
import { AsyncIteratorClass, EventPublisher } from "@orpc/server";

/** Bounded JSON transport; the shared Gateway owns protocol validation. */
export async function connectModuleSocket(input: {
  url: URL;
  signal?: AbortSignal;
}): Promise<ModuleTransport> {
  const controller = new AbortController();
  const publisher = new EventPublisher<{
    frame: { value: unknown; bytes: number };
  }>({
    maxBufferedEvents: 32,
  });
  const frames = publisher.subscribe("frame", { signal: controller.signal });
  let queuedBytes = 0;
  let queuedFrames = 0;
  const incoming = new AsyncIteratorClass<unknown>(
    async () => {
      const next = await frames.next();
      if (next.done) {
        return { done: true, value: undefined };
      }
      queuedBytes -= next.value.bytes;
      queuedFrames -= 1;
      return { done: false, value: next.value.value };
    },
    () => frames.return().then(() => undefined)
  );
  const socket = new WebSocket(input.url);
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  socket.addEventListener(
    "close",
    () => {
      controller.abort();
      resolveClosed();
    },
    { once: true }
  );
  socket.addEventListener(
    "error",
    () => {
      socket.close();
      controller.abort();
      resolveClosed();
    },
    { once: true }
  );
  socket.addEventListener("message", (event) => {
    if (controller.signal.aborted) {
      return;
    }
    if (
      typeof event.data !== "string" ||
      Buffer.byteLength(event.data) > 1024 * 1024
    ) {
      socket.close(1009);
      return;
    }
    try {
      const bytes = Buffer.byteLength(event.data);
      if (queuedFrames >= 32 || queuedBytes + bytes > 4 * 1024 * 1024) {
        controller.abort();
        socket.close(1009);
        return;
      }
      queuedBytes += bytes;
      queuedFrames += 1;
      publisher.publish("frame", { bytes, value: JSON.parse(event.data) });
    } catch {
      socket.close(1007);
    }
  });
  const signal = AbortSignal.any([
    AbortSignal.timeout(10_000),
    ...(input.signal ? [input.signal] : []),
  ]);
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error("Module Gateway connection failed"));
      };
      const cleanup = () => {
        signal.removeEventListener("abort", abort);
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
      };
      socket.addEventListener("open", opened, { once: true });
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("close", failed, { once: true });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
    });
  } catch (error) {
    socket.close();
    controller.abort();
    await incoming.return();
    throw error;
  }
  return {
    async close() {
      socket.close(1000);
      controller.abort();
      await incoming.return();
      await Promise.race([
        closed,
        new Promise<void>((resolve) => setTimeout(resolve, 1000)),
      ]);
    },
    closed,
    incoming,
    async send(frame) {
      const encoded = JSON.stringify(frame);
      if (
        socket.readyState !== WebSocket.OPEN ||
        encoded === undefined ||
        Buffer.byteLength(encoded) > 1024 * 1024 ||
        socket.bufferedAmount + Buffer.byteLength(encoded) > 4 * 1024 * 1024
      ) {
        throw new Error(
          "Module Gateway transport unavailable or over capacity"
        );
      }
      socket.send(encoded);
    },
  };
}
