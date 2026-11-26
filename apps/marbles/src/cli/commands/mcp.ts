import { defineCommand, noPositionals } from "~/cli/command";

export const mcpCommand = defineCommand({
  group: "system",
  json: false,
  name: "mcp",
  needs: "none",
  parse: noPositionals("mcp"),
  async run(ctx) {
    const { isServer, relay } = await import("~/mcp/relay");
    if (!isServer()) {
      if (ctx.entry === undefined) {
        throw new Error(
          "marbles mcp relays to the CLI's entry, which runCli was not given"
        );
      }
      await relay(ctx.entry, ctx.argv);
      return;
    }
    const { serveStdio } = await import("~/mcp/stdio");
    await serveStdio(ctx.flags);
  },
  summary:
    "serve this workspace to an MCP client over stdio; starts and hosts nothing",
  usage: "mcp",
});
