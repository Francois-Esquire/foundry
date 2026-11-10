/**
 * The font builder the app uses in the browser. It owns the engine worker:
 * starts it on first use, tells subscribers how the engine is doing, and
 * turns every engine failure into a BuildError.
 */
import { BuildError, type FontBuilder } from "../building";
import type {
  EngineCall,
  EngineResult,
  EngineResults,
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
  const send = <Kind extends EngineCall["kind"]>(
    call: Extract<EngineCall, { kind: Kind }>
  ) =>
    new Promise<EngineResults[Kind]>((resolve, reject) => {
      nextId += 1;
      const id = nextId;
      waiting.set(id, {
        reject,
        resolve: resolve as (value: EngineResult) => void,
      });
      try {
        running().postMessage({ call, id });
      } catch (error) {
        waiting.delete(id);
        const detail = error instanceof Error ? error.message : String(error);
        reject(
          new BuildError(
            `The request could not be sent to the font engine (${detail}).`
          )
        );
      }
    });

  return {
    blankFont: (request) => send({ kind: "blankFont", request }),
    build: (request) => send({ kind: "build", request }),
    buildVariable: (request) => send({ kind: "buildVariable", request }),
    describeLayout: (font, faceIndex = 0) =>
      send({ faceIndex, font, kind: "describeLayout" }),
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
    validate: (font) => send({ font, kind: "validate" }),
  };
};
