import { parseArgs } from "node:util";
import { checkPort, DEFAULT_PORT } from "../lib/serve";

export const HELP = `Atlas — workspace analysis and a local web viewer

  atlas [path]         Scan a workspace, serve it, and open the browser
  atlas scan [path]    Scan and save the dataset without starting the web viewer
  atlas serve [path]   Serve the saved dataset without running analysis

Paths default to the current working directory.

  --state <path>       State root (default: ~/.foundry/atlas)
  --port <number>      Local port (default: ${DEFAULT_PORT}; 0 chooses a free port)
  --no-open            Do not open the browser
  --history            Analyze Git checkpoints as well when scanning
  --help, -h           Show this help
`;

export type Arguments = ReturnType<typeof parseArguments>;

export function parseArguments(args: string[], cwd = process.cwd()) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      help: { short: "h", type: "boolean" },
      history: { type: "boolean" },
      "no-open": { type: "boolean" },
      port: { type: "string" },
      state: { type: "string" },
    },
    strict: true,
  });
  const command =
    positionals[0] === "scan" || positionals[0] === "serve"
      ? positionals.shift()
      : "open";
  if (positionals.length > 1) {
    throw new Error("Expected at most one workspace path.");
  }
  const port = values.port === undefined ? undefined : parsePort(values.port);
  return {
    command,
    help: values.help ?? false,
    history: values.history ?? false,
    open: !values["no-open"],
    port,
    state: values.state,
    target: positionals[0] ?? cwd,
  };
}

function parsePort(value: string): number {
  const port = value ? Number(value) : Number.NaN;
  checkPort(port);
  return port;
}
