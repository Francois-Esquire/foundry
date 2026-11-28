import type { Output } from "ai";
import type { AnyDefinition, LockedNode } from "~/lib/definitions";
import type { MonitorRecord } from "~/lib/definitions/registry";
import type {
  AgentLike,
  ArtifactDefinition,
  SandboxDefinition,
  WorkspaceDefinition,
} from "~/lib/definitions/types";
import type { ProviderPlugin } from "~/lib/providers/plugins";
import type { Schedule } from "~/lib/schedule/triggers";
import { configOf } from "./config";
import type {
  CollectInput,
  WorkspaceInput,
  WorkspaceModule,
} from "./declarations";
import {
  isAgent,
  isArtifactDefinition,
  isDeclarationItem,
  isDefinition,
  isModuleNamespace,
  isModuleSource,
  isMonitorRecord,
  isObserver,
  isSandboxDefinition,
  isSchedule,
  isWorkspaceDeclaration,
  isWorkspaceDefinition,
  isWorkspaceInput,
  taggedProvider,
} from "./declarations";
import type { Observer } from "./observe";

interface PendingEntry<T> {
  readonly exportKey?: string;
  readonly file?: string;
  readonly value: T;
}

export interface PendingBatch {
  readonly agents: PendingEntry<AgentLike<Output.Output>>[];
  readonly artifacts: PendingEntry<ArtifactDefinition>[];
  readonly configs: { readonly file: string; readonly value: unknown }[];
  readonly definitions: PendingEntry<AnyDefinition>[];
  readonly monitors: PendingEntry<MonitorRecord>[];
  readonly observers: PendingEntry<Observer>[];
  readonly providers: PendingEntry<{
    readonly declaration: object;
    readonly plugin: ProviderPlugin;
  }>[];
  readonly sandboxes: PendingEntry<SandboxDefinition>[];
  readonly schedules: PendingEntry<Schedule>[];
  readonly workspaces: PendingEntry<WorkspaceDefinition>[];
}

export function normalizedPath(file: string): string {
  const unix = file.replaceAll("\\", "/");
  const rooted = unix.startsWith("/");
  const stack: string[] = [];
  for (const part of unix.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (stack.length > 0 && stack.at(-1) !== "..") {
        stack.pop();
      } else if (!rooted) {
        stack.push("..");
      }
      continue;
    }
    stack.push(part);
  }
  return `${rooted ? "/" : ""}${stack.join("/")}` || (rooted ? "/" : ".");
}

function collectWorkspacesFromValue(
  value: unknown,
  workspaces: Set<string>,
  seen: Set<object> = new Set()
): void {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  if (isWorkspaceDefinition(value)) {
    workspaces.add(value.path);
    return;
  }
  if (isSandboxDefinition(value)) {
    if ("mount" in value && isWorkspaceDefinition(value.mount)) {
      workspaces.add(value.mount.path);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectWorkspacesFromValue(item, workspaces, seen);
    }
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    for (const member of Object.values(value)) {
      collectWorkspacesFromValue(member, workspaces, seen);
    }
  }
}

export function walkStaticTree(
  node: LockedNode,
  ownerName: string,
  path: readonly string[],
  workspaces: Set<string>,
  identities: Map<AnyDefinition, string>,
  nested?: Set<AnyDefinition>
): void {
  collectWorkspacesFromValue(node.literal, workspaces);
  nested?.add(node.definition);
  if (node.definition.name === undefined && !identities.has(node.definition)) {
    identities.set(
      node.definition,
      `${ownerName}:${path.join(".") || "$root"}`
    );
  }
  for (const [key, child] of node.children) {
    walkStaticTree(
      child,
      ownerName,
      [...path, key],
      workspaces,
      identities,
      nested
    );
  }
}

function entryMeta(
  file: string | undefined,
  exportKey?: string
): { readonly exportKey?: string; readonly file?: string } {
  return {
    ...(exportKey === undefined ? {} : { exportKey }),
    ...(file === undefined ? {} : { file }),
  };
}

function addResourceToBatch(
  batch: PendingBatch,
  value: unknown,
  file: string | undefined
): boolean {
  const meta = file === undefined ? {} : { file };
  if (isWorkspaceDefinition(value)) {
    batch.workspaces.push({ ...meta, value });
    return true;
  }
  if (isSandboxDefinition(value)) {
    batch.sandboxes.push({ ...meta, value });
    return true;
  }
  if (isArtifactDefinition(value)) {
    batch.artifacts.push({ ...meta, value });
    return true;
  }
  const plugin = taggedProvider(value);
  if (plugin !== undefined) {
    batch.providers.push({
      ...meta,
      value: { declaration: value as object, plugin },
    });
    return true;
  }
  return false;
}

