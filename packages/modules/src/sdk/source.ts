/**
 * The one authored entrypoint of the local SDK package. The pack builder emits
 * its readable TypeScript source, ESM, and declarations from this exact text.
 */
export const MODULE_SDK_ENTRYPOINT = `export interface GatewayTransport {
  invoke(alias: string, input: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  stream(alias: string, input: unknown, options?: { signal?: AbortSignal }): AsyncIterable<unknown>;
}

export interface GatewayClient {
  call(alias: string, input: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  observe(alias: string, input: unknown, options?: { signal?: AbortSignal }): AsyncIterable<unknown>;
}

export interface GatewaySocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", listener: (event: unknown) => void): void;
}

export class GatewayFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GatewayFailure";
  }
}

export function createGatewayClient(transport: GatewayTransport): GatewayClient {
  return Object.freeze({
    call: (alias: string, input: unknown, options?: { signal?: AbortSignal }) => transport.invoke(alias, input, options),
    observe: (alias: string, input: unknown, options?: { signal?: AbortSignal }) => transport.stream(alias, input, options),
  });
}

/** A non-reconnecting v1 client for the Program side of the host-opened socket. */
export function createWebSocketGatewayTransport(socket: GatewaySocket): GatewayTransport {
  const maximumFrameBytes = 1024 * 1024;
  const pending = new Map<string, Pending>();
  let nextId = 0;
  let ready: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const readyPromise = new Promise<void>((resolve, reject) => {
    ready = resolve;
    rejectReady = reject;
  });
  const failAll = (error: Error): void => {
    rejectReady?.(error);
    for (const entry of pending.values()) entry.fail(error);
    pending.clear();
  };
  socket.addEventListener("close", () => failAll(new GatewayFailure("transport-closed", "Gateway socket closed")));
  socket.addEventListener("error", () => failAll(new GatewayFailure("transport-closed", "Gateway socket failed")));
  socket.addEventListener("message", (event) => {
    try {
      const data = messageData(event);
      if (typeof data !== "string" || byteLength(data) > maximumFrameBytes) {
        throw new GatewayFailure("invalid-frame", "Gateway received an invalid frame");
      }
      const frame: unknown = JSON.parse(data);
      if (!isRecord(frame) || typeof frame.kind !== "string") {
        throw new GatewayFailure("invalid-frame", "Gateway received an invalid frame");
      }
      if (frame.kind === "hello") {
        if (frame.protocol !== 1 || (frame.mode !== "development" && frame.mode !== "runtime")) {
          throw new GatewayFailure("incompatible-protocol", "Gateway protocol is incompatible");
        }
        send(socket, { kind: "ready", protocol: 1, mode: frame.mode });
        ready?.();
        return;
      }
      if (frame.kind === "shutdown") {
        failAll(new GatewayFailure("transport-closed", "Gateway session shut down"));
        return;
      }
      if (frame.kind === "heartbeat") {
        send(socket, { kind: "heartbeat", sequence: frame.sequence });
        return;
      }
      if (typeof frame.id !== "string") return;
      const entry = pending.get(frame.id);
      if (entry === undefined) return;
      if (frame.kind === "result") {
        entry.result(frame.output);
        pending.delete(frame.id);
      } else if (frame.kind === "next") {
        entry.next(frame.event);
      } else if (frame.kind === "complete") {
        entry.complete();
        pending.delete(frame.id);
      } else if (frame.kind === "failure") {
        entry.fail(new GatewayFailure(typeof frame.code === "string" ? frame.code : "provider-failure", "Gateway request failed"));
        pending.delete(frame.id);
      }
    } catch (error) {
      failAll(error instanceof Error ? error : new GatewayFailure("invalid-frame", "Gateway frame failed"));
      socket.close(1002, "Gateway protocol error");
    }
  });
  const begin = async (alias: string, input: unknown, mode: "unary" | "stream", signal?: AbortSignal): Promise<{ id: string; entry: Pending }> => {
    if (signal?.aborted) throw abortFailure(signal);
    await readyPromise;
    const id = "request-" + String(++nextId);
    const entry = new Pending();
    pending.set(id, entry);
    const cancelled = (): void => {
      if (!pending.delete(id)) return;
      entry.fail(abortFailure(signal));
      send(socket, { kind: "cancel", id });
    };
    signal?.addEventListener("abort", cancelled, { once: true });
    try {
      send(socket, { kind: "invoke", id, alias, input, mode });
    } catch (error) {
      pending.delete(id);
      entry.fail(error instanceof Error ? error : new GatewayFailure("invalid-frame", "Gateway request failed"));
    }
    return { id, entry };
  };
  return Object.freeze({
    async invoke(alias: string, input: unknown, options?: { signal?: AbortSignal }) {
      const started = await begin(alias, input, "unary", options?.signal);
      return started.entry.unary;
    },
    stream(alias: string, input: unknown, options?: { signal?: AbortSignal }) {
      const queue = new AsyncQueue();
      void begin(alias, input, "stream", options?.signal)
        .then(({ entry }) => entry.attach(queue))
        .catch((error) => queue.fail(error));
      return queue;
    },
  });
}

class Pending {
  #resolve: ((value: unknown) => void) | undefined;
  #reject: ((error: Error) => void) | undefined;
  #queue: AsyncQueue | undefined;
  readonly unary = new Promise<unknown>((resolve, reject) => {
    this.#resolve = resolve;
    this.#reject = reject;
  });
  attach(queue: AsyncQueue): void {
    this.#queue = queue;
  }
  result(value: unknown): void { this.#resolve?.(value); }
  next(value: unknown): void { this.#queue?.push(value); }
  complete(): void { this.#queue?.end(); }
  fail(error: Error): void {
    this.#reject?.(error);
    this.#queue?.fail(error);
  }
}

class AsyncQueue implements AsyncIterableIterator<unknown> {
  #values: unknown[] = [];
  #waiting: ((result: IteratorResult<unknown>) => void) | undefined;
  #failure: Error | undefined;
  #ended = false;
  [Symbol.asyncIterator](): AsyncIterableIterator<unknown> { return this; }
  next(): Promise<IteratorResult<unknown>> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => { this.#waiting = resolve; });
  }
  return(): Promise<IteratorResult<unknown>> { this.end(); return Promise.resolve({ done: true, value: undefined }); }
  push(value: unknown): void {
    if (this.#ended) return;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    if (waiting !== undefined) waiting({ done: false, value });
    else this.#values.push(value);
  }
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    const waiting = this.#waiting;
    this.#waiting = undefined;
    waiting?.({ done: true, value: undefined });
  }
  fail(error: unknown): void {
    if (this.#ended) return;
    this.#failure = error instanceof Error ? error : new Error(String(error));
    this.#ended = true;
  }
}

function send(socket: GatewaySocket, frame: object): void {
  const encoded = JSON.stringify(frame);
  if (typeof encoded !== "string" || byteLength(encoded) > 1024 * 1024) {
    throw new GatewayFailure("invalid-frame", "Gateway frame exceeds the v1 limit");
  }
  if (socket.readyState !== 1) throw new GatewayFailure("transport-closed", "Gateway socket is closed");
  socket.send(encoded);
}
function messageData(event: unknown): unknown {
  return typeof event === "object" && event !== null && "data" in event
    ? (event as { readonly data: unknown }).data
    : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function abortFailure(signal: AbortSignal | undefined): GatewayFailure {
  return new GatewayFailure("cancelled", signal?.reason instanceof Error ? signal.reason.message : "Gateway request was cancelled");
}
`;
