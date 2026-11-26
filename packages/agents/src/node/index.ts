// biome-ignore lint/performance/noBarrelFile: Public Node entry point for @foundry/agents/node.
export {
  defaultAgentRoots,
  gatherAgents,
  parseAgentSpec,
} from "./gather-agents";
export { createNodeMcpClient, spawnStdioTransport } from "./mcp-stdio";
