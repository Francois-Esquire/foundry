import type { Hosted, TaskRunner } from "~/access/workspace";
import type { CliContext, GlobalFlags } from "~/cli/context";
import { UsageError } from "~/cli/errors";
import type { Triggers } from "~/create";
import type { OpenedWorkspace } from "~/workspace/open";

export type CommandGroup = "core" | "resources" | "system";

export type CommandNeeds =
  | "none"
  | "workspace"
  | "triggers"
  | "daemon"
  | "tasks";

interface CommandFlagsSpec {
  readonly options?: ReadonlySet<string>;
  readonly switches?: ReadonlySet<string>;
}

export interface UsageEntry {
  readonly command: string;
  readonly summary: string;
}

interface ContextForNeeds {
  readonly daemon: CliContext & { readonly hosted: Hosted };
  readonly none: CliContext;
  readonly tasks: CliContext & { readonly tasks: TaskRunner };
  readonly triggers: CliContext & {
    readonly opened: OpenedWorkspace;
    readonly triggers: Triggers;
  };
  readonly workspace: CliContext & { readonly workspace: OpenedWorkspace };
}

export interface CommandDefinition<
  Name extends string = string,
  Args = Record<never, never>,
  Needs extends CommandNeeds = CommandNeeds,
> {
  readonly checkProviders?: true;
  readonly details?: string;
  readonly flags?: CommandFlagsSpec;
  readonly group: CommandGroup;
  readonly hidden?: true;
  interactive?(ctx: CliContext, args: NoInfer<Args>): Promise<void>;
  readonly json?: false;
  readonly name: Name;
  readonly needs: Needs;
  parse(positionals: readonly string[], flags: GlobalFlags): Args;
  run(ctx: ContextForNeeds[Needs], args: NoInfer<Args>): Promise<void> | void;
  readonly summary: string;
  readonly usage: string | readonly UsageEntry[];
}

export function defineCommand<
  const Name extends string,
  Args,
  Needs extends CommandNeeds = "none",
>(
  command: CommandDefinition<Name, Args, Needs>
): CommandDefinition<Name, Args, Needs> {
  return command;
}

export function isFlag(word: string): boolean {
  return word.startsWith("--") || word === "-h";
}

export function noPositionals(
  name: string
): (positionals: readonly string[]) => Record<never, never> {
  return (positionals) => {
    if (positionals.length > 0) {
      throw new UsageError(`${name} takes no arguments`);
    }
    return {};
  };
}

export function parseInputJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new UsageError(
      `--input is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}
