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

/**
 * A non-reconnecting v1 client for the Program side of the host-opened socket.
 * A socket failure rejects every pending call and stream read; ending a stream
 * early (iterator \`return()\` or its signal) sends \`cancel\` and forgets it, so
 * frames the host sent before it saw the cancel are ignored. Reconnecting is a
 * new socket and a new transport.
 */
export function createWebSocketGatewayTransport(socket: GatewaySocket): GatewayTransport {
  const maximumFrameBytes = 1024 * 1024;
  const pending = new Map<string, Call>();
  let nextId = 0;
  let bound = false;
  let failure: Error | undefined;
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A socket may fail before anything waits for the handshake.
  readyPromise.catch(() => undefined);
  const failAll = (error: Error): void => {
    failure ??= error;
    rejectReady(error);
    for (const call of [...pending.values()]) call.fail(error, false);
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
        if (bound || frame.protocol !== 1 || (frame.mode !== "development" && frame.mode !== "runtime")) {
          throw new GatewayFailure("incompatible-protocol", "Gateway hello is invalid");
        }
        bound = true;
        send(socket, { kind: "ready", protocol: 1, mode: frame.mode });
        resolveReady();
        return;
      }
      if (!bound) {
        throw new GatewayFailure("invalid-frame", "Gateway hello is missing");
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
      // A call that already ended was forgotten: its late frames fall here.
      const call = pending.get(frame.id);
      if (call === undefined) return;
      if (frame.kind === "result") {
        call.result(frame.output);
      } else if (frame.kind === "next") {
        call.push(frame.event);
      } else if (frame.kind === "complete") {
        call.complete();
      } else if (frame.kind === "failure") {
        call.fail(new GatewayFailure(typeof frame.code === "string" ? frame.code : "provider-failure", "Gateway request failed"), false);
      }
    } catch (error) {
      failAll(asError(error, "Gateway frame failed"));
      socket.close(1002, "Gateway protocol error");
    }
  });
  const start = (alias: string, input: unknown, mode: "unary" | "stream", signal?: AbortSignal): Call => {
    const id = "request-" + String(++nextId);
    let sent = false;
    const abort = (): void => call.fail(abortFailure(signal), true);
    const call = new Call((cancel) => {
      pending.delete(id);
      signal?.removeEventListener("abort", abort);
      if (cancel && sent && socket.readyState === 1) {
        try {
          send(socket, { kind: "cancel", id });
        } catch {
          // The socket is closing; the host ends the request with it.
        }
      }
    });
    if (failure !== undefined) {
      call.fail(failure, false);
      return call;
    }
    if (signal?.aborted) {
      call.fail(abortFailure(signal), false);
      return call;
    }
    pending.set(id, call);
    signal?.addEventListener("abort", abort, { once: true });
    readyPromise.then(
      () => {
        if (call.settled) return;
        try {
          send(socket, { kind: "invoke", id, alias, input, mode });
          sent = true;
        } catch (error) {
          call.fail(asError(error, "Gateway request failed"), false);
        }
      },
      (error: unknown) => call.fail(asError(error, "Gateway socket failed"), false)
    );
    return call;
  };
  return Object.freeze({
    invoke(alias: string, input: unknown, options?: { signal?: AbortSignal }) {
      return start(alias, input, "unary", options?.signal).unary;
    },
    stream(alias: string, input: unknown, options?: { signal?: AbortSignal }): AsyncIterable<unknown> {
      return start(alias, input, "stream", options?.signal);
    },
  });
}

