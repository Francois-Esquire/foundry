/**
 * The MCP tools over a workspace hosted in this process under `--dry-run`,
 * for tests that drive definitions through them with the dry-run echo.
 * `marbles mcp` hosts nothing, so these tests host here. Run by Bun as a
 * subprocess with the source as its argument, never imported. Protocol
 * frames go to stdout, so the source must not print there. The state root
 * is the test run's Foundry home; nothing is written to it.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { layout } from "~/layout";
import { createMcpServer } from "~/mcp/server";
import { hostWorkspace } from "~/workspace/host";

const [source] = process.argv.slice(2);
if (source === undefined || process.env.FOUNDRY_HOME === undefined) {
  throw new Error("usage: FOUNDRY_HOME=<dir> bun dry-mcp-host.ts <source>");
}
const { artifacts, state } = layout();
const host = await hostWorkspace({
  artifacts,
  askable: false,
  dry: true,
  env: "require",
  print: (line) => process.stderr.write(`${line}\n`),
  source,
  state,
});
const server = createMcpServer({
  hosted: (_id, work) => work(host),
  id: host.id,
  tasks: (command) => host.tasks(command),
  workspaces: () =>
    Promise.resolve([
      { config: host.config, id: host.id, root: host.root, state: "ready" },
    ]),
});
process.stdin.once("end", async () => {
  await server.close();
  await host.close();
  process.exit();
});
await server.connect(new StdioServerTransport());
