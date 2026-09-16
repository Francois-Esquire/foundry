import type { ChildProcess } from "node:child_process";
import { fork } from "node:child_process";

import type {
  HostTransport,
  WorkerReply,
  WorkerRequest,
  WorkerSideTransport,
} from "./protocol";

/**
 * Node IPC transports for the bridge. Messages ride the built-in `ipc` channel
 * (JSON-serialized), leaving stdout/stderr as plain log passthrough — the
 * runtime logs freely without corrupting the protocol.
 */

export interface ForkLocalWorkerOptions {
  /** transformers-js cache dir the worker should serve (passed as --cache). */
  cacheDir: string;
  /**
   * Path to the executable worker entry. Defaults to this package's
   * worker-entry next to the compiled module — override when a bundler has
   * relocated it.
   */
  entry?: string;
  /** Node-compatible runtime to fork with; defaults to the current one. */
  execPath?: string;
}

export interface ForkedLocalWorker {
  child: ChildProcess;
  transport: HostTransport;
}

/** Spawn the unbound inference worker and return the host-side transport. */
export function forkLocalWorker(
  options: ForkLocalWorkerOptions
): ForkedLocalWorker {
  const entry =
    options.entry ?? new URL("./worker-entry.js", import.meta.url).pathname;
  const child = fork(entry, ["--cache", options.cacheDir], {
    ...(options.execPath ? { execPath: options.execPath } : {}),
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  const transport: HostTransport = {
    onExit: (handler) => {
      child.on("exit", (code, signal) => {
        handler(`code=${code ?? "?"} signal=${signal ?? "none"}`);
      });
      child.on("error", (error) => {
        handler(error.message);
      });
    },
    onMessage: (handler) => {
      child.on("message", (message) => {
        handler(message as WorkerReply);
      });
    },
    send: (message: WorkerRequest) => {
      child.send(message);
    },
  };

  return { child, transport };
}

/** The worker-process side of the IPC channel (`process.send`/`message`). */
export function processIpcTransport(): WorkerSideTransport {
  if (typeof process.send !== "function") {
    throw new Error(
      "[remote-local] no IPC channel — the worker must be started via fork()"
    );
  }
  return {
    onExit: (handler) => {
      process.on("disconnect", () => {
        handler("host disconnected");
      });
    },
    onMessage: (handler) => {
      process.on("message", (message) => {
        handler(message as WorkerRequest);
      });
    },
    send: (message: WorkerReply) => {
      process.send?.(message);
    },
  };
}