/** One request: a unary result or a stream of events. It is released once, when it settles or is returned. */
class Call implements AsyncIterableIterator<unknown> {
  readonly unary: Promise<unknown>;
  #resolveUnary: (value: unknown) => void = () => undefined;
  #rejectUnary: (error: Error) => void = () => undefined;
  #values: unknown[] = [];
  #waiting: { resolve(result: IteratorResult<unknown>): void; reject(error: Error): void }[] = [];
  #failure: Error | undefined;
  #ended = false;
  #release: ((cancel: boolean) => void) | undefined;
  constructor(release: (cancel: boolean) => void) {
    this.#release = release;
    this.unary = new Promise<unknown>((resolve, reject) => {
      this.#resolveUnary = resolve;
      this.#rejectUnary = reject;
    });
    // A stream never reads its unary result.
    this.unary.catch(() => undefined);
  }
  get settled(): boolean {
    return this.#release === undefined;
  }
  [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
    return this;
  }
  next(): Promise<IteratorResult<unknown>> {
    if (this.#values.length > 0) return Promise.resolve({ done: false, value: this.#values.shift() });
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.#waiting.push({ resolve, reject });
    });
  }
  /** Ends the stream early: the host is told to cancel it and its state is dropped. */
  return(): Promise<IteratorResult<unknown>> {
    this.#values = [];
    this.#failure = undefined;
    this.#end(true);
    for (const waiter of this.#waiting.splice(0)) waiter.resolve({ done: true, value: undefined });
    return Promise.resolve({ done: true, value: undefined });
  }
  result(value: unknown): void {
    this.#resolveUnary(value);
    this.complete();
  }
  push(value: unknown): void {
    if (this.#ended) return;
    const waiter = this.#waiting.shift();
    if (waiter !== undefined) waiter.resolve({ done: false, value });
    else this.#values.push(value);
  }
  complete(): void {
    if (this.#ended) return;
    this.#end(false);
    for (const waiter of this.#waiting.splice(0)) waiter.resolve({ done: true, value: undefined });
  }
  fail(error: Error, cancel: boolean): void {
    if (this.#ended) return;
    this.#failure = error;
    this.#rejectUnary(error);
    this.#end(cancel);
    for (const waiter of this.#waiting.splice(0)) waiter.reject(error);
  }
  #end(cancel: boolean): void {
    this.#ended = true;
    const release = this.#release;
    this.#release = undefined;
    release?.(cancel);
  }
}

/** The server side of a socket, such as Bun's \`ServerWebSocket\`: the host connects to the Program. */
export interface ProgramSocket {
  readonly readyState: number;
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

/** The Program's end of the host Gateway connection. */
export interface ProgramGateway {
  /** A client over the host's current connection; undefined until the host connects. */
  readonly client: GatewayClient | undefined;
  /** Handlers for the \`/_foundry/module-gateway\` upgrade, as \`Bun.serve({ websocket })\` takes them. */
  readonly websocket: {
    open(socket: ProgramSocket): void;
    message(socket: ProgramSocket, message: unknown): void;
    close(socket: ProgramSocket): void;
  };
}

export function createProgramGateway(): ProgramGateway {
  const connections = new Map<ProgramSocket, { client: GatewayClient; emit(type: "message" | "close", event: unknown): void }>();
  let current: GatewayClient | undefined;
  return {
    get client() {
      return current;
    },
    websocket: {
      open(socket: ProgramSocket) {
        const listeners: Record<"message" | "close" | "error", ((event: unknown) => void)[]> = { message: [], close: [], error: [] };
        const client = createGatewayClient(
          createWebSocketGatewayTransport({
            get readyState() {
              return socket.readyState;
            },
            send: (data) => {
              socket.send(data);
            },
            close: (code, reason) => socket.close(code, reason),
            addEventListener: (type, listener) => {
              listeners[type].push(listener);
            },
          })
        );
        connections.set(socket, {
          client,
          emit: (type, event) => {
            for (const listener of listeners[type]) listener(event);
          },
        });
        current = client;
      },
      message(socket: ProgramSocket, message: unknown) {
        connections.get(socket)?.emit("message", { data: message });
      },
      close(socket: ProgramSocket) {
        const connection = connections.get(socket);
        connections.delete(socket);
        if (connection !== undefined && current === connection.client) current = undefined;
        connection?.emit("close", {});
      },
    },
  };
}

/** What the host shares as \`works.system.theme\`: the selected mode and the appearance in effect. */
export interface ModuleTheme {
  readonly mode: "auto" | "light" | "dark";
  readonly effective: "light" | "dark";
  readonly revision: number;
}

/** The same-origin route a composed Program relays the theme on, beside \`/_module/graphql\`. */
export const MODULE_THEME_PATH = "/_module/theme";
/** The Manifest alias the relay reads: \`{ "alias": "theme", "capability": "works.system.theme", "version": 1 }\`. */
export const MODULE_THEME_ALIAS = "theme";

export function isModuleTheme(value: unknown): value is ModuleTheme {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    (value.mode === "auto" || value.mode === "light" || value.mode === "dark") &&
    (value.effective === "light" || value.effective === "dark") &&
    typeof value.revision === "number" &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0
  );
}

/**
 * Relays the host theme to the Program's own View as server-sent events, one
 * validated snapshot per event. It answers 200 only once the host has sent an
 * authorized snapshot; any other status means the theme is unavailable. A View
 * that reads slower than the host changes gets the newest snapshot, never a
 * backlog. Disconnecting the View cancels the Gateway stream.
 */
export async function relayModuleTheme(gateway: { readonly client: GatewayClient | undefined }, request: Request, alias: string = MODULE_THEME_ALIAS): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { allow: "GET" } });
  const client = gateway.client;
  if (client === undefined) return new Response(null, { status: 503 });
  const controller = new AbortController();
  const stop = (): void => {
    request.signal.removeEventListener("abort", stop);
    controller.abort();
  };
  request.signal.addEventListener("abort", stop, { once: true });
  const events = client.observe(alias, {}, { signal: controller.signal })[Symbol.asyncIterator]();
  let latest: ModuleTheme | undefined;
  try {
    const first = await events.next();
    if (first.done === true || !isModuleTheme(first.value)) {
      throw new GatewayFailure("invalid-output", "Gateway theme is invalid");
    }
    latest = first.value;
  } catch (error) {
    stop();
    return new Response(null, { status: relayStatus(error) });
  }
  let ended = false;
  let wake: (() => void) | undefined;
  const settle = (): void => {
    ended = true;
    stop();
    wake?.();
  };
  void (async () => {
    try {
      for (;;) {
        const next = await events.next();
        if (next.done === true || !isModuleTheme(next.value)) break;
        latest = next.value;
        wake?.();
      }
    } catch {
      // Revoked, cancelled or disconnected: the response ends below.
    }
    settle();
  })();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(stream) {
        while (latest === undefined && !ended) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
        if (latest !== undefined) {
          stream.enqueue(encoder.encode("data: " + JSON.stringify(latest) + "\\n\\n"));
          latest = undefined;
          return;
        }
        try {
          stream.close();
        } catch {
          // The View already went away.
        }
      },
      cancel() {
        settle();
      },
    },
    { highWaterMark: 0 }
  );
  return new Response(body, { headers: { "cache-control": "no-store", "content-type": "text/event-stream" } });
}

