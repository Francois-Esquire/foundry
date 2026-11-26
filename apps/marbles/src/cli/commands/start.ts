import { defineCommand, noPositionals } from "~/cli/command";

export const startCommand = defineCommand({
  group: "system",
  name: "start",
  needs: "daemon",
  parse: noPositionals("start"),
  run(ctx) {
    if (ctx.hosted.kind !== "remote") {
      return;
    }
    const result = {
      id: ctx.hosted.id,
      pid: ctx.hosted.client.hello.pid,
      root: ctx.hosted.workspace.root,
      source: ctx.hosted.workspace.config,
    };
    ctx.output(
      result,
      ({ id, pid, root }) =>
        `[process] pid ${String(pid)} hosts ${root} (${id})`
    );
  },
  summary:
    "start the Marbles process if needed, host this workspace in it, and exit",
  usage: "start",
});
