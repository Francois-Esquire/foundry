import { defineCommand } from "~/cli/command";
import type { CliContext } from "~/cli/context";
import { UsageError } from "~/cli/errors";
import { writeDatabase } from "~/database/open";
import { WorkspaceRegistry } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import { insideState } from "~/lib/state/workspace";
import { joinProcess } from "~/process/access";
import { stopProcess } from "~/process/client";

async function detachWorkspace(ctx: CliContext): Promise<void> {
  const { workspace } = ctx.findWorkspace();
  const where = `${workspace.root} (${workspace.id})`;
  const forget = async (): Promise<void> => {
    await writeDatabase(stateDatabase(ctx.flags.state), (database) =>
      new WorkspaceRegistry({
        acceptWorkspace: (workspaceId) =>
          insideState(ctx.flags.state, workspaceId),
        database,
      }).unhost(workspace.id)
    );
  };
  const client = await joinProcess();
  if (client === undefined) {
    await forget();
    ctx.output(
      {
        detached: false,
        id: workspace.id,
        root: workspace.root,
        running: false,
      },
      () => `no Marbles process is running; ${where} is not hosted`
    );
    return;
  }
  try {
    const summaries = await client.workspaces();
    if (summaries.some((summary) => summary.id === workspace.id)) {
      await client.detach(workspace.id);
      ctx.output(
        {
          detached: true,
          id: workspace.id,
          pid: client.hello.pid,
          root: workspace.root,
          running: true,
        },
        () =>
          `detached ${where} from Marbles process pid ${String(client.hello.pid)}`
      );
    } else {
      await forget();
      ctx.output(
        {
          detached: false,
          id: workspace.id,
          pid: client.hello.pid,
          root: workspace.root,
          running: true,
        },
        () => `${where} is not hosted`
      );
    }
  } finally {
    client.close();
  }
}

async function stopDaemon(ctx: CliContext): Promise<void> {
  const stopped = await stopProcess({
    layout: ctx.layout,
    onStopping: (hello) => {
      const log = ctx.flags.json ? ctx.io.diagnose : ctx.io.print;
      log(
        `stopping Marbles process pid ${String(hello.pid)}; waiting for its engine generations to drain`
      );
    },
  });
  ctx.output(
    stopped === undefined
      ? { stopped: false }
      : { pid: stopped.pid, stopped: true },
    () =>
      stopped === undefined
        ? "no Marbles process is running"
        : `stopped Marbles process pid ${String(stopped.pid)}`
  );
}

export const stopCommand = defineCommand({
  flags: {
    switches: new Set(["--workspace"]),
  },
  group: "system",
  name: "stop",
  needs: "none",
  parse(positionals: readonly string[]): { readonly workspace: boolean } {
    const workspace = positionals[0] === "--workspace";
    if (positionals.length > (workspace ? 1 : 0)) {
      throw new UsageError("stop takes no arguments but --workspace");
    }
    return { workspace };
  },
  run(ctx, args) {
    return args.workspace ? detachWorkspace(ctx) : stopDaemon(ctx);
  },
  summary: "stop the Marbles process and every workspace it hosts",
  usage: [
    {
      command: "stop",
      summary: "stop the Marbles process and every workspace it hosts",
    },
    {
      command: "stop --workspace",
      summary: "stop hosting this workspace; it is not started again at boot",
    },
  ],
});
