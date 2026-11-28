import { showArgv } from "~/lib/commands/argv";
import type { SandboxHandle, SandboxInstance } from "~/lib/definitions/types";
import type { StepWork } from "~/lib/runs/step-work";

const COMMAND_ERROR = Symbol.for("marbles.command-error.v1");

export interface CommandSite {
  readonly cwd: () => string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly print: (line: string) => void;
  readonly signal: () => AbortSignal | undefined;
  readonly spawned?: string;
  readonly work?: StepWork;
  readonly write?: (value: unknown) => void;
}

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

export class CommandError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return (
      typeof value === "object" && value !== null && COMMAND_ERROR in value
    );
  }

  readonly [COMMAND_ERROR] = true;
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
