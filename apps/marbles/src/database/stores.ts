import type { BlobFiles } from "@foundry/artifacts";
import { Artifacts } from "@foundry/artifacts";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { SqliteAuthorizationStore } from "@foundry/authorization/store/sqlite";
import type { ContainerStore } from "@foundry/sandbox/store";
import { SqliteContainerStore } from "@foundry/sandbox/store/sqlite";
import type { WorkspaceStore } from "@foundry/workspaces/store";
import { SqliteWorkspaceStore } from "@foundry/workspaces/store/sqlite";
import { DatabaseActivityStore } from "~/database/activities";
import { DatabaseAutomationStore } from "~/database/automations";
import { surfacingBusy } from "~/database/busy";
import { ChangeRecorder } from "~/database/changes";
import { DatabaseExecutionStore } from "~/database/executions";
import { DatabaseProviderStore } from "~/database/providers";
import { DatabaseRecoveryLog } from "~/database/recoveries";
import { DatabaseRunStore } from "~/database/runs";
import { DatabaseSessionStore } from "~/database/sessions";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { DatabaseTriggerStore } from "~/database/triggers";
import type { StoreDatabase } from "~/database/types";
import { DatabaseUsageStore } from "~/database/usage";
import type { Fact } from "~/lib/events/source";
import {
  ARTIFACTS,
  SANDBOXES,
  sourceKey,
  WORKSPACES,
} from "~/lib/events/source";
import type { OwnerLiveness } from "~/lib/owner-liveness";

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
          onCommit: recorded(ARTIFACTS_KEY),
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

export interface SqliteWorkspaceStoresOptions {
  readonly blobs?: BlobFiles;
  readonly changes?: ChangeRecorder;
  readonly liveness?: OwnerLiveness;
  readonly location?: string;
}

export interface SqliteWorkspaceStores {
  readonly activities: DatabaseActivityStore;
  readonly artifactStore: SqliteArtifactStore;
  readonly artifacts: Artifacts;
  readonly authorization: SqliteAuthorizationStore;
  readonly automations: DatabaseAutomationStore;
  readonly changes: ChangeRecorder;
  readonly containers: ContainerStore;
  readonly executions: DatabaseExecutionStore;
  readonly providers: DatabaseProviderStore;
  readonly records: DatabaseWorkspaceRecords;
  readonly recoveryLog: DatabaseRecoveryLog;
  readonly runs: DatabaseRunStore;
  readonly sessions: DatabaseSessionStore;
  readonly triggers: DatabaseTriggerStore;
  readonly usage: DatabaseUsageStore;
  readonly workspaces: WorkspaceStore;
}

export function assembleSqliteWorkspaceStores(
  database: StoreDatabase,
  scope: string,
  options: SqliteWorkspaceStoresOptions = {}
): SqliteWorkspaceStores {
  const { blobs, liveness, location } = options;
  const records = new DatabaseWorkspaceRecords({
    database,
    scope,
    ...(options.changes === undefined ? {} : { changes: options.changes }),
    ...(liveness === undefined ? {} : { liveness }),
  });
  const { changes } = records;
  const stores = workspaceStores(database, scope, {
    changes,
    ...(location === undefined ? {} : { location }),
  });
  return {
    activities: new DatabaseActivityStore({ database, scope }),
    artifactStore: stores.artifacts,
    artifacts: new Artifacts({
      ...(blobs ? { files: blobs } : {}),
      store: stores.artifacts,
    }),
    authorization: surfacingBusy(
      new SqliteAuthorizationStore({ database, scope })
    ),
    automations: new DatabaseAutomationStore({ database, scope }),
    changes,
    containers: stores.containers,
    executions: new DatabaseExecutionStore({ database, scope }),
    providers: new DatabaseProviderStore({ database }),
    records,
    recoveryLog: new DatabaseRecoveryLog({ database, scope }),
    runs: new DatabaseRunStore({ changes, database, scope }),
    sessions: new DatabaseSessionStore({ changes, database, scope }),
    triggers: new DatabaseTriggerStore({ database, scope }),
    usage: new DatabaseUsageStore({ database, scope }),
    workspaces: stores.workspaces,
  };
}
