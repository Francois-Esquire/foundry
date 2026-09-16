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

export type AgentSource =
  | { kind: "file"; root: string; path: string }
  | { kind: "virtual" };

export interface AgentSpec {
  id: string;
  mcp?: string[];
  mesh?: { join: boolean; node?: string };
  model?: string;
  prompt: string;
  role?: string;
  skills?: string[];
  source?: AgentSource;
  /**
   * Declared tool names. NOT yet provisioned — there is no tool-name catalog
   * to resolve them against (a deliberate divergence: the `.md` format keeps a
   * `tools:` list). Carried as durable spec data until that catalog exists.
   */
  tools?: string[];
}
