import { resolve } from "node:path";
import { defineCommand, isFlag, type UsageEntry } from "~/cli/command";
import { UsageError } from "~/cli/errors";
import {
  getResource,
  listResources,
  type ResourceCommandContext,
} from "~/cli/resource-runner";
import type { ResourceKind } from "~/lib/definitions/resources";

type ResourceCommandName = "artifacts" | "runs" | "sandboxes" | "sessions";

type ResourceAction =
  | {
      readonly action: "list";
      readonly all: boolean;
      readonly workspace?: string;
    }
  | {
      readonly action: "get";
      readonly all: boolean;
      readonly id: string;
      readonly workspace?: string;
    };

const RESOURCE_FLAGS = {
  options: new Set(["--workspace"]),
  switches: new Set(["--all"]),
} as const;

function extractScopeFlags(
  command: ResourceCommandName,
  positionals: readonly string[]
): {
  readonly all: boolean;
  readonly rest: readonly string[];
  readonly workspace?: string;
} {
  let all = false;
  let workspace: string | undefined;
  const rest: string[] = [];
  const words = positionals.values();
  for (const word of words) {
    if (word === "--all") {
      all = true;
    } else if (word === "--workspace") {
      const { value } = words.next();
      if (value === undefined) {
        throw new UsageError(`${command}: --workspace takes a value`);
      }
      if (isFlag(value)) {
        throw new UsageError(
          `${command}: --workspace takes a value, not the flag ${value}`
        );
      }
      workspace = value;
    } else {
      rest.push(word);
    }
  }
  if (all && workspace !== undefined) {
    throw new UsageError(`${command} takes --workspace or --all, not both`);
  }
  return {
    all,
    rest,
    ...(workspace === undefined ? {} : { workspace }),
  };
}

function defineResourceCommand<Name extends ResourceCommandName>(spec: {
  readonly kind: ResourceKind;
  readonly name: Name;
  readonly summary: string;
  readonly usage: string | readonly UsageEntry[];
}) {
  const { kind, name, summary, usage } = spec;
  return defineCommand({
    flags: RESOURCE_FLAGS,
    group: "resources",
    name,
    needs: "workspace",
    parse(positionals: readonly string[]): ResourceAction {
      const { all, rest, workspace } = extractScopeFlags(name, positionals);
      const scope = {
        all,
        ...(workspace === undefined ? {} : { workspace }),
      };
      const [first, ...tail] = rest;
      if (first === undefined || first === "list") {
        if (tail.length > 0) {
          throw new UsageError(
            `${name} list takes no arguments besides --workspace or --all`
          );
        }
        return { action: "list", ...scope };
      }
      if (first === "get") {
        const [id, ...extra] = tail;
        if (id === undefined || extra.length > 0) {
          throw new UsageError(`${name} get takes one id`);
        }
        return { action: "get", id, ...scope };
      }
      throw new UsageError(`${name} takes list or get <id>`);
    },
    run(ctx, args) {
      const context: ResourceCommandContext = {
        directory: ctx.flags.directory,
        json: ctx.flags.json,
        print: ctx.io.print,
        state: resolve(ctx.flags.state),
        workspace: ctx.workspace.workspace,
      };
      const scope = {
        all: args.all,
        ...(args.workspace === undefined ? {} : { workspace: args.workspace }),
      };
      if (args.action === "get") {
        return getResource(kind, args.id, scope, context);
      }
      return listResources(kind, scope, context);
    },
    summary,
    usage,
  });
}

export const runsCommand = defineResourceCommand({
  kind: "run",
  name: "runs",
  summary: "workflow runs: list or get <id>",
  usage: "runs [list | get <id>] [--workspace <ws> | --all]",
});

export const sessionsCommand = defineResourceCommand({
  kind: "session",
  name: "sessions",
  summary: "agent sessions: list or get <id>",
  usage: "sessions [list | get <id>] [--workspace <ws> | --all]",
});

export const artifactsCommand = defineResourceCommand({
  kind: "artifact",
  name: "artifacts",
  summary: "artifacts: list or get <id>",
  usage: "artifacts [list | get <id>] [--workspace <ws> | --all]",
});

export const sandboxesCommand = defineResourceCommand({
  kind: "sandbox",
  name: "sandboxes",
  summary: "sandbox containers: list or get <id>",
  usage: "sandboxes [list | get <id>] [--workspace <ws> | --all]",
});
