import { defineCommand, isFlag, parseInputJson } from "~/cli/command";
import { UsageError } from "~/cli/errors";

const ENQUEUE_USAGE =
  "enqueue takes one step or workflow name, and --key <key> to enqueue it once per key";

function optionValue(flag: string, value: string | undefined): string {
  if (value === undefined) {
    throw new UsageError(`enqueue: ${flag} takes a value`);
  }
  if (isFlag(value)) {
    throw new UsageError(
      `enqueue: ${flag} takes a value, not the flag ${value}`
    );
  }
  return value;
}

export const enqueueCommand = defineCommand({
  checkProviders: true,
  flags: {
    options: new Set(["--input", "--key"]),
  },
  group: "core",
  name: "enqueue",
  needs: "daemon",
  parse(positionals: readonly string[]): {
    readonly inputJson?: string;
    readonly key?: string;
    readonly name: string;
  } {
    let inputJson: string | undefined;
    let key: string | undefined;
    const names: string[] = [];
    const words = positionals.values();
    for (const word of words) {
      if (word === "--input") {
        inputJson = optionValue("--input", words.next().value);
      } else if (word === "--key") {
        if (key !== undefined) {
          throw new UsageError(ENQUEUE_USAGE);
        }
        const value = optionValue("--key", words.next().value);
        if (value.trim() === "") {
          throw new UsageError("enqueue: --key takes a key that is not blank");
        }
        key = value;
      } else {
        names.push(word);
      }
    }
    const [name, ...extra] = names;
    if (name === undefined || extra.length > 0) {
      throw new UsageError(ENQUEUE_USAGE);
    }
    return {
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
    const queued = await workspace.dispatchWorkflow(
      args.name,
      input,
      args.key === undefined ? {} : { key: args.key }
    );
    if (!ctx.flags.json) {
      ctx.io.diagnose(
        `[enqueue] ${queued.name} ${queued.status} ${queued.runId}; marbles watch ${queued.runId} follows it`
      );
    }
    ctx.output(queued, ({ runId }) => runId);
  },
  summary:
    "queue one step or workflow and print its run ID at once;\n--key enqueues it once per key, as enqueue(input, { key }) does",
  usage: "enqueue <name> [--input json] [--key key]",
});