function relayStatus(error: unknown): number {
  const code = error instanceof GatewayFailure ? error.code : "";
  if (code === "unauthorized") return 403;
  if (code === "unknown-alias" || code === "unknown-capability") return 404;
  if (code === "transport-closed") return 503;
  return 502;
}

export interface WatchModuleThemeOptions {
  readonly signal?: AbortSignal;
  /** The relay; the composer's same-origin route by default. */
  readonly url?: string;
  /** The first wait before reconnecting after the theme becomes unavailable; it doubles up to 30 s. */
  readonly retryMs?: number;
}

/**
 * Follows the host theme in a Module View through \`fetch\` and a streaming
 * reader. \`onTheme(null)\` means unavailable (not approved, revoked,
 * disconnected or an older Program without the relay): clear explicit mode
 * state and let CSS \`prefers-color-scheme\` decide until a fresh snapshot
 * arrives. Reconnects with backoff, and resolves once \`signal\` aborts.
 */
export async function watchModuleTheme(onTheme: (theme: ModuleTheme | null) => void, options: WatchModuleThemeOptions = {}): Promise<void> {
  const { signal } = options;
  const firstDelay = options.retryMs ?? 1000;
  let delay = firstDelay;
  let reported: ModuleTheme | null | undefined;
  const report = (theme: ModuleTheme | null): void => {
    if (theme === null && reported === null) return;
    reported = theme;
    onTheme(theme);
  };
  while (!aborted(signal)) {
    await readModuleTheme(options.url ?? MODULE_THEME_PATH, signal, (theme) => {
      delay = firstDelay;
      report(theme);
    });
    // Read again: the read above may have ended because the signal aborted.
    if (aborted(signal)) return;
    report(null);
    await sleep(delay, signal);
    delay = Math.min(delay * 2, 30_000);
  }
}

/** Reads one relay response until it ends, fails or carries an invalid event. */
async function readModuleTheme(url: string, signal: AbortSignal | undefined, onTheme: (theme: ModuleTheme) => void): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", headers: { accept: "text/event-stream" }, signal });
  } catch {
    return;
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  const reader = response.body.getReader();
  // Stopping releases the reader even where an aborted fetch leaves its body open.
  const release = (): void => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", release, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let revision = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\\n\\n");
      while (boundary !== -1) {
        const theme = themeEvent(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (theme === null) return;
        if (theme.revision > revision) {
          revision = theme.revision;
          onTheme(theme);
        }
        boundary = buffer.indexOf("\\n\\n");
      }
      if (buffer.length > 65_536) return;
    }
  } catch {
    return;
  } finally {
    signal?.removeEventListener("abort", release);
    // Releases the connection; the relay then cancels its Gateway stream.
    await reader.cancel().catch(() => undefined);
  }
}

function themeEvent(event: string): ModuleTheme | null {
  const data = event
    .split("\\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\\n");
  try {
    const value: unknown = JSON.parse(data);
    return isModuleTheme(value) ? value : null;
  } catch {
    return null;
  }
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sleep(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done, { once: true });
  });
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
function asError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new GatewayFailure("invalid-frame", message);
}
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function abortFailure(signal: AbortSignal | undefined): GatewayFailure {
  return new GatewayFailure("cancelled", signal?.reason instanceof Error ? signal.reason.message : "Gateway request was cancelled");
}
`;
