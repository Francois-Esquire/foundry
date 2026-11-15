import type {
  ArtifactStore,
  ArtifactStoreWrite,
} from "@foundry/artifacts/store";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { DatabaseAssociationStore } from "~/database/associations";
import { relinkArtifact } from "~/database/links";
import type { StoreDatabase } from "~/database/open";
import type { ArtifactFile } from "~/database/resources";
import { ALL_WORKSPACES, ResourceView } from "~/database/resources";
import { WorkspaceRegistry } from "~/database/workspaces";
import type { ResourceRef } from "~/lib/resources";
import { sameResource } from "~/lib/resources";

/**
 * An artifact store that keeps the workspaces' links to its artifacts
 * current. Once a write has landed, each artifact it changed (put,
 * deleted, given new Content, or one of whose blobs it rewrote) is
 * relinked in its owner and in every workspace it is shared with, and
 * unlinked in any other that links it (`relinkArtifact`). Only a
 * workspace whose `.marbles` is there is touched: one never linked
 * (`marbles relink`) gets none from here.
 *
 * Linking follows the write; it never fails it. Each workspace and
 * artifact is relinked on its own, so one that cannot be (a link in the
 * way, a root that is gone) is reported through `report` and the rest
 * still are; `marbles relink` repairs what was reported. Updates run one at
 * a time, in the order the writes landed.
 */

export interface KeptLinksOptions {
  /** The shared artifact store, whose blob files the links point at. */
  readonly artifacts: string;
  readonly database: StoreDatabase;
  /** The workspace whose store this is. */
  readonly owner: string;
  readonly report: (line: string) => void;
  /** The Marbles state root. */
  readonly state: string;
}

/** What one write changed, by id. */
export interface Touched {
  readonly artifacts: readonly string[];
  readonly blobs: readonly string[];
}

export function keepingLinks<T extends ArtifactStore>(
  store: T,
  options: KeptLinksOptions
): T {
  return followingCommits(store, artifactLinker(options));
}

/**
 * `store`, calling `landed` with what each write changed once it is there
 * for good: a commit made on the store itself as soon as it resolves; one
 * made through a transaction's view, nested ones included, only once the
 * outermost transaction has resolved, and never for one that rejected.
 * Everything else is the store's own, transaction absent where it offers
 * none; the store takes each write when it is called, before anything here
 * reads it, and nothing here can make a write fail.
 */
export function followingCommits<T extends ArtifactStore>(
  store: T,
  landed: (touched: Touched) => void
): T {
  return observed(store, (changes) => {
    for (const touched of changes) {
      landed(touched);
    }
  });
}

/** `store`, handing what its commits and transactions changed to `sink` once each resolves. */
function observed<T extends ArtifactStore>(
  store: T,
  sink: (changes: readonly Touched[]) => void
): T {
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === "commit" && typeof value === "function") {
        return async (write: ArtifactStoreWrite): Promise<void> => {
          // Called first: the store takes its own copy of the write now.
          const committed: Promise<void> = Reflect.apply(value, target, [
            write,
          ]);
          const touched = touchedBy(write);
          await committed;
          sink([touched]);
        };
      }
      if (property === "transaction" && typeof value === "function") {
        return async <R>(
          work: (view: ArtifactStore) => Promise<R>,
          ...rest: unknown[]
        ): Promise<R> => {
          const pending: Touched[] = [];
          const result = (await Reflect.apply(value, target, [
            (view: ArtifactStore) =>
              work(observed(view, (changes) => pending.push(...changes))),
            ...rest,
          ])) as R;
          sink(pending);
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The ids a write names; nothing when the write cannot be read, which its store has refused already. */
function touchedBy(write: ArtifactStoreWrite): Touched {
  try {
    return {
      artifacts: [
        ...(write.putArtifacts ?? []).map((artifact) => artifact.id),
        ...(write.deleteArtifacts ?? []),
        ...(write.putContents ?? []).map((content) => content.artifactId),
      ],
      blobs: (write.putBlobs ?? []).map((blob) => blob.id),
    };
  } catch {
    return { artifacts: [], blobs: [] };
  }
}

/** Queue the relinking of what each write touched, one update at a time. */
function artifactLinker(options: KeptLinksOptions): (touched: Touched) => void {
  const { owner, report } = options;
  let queue: Promise<void> = Promise.resolve();
  const failed = (what: string, error: unknown) =>
    report(
      `[links] could not update ${what}; marbles relink repairs it: ${error instanceof Error ? error.message : String(error)}`
    );
  return (touched) => {
    if (touched.artifacts.length === 0 && touched.blobs.length === 0) {
      return;
    }
    queue = queue
      .then(() => relinkTouched(options, touched, failed))
      .catch((error: unknown) =>
        failed(`the links of ${owner}'s artifacts`, error)
      );
  };
}

async function relinkTouched(
  options: KeptLinksOptions,
  touched: Touched,
  failed: (what: string, error: unknown) => void
): Promise<void> {
  const { artifacts, database, owner, report, state } = options;
  const ids = await changedArtifacts(
    new SqliteArtifactStore({ database, scope: owner }),
    touched
  );
  if (ids.size === 0) {
    return;
  }
  const records = await new WorkspaceRegistry({ database, state }).list();
  const shares = await new DatabaseAssociationStore({ database }).list(
    "artifact"
  );
  const view = new ResourceView({ database, scope: ALL_WORKSPACES, state });
  for (const id of ids) {
    const ref: ResourceRef = { id, kind: "artifact", owner };
    let files: readonly ArtifactFile[];
    try {
      files = await view.artifactFiles(ref);
    } catch (error) {
      failed(`the links of artifact ${id}`, error);
      continue;
    }
    const shownIn = new Set([
      owner,
      ...shares
        .filter((share) => sameResource(share.ref, ref))
        .map((share) => share.workspace),
    ]);
    for (const record of records) {
      try {
        const done = await relinkArtifact({
          artifacts,
          files: shownIn.has(record.id) ? files : [],
          ref,
          root: record.root,
          workspace: record.id,
        });
        for (const path of done?.refused ?? []) {
          report(
            `[links] ${record.root}: ${path} goes through a link or a file; artifact ${id} is not linked there`
          );
        }
      } catch (error) {
        failed(`the links of artifact ${id} in ${record.root}`, error);
      }
    }
  }
}

/** The artifacts a write changed: those it named, and those whose Content holds a blob it put. */
async function changedArtifacts(
  store: SqliteArtifactStore,
  touched: Touched
): Promise<Set<string>> {
  const ids = new Set<string>(touched.artifacts);
  for (const blob of touched.blobs) {
    const { contentIds } = await store.findReferences(
      blob as Parameters<SqliteArtifactStore["findReferences"]>[0]
    );
    for (const contentId of contentIds) {
      const content = await store.getContent(contentId);
      if (content !== null) {
        ids.add(content.artifactId);
      }
    }
  }
  return ids;
}
