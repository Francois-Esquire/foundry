import type {
  ArtifactStore,
  ArtifactStoreWrite,
} from "@foundry/artifacts/store";
import { SqliteArtifactStore } from "@foundry/artifacts/store/sqlite";
import { DatabaseAssociationStore } from "~/database/associations";
import { relinkArtifact } from "~/database/links";
import type { ArtifactFile } from "~/database/resources";
import { ALL_WORKSPACES, ResourceView } from "~/database/resources";
import type { StoreDatabase } from "~/database/types";
import { WorkspaceRegistry } from "~/database/workspaces";
import type { ResourceAssociation, ResourceRef } from "~/lib/resources";
import { sameResource } from "~/lib/resources";
import { insideState } from "~/lib/state/workspace";

export interface KeptLinksOptions {
  readonly artifacts: string;
  readonly database: StoreDatabase;
  readonly owner: string;
  readonly report: (line: string) => void;
  readonly state: string;
}

export interface Touched {
  readonly artifacts: readonly string[];
  readonly blobs: readonly string[];
}

export interface LinksKept {
  drainLinks(withinMs: number): Promise<void>;
}

export class HostBoundStoreError extends Error {
  override readonly name = "HostBoundStoreError";
}

export function keepingLinks<T extends ArtifactStore>(
  store: T,
  options: KeptLinksOptions
): T & LinksKept {
  if (store.durability === "host") {
    throw new HostBoundStoreError(
      "keepingLinks needs an artifact store over the database itself: this one's commits land only when its host's transaction commits, and nothing tells it when, so its links would follow writes that may roll back"
    );
  }
  const linker = artifactLinker(options);
  const followed = followingCommits(store, linker.follow);
  return new Proxy(followed, {
    get(target, property) {
      return property === "drainLinks"
        ? linker.drain
        : Reflect.get(target, property, target);
    },
  }) as T & LinksKept;
}

export function followingCommits<T extends ArtifactStore>(
  store: T,
  landed: (touched: Touched) => void
): T {
  return observed(store, (touched) => {
    if (touched.artifacts.length > 0 || touched.blobs.length > 0) {
      landed(touched);
    }
  });
}

