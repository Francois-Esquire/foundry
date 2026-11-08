/**
 * A source-neutral agent declaration. `skills` and `mcp` name catalog entries
 * resolved by the agent surface.
 */

import type { AgentSpec as CoreAgentSpec } from "@foundry/core/agents";
import type { CompactionSettings } from "../harness/session-harness";
import type { AgentSettings } from "./resolve";

export type { AgentSource } from "@foundry/core/agents";

export type AgentSpec = CoreAgentSpec<
  AgentSettings,
  Pick<CompactionSettings, "keepTokens" | "window">
>;
