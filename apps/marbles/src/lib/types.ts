import type {
  CompactionSettings,
  HarnessAuthoritySettings,
  HarnessPermissionProfile,
  HarnessQuestionCallback,
  HarnessSession,
  SessionHarness,
  TurnCallSettings,
  TurnOptions,
} from "@foundry/agents/harness";
import type {
  SessionInput,
  SessionMessage,
  SessionStream,
  SessionUsage,
} from "@foundry/agents/session";
import type { Skill } from "@foundry/agents/skills";
import type {
  ArtifactResolved,
  Content,
  ContentResolved,
  ContentSummary,
  CreateArtifactInput,
  FileInput,
  FileResolved,
} from "@foundry/artifacts";
import type { ContainerSandboxConstraints } from "@foundry/sandbox/container/constraints";
import type { Container } from "@foundry/sandbox/container/containers";
import type {
  SandboxCommand,
  SandboxExecOptions,
  SandboxExecResult,
} from "@foundry/sandbox/types";
import type { Workspace as PackageWorkspace } from "@foundry/workspaces";
import type { Git } from "@foundry/workspaces/git";
import type {
  InferGenerateOutput,
  Output,
  StreamTextResult,
  ToolSet,
} from "ai";
import type { Log } from "~/lib/log";

/**
 * The public types of the authoring API: what a `marbles.config.ts` sees.
 * Definitions are presets; the context is what a body destructures.
 */

export interface SkillOp {
  readonly glob?: string;
  readonly kind: "load" | "add" | "pick" | "skill";
  readonly names?: readonly string[];
  /** A skill defined in code, for `kind: "skill"`. */
  readonly skill?: Skill;
}

/** An immutable recipe for a set of skills, resolved when a session opens. */
export interface SkillSet {
  /** A folder of skills by glob, or a skill defined in code (`defineSkill`). */
  add(source: string | Skill): SkillSet;
  readonly kind: "skills";
  readonly ops: readonly SkillOp[];
  pick(...names: readonly string[]): SkillSet;
}

export type { TurnOptions } from "@foundry/agents/harness";

/**
 * Model settings and structured output every turn starts from; a turn's own
 * options override them. A CLI harness honours `output` and ignores the
 * model settings, which its own loop owns.
 */
export type AgentSettings<OUTPUT extends Output.Output = never> =
  TurnCallSettings<OUTPUT>;

export interface AgentDefinition<OUTPUT extends Output.Output = never> {
  readonly id: string;
  readonly kind: "agent";
  /** A catalog model id, e.g. `anthropic/claude-sonnet-4.6`. */
  readonly model?: string;
  readonly prompt: string;
  /** A models provider id: `codex`, `claude-code`. Omit for the default. */
  readonly provider?: string;
  readonly settings?: AgentSettings<OUTPUT>;
  readonly skills?: SkillSet;
}

export interface WorkspaceDefinition {
  readonly id: string;
  readonly kind: "workspace";
  /** Relative paths resolve from the config's directory. */
  readonly path: string;
}

export type SandboxResources = NonNullable<
  ContainerSandboxConstraints["resources"]
>;

/**
 * What both kinds of sandbox take from the container's own constraints.
 * `workdir` defaults to where the workspace is (`/workspace`).
 */
interface SandboxOptions
  extends Pick<
    ContainerSandboxConstraints,
    | "detached"
    | "labels"
    | "network"
    | "ports"
    | "publicEnvironment"
    | "workdir"
  > {
  readonly resources?: SandboxResources;
}

/** An image with a workspace mounted read/write, at `/workspace` unless `target` says. */
export interface ImageSandbox extends SandboxOptions {
  /** Permit workspace binaries while retaining nosuid and nodev. */
  readonly executable?: boolean;
  readonly image: string;
  /** `"."` (the config's directory) or a declared workspace. */
  readonly mount?: "." | WorkspaceDefinition;
  /** Where the mount lands in the guest; `/workspace` when omitted. */
  readonly target?: string;
}

/**
 * A scratch sandbox seeded with files under `/workspace` instead of a
 * mount; the image defaults to the runtime's.
 */
export interface FilesSandbox extends SandboxOptions {
  readonly files: Readonly<Record<string, string>>;
  readonly image?: string;
}

export type SandboxSpec = ImageSandbox | FilesSandbox;

export type SandboxDefinition = SandboxSpec & {
  readonly kind: "sandbox";
  readonly id: string;
};

export interface ArtifactDefinition {
  readonly id: string;
  readonly kind: "artifact";
  readonly name: string;
  readonly type: string;
}

export interface SessionRef {
  readonly id: string;
  readonly model?: string;
  readonly provider?: string;
}

