import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { ProcessController, processError } from "./process-controller";
import type { SandboxPipedProcess } from "./types";

export interface NodeSandboxPipedProcess extends SandboxPipedProcess {
  off(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  off(event: "error", listener: (error: Error) => void): this;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  on(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  once(event: "error", listener: (error: Error) => void): this;
  removeListener(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  readonly stderr: Readable;
  readonly stdin: Writable;
  readonly stdout: Readable;
}

/** Return immediately for child-process hooks while the sandbox launch is pending. */
export function prepareSandboxProcess(
  launch: () => Promise<SandboxPipedProcess>
): NodeSandboxPipedProcess {
  const started = Promise.resolve().then(launch);
  const process = new ProcessController(async (signal) => {
    const child = await started;
    child.kill(signal);
  });
  const attach = async () => {
    try {
      const child = await started;
      if (
        !(
          child.stdin instanceof Writable &&
          child.stdout instanceof Readable &&
          child.stderr instanceof Readable
        )
      ) {
        child.kill("SIGKILL");
        throw new Error("Sandbox spawn hook requires Node byte streams");
      }
      child.stdout.on("error", (error: Error) => process.fail(error));
      child.stderr.on("error", (error: Error) => process.fail(error));
      child.stdin.on("error", (error: Error) => process.fail(error));
      process.stdin.pipe(child.stdin);
      child.stdout.pipe(process.stdout, { end: false });
      child.stderr.pipe(process.stderr, { end: false });
      const [exit] = await Promise.all([
        child.exited,
        finished(child.stdout, { readable: true, writable: false }),
        finished(child.stderr, { readable: true, writable: false }),
      ]);
      process.complete(exit.exitCode);
    } catch (error) {
      process.fail(processError(error));
    }
  };
  attach().catch((error: unknown) => process.fail(processError(error)));
  return process;
}