function observed<T extends ArtifactStore>(
  store: T,
  sink: (touched: Touched) => void
): T {
  return new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === "commit" && typeof value === "function") {
        return async (write: ArtifactStoreWrite): Promise<void> => {
          const committed: Promise<void> = Reflect.apply(value, target, [
            write,
          ]);
          const touched = touchedBy(write);
          await committed;
          sink(touched);
        };
      }
      if (property === "transaction" && typeof value === "function") {
        return async <R>(
          work: (view: ArtifactStore) => Promise<R>,
          ...rest: unknown[]
        ): Promise<R> => {
          const artifacts = new Set<string>();
          const blobs = new Set<string>();
          const result = (await Reflect.apply(value, target, [
            (view: ArtifactStore) =>
              work(
                observed(view, (touched) => {
                  for (const id of touched.artifacts) {
                    artifacts.add(id);
                  }
                  for (const id of touched.blobs) {
                    blobs.add(id);
                  }
                })
              ),
            ...rest,
          ])) as R;
          sink({ artifacts: [...artifacts], blobs: [...blobs] });
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function touchedBy(write: ArtifactStoreWrite): Touched {
  try {
    return {
      artifacts: [
        ...new Set([
          ...(write.putArtifacts ?? []).map((artifact) => artifact.id),
          ...(write.deleteArtifacts ?? []),
          ...(write.putContents ?? []).map((content) => content.artifactId),
        ]),
      ],
      blobs: [...new Set((write.putBlobs ?? []).map((blob) => blob.id))],
    };
  } catch {
    return { artifacts: [], blobs: [] };
  }
}

function artifactLinker(options: KeptLinksOptions): {
  readonly drain: (withinMs: number) => Promise<void>;
  readonly follow: (touched: Touched) => void;
} {
  const { owner, report } = options;
  let queue: Promise<void> = Promise.resolve();
  const giveUp = new AbortController();
  let admitting = true;
  const live = (): void => {
    giveUp.signal.throwIfAborted();
  };
  const failed = (what: string, error: unknown) =>
    report(
      `[links] could not update ${what}: ${error instanceof Error ? error.message : String(error)}`
    );
  const follow = (touched: Touched) => {
    if (touched.artifacts.length === 0 && touched.blobs.length === 0) {
      return;
    }
    if (!admitting) {
      failed(
        `the links of ${owner}'s artifacts`,
        new Error(
          `a write landed after the host began to close, touching ${String(touched.artifacts.length)} artifacts and ${String(touched.blobs.length)} blobs`
        )
      );
      return;
    }
    queue = queue
      .then(() =>
        relinkTouched(options, touched, {
          failed,
          live,
          signal: giveUp.signal,
        })
      )
      .catch((error: unknown) => {
        if (!(error instanceof LinksAbandoned)) {
          failed(`the links of ${owner}'s artifacts`, error);
        }
      });
  };
  const settled = async (timedOut?: Promise<"timed out">) => {
    for (;;) {
      const waited = queue;
      const outcome = await (timedOut === undefined
        ? waited
        : Promise.race([waited, timedOut]));
      if (outcome === "timed out") {
        return false;
      }
      if (queue === waited) {
        return true;
      }
    }
  };
  const drain = async (withinMs: number): Promise<void> => {
    admitting = false;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<"timed out">((done) => {
      timer = setTimeout(() => done("timed out"), withinMs);
    });
    try {
      if (giveUp.signal.aborted || (await settled(timedOut))) {
        await settled();
        return;
      }
    } finally {
      clearTimeout(timer);
    }
    if (giveUp.signal.aborted) {
      await settled();
      return;
    }
    giveUp.abort(new LinksAbandoned());
    failed(
      `the links of ${owner}'s artifacts`,
      new Error(
        `updates were still waiting after ${String(withinMs)} ms, for a workspace's .marbles/.lock or their turn, when the host closed`
      )
    );
    await settled();
  };
  return { drain, follow };
}

class LinksAbandoned extends Error {
  override readonly name = "LinksAbandoned";
}

interface Relinking {
  readonly failed: (what: string, error: unknown) => void;
  readonly live: () => void;
  readonly signal: AbortSignal;
}

async function relinkTouched(
  options: KeptLinksOptions,
  touched: Touched,
  { failed, live, signal }: Relinking
): Promise<void> {
  const { artifacts, database, owner, report, state } = options;
  const ids = await changedArtifacts(
    new SqliteArtifactStore({ database, scope: owner }),
    touched,
    live
  );
  if (ids.size === 0) {
    return;
  }
  live();
  const records = await new WorkspaceRegistry({
    acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
    database,
  }).list();
  const view = new ResourceView({
    acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
    database,
    scope: ALL_WORKSPACES,
  });
  const shares = new DatabaseAssociationStore({ database });
  let listedAhead: Promise<readonly ResourceAssociation[]> | undefined;
  const sharesAhead = () => {
    listedAhead ??= shares.list("artifact").catch((error: unknown) => {
      listedAhead = undefined;
      throw error;
    });
    return listedAhead;
  };
  for (const id of ids) {
    const ref: ResourceRef = { id, kind: "artifact", owner };
    for (const record of records) {
      let ahead = true;
      const files = async (): Promise<readonly ArtifactFile[]> => {
        live();
        const first = ahead;
        ahead = false;
        const shown =
          record.id === owner ||
          (await (first ? sharesAhead() : shares.list("artifact"))).some(
            (share) =>
              sameResource(share.ref, ref) && share.workspace === record.id
          );
        live();
        return shown ? view.artifactFiles(ref) : [];
      };
      try {
        const done = await relinkArtifact({
          artifacts,
          files,
          ref,
          root: record.root,
          signal,
          workspace: record.id,
        });
        for (const path of done?.refused ?? []) {
          report(
            `[links] ${record.root}: ${path} goes through a link, a file or a path outside .marbles; artifact ${id} is not linked there`
          );
        }
      } catch (error) {
        if (error instanceof LinksAbandoned) {
          throw error;
        }
        failed(`the links of artifact ${id} in ${record.root}`, error);
      }
    }
  }
}

async function changedArtifacts(
  store: SqliteArtifactStore,
  touched: Touched,
  live: () => void
): Promise<Set<string>> {
  const ids = new Set<string>(touched.artifacts);
  for (const blob of touched.blobs) {
    live();
    const { contentIds } = await store.findReferences(
      blob as Parameters<SqliteArtifactStore["findReferences"]>[0]
    );
    for (const contentId of contentIds) {
      live();
      const content = await store.getContent(contentId);
      if (content !== null) {
        ids.add(content.artifactId);
      }
    }
  }
  return ids;
}