interface SharedSessionOptions {
  /** Enable automatic compaction or supply its settings; false disables it. */
  readonly compaction?: boolean | Partial<CompactionSettings>;
  /** Continue this session instead of starting a new one. */
  readonly session?: SessionRef | Session<Output.Output>;
}

interface HostSessionOptions extends SharedSessionOptions {
  readonly apiKey?: never;
  readonly authority?: never;
  readonly cwd?: string;
  readonly oauthToken?: never;
  readonly profile?: never;
  readonly question?: never;
  readonly sandbox?: never;
}

export interface SandboxAgentOptions extends SharedSessionOptions {
  /** Explicit per-session key; never persisted with the sandbox or session. */
  readonly apiKey?: string;
  readonly authority?: Pick<
    HarnessAuthoritySettings,
    "policy" | "approve" | "onApprovalRequest"
  >;
  readonly cwd?: never;

  /** Claude subscription token; defaults to the host Claude Code login. */
  readonly oauthToken?: string;
  readonly profile?: HarnessPermissionProfile;
  /** Host handler for model questions; the dashboard supplies one by default. */
  readonly question?: HarnessQuestionCallback;
  /** Run the harness inside a started sandbox, or a declared one, which starts. */
  readonly sandbox: SandboxHandle | SandboxInstance;
}

export type SessionOptions = HostSessionOptions | SandboxAgentOptions;

export type SessionReply<OUTPUT extends Output.Output = never> =
  SessionMessage & {
    /** Every text part of the final turn, joined with newlines. */
    readonly text: string;
    /** The parsed structured value; present when the turn had an `output`. */
    readonly output: InferGenerateOutput<OUTPUT>;
    readonly usage: SessionUsage;
    /**
     * The AI SDK result of the final turn, settled. Absent for a CLI
     * harness, which runs its own loop.
     */
    readonly result?: StreamTextResult<
      ToolSet,
      Record<string, unknown>,
      OUTPUT
    >;
  };

/**
 * A session, pre-wired: every turn is aborted with the step and its text
 * lands on the step's stream. `harness` is the package object underneath.
 * A turn with an `output` that produces no valid value rejects, after its
 * message is committed; `DEFAULT` is the agent's own `output`.
 */
export interface Session<DEFAULT extends Output.Output = never> {
  generate<OUTPUT extends Output.Output = DEFAULT>(
    input: SessionInput,
    options?: TurnOptions<OUTPUT>
  ): Promise<SessionReply<OUTPUT>>;
  readonly harness: SessionHarness | HarnessSession;
  readonly ref: SessionRef;
  stream<OUTPUT extends Output.Output = DEFAULT>(
    input: SessionInput,
    options?: TurnOptions<OUTPUT>
  ): SessionStream<OUTPUT>;
}

/**
 * An agent definition you can use directly: each call is one turn on a
 * fresh session, in the calling step when there is one. For a
 * conversation, open a session with `agents.session(agent)`.
 */
export interface Agent<DEFAULT extends Output.Output = never>
  extends AgentDefinition<DEFAULT> {
  generate<OUTPUT extends Output.Output = DEFAULT>(
    input: SessionInput,
    options?: TurnOptions<OUTPUT>
  ): Promise<SessionReply<OUTPUT>>;
  stream<OUTPUT extends Output.Output = DEFAULT>(
    input: SessionInput,
    options?: TurnOptions<OUTPUT>
  ): SessionStream<OUTPUT>;
}

/** A declared workspace you can use: its handle, loaded on first use. */
export type WorkspaceInstance = WorkspaceDefinition & WorkspaceHandle;

/**
 * A declared sandbox you can use: its handle's `exec`, `close`, and
 * facets, started by the first call that needs the container, in the
 * calling step when there is one (and closed with it), else kept until
 * `close` or the runtime's `dispose`. Its `id` stays the definition's.
 */
export type SandboxInstance = SandboxDefinition &
  Pick<
    SandboxHandle,
    | "close"
    | "commands"
    | "exec"
    | "ports"
    | "processes"
    | "services"
    | "shell"
    | "volumes"
  > & {
    /** The container's filesystem; a files sandbox's seed map stays on its spec. */
    readonly filesystem: SandboxHandle["files"];
  };

/** A declared artifact you can use: each `write` adds a version. */
export interface ArtifactInstance extends ArtifactDefinition {
  /** The current version, or undefined before the first write. */
  latest(): Promise<LatestArtifact | undefined>;
  write(
    files: ArtifactFiles,
    options?: ArtifactWriteOptions
  ): Promise<ArtifactVersion>;
}

