import type { FontBuilder } from "~/packaging/building";
import type { EngineWorker } from "~/packaging/engine/client";
import type { FromEngine, ToEngine } from "~/packaging/engine/protocol";
import { serveEngine } from "~/packaging/engine/serve";

type Listener = (event: never) => void;

/**
 * A worker in the same thread: the engine server on one end of a message
 * channel and the client on the other. Messages are really cloned and
 * transferred, as they are between a page and a worker.
 */
export const channelWorker = (
  start: () => Promise<FontBuilder>
): EngineWorker => {
  const { port1, port2 } = new MessageChannel();
  serveEngine(port2, start);
  port2.start();
  port1.start();
  return {
    addEventListener(type: string, listener: Listener) {
      if (type === "message") {
        port1.addEventListener(
          "message",
          listener as (event: MessageEvent) => void
        );
      }
    },
    postMessage: (message) => port1.postMessage(message),
    terminate: () => {
      port1.close();
      port2.close();
    },
  };
};

/** A worker the test drives by hand. */
export class ScriptedWorker implements EngineWorker {
  readonly posted: ToEngine[] = [];
  terminated = false;
  readonly #listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  postMessage(message: ToEngine) {
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  say(message: FromEngine) {
    this.#emit("message", { data: message });
  }

  crash(message: string) {
    this.#emit("error", { message });
  }

  #emit(type: string, event: unknown) {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event as never);
    }
  }
}
