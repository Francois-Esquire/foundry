/**
 * The source-neutral declaration of an agent: what it *is* (prompt, model,
 * the catalog entries it wants), independent of how it was authored. It
 * references catalog vocabularies by name (Published Language), never
 * embedding their shapes: `skills` and `mcp` are identifiers a host
 * resolves. The model settings and compaction shapes belong to the runtime
 * that provisions the spec, so they are type parameters here.
 */

export type AgentSource =
  | { kind: "file"; root: string; path: string }
  | { kind: "virtual" };

export interface AgentSpec<Settings = unknown, Compaction = unknown> {
  id: string;
  mcp?: string[];
  mesh?: { join: boolean; node?: string };
  model?: string;
  prompt: string;
  provider?: string;
  role?: string;
  session?: {
    compaction?: false | Compaction;
  };
  settings?: Settings;
  skills?: string[];
  source?: AgentSource;
  tools?: string[];
}

/** Source-neutral catalog identity. `id` is deliberately opaque: built-ins,
 * file agents, and installed resources may choose their own namespace. */
export interface AgentPresetIdentity {
  readonly generation: number;
  readonly id: string;
}
