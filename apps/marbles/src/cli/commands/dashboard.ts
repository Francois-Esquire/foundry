import type { Hosted } from "~/access/workspace";
import { defineCommand, noPositionals } from "~/cli/command";
import type { CliContext } from "~/cli/context";
import { describeDisconnect } from "~/process/client";

function interrupted(): { readonly done: Promise<void>; release(): void } {
  let finish: () => void = () => undefined;
  const done = new Promise<void>((settle) => {
    finish = settle;
  });
  const stop = () => finish();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return {
    done,
    release() {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    },
  };
}

async function runUntilStopped(ctx: CliContext, hosted: Hosted): Promise<void> {
  if (hosted.kind !== "remote") {
    return;
  }
  const signal = interrupted();
  try {
    const { client, id, workspace } = hosted;
    ctx.io.print(
      `[process] pid ${String(client.hello.pid)} hosts ${workspace.root} (${id}); Ctrl+C detaches and leaves it running`
    );
    const unsubscribe = client.subscribe(id, {
      line: ctx.io.print,
      workspace(summary) {
        ctx.io.print(
          `[workspace] ${summary.state}${summary.error ? `: ${summary.error}` : ""}`
        );
      },
    });
    try {
      const ended = await Promise.race([
        signal.done.then(() => "interrupted" as const),
        client.closed,
      ]);
      if (ended === "interrupted") {
        return;
      }
      ctx.io.print(`[process] ${describeDisconnect(ended)}`);
      if (ended.kind !== "stopped") {
        process.exitCode = 1;
      }
    } finally {
      unsubscribe();
    }
  } finally {
    signal.release();
  }
}

export const dashboardCommand = defineCommand({
  group: "core",
  hidden: true,
  async interactive(ctx) {
    const { runInteractive } = await import("~/tui/interactive");
    await runInteractive(ctx.flags);
  },
  json: false,
  name: "dashboard",
  needs: "daemon",
  parse: noPositionals("dashboard"),
  run(ctx) {
    return runUntilStopped(ctx, ctx.hosted);
  },
  summary: "open the dashboard; piped, host this workspace and follow it",
  usage: "marbles",
});
