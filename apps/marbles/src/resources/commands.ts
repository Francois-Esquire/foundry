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

/**
 * The resource commands of the CLI, all over the Marbles database: the
 * listings read through a view (read only; a state root without a database
 * lists nothing and is left without one), sharing changes associations,
 * and relinking rebuilds a workspace's links from what its view shows.
 */

export interface ResourceCommandContext {
  /** The shared artifact store. */
  readonly artifacts: string;
  /** The directory the command line is relative to. */
  readonly directory: string;
  readonly print: (line: string) => void;
  /** The Marbles state root. */
  readonly state: string;
  /** The workspace the command runs in. */
  readonly workspace: Workspace;
}

/** Print every resource of `kind` this workspace shows, or every workspace's with `all`. */
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
  /** The other workspace's directory, relative to the command line's. */
  readonly with: string;
}

/**
 * Share a resource this workspace shows with the workspace at `with`, or
 * stop sharing it there; an artifact's links in that workspace are rebuilt
 * after.
 */
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

/** Rebuild this workspace's links, or every registered workspace's with `all`. */
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
    if (existsSync(workspace.root)) {
      await relinkOne(workspace, context);
    } else {
      context.print(`${workspace.root}: not here, left as it is`);
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
      rebuildLinks({ artifacts: context.artifacts, root: workspace.root, view })
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
    `${dir}: ${String(report.linked)} linked${report.unlinkable === 0 ? "" : `, ${String(report.unlinkable)} left unlinked (no one blob file holds it)`}`,
    ...report.kept.map((path) => `  ${path}: not a link, left as it is`),
  ];
}

/** The workspace rooted at `directory`. */
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

/** The one resource of `kind` and `id` this workspace shows. */
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
