import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { SandboxError } from "./errors";
import type { SandboxPipedProcess } from "./types";

export function processError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Shared lifecycle for native processes and deferred host spawn hooks. */
export class ProcessController
  extends EventEmitter<{
    exit: [code: number | null, signal: NodeJS.Signals | null];
    error: [error: Error];
  }>
  implements SandboxPipedProcess
{
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exited: Promise<{ readonly exitCode: number }>;
  exitCode: number | null = null;
  killed: boolean;
  private settled: boolean;
  private readonly resolveExit: (value: { exitCode: number }) => void;
  private readonly rejectExit: (error: Error) => void;
  private readonly terminate: (signal: string | number) => Promise<void>;

  constructor(terminate: (signal: string | number) => Promise<void>) {
    super();
    this.killed = false;
    this.settled = false;
    this.terminate = terminate;
    const completion = Promise.withResolvers<{ exitCode: number }>();
    this.exited = completion.promise;
    this.resolveExit = completion.resolve;
    this.rejectExit = completion.reject;
    // Failures remain observable via `exited`, even before listeners attach.
    this.exited.catch(() => undefined);
    for (const stream of [this.stdin, this.stdout, this.stderr]) {
      stream.on("error", (error: Error) => this.fail(error));
    }
    for (const stream of [this.stdout, this.stderr]) {
      stream.once("close", () => {
        if (!this.settled) {
          this.fail(
            new SandboxError(
              "provider-failed",
              "Process output closed before completion"
            )
          );
        }
      });
    }
  }

  kill(signal: string | number = "SIGTERM"): boolean {
    if (this.settled) {
      return false;
    }
    this.killed = true;
    this.terminate(signal).catch((error: unknown) => {
      this.killed = false;
      this.fail(processError(error));
    });
    return true;
  }

  complete(exitCode: number): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.exitCode = exitCode;
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    this.resolveExit({ exitCode });
    this.emit("exit", exitCode, null);
  }

  fail(error: Error): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    if (!this.killed) {
      this.killed = true;
      this.terminate("SIGKILL").catch((cleanupError: unknown) => {
        if (this.listenerCount("error") > 0 && cleanupError !== error) {
          this.emit("error", processError(cleanupError));
        }
      });
    }
    this.stdin.destroy(error);
    this.stdout.destroy(error);
    this.stderr.destroy(error);
    this.rejectExit(error);
    if (this.listenerCount("error") > 0) {
      this.emit("error", error);
    }
  }
}
