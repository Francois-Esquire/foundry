import { resolve } from "node:path";
import { defineCommand } from "~/cli/command";
import { UsageError } from "~/cli/errors";
import { watchRun } from "~/cli/watch";

export const watchCommand = defineCommand({
  group: "core",
  json: false,
  name: "watch",
  needs: "none",
  parse([runId, ...rest]: readonly string[]): { readonly runId: string } {
    if (!runId || rest.length > 0) {
      throw new UsageError("watch takes one run ID");
    }
    return { runId };
  },
  async run(ctx, args) {
    const controller = new AbortController();
    const interrupt = (): void => controller.abort();
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      const status = await watchRun(resolve(ctx.flags.state), args.runId, {
        signal: controller.signal,
        write: ctx.io.stdout,
      });
      if (status !== "completed") {
        process.exitCode = 1;
      }
    } catch (error) {
      if (controller.signal.aborted) {
        process.exitCode = 130;
        return;
      }
      throw error;
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  },
  summary: "replay a run's output, follow it live, and exit when it ends",
  usage: "watch <runId>",
});
