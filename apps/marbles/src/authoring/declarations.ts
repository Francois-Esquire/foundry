import type { Output } from "ai";
import type { AnyDefinition } from "~/lib/definition";
import type { Handler, Source } from "~/lib/events/source";
import {
  MODULE_SOURCE,
  MONITOR_META,
  OBSERVER_META,
  PROVIDER_DECLARATION,
  WORKSPACE_DECLARATION,
} from "~/lib/handles";
import type { ProviderPlugin } from "~/lib/providers/plugins";
import type { MonitorRecord } from "~/lib/registry";
import type { Schedule } from "~/lib/triggers";
import type {
  AgentLike,
  ArtifactDefinition,
  SandboxDefinition,
  WorkspaceDefinition,
} from "~/lib/types";
import type { MarblesConfig } from "./config";
import type { Observer } from "./observe";

export interface DeclaredObserver {
  readonly handler: Handler<unknown>;
  readonly name: string;
  readonly source: Source;
  readonly timeout?: number;
  readonly types?: readonly string[];
}

export type WorkspaceModule = Readonly<Record<string, unknown>>;

export interface ModuleSource {
  readonly exports: WorkspaceModule;
  readonly file?: string;
  readonly [MODULE_SOURCE]?: true;
}

export type WorkspaceDeclarationItem =
  | AnyDefinition
  | AgentLike<Output.Output>
  | ArtifactDefinition
  | SandboxDefinition
  | WorkspaceDefinition
  | Schedule
  | MonitorRecord
  | Observer
  | ProviderPlugin
  | WorkspaceDeclaration;

export interface WorkspaceInput {
  readonly agents?: readonly AgentLike<Output.Output>[];
  readonly artifacts?: readonly ArtifactDefinition[];
  readonly config?: MarblesConfig;
  readonly declarations?: readonly WorkspaceDeclarationItem[];
  readonly definitions?: readonly AnyDefinition[];
  readonly modules?: readonly (WorkspaceModule | ModuleSource)[];
  readonly monitors?: readonly MonitorRecord[];
  readonly observers?: readonly Observer[];
  readonly providers?: readonly ProviderPlugin[];
  readonly sandboxes?: readonly SandboxDefinition[];
  readonly schedules?: readonly Schedule[];
  readonly source?: string;
  readonly workspaces?: readonly WorkspaceDefinition[];
}

export interface WorkspaceDeclaration {
  readonly input: WorkspaceInput;
  readonly kind: "workspace-declaration";
  readonly [WORKSPACE_DECLARATION]?: true;
}

type CollectItem =
  | WorkspaceDeclaration
  | WorkspaceDeclarationItem
  | ModuleSource
  | WorkspaceModule;

export type CollectInput =
  | WorkspaceDeclaration
  | WorkspaceDeclarationItem
  | WorkspaceInput
  | ModuleSource
  | WorkspaceModule
  | readonly CollectItem[];

export function moduleSource(
  exports: WorkspaceModule,
  file?: string
): ModuleSource {
  const source: ModuleSource =
    file === undefined ? { exports } : { exports, file };
  Object.defineProperty(source, MODULE_SOURCE, {
    enumerable: false,
    value: true,
  });
  return Object.freeze(source);
}

export function defineWorkspace(input: WorkspaceInput): WorkspaceDeclaration {
  const declaration: WorkspaceDeclaration = {
    input,
    kind: "workspace-declaration",
  };
  Object.defineProperty(declaration, WORKSPACE_DECLARATION, {
    enumerable: false,
    value: true,
  });
  return Object.freeze(declaration);
}

const WORKSPACE_INPUT_KEYS = new Set([
  "agents",
  "artifacts",
  "config",
  "declarations",
  "definitions",
  "modules",
  "monitors",
  "observers",
  "providers",
  "sandboxes",
  "schedules",
  "source",
  "workspaces",
]);

export function isWorkspaceDeclaration(
  value: unknown
): value is WorkspaceDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    (WORKSPACE_DECLARATION in value ||
      ("kind" in value &&
        value.kind === "workspace-declaration" &&
        "input" in value))
  );
}

export function isModuleNamespace(value: object): boolean {
  return (
    Object.prototype.toString.call(value) === "[object Module]" ||
    Reflect.get(value, Symbol.toStringTag) === "Module"
  );
}

export function isDefinition(value: unknown): value is AnyDefinition {
  return (
    (typeof value === "function" ||
      (typeof value === "object" && value !== null)) &&
    "kind" in value &&
    (value.kind === "step" || value.kind === "workflow")
  );
}

export function isAgent(value: unknown): value is AgentLike<Output.Output> {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "agent" &&
    "id" in value
  );
}

export function isWorkspaceDefinition(
  value: unknown
): value is WorkspaceDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "workspace" &&
    "path" in value &&
    typeof value.path === "string"
  );
}

export function isSandboxDefinition(
  value: unknown
): value is SandboxDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "sandbox" &&
    "id" in value
  );
}

export function isArtifactDefinition(
  value: unknown
): value is ArtifactDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "artifact" &&
    "name" in value &&
    "type" in value
  );
}

export function isSchedule(value: unknown): value is Schedule {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "schedule" &&
    "trigger" in value
  );
}

export function isMonitorRecord(value: unknown): value is MonitorRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    (MONITOR_META in value ||
      ("handler" in value &&
        "source" in value &&
        "trigger" in value &&
        "key" in value))
  );
}

export function isObserver(value: unknown): value is Observer {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "observer" &&
    OBSERVER_META in value
  );
}

export function taggedProvider(value: unknown): ProviderPlugin | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  return (value as { [PROVIDER_DECLARATION]?: ProviderPlugin })[
    PROVIDER_DECLARATION
  ];
}

export function isDeclarationItem(value: unknown): boolean {
  if (typeof value === "object" && value !== null && isModuleNamespace(value)) {
    return false;
  }
  return (
    isWorkspaceDeclaration(value) ||
    isDefinition(value) ||
    isAgent(value) ||
    isWorkspaceDefinition(value) ||
    isSandboxDefinition(value) ||
    isArtifactDefinition(value) ||
    taggedProvider(value) !== undefined ||
    isObserver(value) ||
    isSchedule(value) ||
    isMonitorRecord(value)
  );
}

export function isModuleSource(value: unknown): value is ModuleSource {
  if (typeof value !== "object" || value === null || isModuleNamespace(value)) {
    return false;
  }
  if (MODULE_SOURCE in value) {
    return true;
  }
  const keys = Object.keys(value);
  if (
    keys.length === 0 ||
    !keys.includes("exports") ||
    keys.some((key) => key !== "exports" && key !== "file")
  ) {
    return false;
  }
  const fileValue = (value as { file?: unknown }).file;
  if (fileValue !== undefined && typeof fileValue !== "string") {
    return false;
  }
  const exportsValue = (value as { exports?: unknown }).exports;
  return (
    typeof exportsValue === "object" &&
    exportsValue !== null &&
    !isDeclarationItem(exportsValue)
  );
}

export function isWorkspaceInput(value: unknown): value is WorkspaceInput {
  if (typeof value !== "object" || value === null || isModuleNamespace(value)) {
    return false;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return false;
  }
  return entries.every(([key, item]) => {
    if (!WORKSPACE_INPUT_KEYS.has(key)) {
      return false;
    }
    if (key === "config") {
      return typeof item === "object" && item !== null;
    }
    if (key === "source") {
      return typeof item === "string";
    }
    return Array.isArray(item);
  });
}
