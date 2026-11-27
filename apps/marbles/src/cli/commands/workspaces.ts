import { resolve } from "node:path";
import { defineCommand } from "~/cli/command";
import { UsageError } from "~/cli/errors";
import { statusText, workspaceLines } from "~/cli/format/status";
import { loadSettings, settingsPath } from "~/cli/settings";
import { ResourceNotFoundError } from "~/lib/resources";
import { readStatus } from "~/process/status";

type WorkspacesArgs =
  | { readonly action: "list" }
  | { readonly action: "get"; readonly id: string };

export const workspacesCommand = defineCommand({
  group: "resources",
  name: "workspaces",
  needs: "workspace",
  parse(positionals: readonly string[]): WorkspacesArgs {
    const [first, ...rest] = positionals;
    if (first === undefined || first === "list") {
      if (rest.length > 0) {
        throw new UsageError("workspaces list takes no arguments");
      }
      return { action: "list" };
    }
    if (first === "get") {
      const [id, ...extra] = rest;
      if (id === undefined || extra.length > 0) {
        throw new UsageError(
          "workspaces get takes one workspace id or directory"
        );
      }
      return { action: "get", id };
    }
    throw new UsageError("workspaces takes list or get <id|dir>");
  },
  async run(ctx, args) {
    const report = await readStatus(resolve(ctx.flags.state));
    if (args.action === "get") {
      const targetPath = resolve(ctx.flags.directory, args.id);
      const found = report.workspaces.find(
        (workspace) =>
          workspace.id === args.id || resolve(workspace.root) === targetPath
      );
      if (found === undefined) {
        throw new ResourceNotFoundError(`no workspace "${args.id}"`);
      }
      ctx.output(found, (value) => workspaceLines(value).join("\n"));
      return;
    }
    if (ctx.interactive && !ctx.flags.json) {
      const [{ showStatus }, { applyTheme }] = await Promise.all([
        import("~/tui/views/status"),
        import("~/tui/theme"),
      ]);
      applyTheme(loadSettings(settingsPath(ctx.flags.state)).settings.theme);
      await showStatus({ here: ctx.workspace.workspace.id, report });
      return;
    }
    ctx.output(report, (value) =>
      statusText(value, ctx.workspace.workspace.id)
    );
  },
  summary: "the Marbles process and every workspace it has run",
  usage: [
    {
      command: "workspaces [list]",
      summary: "the Marbles process and every workspace it has run",
    },
    {
      command: "workspaces get <id|dir>",
      summary: "show one workspace's status, schedules, runs and observers",
    },
  ],
});
