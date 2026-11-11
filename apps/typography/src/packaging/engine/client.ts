/**
 * The font builder the app uses in the browser. It owns the engine worker:
 * starts it on first use, tells subscribers how the engine is doing, and
 * turns every engine failure into a BuildError.
 */

import { reasonOf } from "~/lib/reason";
import { BuildError, type FontBuilder } from "../building";
import type {
  EngineCall,
  EngineMethod,
  EngineResult,
  FromEngine,
  ToEngine,
} from "./protocol";

export type EngineStatus = "idle" | "starting" | "ready" | "failed";

/** What the client needs from a worker. */
export interface EngineWorker {
  addEventListener(
    type: "message",
    listener: (event: { readonly data: FromEngine }) => void
  ): void;
  addEventListener(
    type: "error",
    listener: (event: { readonly message?: string }) => void
  ): void;
  postMessage(message: ToEngine): void;
  terminate(): void;
}

export interface EngineClient extends FontBuilder {
  /** Stops the worker and rejects calls still waiting. The next call starts a new one. */
  dispose(): void;
  /** Starts the engine ahead of the first call, so that call does not wait for it. */
  start(): void;
  status(): EngineStatus;
  /** Calls the listener on every status change. Returns the way to unsubscribe. */
  subscribe(listener: (status: EngineStatus) => void): () => void;
}

interface Waiting {
  readonly reject: (error: BuildError) => void;
  readonly resolve: (value: EngineResult) => void;
}

const spawnEngineWorker = (): EngineWorker =>
  new Worker(new URL("./engine.worker.ts", import.meta.url), {
    type: "module",
  });

export const createEngineClient = (
  spawn: () => EngineWorker = spawnEngineWorker
): EngineClient => {
  const listeners = new Set<(status: EngineStatus) => void>();
  const waiting = new Map<number, Waiting>();
  let status: EngineStatus = "idle";
  let worker: EngineWorker | undefined;
  let nextId = 0;

  const setStatus = (next: EngineStatus) => {
    if (status === next) {
      return;
    }
    status = next;
    for (const listener of listeners) {
      listener(next);
    }
  };

  const stop = (next: EngineStatus, reason: string) => {
    worker?.terminate();
    worker = undefined;
    const stranded = [...waiting.values()];
    waiting.clear();
    for (const call of stranded) {
      call.reject(new BuildError(reason));
    }
    setStatus(next);
  };

  const receive = (from: EngineWorker, message: FromEngine) => {
    if (from !== worker) {
      return;
    }
    if (message.kind === "ready") {
      setStatus("ready");
      return;
    }
    if (message.kind === "failed") {
      stop(
        "failed",
        `The font engine did not start (${message.message}). Try again.`
      );
      return;
    }
    const call = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.kind === "result") {
      call?.resolve(message.value);
    } else {
      call?.reject(new BuildError(message.message));
    }
  };

  const running = (): EngineWorker => {
    if (worker) {
      return worker;
    }
    const started = spawn();
    worker = started;
    setStatus("starting");
    started.addEventListener("message", (event) =>
      receive(started, event.data)
    );
    started.addEventListener("error", (event) => {
      if (started === worker) {
        const detail = event.message ? ` (${event.message})` : "";
        stop("failed", `The font engine stopped${detail}. Try again.`);
      }
    });
    return started;
  };

  /**
   * Posts a call. The bytes in it are copied, never transferred: they belong
   * to the caller, and a source font has to stay readable. Results come back
   * transferred. The worker answers calls in the order they were made, so
   * calls made while the engine starts simply wait their turn.
   */
  const send = (call: EngineCall) =>
    new Promise<EngineResult>((resolve, reject) => {
      nextId += 1;
      const id = nextId;
      waiting.set(id, { reject, resolve });
      try {
        running().postMessage({ call, id });
      } catch (error) {
        waiting.delete(id);
        const detail = reasonOf(error);
        reject(
          new BuildError(
            `The request could not be sent to the font engine (${detail}).`
          )
        );
      }
    });

  /**
   * A method of the port, answered by the worker. The worker runs the same
   * method with the same arguments, so its answer is that method's result,
   * which is what the cast says.
   */
  const remote = <Method extends EngineMethod>(kind: Method) =>
    ((...args: Parameters<FontBuilder[Method]>) =>
      send({ args, kind } as EngineCall)) as FontBuilder[Method];

  return {
    blankFont: remote("blankFont"),
    build: remote("build"),
    buildVariable: remote("buildVariable"),
    describeLayout: remote("describeLayout"),
    dispose: () => stop("idle", "The font engine was stopped."),
    start: () => {
      running();
    },
    status: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    validate: remote("validate"),
  };
};
