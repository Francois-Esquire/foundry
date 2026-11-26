import { defineCommand, extractOption, parseInputJson } from "~/cli/command";
import { UsageError } from "~/cli/errors";

export const runCommand = defineCommand({
  checkProviders: true,
  flags: {
    options: new Set(["--input"]),
  },
  group: "core",
  name: "run",
  needs: "daemon",
  parse(positionals: readonly string[]): {
    readonly inputJson?: string;
    readonly name: string;
  } {
    const words = [...positionals];
    const inputJson = extractOption(words, "--input", "run: ");
    const [name, ...rest] = words;
    if (name === undefined) {
      throw new UsageError(
        'run takes a step, workflow, schedule, or monitor name; run "marbles" with no command to open the dashboard'
      );
    }
    if (rest.length > 0) {
      throw new UsageError(
        "run takes one step, workflow, schedule, or monitor name"
      );
    }
    return { name, ...(inputJson === undefined ? {} : { inputJson }) };
  },
  async run(ctx, args) {
    const input: unknown =
      args.inputJson === undefined ? undefined : parseInputJson(args.inputJson);
    const workspace =
      ctx.hosted.kind === "local" ? ctx.hosted.host : ctx.hosted.workspace;
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
    "run one step, workflow, schedule or monitor now, wait, print its result",
  usage: "run <name> [--input json]",
});