export interface Agents {
  session<OUTPUT extends Output.Output = never>(
    agent: AgentDefinition<OUTPUT>,
    options?: SessionOptions
  ): Promise<Session<OUTPUT>>;
}

/**
 * A directory, as `@foundry/workspaces` has it: `files()` and `entries()`
 * with kind and metadata, `read`, `save`, `createFile`, `refresh`,
 * `summary`, and `scan`, loaded at the first call. `git` carries Marbles'
 * worktree defaults. Registry operations (`rename`, `remove`) are the host's.
 */
export type WorkspaceHandle = Pick<
  PackageWorkspace,
  | "createFile"
  | "entries"
  | "files"
  | "read"
  | "refresh"
  | "registration"
  | "save"
  | "scan"
  | "summary"
> & {
  /** Throws when the directory is not a git repository. */
  readonly git: Git;
  readonly root: string;
};

/** A workspace already loaded, so its registry identity is known. */
export type LoadedWorkspace = WorkspaceHandle &
  Pick<PackageWorkspace, "id" | "source">;

export interface Workspaces {
  /** The config's own directory. */
  readonly current: WorkspaceHandle;
  load(
    ref: WorkspaceDefinition | { readonly path: string }
  ): Promise<LoadedWorkspace>;
}

/**
 * A running sandbox: the `@foundry/sandbox` container (`commands`,
 * `files`, `processes`, `shell`, `ports`, `services`, `volumes`), with
 * Marbles' defaults. In a step every call carries the step's signal and
 * `exec` output lands on its stream. `exec` is `commands.exec`.
 */
export type SandboxHandle = Omit<Container, "row"> & {
  exec(
    command: SandboxCommand,
    options?: SandboxExecOptions
  ): Promise<SandboxExecResult>;
};

export interface Sandboxes {
  open(id: string): Promise<SandboxHandle>;
  start(sandbox: SandboxDefinition | SandboxSpec): Promise<SandboxHandle>;
}

/**
 * Files by path: text, bytes, or any of the package's file inputs (a blob
 * already stored, an explicit `mime`).
 */
export type ArtifactFiles = Readonly<
  Record<string, string | Uint8Array | FileInput>
>;

/** A value as JSON carries it: dates become ISO strings. */
type AsJson<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends Date
    ? string
    : T extends readonly (infer U)[]
      ? readonly AsJson<U>[]
      : T extends object
        ? { readonly [K in keyof T]: AsJson<T[K]> }
        : T;

/**
 * One version of an artifact: the `@foundry/artifacts` Content, as JSON,
 * since a step returns it and a run records it. `id` is the version's own
 * id; `digest`, `state`, `tag`, `metadata` (with the run and session that
 * wrote it), `tree`, and the timestamps (ISO strings) come with it.
 */
export type ArtifactVersion = AsJson<Content>;

/** An artifact by its declaration, or by the id the package gave it. */
export type ArtifactRef = ArtifactDefinition | string;

export interface ArtifactWriteOptions {
  /** Merged into the new version's metadata. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** `false` changes only the files given and keeps the rest; replaces by default. */
  readonly replace?: boolean;
}

/** An artifact's current version, with its files to read. */
export interface LatestArtifact {
  /** A file's bytes; undefined when the version has no such file. */
  bytes(path: string): Promise<Uint8Array | undefined>;
  /** A file as UTF-8 text; undefined when the version has no such file. */
  text(path: string): Promise<string | undefined>;
  readonly version: ArtifactVersion;
}

export interface Artifacts {
  create(
    input: Pick<
      CreateArtifactInput,
      "freeze" | "metadata" | "name" | "type"
    > & {
      readonly entries?: ArtifactFiles;
    }
  ): Promise<ArtifactVersion>;
  /** The artifact and its current version, or null when it has none yet. */
  get(artifact: ArtifactRef): Promise<ArtifactResolved | null>;
  getContent(versionId: string): Promise<ContentResolved | null>;
  /**
   * The artifact's current version, or undefined before its first. A
   * declared artifact is per workspace, so this is what an earlier run in
   * this workspace left. Under `--dry-run` it reads the real store.
   */
  latest(artifact: ArtifactRef): Promise<LatestArtifact | undefined>;
  /** Every version, oldest first. */
  listContents(artifact: ArtifactRef): Promise<readonly ContentSummary[]>;
  readFile(versionId: string, path: string): Promise<FileResolved | null>;
  /** The version's entry file: `metadata.entry`, the only file, or `index.html`. */
  readRoot(versionId: string): Promise<FileResolved | null>;
  /** Adds a version to the declared artifact. */
  write(
    artifact: ArtifactDefinition,
    files: ArtifactFiles,
    options?: ArtifactWriteOptions
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
