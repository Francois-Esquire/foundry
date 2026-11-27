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
import type { McpServerDefinition } from "@foundry/agents/mcp";
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
import type { Authorization, GrantId } from "@foundry/authorization";
import type {
  Container,
  ContainerSandboxConstraints,
  SandboxCommand,
  SandboxExecOptions,
  SandboxExecResult,
} from "@foundry/sandbox";
import type { Workspace as PackageWorkspace } from "@foundry/workspaces";
import type { Git } from "@foundry/workspaces/node/git";
import type {
  InferGenerateOutput,
  Output,
  StreamTextResult,
  ToolSet,
} from "ai";
import type { Exec } from "~/lib/command-error";
import type { AGENT_PROMPT } from "~/lib/handles";
import type { Log } from "~/lib/log";

export interface SkillOp {
  readonly glob?: string;
  readonly kind: "load" | "add" | "pick" | "skill";
  readonly names?: readonly string[];
  readonly skill?: Skill;
}

export interface SkillSet {
  add(source: string | Skill): SkillSet;
  readonly kind: "skills";
  readonly ops: readonly SkillOp[];
  pick(...names: readonly string[]): SkillSet;
}

export type { TurnOptions } from "@foundry/agents/harness";

export type AgentSettings<OUTPUT extends Output.Output = never> =
  TurnCallSettings<OUTPUT>;

export type AgentMcpServer = Omit<McpServerDefinition, "enabled">;

export interface AgentRoute {
  readonly model?: string;
  readonly provider?: string;
}

export interface AgentDefinition<OUTPUT extends Output.Output = never>
  extends AgentRoute {
  readonly id: string;
  readonly kind: "agent";
  readonly mcp?: readonly AgentMcpServer[];
  readonly prompt: string;
  readonly settings?: AgentSettings<OUTPUT>;
  readonly skills?: SkillSet;
  readonly [AGENT_PROMPT]?: (harness: string) => string;
}

export interface WorkspaceDefinition {
  readonly id: string;
  readonly kind: "workspace";
  readonly path: string;
}

export type SandboxResources = NonNullable<
  ContainerSandboxConstraints["resources"]
>;

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

export interface ImageSandbox extends SandboxOptions {
  readonly executable?: boolean;
  readonly image: string;
  readonly mount?: "." | WorkspaceDefinition;
  readonly target?: string;
}

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
  readonly implementation?: string;
  readonly input?: unknown;
  readonly instance?: string;
  readonly model?: string;
  readonly noInput?: true;
  readonly provider?: string;
}

interface SharedSessionOptions {
  readonly compaction?: boolean | Partial<CompactionSettings>;
  readonly session?: SessionRef | Session<Output.Output>;
}

interface HostSessionOptions extends SharedSessionOptions {
  readonly apiKey?: never;
  readonly authority?: never;
  readonly authorization?: Authorization;
  readonly cwd?: string;
  readonly maxTurns?: number;
  readonly oauthToken?: never;
  readonly profile?: never;
  readonly question?: never;
  readonly sandbox?: never;
}

export interface SandboxAgentOptions extends SharedSessionOptions {
  readonly apiKey?: string;
  readonly authority?: Partial<
    Pick<
      HarnessAuthoritySettings,
      "approve" | "authorization" | "onApprovalRequest" | "principalAttributes"
    >
  >;
  readonly cwd?: never;
  readonly maxTurns?: never;

  readonly oauthToken?: string;
  readonly profile?: HarnessPermissionProfile;
  readonly question?: HarnessQuestionCallback;
  readonly sandbox: SandboxHandle | SandboxInstance;
}

export type SessionOptions = HostSessionOptions | SandboxAgentOptions;

export type SessionReply<OUTPUT extends Output.Output = never> =
  SessionMessage & {
    readonly text: string;
    readonly output: InferGenerateOutput<OUTPUT>;
    readonly usage: SessionUsage;
    readonly result?: StreamTextResult<
      ToolSet,
      Record<string, unknown>,
      OUTPUT
    >;
  };

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

interface AgentCalls<DEFAULT extends Output.Output> {
  generate<OUTPUT extends Output.Output = DEFAULT>(
    input: SessionInput,
    options?: TurnOptions<OUTPUT>
  ): Promise<SessionReply<OUTPUT>>;
  stream<OUTPUT extends Output.Output = DEFAULT>(
    input: SessionInput,
    options?: TurnOptions<OUTPUT>
  ): SessionStream<OUTPUT>;
}

type AgentChanges<OUTPUT extends Output.Output> = Pick<
  AgentDefinition<OUTPUT>,
  "model" | "provider" | "settings"
>;

export interface Agent<DEFAULT extends Output.Output = never>
  extends AgentDefinition<DEFAULT>,
    AgentCalls<DEFAULT> {
  extend<OUTPUT extends Output.Output = DEFAULT>(
    changes: AgentChanges<OUTPUT>
  ): Agent<OUTPUT>;
}

