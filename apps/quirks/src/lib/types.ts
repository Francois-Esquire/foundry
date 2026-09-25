import type {
  CompactionSettings,
  SessionHarness,
  SessionStreamOptions,
} from "@foundry/agents/harness";
import type {
  SessionInput,
  SessionMessage,
  SessionStream,
} from "@foundry/agents/session";
import type { Git } from "@foundry/workspaces/git";
import type { Log } from "~/lib/log";

/**
 * The public types of the authoring API: what a `quirks.config.ts` sees.
 * Definitions are presets; the context is what a body destructures.
 */

// ── Definitions ────────────────────────────────────────────────────────────

export interface SkillOp {
  readonly glob?: string;
  readonly kind: "load" | "add" | "pick";
  readonly names?: readonly string[];
}

/** An immutable recipe for a set of skills, resolved when a session opens. */
export interface SkillSet {
  add(glob: string): SkillSet;
  readonly kind: "skills";
  readonly ops: readonly SkillOp[];
  pick(...names: readonly string[]): SkillSet;
}

export interface AgentDefinition {
  readonly id: string;
  readonly kind: "agent";
  /** A catalog model id, e.g. `anthropic/claude-sonnet-4.6`. */
  readonly model?: string;
  readonly prompt: string;
  /** A models provider id: `codex`, `claude-code`. Omit for the default. */
  readonly provider?: string;
  readonly skills?: SkillSet;
}

export interface WorkspaceDefinition {
  readonly id: string;
  readonly kind: "workspace";
  /** Relative paths resolve from the config's directory. */
  readonly path: string;
}

export interface SandboxResources {
  readonly cpus?: number;
  readonly memoryBytes?: number;
}

export type SandboxDefinition =
  | {
      readonly kind: "sandbox";
      readonly id: string;
      readonly image: string;
      /** `"."` (the config's directory) or a declared workspace. */
      readonly mount?: "." | WorkspaceDefinition;
      readonly resources?: SandboxResources;
    }
  | {
      readonly kind: "sandbox";
      readonly id: string;
      readonly files: Readonly<Record<string, string>>;
    };

export interface ArtifactDefinition {
  readonly id: string;
  readonly kind: "artifact";
  readonly name: string;
  readonly type: string;
}

// ── Context ────────────────────────────────────────────────────────────────

export interface SessionRef {
  readonly id: string;
  readonly model?: string;
  readonly provider?: string;
}

export interface SessionOptions {
  readonly compaction?: boolean | Partial<CompactionSettings>;
  /** Overrides the composed working directory. */
  readonly cwd?: string;
  /** Continue this session instead of starting a new one. */
  readonly session?: SessionRef | Session;
}

export type SessionReply = SessionMessage & { readonly text: string };

/**
 * A session, pre-wired: every turn is aborted with the step and its text
 * lands on the step's stream. `harness` is the package object underneath.
 */
export interface Session {
  generate(
    input: SessionInput,
    options?: SessionStreamOptions
  ): Promise<SessionReply>;
  readonly harness: SessionHarness;
  readonly ref: SessionRef;
  stream(input: SessionInput, options?: SessionStreamOptions): SessionStream;
}

export interface Agents {
  session(agent: AgentDefinition, options?: SessionOptions): Promise<Session>;
}

export interface WorkspaceHandle {
  files(): Promise<readonly string[]>;
  /** Throws when the directory is not a git repository. */
  readonly git: Git;
  readonly root: string;
}

export interface Workspaces {
  /** The config's own directory. */
  readonly current: WorkspaceHandle;
  load(
    ref: WorkspaceDefinition | { readonly path: string }
  ): Promise<WorkspaceHandle>;
}

interface ExecResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface Sandbox {
  close(): Promise<void>;
  exec(argv: readonly string[]): Promise<ExecResult>;
  readonly id: string;
}

export interface SandboxSpec {
  readonly image: string;
  readonly mount?: "." | WorkspaceDefinition;
  readonly resources?: SandboxResources;
}

export interface Sandboxes {
  open(id: string): Promise<Sandbox>;
  start(sandbox: SandboxDefinition | SandboxSpec): Promise<Sandbox>;
}

export type ArtifactFiles = Readonly<Record<string, string | Uint8Array>>;

export interface ArtifactVersion {
  readonly artifactId: string;
  readonly contentId: string;
  /** `artifactId:contentId`. */
  readonly id: string;
}

export interface Artifacts {
  create(input: {
    readonly name: string;
    readonly type: string;
    readonly entries?: ArtifactFiles;
  }): Promise<ArtifactVersion>;
  /** Adds a version to the declared artifact. */
  write(
    artifact: ArtifactDefinition,
    files: ArtifactFiles
  ): Promise<ArtifactVersion>;
}

export interface Question {
  readonly body?: string;
  /** Offer these answers; without them the answer is free text. */
  readonly choices?: readonly string[];
  /** Optional: update the same entry across steps. */
  readonly key?: string;
  readonly title: string;
}

export interface ApprovalRequest {
  readonly body?: string;
  readonly key?: string;
  readonly title: string;
}

export interface Approval {
  readonly approved: boolean;
  readonly note?: string;
}

export interface Ask {
  /** A hard block: the run shows as blocked until someone decides. */
  approval(request: ApprovalRequest): Promise<Approval>;
  /** Input: the step waits, the run shows as waiting. */
  question(question: Question): Promise<string>;
}

export interface ReportEntry {
  readonly body?: string;
  readonly key?: string;
  /** Files copied into the entry; relative paths resolve from the config's directory. */
  readonly media?: readonly string[];
  readonly title: string;
}

export interface Report {
  /** Writes a new version to the artifact, posts it, and returns the version. */
  artifact(
    artifact: ArtifactDefinition,
    files: ArtifactFiles,
    entry?: Partial<ReportEntry>
  ): Promise<ArtifactVersion>;
  milestone(entry: ReportEntry): void;
  result(entry: ReportEntry): void;
}

export interface Stream {
  pipe<T>(source: ReadableStream<T> | AsyncIterable<T>): Promise<void>;
  write(value: unknown): void;
}

/** The run scope: the top layer, exposed for advanced patterns. */
export interface Run {
  abort(reason?: unknown): void;
  readonly id: string;
  /** Where this step sits in the tree. */
  readonly path: readonly string[];
  /** The run's own session. */
  readonly session: SessionRef;
  /** Fires only when the whole run is cancelled or aborted. */
  readonly signal: AbortSignal;
  /** The whole run's output, every step. Each access opens a new subscription. */
  readonly stream: ReadableStream<unknown>;
}

/** What every `.do` receives. */
export interface Context<I = Record<string, never>> {
  readonly agents: Agents;
  readonly artifacts: Artifacts;
  readonly ask: Ask;
  readonly input: I;
  readonly log: Log;
  readonly report: Report;
  readonly run: Run;
  readonly sandboxes: Sandboxes;
  /** Fires when this step is cancelled or paused, or its run is. */
  readonly signal: AbortSignal;
  readonly stream: Stream;
  readonly workspaces: Workspaces;
}

/** What a workflow's setup receives: no frame, so no managers. */
export interface SetupContext<I> {
  readonly input: I;
  readonly log: Log;
  readonly run: { readonly id: string };
}
