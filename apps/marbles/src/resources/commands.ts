import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { LinksReport } from "~/database/links";
import { rebuildLinks } from "~/database/links";
import { writeDatabase } from "~/database/open";
import type { ViewScope } from "~/database/resources";
import {
  ALL_WORKSPACES,
  readResourceView,
  resourceAssociations,
} from "~/database/resources";
import { recordedWorkspaces } from "~/database/workspaces";
import { resourceLinks, stateDatabase } from "~/layout";
import type { ResourceKind, ResourceRef } from "~/lib/resources";
import { ResourceAssociationError, refuseUnshareable } from "~/lib/resources";
import type { Workspace } from "~/lib/state/workspace";
import { workspaceState } from "~/lib/state/workspace";
import { resourceLines } from "~/resources/text";

export interface ResourceCommandContext {
  readonly artifacts: string;
  readonly directory: string;
  readonly print: (line: string) => void;
  readonly state: string;
  readonly workspace: Workspace;
}

export async function listResources(
  kind: ResourceKind,
  all: boolean,
  context: ResourceCommandContext
): Promise<void> {
  const here = context.workspace.id;
  const scope: ViewScope = all ? ALL_WORKSPACES : { workspace: here };
  const lines = await readResourceView(context.state, scope, (view) =>
    resourceLines(kind, view, here)
  );
  for (const line of lines ?? []) {
    context.print(line);
  }
}

export interface AssociationRequest {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly with: string;
}

export async function changeAssociation(
  change: "share" | "unshare",
  request: AssociationRequest,
  context: ResourceCommandContext
): Promise<void> {
  if (change === "share") {
    refuseUnshareable(request.kind);
  }
  const other = otherWorkspace(request.with, context);
  const ref = await shownHere(request, context);
  const changed = await writeDatabase(
    stateDatabase(context.state),
    (database) =>
      resourceAssociations(database, context.state)[change](ref, other.id)
  );
  if (changed === undefined) {
    throw new ResourceAssociationError(
      `no ${request.kind} ${request.id} in this workspace`
    );
  }
  const verb = change === "share" ? "shared with" : "unshared from";
  context.print(
    `${changed ? "" : "already "}${verb} ${other.root}: ${ref.kind} ${ref.id}`
  );
  if (ref.kind === "artifact") {
    await relinkOne(other, context);
  }
}

export async function relink(
  all: boolean,
  context: ResourceCommandContext
): Promise<void> {
  const workspaces = all
    ? (await recordedWorkspaces(context.state)).map((record) => ({
        id: record.id,
        root: record.root,
      }))
    : [context.workspace];
  for (const workspace of workspaces) {
    if (!existsSync(workspace.root)) {
      context.print(`${workspace.root}: not here, left as it is`);
    } else if (all) {
      try {
        await relinkOne(workspace, context);
      } catch (error) {
        context.print(
          `${workspace.root}: not relinked: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else {
      await relinkOne(workspace, context);
    }
  }
}

async function relinkOne(
  workspace: Pick<Workspace, "id" | "root">,
  context: ResourceCommandContext
): Promise<void> {
  const report = await readResourceView(
    context.state,
    { workspace: workspace.id },
    (view) =>
      rebuildLinks({
        artifacts: context.artifacts,
        root: workspace.root,
        view,
        workspace: workspace.id,
      })
  );
  for (const line of reportLines(workspace.root, report)) {
    context.print(line);
  }
}

function reportLines(root: string, report: LinksReport | undefined): string[] {
  const dir = resourceLinks(root, "artifact");
  if (report === undefined) {
    return [`${dir}: no Marbles database yet, nothing to link`];
  }
  return [
    `${dir}: ${String(report.linked)} linked${report.unlinkable === 0 ? "" : `, ${String(report.unlinkable)} left unlinked (no one blob file holds it, or no name can)`}`,
    ...report.kept.map(
      (path) => `  ${path}: not a link Marbles made, left as it is`
    ),
    ...report.refused.map(
      (path) => `  ${path}: goes through a link or a file, not linked`
    ),
  ];
}

function otherWorkspace(
  directory: string,
  context: ResourceCommandContext
): Workspace {
  const root = resolve(context.directory, directory);
  if (!existsSync(root)) {
    throw new ResourceAssociationError(`no directory ${root}`);
  }
  return workspaceState(context.state, root);
}

async function shownHere(
  request: AssociationRequest,
  context: ResourceCommandContext
): Promise<ResourceRef> {
  const found =
    (await readResourceView(
      context.state,
      { workspace: context.workspace.id },
      (view) => view.find(request.kind, request.id)
    )) ?? [];
  const [ref, ...more] = found;
  if (ref === undefined) {
    throw new ResourceAssociationError(
      `no ${request.kind} ${request.id} in this workspace`
    );
  }
  if (more.length > 0) {
    throw new ResourceAssociationError(
      `${String(found.length)} ${request.kind}s ${request.id} are shown here, from ${found.map((item) => item.owner).join(", ")}; share it from the workspace that owns it`
    );
  }
  return ref;
}
