import { join } from "node:path";
import type { ArtifactOperations } from "@foundry/artifacts";
import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import type { ContainerStore } from "@foundry/sandbox/store";
import { createSqliteContainerStore } from "@foundry/sandbox/store/sqlite";
import type { WorkspaceStore } from "@foundry/workspaces/store";
import { SqliteWorkspaceStore } from "@foundry/workspaces/store/sqlite";
import { surfacingBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import { stateDatabase } from "~/layout";

/**
 * A workspace's artifacts, sandbox containers and workspace catalogue in
 * the Marbles database: each package's own SQLite store, scoped by the
 * workspace id, over the handle the host keeps open. The stores are
 * handed over as the packages make them, so every rule of theirs (a write
 * owned from the call, a value they cannot store refused, one call at a
 * time) is the package's, not Marbles' again; only a lock waited on too
 * long surfaces as Marbles says it, a `DatabaseBusyError`
 * (`surfacingBusy`). Nothing records their
 * changes yet: unlike `tasks.ts` and `sessions.ts`, none of them has an
 * `onCommit` hook here.
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

/** Every store of the workspace `scope` (its id) over `database`. */
export function workspaceStores(
  database: StoreDatabase,
  scope: string
): WorkspaceStores {
  return {
    artifacts: surfacingBusy(new SqliteArtifactStore({ database, scope })),
    containers: surfacingBusy(createSqliteContainerStore({ database, scope })),
    workspaces: surfacingBusy(new SqliteWorkspaceStore({ database, scope })),
  };
}

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
