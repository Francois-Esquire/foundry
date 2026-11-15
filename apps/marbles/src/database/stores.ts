import { join } from "node:path";
import type { ArtifactOperations } from "@foundry/artifacts";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import type { ContainerStore } from "@foundry/sandbox/store";
import { createSqliteContainerStore } from "@foundry/sandbox/store/sqlite";
import type { WorkspaceStore } from "@foundry/workspaces/store";
import { SqliteWorkspaceStore } from "@foundry/workspaces/store/sqlite";
import { removeShares } from "~/database/associations";
import { surfacingBusy } from "~/database/busy";
import { ChangeRecorder } from "~/database/changes";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";
import type { Fact } from "~/lib/events/source";
import {
  ARTIFACTS,
  SANDBOXES,
  sourceKey,
  WORKSPACES,
} from "~/lib/events/source";

/**
 * A workspace's artifacts, sandbox containers and workspace catalogue in
 * the Marbles database: each package's own SQLite store, scoped by the
 * workspace id, over the handle the host keeps open. The stores are
 * handed over as the packages make them, so every rule of theirs (a write
 * owned from the call, a value they cannot store refused, one call at a
 * time) is the package's, not Marbles' again; only a lock waited on too
 * long surfaces as Marbles says it, a `DatabaseBusyError`
 * (`surfacingBusy`). Each records its change facts in the workspace's
 * change log through its `onCommit` hook (`database/changes.ts`); who
 * holds each container row is on the row itself (`lib/sandbox/holders.ts`).
 * An artifact the commit deletes also takes its shares
 * (`marbles_resource_workspaces`) with it, in the same transaction.
 *
 * An artifact's records are rows; its bytes past the inline limit are blob
 * files on disk, which the package stages and names. Each workspace keeps
 * those under a directory of its own in the artifact store
 * (`artifactBlobs`), as its records are a scope of their own.
 */

export interface WorkspaceStores {
  /** The records of the workspace's artifacts and feed. */
  readonly artifacts: SqliteArtifactStore;
  /** The rows of the containers the workspace's sandboxes run in. */
  readonly containers: ContainerStore;
  /** The workspace catalogue's registrations and entries. */
  readonly workspaces: WorkspaceStore;
}

/**
 * Every store of the workspace `scope` (its id) over `database`, each
 * recording its change facts through `changes`: the recorder every store
 * of the workspace in this process shares, so a commit wakes delivery at
 * once; one of their own when omitted, whose commits delivery notices on
 * its next tick.
 */
export function workspaceStores(
  database: StoreDatabase,
  scope: string,
  changes: ChangeRecorder = new ChangeRecorder(scope)
): WorkspaceStores {
  const recorded =
    (source: string) =>
    (
      transaction: Parameters<ChangeRecorder["record"]>[0],
      write: { readonly events?: readonly Fact[] }
    ) =>
      changes.record(transaction, source, write.events);
  return {
    artifacts: surfacingBusy(
      changes.causing(
        new SqliteArtifactStore({
          database,
          onCommit: async (transaction, write) => {
            await recorded(ARTIFACTS_KEY)(transaction, write);
            // An artifact's shares go with it, in the same transaction.
            await removeShares(
              transaction,
              "artifact",
              scope,
              write.deleteArtifacts ?? []
            );
          },
          scope,
        })
      )
    ),
    containers: surfacingBusy(
      changes.causing(
        createSqliteContainerStore({
          database,
          onCommit: recorded(SANDBOXES_KEY),
          scope,
        })
      )
    ),
    workspaces: surfacingBusy(
      changes.causing(
        new SqliteWorkspaceStore({
          database,
          onCommit: recorded(WORKSPACES_KEY),
          scope,
        })
      )
    ),
  };
}

const ARTIFACTS_KEY = sourceKey(ARTIFACTS) ?? "artifacts";
const SANDBOXES_KEY = sourceKey(SANDBOXES) ?? "sandboxes";
const WORKSPACES_KEY = sourceKey(WORKSPACES) ?? "workspaces";

/**
 * Where the workspace `scope` keeps its artifacts' blob files, in the
 * artifact store at `dir`: `<dir>/workspaces/<id>/blobs`. A directory per
 * scope, so a manager sweeping the files its records no longer name
 * (`ArtifactManager.recover`) never reaches another workspace's.
 */
export function artifactBlobs(dir: string, scope: string): string {
  return join(dir, "workspaces", scope, "blobs");
}

/**
 * The workspace `scope`'s artifacts as a real run left them in the Marbles
 * database at the state root `state`, read only: each call opens a
 * read-only connection (`readDatabase`), reads, loading any file's bytes,
 * and closes it, so nothing is created, migrated or written. With no
 * database, or nothing migrated into it, there is nothing to find. For
 * `--dry-run`, whose own artifacts are in memory.
 */
export function readArtifacts(
  state: string,
  dir: string,
  scope: string
): Pick<ArtifactOperations, "get" | "readFile"> {
  const files = blobFiles(artifactBlobs(dir, scope));
  const read = async <T>(
    work: (artifacts: ArtifactManager) => Promise<T | null>
  ): Promise<T | null> =>
    (await readDatabase(stateDatabase(state), (database) =>
      work(
        new ArtifactManager({
          files,
          store: new SqliteArtifactStore({ database, scope }),
        })
      )
    )) ?? null;
  return {
    get: (id) => read((artifacts) => artifacts.get(id)),
    readFile: (contentId, path) =>
      read((artifacts) => artifacts.readFile(contentId, path)),
  };
}