function addTriggerToBatch(
  batch: PendingBatch,
  value: unknown,
  file: string | undefined,
  exportKey?: string
): boolean {
  if (isObserver(value)) {
    batch.observers.push({ ...entryMeta(file, exportKey), value });
    return true;
  }
  if (isSchedule(value)) {
    batch.schedules.push({ ...entryMeta(file, exportKey), value });
    return true;
  }
  if (isMonitorRecord(value)) {
    batch.monitors.push({ ...(file === undefined ? {} : { file }), value });
    return true;
  }
  return false;
}

function workspaceInputItems(wsInput: WorkspaceInput): readonly unknown[] {
  const groups: readonly (readonly unknown[] | undefined)[] = [
    wsInput.declarations,
    wsInput.definitions,
    wsInput.agents,
    wsInput.artifacts,
    wsInput.sandboxes,
    wsInput.workspaces,
    wsInput.observers,
    wsInput.monitors,
    wsInput.schedules,
  ];
  return groups.flatMap((group) => group ?? []);
}

export function collectBatch(
  input: CollectInput,
  allocateScope?: (prefix: string) => string
): PendingBatch {
  const batch: PendingBatch = {
    agents: [],
    artifacts: [],
    configs: [],
    definitions: [],
    monitors: [],
    observers: [],
    providers: [],
    sandboxes: [],
    schedules: [],
    workspaces: [],
  };
  const seenWorkspaces = new Set<object>();
  let localSyntheticScope = 0;

  const nextScope =
    allocateScope ??
    ((prefix: string): string => {
      localSyntheticScope += 1;
      return `\0synthetic:${prefix}#${String(localSyntheticScope)}`;
    });

  const visitValue = (
    value: unknown,
    file: string | undefined,
    exportKey?: string
  ): void => {
    if (value === null || value === undefined) {
      return;
    }
    if (isWorkspaceDeclaration(value)) {
      if (!seenWorkspaces.has(value)) {
        seenWorkspaces.add(value);
        visitWorkspaceInput(value.input, file);
      }
      return;
    }
    if (isDefinition(value)) {
      batch.definitions.push({ ...entryMeta(file, exportKey), value });
      return;
    }
    if (isAgent(value)) {
      batch.agents.push({ ...entryMeta(file, exportKey), value });
      return;
    }
    if (addResourceToBatch(batch, value, file)) {
      return;
    }
    addTriggerToBatch(batch, value, file, exportKey);
  };

  const visitModule = (
    exportsObject: WorkspaceModule,
    file: string | undefined
  ): void => {
    if ("default" in exportsObject && exportsObject.default !== undefined) {
      const defaultValue = exportsObject.default;
      const scopeFile = file ?? nextScope("module");
      if (configOf(scopeFile, defaultValue) === undefined) {
        visitValue(defaultValue, file, "default");
      } else {
        batch.configs.push({ file: scopeFile, value: defaultValue });
      }
    }
    for (const [key, value] of Object.entries(exportsObject)) {
      if (key !== "default") {
        visitValue(value, file, key);
      }
    }
  };

  const visitWorkspaceInput = (
    wsInput: WorkspaceInput,
    parentFile: string | undefined
  ): void => {
    let scopeFile = wsInput.source ?? parentFile;
    if (wsInput.config !== undefined) {
      scopeFile = scopeFile ?? nextScope("workspace-config");
      batch.configs.push({ file: scopeFile, value: wsInput.config });
    }
    for (const mod of wsInput.modules ?? []) {
      if (isModuleSource(mod)) {
        visitModule(mod.exports, mod.file ?? scopeFile);
      } else {
        visitModule(mod, scopeFile);
      }
    }
    for (const item of workspaceInputItems(wsInput)) {
      visitValue(item, scopeFile);
    }
    for (const item of wsInput.providers ?? []) {
      const original = taggedProvider(item) ?? item;
      batch.providers.push({
        ...(scopeFile === undefined ? {} : { file: scopeFile }),
        value: { declaration: item, plugin: original },
      });
    }
  };

  const visitTop = (item: CollectInput): void => {
    if (Array.isArray(item)) {
      for (const each of item) {
        visitTop(each);
      }
      return;
    }
    if (isModuleSource(item)) {
      visitModule(item.exports, item.file);
      return;
    }
    if (typeof item === "object" && item !== null && isModuleNamespace(item)) {
      visitModule(item as WorkspaceModule, undefined);
      return;
    }
    if (isDeclarationItem(item)) {
      visitValue(item, undefined);
      return;
    }
    if (isWorkspaceInput(item)) {
      visitWorkspaceInput(item, undefined);
      return;
    }
    visitModule(item as WorkspaceModule, undefined);
  };

  visitTop(input);
  return batch;
}
