import type { Readable, Writable } from "node:stream";

export interface CliProcess {
  kill(signal: NodeJS.Signals): boolean;
  on(
    event: "exit",
    listener: (code: number | null, signal: string | null) => void
  ): void;
  on(event: "error", listener: (error: Error) => void): void;
  stderr?: Readable;
  stdin: Writable;
  stdout: Readable;
}
