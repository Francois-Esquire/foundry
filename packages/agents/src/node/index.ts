import { McpClient } from "../mcp/client";
import type { McpClientOptions, McpServerDefinition } from "../mcp/types";
import { spawnStdioTransport } from "./mcp-stdio";

// biome-ignore lint/performance/noBarrelFile: Public Node entry point for @foundry/agents/node.
export {
  defaultAgentRoots,
  gatherAgents,
  parseAgentSpec,
} from "./gather-agents";
export { spawnStdioTransport } from "./mcp-stdio";

export function createNodeMcpClient(
  definition: McpServerDefinition,
  options: McpClientOptions = {}
): McpClient {
  return new McpClient(definition, {
    spawnStdio: spawnStdioTransport,
    ...options,
  });
}
