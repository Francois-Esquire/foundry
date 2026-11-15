import type {
  ArtifactStore,
  ArtifactStoreWrite,
} from "@foundry/artifacts/store";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { DatabaseAssociationStore } from "~/database/associations";
import { relinkArtifact } from "~/database/links";
import type { StoreDatabase } from "~/database/open";
import { ALL_WORKSPACES, ResourceView } from "~/database/resources";
import { WorkspaceRegistry } from "~/database/workspaces";
import type { ResourceRef } from "~/lib/resources";
import { sameResource } from "~/lib/resources";

/**
 * An artifact store that keeps the workspaces' links to its artifacts
 * current: once a write has committed (never inside its transaction), each
 * artifact it changed (put, deleted, given new Content, or one of whose
 * blobs it rewrote) is relinked in its owner and in every workspace it is
 * shared with, and unlinked in any other that links it (`relinkArtifact`).
 * Only a workspace whose links directory is there is touched: one never
 * linked (`marbles relink`) gets none from here.
 *
 * Linking follows the write; it never fails it. Updates run one at a time,
 * in the order the writes committed, and a failure is reported through
 * `report` and left for `marbles relink` to repair.
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

/** What one write changed, by id, taken when the write is handed over. */
interface Touched {
  readonly artifacts: readonly string[];
  readonly blobs: readonly string[];
}

export function keepingLinks<T extends ArtifactStore>(
  store: T,
  options: KeptLinksOptions
): T {
  const linker = artifactLinker(options);
  const committing =
    (target: ArtifactStore, after: (touched: Touched) => void) =>
    async (write: ArtifactStoreWrite): Promise<void> => {
      const touched = touchedBy(write);
      await target.commit(write);
      after(touched);
    };
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === "commit") {
        return committing(target, linker);
      }
      if (property === "transaction" && typeof value === "function") {
        return async <R>(
          work: (view: ArtifactStore) => Promise<R>,
          ...rest: unknown[]
        ): Promise<R> => {
          const seen: Touched[] = [];
          const result = (await Reflect.apply(value, target, [
            (view: ArtifactStore) =>
              work(
                new Proxy(view, {
                  get(inner, name) {
                    const member: unknown = Reflect.get(inner, name, inner);
                    if (name === "commit") {
                      return committing(inner, (touched) => seen.push(touched));
                    }
                    return typeof member === "function"
                      ? member.bind(inner)
                      : member;
                  },
                })
              ),
            ...rest,
          ])) as R;
          for (const touched of seen) {
            linker(touched);
          }
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function touchedBy(write: ArtifactStoreWrite): Touched {
  return {
    artifacts: [
      ...(write.putArtifacts ?? []).map((artifact) => artifact.id),
      ...(write.deleteArtifacts ?? []),
      ...(write.putContents ?? []).map((content) => content.artifactId),
    ],
    blobs: (write.putBlobs ?? []).map((blob) => blob.id),
  };
}

/** Queue the relinking of what each write touched, one update at a time. */
function artifactLinker(options: KeptLinksOptions): (touched: Touched) => void {
  const { artifacts, database, owner, report, state } = options;
  let queue: Promise<void> = Promise.resolve();
  const update = async (touched: Touched): Promise<void> => {
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
      const shownIn = new Set([
        owner,
        ...shares
          .filter((share) => sameResource(share.ref, ref))
          .map((share) => share.workspace),
      ]);
      const files = await view.artifactFiles(ref);
      for (const record of records) {
        await relinkArtifact({
          artifacts,
          files: shownIn.has(record.id) ? files : [],
          ref,
          root: record.root,
        });
      }
    }
  };
  return (touched) => {
    if (touched.artifacts.length === 0 && touched.blobs.length === 0) {
      return;
    }
    queue = queue
      .then(() => update(touched))
      .catch((error: unknown) => {
        report(
          `[links] could not update the links of ${owner}'s artifacts; marbles relink repairs them: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  };
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
