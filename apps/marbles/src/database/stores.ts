import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import type { ContainerStore } from "@foundry/sandbox/store";
import { SqliteContainerStore } from "@foundry/sandbox/store/sqlite";
import type { WorkspaceStore } from "@foundry/workspaces/store";
import { SqliteWorkspaceStore } from "@foundry/workspaces/store/sqlite";
import { removeShares } from "~/database/associations";
import { surfacingBusy } from "~/database/busy";
import { ChangeRecorder } from "~/database/changes";
import type { StoreDatabase } from "~/database/types";
import type { Fact } from "~/lib/events/source";
import {
  ARTIFACTS,
  SANDBOXES,
  sourceKey,
  WORKSPACES,
} from "~/lib/events/source";

export interface WorkspaceStores {
  readonly artifacts: SqliteArtifactStore;
  readonly containers: ContainerStore;
  readonly workspaces: WorkspaceStore;
}

export function workspaceStores(
  database: StoreDatabase,
  scope: string,
  options: {
    readonly changes?: ChangeRecorder;
    readonly location?: string;
  } = {}
): WorkspaceStores {
  const { location } = options;
  const changes = options.changes ?? new ChangeRecorder(scope);
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
        new SqliteContainerStore({
          database,
          onCommit: recorded(SANDBOXES_KEY),
          scope,
          ...(location === undefined ? {} : { location }),
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
