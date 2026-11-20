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

export interface AgentPresetIdentity {
  readonly generation: number;
  readonly id: string;
}
