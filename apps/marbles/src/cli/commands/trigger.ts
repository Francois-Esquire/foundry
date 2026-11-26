import { defineCommand, isFlag, parseInputJson } from "~/cli/command";
import { UsageError } from "~/cli/errors";

const TRIGGER_USAGE =
  "trigger takes one step, workflow, schedule, or monitor name";

function optionValue(flag: string, value: string | undefined): string {
  if (value === undefined) {
    throw new UsageError(`trigger: ${flag} takes a value`);
  }
  if (isFlag(value)) {
    throw new UsageError(
      `trigger: ${flag} takes a value, not the flag ${value}`
    );
  }
  return value;
}

export const triggerCommand = defineCommand({
  checkProviders: true,
  flags: {
    options: new Set(["--input", "--key"]),
    switches: new Set(["--async"]),
  },
  group: "core",
  name: "trigger",
  needs: "daemon",
  parse(positionals: readonly string[]): {
    readonly async: boolean;
    readonly inputJson?: string;
    readonly key?: string;
    readonly name: string;
  } {
    let asyncMode = false;
    let inputJson: string | undefined;
    let key: string | undefined;
    const names: string[] = [];
    const words = positionals.values();
    for (const word of words) {
      if (word === "--async") {
        asyncMode = true;
      } else if (word === "--input") {
        inputJson = optionValue("--input", words.next().value);
      } else if (word === "--key") {
        if (key !== undefined) {
          throw new UsageError("trigger: --key may only be given once");
        }
        const value = optionValue("--key", words.next().value);
        if (value.trim() === "") {
          throw new UsageError("trigger: --key takes a key that is not blank");
        }
        key = value;
      } else {
        names.push(word);
      }
    }
    const [name, ...extra] = names;
    if (name === undefined) {
      throw new UsageError(
        `${TRIGGER_USAGE}; run "marbles" with no command to open the dashboard`
      );
    }
    if (extra.length > 0) {
      throw new UsageError(TRIGGER_USAGE);
    }
    if (key !== undefined && !asyncMode) {
      throw new UsageError("trigger: --key requires --async");
    }
    return {
      async: asyncMode,
      name,
      ...(inputJson === undefined ? {} : { inputJson }),
      ...(key === undefined ? {} : { key }),
    };
  },
  async run(ctx, args) {
    const input: unknown =
      args.inputJson === undefined ? undefined : parseInputJson(args.inputJson);
    const workspace =
      ctx.hosted.kind === "local" ? ctx.hosted.host : ctx.hosted.workspace;
    if (args.async) {
      const queued = await workspace.dispatchWorkflow(
        args.name,
        input,
        args.key === undefined ? {} : { key: args.key }
      );
      if (!ctx.flags.json) {
        ctx.io.diagnose(
          `[trigger] ${queued.name} ${queued.status} ${queued.runId}; marbles watch ${queued.runId} follows it`
        );
      }
      ctx.output(queued, ({ runId }) => runId);
      return;
    }
    const result = await workspace.roll(args.name, input);
    const payload = {
      lines: result.lines,
      name: args.name,
      ...("value" in result ? { value: result.value } : {}),
    };
    ctx.output(payload, () => {
      const parts: string[] = [];
      if (ctx.hosted.kind === "remote") {
        parts.push(...result.lines);
      }
      if ("value" in result) {
        parts.push(JSON.stringify(result.value, null, 2));
      }
      return parts.join("\n");
    });
  },
  summary:
    "run one step, workflow, schedule or monitor now, or enqueue it with --async",
  usage: [
    {
      command: "trigger <name> [--input json]",
      summary:
        "run one step, workflow, schedule or monitor now, wait, print its result",
    },
    {
      command: "trigger <name> --async [--input json] [--key key]",
      summary:
        "queue one step or workflow and print its run ID at once;\n--key enqueues it once per key",
    },
  ],
});
