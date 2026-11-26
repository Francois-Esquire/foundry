import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type ResourceItem,
  resourceDetail,
  resourceItems,
  resourceLines,
} from "~/cli/resources/text";
import type { ViewScope } from "~/database/resources";
import { ALL_WORKSPACES, readResourceView } from "~/database/resources";
import { recordedWorkspaces } from "~/database/workspaces";
import type { ResourceKind } from "~/lib/resources";
import { ResourceAssociationError } from "~/lib/resources";
import type { Workspace } from "~/lib/state/workspace";
import { workspaceState } from "~/lib/state/workspace";

export interface ResourceCommandContext {
  readonly directory: string;
  readonly json?: boolean;
  readonly print: (line: string) => void;
  readonly state: string;
  readonly workspace: Workspace;
}

export interface ResourceScopeInput {
  readonly all: boolean;
  readonly workspace?: string;
}

async function resolveScope(
  input: ResourceScopeInput,
  context: ResourceCommandContext
): Promise<{ readonly here: string; readonly scope: ViewScope }> {
  if (input.all) {
    return { here: context.workspace.id, scope: ALL_WORKSPACES };
  }
  if (input.workspace === undefined) {
    return {
      here: context.workspace.id,
      scope: { workspace: context.workspace.id },
    };
  }
  const target = await resolveWorkspaceTarget(
    context.state,
    context.directory,
    input.workspace
  );
  return { here: target.id, scope: { workspace: target.id } };
}

export async function resolveWorkspaceTarget(
  state: string,
  directory: string,
  target: string
): Promise<{ readonly id: string; readonly root: string }> {
  const resolvedPath = resolve(directory, target);
  const recorded = await recordedWorkspaces(state);
  const matched = recorded.find(
    (entry) => entry.id === target || resolve(entry.root) === resolvedPath
  );
  if (matched !== undefined) {
    return { id: matched.id, root: matched.root };
  }
  if (existsSync(resolvedPath)) {
    const derived = workspaceState(state, resolvedPath);
    return { id: derived.id, root: derived.root };
  }
  throw new ResourceAssociationError(`no workspace "${target}"`);
}

export async function listResources(
  kind: ResourceKind,
  scopeInput: ResourceScopeInput,
  context: ResourceCommandContext
): Promise<void> {
  const { here, scope } = await resolveScope(scopeInput, context);
  if (context.json) {
    const items: ResourceItem[] =
      (await readResourceView(context.state, scope, (view) =>
        resourceItems(kind, view)
      )) ?? [];
    context.print(
      JSON.stringify(
        {
          all: scopeInput.all,
          items,
          kind,
          ...(scope === ALL_WORKSPACES ? {} : { workspace: here }),
        },
        null,
        2
      )
    );
    return;
  }
  const lines = await readResourceView(context.state, scope, (view) =>
    resourceLines(kind, view, here)
  );
  for (const line of lines ?? []) {
    context.print(line);
  }
}

export async function getResource(
  kind: ResourceKind,
  id: string,
  scopeInput: ResourceScopeInput,
  context: ResourceCommandContext
): Promise<void> {
  const { scope } = await resolveScope(scopeInput, context);
  const found = await readResourceView(context.state, scope, (view) =>
    resourceDetail(kind, id, view)
  );
  if (found === undefined) {
    throw new ResourceAssociationError(`no ${kind} "${id}"`);
  }
  if (context.json) {
    context.print(JSON.stringify(found.item, null, 2));
    return;
  }
  for (const line of found.lines) {
    context.print(line);
  }
}
