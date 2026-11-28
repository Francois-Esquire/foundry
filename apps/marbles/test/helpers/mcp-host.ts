import "./echo-providers";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { layout } from "~/layout";
import { createMcpServer } from "~/mcp/server";
import { hostWorkspace } from "~/workspace/host";

const [source] = process.argv.slice(2);
if (source === undefined || process.env.FOUNDRY_ROOT === undefined) {
  throw new Error("usage: FOUNDRY_ROOT=<dir> bun mcp-host.ts <source>");
}
const { artifacts, state } = layout();
const host = await hostWorkspace({
  artifacts,
  askable: false,
  directory: process.cwd(),
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
