import { execFile } from "node:child_process";
import type { Writable } from "node:stream";
import { showArgv } from "@foundry/lib/argv";
import { recordChild, SPAWN_RECOVERY_ENV } from "@foundry/lib/spawn-record";

import { StepInputError, type StepWork } from "./step-work";
import type { SandboxHandle, SandboxInstance } from "./types";

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ExecOptions {
  readonly check?: boolean;
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly sandbox?: SandboxHandle | SandboxInstance;
}

export type Exec = (
  argv: readonly string[],
  options?: ExecOptions
) => Promise<CommandResult>;

export interface CommandSite {
  readonly cwd: () => string;
  readonly dry: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly print: (line: string) => void;
  readonly signal: () => AbortSignal | undefined;
  readonly spawned?: string;
  readonly work?: StepWork;
  readonly write?: (value: unknown) => void;
}

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

const MAX_BUFFER = 64 * 1024 * 1024;

function onHost(
  argv: readonly string[],
  options: ExecOptions,
  site: CommandSite
): Promise<CommandResult> {
  const [program = "", ...args] = argv;
  const signal = site.signal();
  site.write?.(`$ ${showArgv(argv)}\n`);
  let ended: (() => void) | undefined;
  return new Promise<CommandResult>((resolve, reject) => {
    const child = execFile(
      program,
      args,
      {
        cwd: options.cwd ?? site.cwd(),
        encoding: "utf8",
        env: { ...(site.environment ?? process.env), ...options.environment },
        maxBuffer: MAX_BUFFER,
        ...(signal ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        if (error && typeof error.code !== "number") {
          reject(new Error(`${program}: ${error.message}`, { cause: error }));
          return;
        }
        resolve({ exitCode: Number(error?.code ?? 0), stderr, stdout });
      }
    );
    child.stdout?.on("data", (chunk: string) => site.write?.(chunk));
    child.stderr?.on("data", (chunk: string) => site.write?.(chunk));
    ended = site.work?.begin({
      command: showArgv(argv),
      kind: "command",
      ...(child.pid === undefined ? {} : { pid: child.pid }),
      ...(child.stdin ? { stdin: lineWriter(child.stdin, site) } : {}),
    });
    recordChild(
      child,
      false,
      site.spawned === undefined
        ? process.env
        : { ...process.env, [SPAWN_RECOVERY_ENV]: site.spawned }
    );
  }).finally(() => ended?.());
}

function lineWriter(
  stdin: Writable,
  site: CommandSite
): (line: string) => void {
  stdin.on("error", () => undefined);
  return (line) => {
    if (!stdin.writable) {
      throw new StepInputError("no-input", "The command closed its input.");
    }
    stdin.write(`${line}\n`);
    site.write?.("\n[stdin] sent a line\n");
  };
}

async function inSandbox(
  argv: readonly string[],
  options: ExecOptions & { readonly sandbox: SandboxHandle | SandboxInstance },
  site: CommandSite
): Promise<CommandResult> {
  const ended = site.work?.begin({ command: showArgv(argv), kind: "command" });
  try {
    return await options.sandbox.exec(argv, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.environment === undefined
        ? {}
        : { environment: options.environment }),
    });
  } finally {
    ended?.();
  }
}

export function commandRunner(site: CommandSite): Exec {
  return async (argv, options = {}) => {
    if (argv.length === 0 || argv[0] === "") {
      throw new Error("exec: give it a program to run");
    }
    let result: CommandResult;
    if (options.sandbox) {
      result = await inSandbox(
        argv,
        { ...options, sandbox: options.sandbox },
        site
      );
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
