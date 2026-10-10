import { execFile } from "node:child_process";
import { showArgv } from "@foundry/lib/argv";

import type { SandboxHandle, SandboxInstance } from "./types";

/**
 * Commands a step runs: an argument list, never shell text. On the host
 * they run with `execFile` in the step's working directory, stop with its
 * signal, and write to its stream; `--dry-run` prints them instead. With a
 * sandbox they run there.
 */

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ExecOptions {
  /** A non-zero exit fails the step unless this is `false`. */
  readonly check?: boolean;
  /** Where to run; the step's working directory by default. */
  readonly cwd?: string;
  /** Added to the environment the command inherits. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Run in this sandbox instead of on the host. */
  readonly sandbox?: SandboxHandle | SandboxInstance;
}

/** Run one command; see {@link ExecOptions}. */
export type Exec = (
  argv: readonly string[],
  options?: ExecOptions
) => Promise<CommandResult>;

/** What a runner reports to: the step's signal and stream, read per call. */
export interface CommandSite {
  readonly cwd: () => string;
  /** Print instead of run. */
  readonly dry: boolean;
  readonly print: (line: string) => void;
  readonly signal: () => AbortSignal | undefined;
  readonly write?: (value: unknown) => void;
}

/** A command that exited non-zero, with what it said. */
export class CommandError extends Error {
  override readonly name = "CommandError";
  readonly result: CommandResult;

  constructor(argv: readonly string[], result: CommandResult) {
    const said = (result.stderr || result.stdout).trim().split("\n").slice(-5);
    super(
      [
        `${showArgv(argv)} exited with ${String(result.exitCode)}`,
        ...said,
      ].join("\n")
    );
    this.result = result;
  }
}

/** Large enough for a build's output; past it the command fails. */
const MAX_BUFFER = 64 * 1024 * 1024;

function onHost(
  argv: readonly string[],
  options: ExecOptions,
  site: CommandSite
): Promise<CommandResult> {
  const [program = "", ...args] = argv;
  const signal = site.signal();
  site.write?.(`$ ${showArgv(argv)}\n`);
  return new Promise((resolve, reject) => {
    const child = execFile(
      program,
      args,
      {
        cwd: options.cwd ?? site.cwd(),
        encoding: "utf8",
        env: { ...process.env, ...options.environment },
        maxBuffer: MAX_BUFFER,
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        if (error && typeof error.code !== "number") {
          // It never ran: not found, not executable, output too large.
          reject(new Error(`${program}: ${error.message}`, { cause: error }));
          return;
        }
        resolve({ exitCode: Number(error?.code ?? 0), stderr, stdout });
      }
    );
    child.stdout?.on("data", (chunk: string) => site.write?.(chunk));
    child.stderr?.on("data", (chunk: string) => site.write?.(chunk));
  });
}

/** A runner for one step, or for the engine outside any. */
export function commandRunner(site: CommandSite): Exec {
  return async (argv, options = {}) => {
    if (argv.length === 0 || argv[0] === "") {
      throw new Error("exec: give it a program to run");
    }
    let result: CommandResult;
    if (options.sandbox) {
      result = await options.sandbox.exec(argv, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment }),
      });
    } else if (site.dry) {
      site.print(`[exec] ${options.cwd ?? site.cwd()}: ${showArgv(argv)}`);
      result = { exitCode: 0, stderr: "", stdout: "" };
    } else {
      result = await onHost(argv, options, site);
    }
    if (result.exitCode !== 0 && options.check !== false) {
      throw new CommandError(argv, result);
    }
    return result;
  };
}
