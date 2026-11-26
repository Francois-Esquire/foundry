import { resolve } from "node:path";
import { defineCommand, type UsageEntry } from "~/cli/command";
import { UsageError } from "~/cli/errors";
import {
  changeAssociation,
  listResources,
  type ResourceCommandContext,
  relink,
} from "~/cli/resources/commands";
import type { ResourceKind } from "~/lib/resources";

type ResourceCommandName = "artifacts" | "runs" | "sandboxes" | "sessions";

type ResourceAction =
  | { readonly action: "list" | "relink"; readonly all: boolean }
  | {
      readonly action: "share" | "unshare";
      readonly id: string;
      readonly kind: ResourceKind;
      readonly with: string;
    };

type ResourceActionName = ResourceAction["action"];

const RESOURCE_USAGE: Readonly<Record<ResourceActionName, string>> = {
  list: "list [--all]",
  relink: "relink [--all]",
  share: "share <id> <dir>",
  unshare: "unshare <id> <dir>",
};

const LISTING_FLAGS = { switches: new Set(["--all"]) } as const;

function choices(items: readonly string[]): string {
  return items.length < 3
    ? items.join(" or ")
    : `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}

function isResourceAction(
  actions: readonly ResourceActionName[],
  name: string
): name is ResourceActionName {
  return actions.some((action) => action === name);
}

function unknownResourceAction(
  command: ResourceCommandName,
  kind: ResourceKind,
  actions: readonly ResourceActionName[],
  action: string
): UsageError {
  const shared =
    kind === "sandbox" && (action === "share" || action === "unshare");
  return new UsageError(
    `${command} takes ${choices(actions.map((each) => RESOURCE_USAGE[each]))}${
      shared ? "; sandboxes are not shared with other workspaces" : ""
    }`
  );
}

function allOf(
  command: ResourceCommandName,
  action: "list" | "relink",
  rest: readonly string[]
): boolean {
  const all = rest[0] === "--all";
  if (rest.length > (all ? 1 : 0)) {
    throw new UsageError(`${command} ${action} takes no arguments but --all`);
  }
  return all;
}

function associated(
  command: ResourceCommandName,
  action: "share" | "unshare",
  [id, other, ...extra]: readonly string[]
): { readonly id: string; readonly with: string } {
  if (
    id === undefined ||
    other === undefined ||
    extra.length > 0 ||
    [id, other].includes("--all")
  ) {
    throw new UsageError(
      `${command} ${action} takes an id and another workspace's directory`
    );
  }
  return { id, with: other };
}

function defineResourceCommand<Name extends ResourceCommandName>(spec: {
  readonly actions: readonly ResourceActionName[];
  readonly kind: ResourceKind;
  readonly name: Name;
  readonly summary: string;
  readonly usage: string | readonly UsageEntry[];
}) {
  const { actions, kind, name, summary, usage } = spec;
  return defineCommand({
    flags: LISTING_FLAGS,
    group: "resources",
    name,
    needs: "workspace",
    parse(positionals: readonly string[]): ResourceAction {
      const [first] = positionals;
      const named = first !== undefined && first !== "--all";
      const action = named ? first : "list";
      const rest = named ? positionals.slice(1) : positionals;
      if (!isResourceAction(actions, action)) {
        throw unknownResourceAction(name, kind, actions, action);
      }
      if (action === "list" || action === "relink") {
        return { action, all: allOf(name, action, rest) };
      }
      return { action, kind, ...associated(name, action, rest) };
    },
    run(ctx, args) {
      const context: ResourceCommandContext = {
        artifacts: resolve(ctx.flags.artifacts),
        directory: ctx.flags.directory,
        json: ctx.flags.json,
        print: ctx.io.print,
        state: resolve(ctx.flags.state),
        workspace: ctx.workspace.workspace,
      };
      switch (args.action) {
        case "list":
          return listResources(kind, args.all, context);
        case "relink":
          return relink(args.all, context);
        default:
          return changeAssociation(args.action, args, context);
      }
    },
    summary,
    usage,
  });
}

export const runsCommand = defineResourceCommand({
  actions: ["list", "share", "unshare"],
  kind: "run",
  name: "runs",
  summary: "workflow runs, each with its steps",
  usage: "runs [list] [--all]",
});

export const sessionsCommand = defineResourceCommand({
  actions: ["list", "share", "unshare"],
  kind: "session",
  name: "sessions",
  summary: "agent sessions: id, messages, updated, summary",
  usage: "sessions [list] [--all]",
});

export const artifactsCommand = defineResourceCommand({
  actions: ["list", "relink", "share", "unshare"],
  kind: "artifact",
  name: "artifacts",
  summary: "artifacts: id, name, type, status, updated",
  usage: [
    {
      command: "artifacts [list] [--all]",
      summary: "artifacts: id, name, type, status, updated",
    },
    {
      command: "artifacts relink [--all]",
      summary: "rebuild .marbles/ links to artifact files from the database",
    },
  ],
});

export const sandboxesCommand = defineResourceCommand({
  actions: ["list"],
  kind: "sandbox",
  name: "sandboxes",
  summary: "sandbox containers: id, status, created",
  usage: [
    {
      command: "sandboxes [list] [--all]",
      summary: "sandbox containers: id, status, created",
    },
    {
      command: "runs | sessions | artifacts share <id> <dir>",
      summary:
        "show one of this workspace's resources in the workspace at <dir> too",
    },
    {
      command: "runs | sessions | artifacts unshare <id> <dir>",
      summary: "stop showing it there; the resource itself stays",
    },
  ],
});
