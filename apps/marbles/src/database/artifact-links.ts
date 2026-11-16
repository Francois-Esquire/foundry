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
 * a time, in the order the writes landed, and `drainLinks` waits for them,
 * for as long as it is given: a host drains before it closes the database.
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

/** What `keepingLinks` adds to the store it keeps links for. */
export interface LinksKept {
  /**
   * Take no new link work from now on, and resolve once no link update is
   * under way or queued, so nothing of this store's link keeping is in a
   * database call or will begin one: the database may close then. A write
   * that lands once this has begun has its links left to `marbles relink`,
   * reported once, and reads nothing. After `withinMs`, give up what has no
   * end of its own, the updates not yet begun and one waiting for a
   * workspace's links lock, reporting them once as `marbles relink` repairs
   * them; an update reading the database or changing links still reaches
   * its next step, where it stops, before this resolves. One stopped
   * changes no link: what it made ahead is removed, and the links are as
   * they were.
   *
   * `withinMs` is no deadline: past it, this still waits for a read of the
   * database under way, however long it takes, since closing the database
   * under it is what this is for. What bounds a host's close is the host's
   * own: a generation's stop timeout; nothing, in a host in this process.
   */
  drainLinks(withinMs: number): Promise<void>;
}

/** A store whose commits land only with its host's transaction, which says nothing of when that commits. */
export class HostBoundStoreError extends Error {
  override readonly name = "HostBoundStoreError";
}

/**
 * `store`, keeping the workspaces' links current after each write that
 * lands. Refused for a store whose commits land only when a transaction
 * its host owns commits (`durability: "host"`): nothing tells it when that
 * is, or that it rolled back, so its links would follow writes that never
 * land.
 */
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
  return observed(store, (touched) => {
    if (touched.artifacts.length > 0 || touched.blobs.length > 0) {
      landed(touched);
    }
  });
}

/** `store`, handing what its commits and transactions changed to `sink` once each resolves. */
function observed<T extends ArtifactStore>(
  store: T,
  sink: (touched: Touched) => void
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
          sink(touched);
        };
      }
      if (property === "transaction" && typeof value === "function") {
        return async <R>(
          work: (view: ArtifactStore) => Promise<R>,
          ...rest: unknown[]
        ): Promise<R> => {
          // Each id once, however many of the transaction's commits name it.
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

/** The ids a write names; nothing when the write cannot be read, which its store has refused already. */
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

/** Queue the relinking of what each write touched, one update at a time, and wait for the queue. */
function artifactLinker(options: KeptLinksOptions): {
  readonly drain: (withinMs: number) => Promise<void>;
  readonly follow: (touched: Touched) => void;
} {
  const { owner, report } = options;
  let queue: Promise<void> = Promise.resolve();
  // Aborted once a drain gave up: an update stops at its next step, before
  // it reads the database again, and a wait for a links lock ends.
  const giveUp = new AbortController();
  // Closed once a drain begins: nothing more is queued.
  let admitting = true;
  const live = (): void => {
    giveUp.signal.throwIfAborted();
  };
  const failed = (what: string, error: unknown) =>
    report(
      `[links] could not update ${what}; marbles relink repairs it: ${error instanceof Error ? error.message : String(error)}`
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
  /** Whether the queue settled before `timedOut` did. */
  const settled = async (timedOut?: Promise<"timed out">) => {
    // An update may queue another while it runs: wait until none is left.
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
    // Another drain may have given up meanwhile: that one has said so.
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
    // What reads the database or changes links now reaches its next step.
    await settled();
  };
  return { drain, follow };
}

/** An update a drain gave up on, ending before it reads the database again. */
class LinksAbandoned extends Error {
  override readonly name = "LinksAbandoned";
}

interface Relinking {
  readonly failed: (what: string, error: unknown) => void;
  /** Throws `LinksAbandoned` once a drain gave up; called before each read of the database. */
  readonly live: () => void;
  /** Aborts, with a `LinksAbandoned`, once a drain gave up: ends a wait for a links lock. */
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
  const records = await new WorkspaceRegistry({ database, state }).list();
  const view = new ResourceView({ database, scope: ALL_WORKSPACES, state });
  const shares = new DatabaseAssociationStore({ database });
  for (const id of ids) {
    const ref: ResourceRef = { id, kind: "artifact", owner };
    for (const record of records) {
      // Read under the workspace's links lock, right before the links are
      // put in place: what the database says then, not when this began,
      // and only if no drain gave up while this waited for the lock.
      const files = async (): Promise<readonly ArtifactFile[]> => {
        live();
        const shown =
          record.id === owner ||
          (await shares.list("artifact")).some(
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

/** The artifacts a write changed: those it named, and those whose Content holds a blob it put. */
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
