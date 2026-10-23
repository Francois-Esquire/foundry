import type { Socket } from "node:net";

import type { Message } from "~/process/protocol";
import {
  decode,
  encode,
  isRequest,
  isResponse,
  lineSplitter,
  RemoteError,
  wireError,
} from "~/process/protocol";

/**
 * Requests and notifications over one connection, a Unix socket carrying
 * newline-delimited JSON. The channel matches responses to the requests it
 * sent and hands incoming requests to the handler it was given; both sides
 * can ask and both can tell. Clients and workers use it alike.
 */

export interface Transport {
  close(): void;
  onClose(handler: () => void): void;
  onMessage(handler: (message: Message) => void): void;
  send(message: Message): void;
}

export interface ChannelHandlers {
  readonly notification?: (method: string, params: unknown) => void;
  /** Answers a request from the other side; a rejection becomes its error. */
  readonly request?: (method: string, params: unknown) => Promise<unknown>;
}

export class Channel {
  readonly closed: Promise<void>;
  readonly #transport: Transport;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #next = 0;
  /** Set once the transport closes; a flag the type system cannot narrow. */
  readonly #state: { closed: boolean } = { closed: false };

  constructor(transport: Transport, handlers: ChannelHandlers = {}) {
    this.#transport = transport;
    this.closed = new Promise((resolve) => {
      transport.onClose(() => {
        this.#state.closed = true;
        const error = new Error("the connection closed");
        for (const { reject } of this.#pending.values()) {
          reject(error);
        }
        this.#pending.clear();
        resolve();
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
    const respond = (outcome: Promise<unknown>) =>
      outcome.then(
        (result) => {
          this.#send(result === undefined ? { id } : { id, result });
        },
        (error: unknown) => {
          this.#send({ error: wireError(error), id });
        }
      );
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

  #send(message: Message): void {
    if (this.#state.closed) {
      return;
    }
    this.#transport.send(message);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#state.closed) {
      return Promise.reject(new Error("the connection closed"));
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

/** A socket carrying newline-delimited JSON. */
export function socketTransport(socket: Socket): Transport {
  socket.setEncoding("utf8");
  return {
    close() {
      socket.end();
      socket.destroy();
    },
    onClose(handler) {
      socket.once("close", handler);
    },
    onMessage(handler) {
      const split = lineSplitter((line) => {
        const message = decode(line);
        if (message) {
          handler(message);
        }
      });
      socket.on("data", (chunk: string) => split(chunk));
    },
    send(message) {
      if (!socket.destroyed) {
        socket.write(encode(message));
      }
    },
  };
}
