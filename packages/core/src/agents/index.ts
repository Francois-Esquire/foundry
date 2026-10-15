/**
 * `@foundry/core/agents`: the shapes of the things an agent is made of and
 * a name can refer to. Types and one symbol, no runtime dependencies, so
 * the prompts and agents packages both build on this instead of on each
 * other.
 */

export type { AgentPresetIdentity, AgentSource, AgentSpec } from "./agent";
export type {
  McpClientStatus,
  McpPrompt,
  McpPromptMessage,
  McpRemoteTransportConfig,
  McpResource,
  McpResourceContent,
  McpServerDefinition,
  McpServerMetadata,
  McpServerState,
  McpServerSummary,
  McpStdioTransportConfig,
  McpTransportConfig,
} from "./mcp";
export type {
  Reference,
  Referenceable,
  ReferenceKind,
  ReferenceSource,
} from "./reference";
// biome-ignore lint/performance/noBarrelFile: This is the exported @foundry/core/agents public API.
export { isReferenceable, REFERENCE, withReference } from "./reference";
export type { Skill, SkillFile } from "./skill";
