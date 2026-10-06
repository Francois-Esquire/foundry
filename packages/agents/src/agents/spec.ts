/**
 * `AgentSpec` — the source-neutral declaration of an agent (design:
 * `agent-as-infrastructure-code`). It is the durable "infrastructure-code"
 * record: what the agent *is* (prompt, model, the catalog entries it wants),
 * independent of how it was authored. A spec may be read from a `.md` file
 * (see `gather-agents.ts`), constructed in code, or minted virtually at
 * runtime — `createAgentPreset(spec, surface)` provisions any of them into a
 * retained `AgentPreset` the same way (`resolveAgent` remains a direct-to-
 * `SessionHarness` compatibility wrapper over it).
 *
 * It references catalog vocabularies by name (Published Language), never
 * embedding their shapes: `skills`/`mcp` are catalog identifiers the surface
 * resolves.
 */

import type { CompactionSettings } from "../harness/session-harness";
import type { AgentSettings } from "./resolve";

export type AgentSource =
  | { kind: "file"; root: string; path: string }
  | { kind: "virtual" };

export interface AgentSpec {
  id: string;
  mcp?: string[];
  mesh?: { join: boolean; node?: string };
  model?: string;
  prompt: string;
  provider?: string;
  role?: string;
  session?: {
    compaction?: false | Pick<CompactionSettings, "keepTokens" | "window">;
  };
  settings?: AgentSettings;
  skills?: string[];
  source?: AgentSource;
  tools?: string[];
}
