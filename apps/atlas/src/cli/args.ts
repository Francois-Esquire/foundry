import { parseArgs } from "node:util";

export const HELP = `Atlas — workspace analysis and a local web viewer

  atlas [path]         Refresh a workspace, serve it, and open the browser
  atlas scan [path]    Generate output without starting the web viewer
  atlas serve [path]   Serve saved output without running analysis

Paths default to the current working directory.

  --state <path>       State root (default: ~/.foundry/atlas)
  --port <number>      Local port (default: 4173; 0 chooses a free port)
  --no-open            Do not open the browser
  --help, -h           Show this help
`;

export function parseArguments(args: string[], cwd = process.cwd()) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      help: { short: "h", type: "boolean" },
      "no-open": { type: "boolean" },
      port: { default: "4173", type: "string" },
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
  const port = Number(values.port);
  if (!(values.port && Number.isInteger(port)) || port < 0 || port > 65_535) {
    throw new Error("Port must be an integer between 0 and 65535.");
  }
  return {
    command,
    help: values.help ?? false,
    open: !values["no-open"],
    port,
    state: values.state,
    target: positionals[0] ?? cwd,
  };
}
