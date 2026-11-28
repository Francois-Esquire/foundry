import { Artifacts } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { asBusy } from "~/database/busy";
import { artifactBlobs } from "~/database/local-artifacts";
import type { StoreDatabase } from "~/database/open";
import { WorkspaceRegistry } from "~/database/workspaces";
import type { FeedEntrySnapshot, FeedReader } from "~/lib/feed/read";
import { feedReader } from "~/lib/feed/read";
import { insideState } from "~/state/workspace";

export interface WorkspaceFeedOptions {
  readonly artifacts: string;
  readonly database: StoreDatabase;
  readonly own: FeedReader;
  readonly state: string;
  readonly workspace: string;
}

const ELSEWHERE_MS = 2000;

export function workspaceFeed(options: WorkspaceFeedOptions): FeedReader {
  const { artifacts, database, own, state, workspace } = options;
  const registry = new WorkspaceRegistry({
    acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
    database,
  });
  const readers = new Map<string, FeedReader>();
  const readerOf = (owner: string): FeedReader => {
    let reader = readers.get(owner);
    if (reader === undefined) {
      reader = feedReader(
        new Artifacts({
          files: blobFiles(artifactBlobs(artifacts, owner)),
          store: new SqliteArtifactStore({ database, scope: owner }),
        })
      );
      readers.set(owner, reader);
    }
    return reader;
  };
  const elsewhere = async (now: Date): Promise<FeedEntrySnapshot[]> => {
    const owners = (await registry.list())
      .map((record) => record.id)
      .filter((id) => id !== workspace);
    const entries: FeedEntrySnapshot[] = [];
    for (const owner of owners) {
      entries.push(...(await readerOf(owner)(now)));
    }
    return entries;
  };
  let last:
    | { readonly at: number; readonly others: readonly FeedEntrySnapshot[] }
    | undefined;
  const cachedElsewhere = async (now: Date) => {
    if (last === undefined || now.getTime() - last.at >= ELSEWHERE_MS) {
      try {
        last = {
          at: now.getTime(),
          others: await asBusy(() => elsewhere(now)),
        };
      } catch {
        last = { at: now.getTime(), others: [] };
      }
    }
    return last.others;
  };
  return async (now = new Date()) => {
    const mine = await own(now);
    const others = await cachedElsewhere(now);
    return [...mine, ...others].sort((a, b) =>
      b.postedAt.localeCompare(a.postedAt)
    );
  };
}