declare const DEFERRED_OUTPUT: unique symbol;

export interface DeferredAgent<
  DEFAULT extends Output.Output = never,
  INPUT = undefined,
> extends AgentRoute,
    AgentCalls<DEFAULT> {
  extend<OUTPUT extends Output.Output = DEFAULT>(
    changes: AgentChanges<OUTPUT> & { readonly input?: INPUT }
  ): DeferredAgent<OUTPUT, INPUT>;
  readonly id: string;
  readonly input?: INPUT;
  readonly kind: "agent";
  readonly prompt?: never;
  readonly [DEFERRED_OUTPUT]?: DEFAULT;
}

export type AgentLike<OUTPUT extends Output.Output = never> =
  | AgentDefinition<OUTPUT>
  | DeferredAgent<OUTPUT, unknown>;

export type WorkspaceInstance = WorkspaceDefinition & WorkspaceHandle;

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
    readonly filesystem: SandboxHandle["files"];
  };

export interface ArtifactInstance extends ArtifactDefinition {
  latest(): Promise<LatestArtifact | undefined>;
  write(
    files: ArtifactFiles,
    options?: ArtifactWriteOptions
  ): Promise<ArtifactVersion>;
}

export interface Agents {
  session<OUTPUT extends Output.Output = never>(
    agent: AgentLike<OUTPUT>,
    options?: SessionOptions
  ): Promise<Session<OUTPUT>>;
}

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
  readonly git: Git;
  readonly root: string;
};

export type LoadedWorkspace = WorkspaceHandle &
  Pick<PackageWorkspace, "id" | "source">;

export interface ScopedWorkspaces {
  readonly current: WorkspaceHandle;
  load(
    ref: WorkspaceDefinition | { readonly path: string }
  ): Promise<LoadedWorkspace>;
}

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

export type ArtifactFiles = Readonly<
  Record<string, string | Uint8Array | FileInput>
>;

type AsJson<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends Date
    ? string
    : T extends readonly (infer U)[]
      ? readonly AsJson<U>[]
      : T extends object
        ? { readonly [K in keyof T]: AsJson<T[K]> }
        : T;

export type ArtifactVersion = AsJson<Content>;

export type ArtifactRef = ArtifactDefinition | string;

export interface ArtifactWriteOptions {
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly replace?: boolean;
}

export interface LatestArtifact {
  bytes(path: string): Promise<Uint8Array | undefined>;
  text(path: string): Promise<string | undefined>;
  readonly version: ArtifactVersion;
}

export interface ScopedArtifacts {
  create(
    input: Pick<
      CreateArtifactInput,
      "freeze" | "metadata" | "name" | "type"
    > & {
      readonly entries?: ArtifactFiles;
    }
  ): Promise<ArtifactVersion>;
  get(artifact: ArtifactRef): Promise<ArtifactResolved | null>;
  getContent(versionId: string): Promise<ContentResolved | null>;
  latest(artifact: ArtifactRef): Promise<LatestArtifact | undefined>;
  listContents(artifact: ArtifactRef): Promise<readonly ContentSummary[]>;
  readFile(versionId: string, path: string): Promise<FileResolved | null>;
  readRoot(versionId: string): Promise<FileResolved | null>;
  write(
    artifact: ArtifactDefinition,
    files: ArtifactFiles,
    options?: ArtifactWriteOptions
  ): Promise<ArtifactVersion>;
}

export interface Question {
  readonly body?: string;
  readonly choices?: readonly string[];
  readonly key?: string;
  readonly title: string;
}

export interface ApprovalRequest {
  readonly body?: string;
  readonly grantId?: GrantId;
  readonly key?: string;
  readonly title: string;
}

export interface Approval {
  readonly approved: boolean;
  readonly grantId?: GrantId;
  readonly note?: string;
}

export interface Ask {
  approval(request: ApprovalRequest): Promise<Approval>;
  question(question: Question): Promise<string>;
}

export interface ReportEntry {
  readonly body?: string;
  readonly key?: string;
  readonly media?: readonly string[];
  readonly title: string;
}

export interface Report {
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

export interface Run {
  abort(reason?: unknown): void;
  readonly id: string;
  readonly path: readonly string[];
  readonly session: SessionRef;
  readonly signal: AbortSignal;
  readonly stream: ReadableStream<unknown>;
}

export interface Context<I = Record<string, never>> {
  readonly agents: Agents;
  readonly artifacts: ScopedArtifacts;
  readonly ask: Ask;
  readonly exec: Exec;
  readonly input: I;
  readonly log: Log;
  readonly report: Report;
  readonly run: Run;
  readonly sandboxes: Sandboxes;
  readonly signal: AbortSignal;
  readonly stream: Stream;
  readonly workspaces: ScopedWorkspaces;
}

export interface SetupContext<I> {
  readonly input: I;
  readonly log: Log;
  readonly run: { readonly id: string };
}
