import { ArtifactManager } from "@foundry/artifacts";
import { blobFiles } from "@foundry/artifacts/node";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { DatabaseAssociationStore } from "~/database/associations";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { artifactBlobs } from "~/database/stores";
import { WorkspaceRegistry } from "~/database/workspaces";
import type { FeedEntrySnapshot, FeedReader } from "~/lib/feed/read";
import { feedReader } from "~/lib/feed/read";
import type { ResourceAssociation } from "~/lib/resources";

/**
 * The feed a hosted workspace's dashboard shows: the workspace's own
 * entries, read by its engine, and every other registered workspace's,
 * read from the Marbles database through that workspace's own artifact
 * store and blob files. Each entry shared with other workspaces names them
 * all (`workspaces`, its owner first), so the dashboard's scopes are views
 * by association: this workspace shows what it owns and what is shared
 * with it, and "all workspaces" shows everything once.
 *
 * Another workspace's entries are read only: an answer goes to this
 * workspace's engine, which holds only its own. They are read again at
 * most every two seconds, and, when they cannot be read, the workspace's
 * own entries are shown alone.
 */

export interface WorkspaceFeedOptions {
  /** The shared artifact store, where every workspace's blob files are. */
  readonly artifacts: string;
  readonly database: StoreDatabase;
  /** This workspace's own entries: its engine's reader. */
  readonly own: FeedReader;
  /** The Marbles state root. */
  readonly state: string;
  /** This workspace's id. */
  readonly workspace: string;
}

/**
 * How long what was read of the other workspaces is shown before it is
 * read again: the dashboard polls far more often than they change.
 */
const ELSEWHERE_MS = 2000;

export function workspaceFeed(options: WorkspaceFeedOptions): FeedReader {
  const { artifacts, database, own, state, workspace } = options;
  const registry = new WorkspaceRegistry({ database, state });
  const associations = new DatabaseAssociationStore({ database });
  /** One reader per other workspace, kept so each entry's files are read once per version. */
  const readers = new Map<string, FeedReader>();
  const readerOf = (owner: string): FeedReader => {
    let reader = readers.get(owner);
    if (reader === undefined) {
      reader = feedReader(
        new ArtifactManager({
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
  /** What was last read of the other workspaces, and when. */
  let last:
    | {
        readonly at: number;
        readonly others: readonly FeedEntrySnapshot[];
        readonly shared: readonly ResourceAssociation[];
      }
    | undefined;
  const elsewhereAndShared = async (now: Date) => {
    if (last === undefined || now.getTime() - last.at >= ELSEWHERE_MS) {
      try {
        last = {
          at: now.getTime(),
          others: await asBusy(() => elsewhere(now)),
          shared: await asBusy(() => associations.list("artifact")),
        };
      } catch {
        // Another workspace's entries are extra: this one's still show.
        last = { at: now.getTime(), others: [], shared: [] };
      }
    }
    return last;
  };
  return async (now = new Date()) => {
    const mine = await own(now);
    const { others, shared } = await elsewhereAndShared(now);
    return [...mine, ...others]
      .map((entry) => withWorkspaces(entry, shared))
      .sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  };
}

/** `entry`, naming every workspace it belongs to when it is shared. */
function withWorkspaces(
  entry: FeedEntrySnapshot,
  shared: readonly ResourceAssociation[]
): FeedEntrySnapshot {
  const owner = entry.workspace.id;
  const others = shared
    .filter(
      (association) =>
        association.ref.owner === owner && association.ref.id === entry.id
    )
    .map((association) => association.workspace)
    .sort();
  return others.length === 0
    ? entry
    : { ...entry, workspaces: [owner, ...others] };
}
