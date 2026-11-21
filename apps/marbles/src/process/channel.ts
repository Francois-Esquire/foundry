import type { Socket } from "node:net";

import type { Message } from "~/process/protocol";
import {
  decode,
  encode,
  isRequest,
  isResponse,
  lineSplitter,
  MAX_LINE_BYTES,
  RemoteError,
  wireError,
} from "~/process/protocol";

export interface Transport {
  close(): void;
  onClose(handler: (reason?: Error) => void): void;
  onMessage(handler: (message: Message) => void): void;
  send(message: Message): void;
}

export interface ChannelHandlers {
  readonly notification?: (method: string, params: unknown) => void;
  readonly request?: (method: string, params: unknown) => Promise<unknown>;
}

class ConnectionClosedError extends Error {
  override readonly name = "ConnectionClosedError";

  constructor(reason?: Error) {
    super(
      reason === undefined
        ? "the connection closed"
        : `the connection failed: ${reason.message}`,
      reason === undefined ? undefined : { cause: reason }
    );
  }
}

export class Channel {
  readonly closed: Promise<Error | undefined>;
  readonly #transport: Transport;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #next = 0;
  readonly #state: { closed: boolean } = { closed: false };

  constructor(transport: Transport, handlers: ChannelHandlers = {}) {
    this.#transport = transport;
    this.closed = new Promise((resolve) => {
      transport.onClose((reason) => {
        this.#state.closed = true;
        const error = new ConnectionClosedError(reason);
        for (const { reject } of this.#pending.values()) {
          reject(error);
        }
        this.#pending.clear();
        resolve(reason);
      });
    });
    transport.onMessage((message) => {
      if (isResponse(message)) {
        const waiting = this.#pending.get(message.id);
        if (!waiting) {
          return;
        }
        this.#pending.delete(message.id);
        if (message.error) {
          waiting.reject(new RemoteError(message.error));
        } else {
          waiting.resolve(message.result);
        }
        return;
      }
      if (isRequest(message)) {
        this.#answer(message.id, message.method, message.params, handlers);
        return;
      }
      handlers.notification?.(message.method, message.params);
    });
  }

  get open(): boolean {
    return !this.#state.closed;
  }

  #answer(
    id: number,
    method: string,
    params: unknown,
    handlers: ChannelHandlers
  ): void {
    const respond = (outcome: Promise<unknown>) => {
      outcome
        .then(
          (result) => {
            this.#reply(id, result === undefined ? { id } : { id, result });
          },
          (error: unknown) => {
            this.#reply(id, { error: wireError(error), id });
          }
        )
        .catch(() => undefined);
    };
    if (!handlers.request) {
      respond(Promise.reject(new Error(`no handler for "${method}"`)));
      return;
    }
    let reply: Promise<unknown>;
    try {
      reply = handlers.request(method, params);
    } catch (error) {
      reply = Promise.reject(error);
    }
    respond(reply);
  }

  #reply(id: number, message: Message): void {
    try {
      this.#send(message);
    } catch (error) {
      this.#send({
        error: {
          message: `the reply could not be encoded: ${wireError(error).message}`,
        },
        id,
      });
    }
  }

  #send(message: Message): void {
    if (this.#state.closed) {
      return;
    }
    this.#transport.send(message);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#state.closed) {
      return Promise.reject(new ConnectionClosedError());
    }
    const id = this.#next;
    this.#next += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      this.#transport.send(
        params === undefined ? { id, method } : { id, method, params }
      );
    });
  }

  notify(method: string, params?: unknown): void {
    this.#send(params === undefined ? { method } : { method, params });
  }

  close(): void {
    this.#transport.close();
  }
}

export function socketTransport(socket: Socket): Transport {
  socket.setEncoding("utf8");
  let failure: Error | undefined;
  socket.on("error", (error: Error) => {
    failure ??= error;
  });
  return {
    close() {
      socket.end();
      socket.destroy();
    },
    onClose(handler) {
      socket.once("close", () => handler(failure));
    },
    onMessage(handler) {
      const split = lineSplitter(
        (line) => {
          const message = decode(line);
          if (message) {
            handler(message);
          }
        },
        () => {
          failure ??= new Error(
            `the peer sent a line over ${String(MAX_LINE_BYTES)} bytes`
          );
          socket.destroy();
        }
      );
      socket.on("data", (chunk: string) => split(chunk));
    },
    send(message) {
      if (!socket.destroyed) {
        socket.write(encode(message));
      }
    },
  };
}
