import type { ChildProcess } from "node:child_process";
import { fork } from "node:child_process";

import type {
  HostTransport,
  WorkerReply,
  WorkerRequest,
  WorkerSideTransport,
} from "./protocol";

export interface ForkLocalWorkerOptions {
  cacheDir: string;
  entry?: string;
  execPath?: string;
}

export interface ForkedLocalWorker {
  child: ChildProcess;
  transport: HostTransport;
}

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
    terminate: () => {
      child.kill("SIGKILL");
    },
  };

  return { child, transport };
}

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
