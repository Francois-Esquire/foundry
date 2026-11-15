import { describe, expect, it } from "vitest";

import type { EventInput } from "../change";
import type { ArtifactId, BlobId, ContentId } from "../ref";
import { artifactIdSchema, blobIdSchema, contentIdSchema } from "../ref";
import type { Artifact, ArtifactEvent, Blob, Content } from "../schema";
import type {
  ArtifactListQuery,
  ArtifactStore,
  ArtifactStoreWrite,
} from "../store";
import { isTransactional } from "./transactional";

const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const AT = new Date("2026-01-01T00:00:00.000Z");

const artifactId = (): ArtifactId =>
  artifactIdSchema.parse(crypto.randomUUID());
const contentId = (): ContentId => contentIdSchema.parse(crypto.randomUUID());
const blobId = (): BlobId => blobIdSchema.parse(crypto.randomUUID());

function artifact(fields: Partial<Artifact> = {}): Artifact {
  return {
    archivedAt: null,
    contentId: null,
    createdAt: AT,
    id: artifactId(),
    metadata: { sessionId: "session" },
    name: "Notes",
    publishedAt: null,
    status: "draft",
    type: "text/plain",
    updatedAt: AT,
    ...fields,
  };
}

/** `input` as an event, at a fixed time. */
/** An array with a hole at index 0, which JSON reads back as `null`. */
function holed(): number[] {
  const values: number[] = [];
  values[1] = 2;
  return values;
}

/** Events each with a part that has no JSON form reading back the same. */
function unplainEvents(): readonly unknown[] {
  const base = event({ artifactId: artifactId(), type: "artifact.created" });
  class Instance {
    readonly artifactId = base.artifactId;
    readonly at = base.at;
    readonly id = base.id;
    readonly type = base.type;
  }
  return [
    new Instance(),
    { ...base, at: new Date() },
    { ...base, extra: Number.NaN },
    { ...base, extra: -0 },
    { ...base, extra: 1n },
    { ...base, extra: undefined },
    { ...base, extra: () => undefined },
    { ...base, extra: holed() },
    { ...base, extra: new Map() },
    { ...base, [Symbol("extra")]: 1 },
    Object.defineProperty({ ...base }, "hidden", {
      enumerable: false,
      value: 1,
    }),
  ];
}

/** An `artifact.removed` event of an Artifact no store holds. */
function removedEvent(): ArtifactEvent {
  return event({
    artifactId: artifactId(),
    artifactType: "text/plain",
    name: "gone",
    type: "artifact.removed",
  });
}

function event(input: EventInput): ArtifactEvent {
  return {
    ...input,
    at: AT.toISOString(),
    id: crypto.randomUUID(),
  } as ArtifactEvent;
}

function content(owner: ArtifactId, blobs: readonly BlobId[] = []): Content {
  return {
    artifactId: owner,
    createdAt: AT,
    digest: DIGEST,
    frozenAt: null,
    id: contentId(),
    metadata: { entry: "a.txt" },
    state: "ready",
    tag: null,
    tree: Object.fromEntries(
      blobs.map((id, index) => [
        `${String(index)}.txt`,
        { blobId: id, bytes: 1, digest: DIGEST, mime: null, type: "file" },
      ])
    ),
    updatedAt: AT,
  };
}

/**
 * A blob whose inline bytes, `[1, 2]`, sit over a `SharedArrayBuffer`,
 * which `structuredClone` keeps shared on Node.
 */
function sharedBlob(): Blob & { readonly bytes: Uint8Array } {
  const bytes = new Uint8Array(new SharedArrayBuffer(2));
  bytes.set([1, 2]);
  return { byteLength: 2, bytes, createdAt: AT, digest: DIGEST, id: blobId() };
}

function inlineBlob(digest = DIGEST): Blob {
  return {
    byteLength: 1,
    bytes: new Uint8Array([1]),
    createdAt: AT,
    digest,
    id: blobId(),
  };
}

/** What a store's refusal of a call from inside its own transaction says. */
const REFUSAL = /refused: .*use the view/;

/**
 * How `promise` settled, as `refused: <message>` or `resolved`, or
 * `still pending` after `ms`: a hang becomes a failed assertion, not a
 * stalled suite.
 */
async function settlesWithin(
  promise: Promise<unknown>,
  ms: number
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("still pending"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "resolved",
        (error: unknown) =>
          `refused: ${error instanceof Error ? error.message : String(error)}`
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The store's `transaction`, bound; every Artifact store offers one. */
function requireTransaction(
  store: ArtifactStore
): <T>(work: (view: ArtifactStore) => Promise<T>) => Promise<T> {
  if (!isTransactional(store)) {
    throw new Error("An Artifact store offers transaction");
  }
  return (work) => store.transaction(work);
}

function sorted<T extends { readonly id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Changes, in place, every value a write holds, pointing its blobs at `other`. */
function scramble(write: ArtifactStoreWrite, other: BlobId): void {
  for (const row of write.putArtifacts ?? []) {
    Object.assign(row, { name: "changed" });
    (row.metadata as { list: string[] }).list.push("changed");
    row.createdAt.setTime(0);
  }
  for (const row of write.putContents ?? []) {
    for (const node of Object.values(row.tree)) {
      Object.assign(node, { blobId: other });
    }
  }
  for (const row of write.putBlobs ?? []) {
    if (row.chunks) {
      Object.assign(row, { chunks: [other] });
    }
  }
  (write.putArtifacts as Artifact[]).push(artifact({ name: "Added" }));
}

/**
 * Fresh, empty storage, reached one scope at a time. The same scope reaches
 * the same records on every call; two scopes never see each other's.
 */
export type ScopedArtifactStores = (scope: string) => ArtifactStore;

/**
 * Fresh, empty storage whose stores hand each commit's write to a host hook
 * (a SQLite store's `onCommit`), and a record the hook keeps: it writes the
 * write's events, in order, in the commit's own transaction.
 */
export interface RecordingArtifactStores {
  /** Makes the hook throw on its next call, after it has recorded. */
  readonly failNextCommit: () => void;
  /** The events recorded by every commit that was kept, in the order kept. */
  readonly recorded: () => Promise<readonly ArtifactEvent[]>;
  readonly stores: ScopedArtifactStores;
}

/**
 * Whether the storage a suite run opens hands its commits to a host hook.
 * A store with one (a SQLite store's `onCommit`) says `hooked: true` and
 * supplies `recording`, so the suite proves the hook is handed each commit's
 * events; a store with none says `hooked: false`.
 */
export type ArtifactStoreMode =
  | { readonly hooked: false }
  | {
      readonly hooked: true;
      readonly recording: () => Promise<RecordingArtifactStores>;
    };

/**
 * Registers the tests every `ArtifactStore` must pass. `open` returns fresh,
 * empty storage, opened per scope: two scopes over one storage never see
 * each other's records, and one scope opened twice sees one set. `mode` says
 * whether the storage has a host hook (see {@link ArtifactStoreMode}).
 */
export function describeArtifactStore(
  name: string,
  open: () => ScopedArtifactStores | Promise<ScopedArtifactStores>,
  mode: ArtifactStoreMode
): void {
  if (mode.hooked) {
    describeRecordedEvents(name, mode.recording);
  }
  const fresh = async () => (await open())("conformance");
  /** Every Artifact, oldest first. */
  const everyArtifact = async (store: ArtifactStore) =>
    (await store.listArtifacts({ includeArchived: true, limit: 1000 }))
      .artifacts;
  describe(`${name} Artifact store conformance`, () => {
    it("reads back every record a commit puts", async () => {
      const store = await fresh();
      const owner = artifact();
      const blob = inlineBlob();
      const version = content(owner.id, [blob.id]);
      await store.commit({
        putArtifacts: [owner],
        putBlobs: [blob],
        putContents: [version],
      });

      expect(await store.getArtifact(owner.id)).toEqual(owner);
      expect(await store.getContent(version.id)).toEqual(version);
      expect(await store.getBlob(blob.id)).toEqual(blob);
      expect(await everyArtifact(store)).toEqual([owner]);
      expect(await store.listContents()).toEqual([version]);
      expect(await store.listContents(owner.id)).toEqual([version]);
      expect(await store.listBlobs()).toEqual([{ id: blob.id }]);
      expect(await store.findBlobs(DIGEST)).toEqual([blob]);
    });

    it("answers absent records with null and empty lists", async () => {
      const store = await fresh();
      expect(await store.getArtifact(artifactId())).toBeNull();
      expect(await store.getContent(contentId())).toBeNull();
      expect(await store.getBlob(blobId())).toBeNull();
      expect(await everyArtifact(store)).toEqual([]);
      expect(await store.listContents()).toEqual([]);
      expect(await store.listBlobs()).toEqual([]);
      expect(await store.findBlobs(DIGEST)).toEqual([]);
      expect(await store.findReferences(blobId())).toEqual({
        blobIds: [],
        contentIds: [],
      });
    });

    it("finds nothing by a key that is no string, and deletes nothing by one", async () => {
      const store = await fresh();
      const kept = artifact();
      const blob = inlineBlob();
      await store.commit({ putArtifacts: [kept], putBlobs: [blob] });
      const missing = undefined as never;
      expect(await store.getArtifact(missing)).toBeNull();
      expect(await store.getContent(missing)).toBeNull();
      expect(await store.getBlob(missing)).toBeNull();
      expect(await store.findBlobs(missing)).toEqual([]);
      expect(await store.findReferences(missing)).toEqual({
        blobIds: [],
        contentIds: [],
      });
      await store.commit({
        deleteArtifacts: [missing],
        deleteBlobs: [missing],
        deleteContents: [missing],
      });
      expect(await everyArtifact(store)).toEqual([kept]);
      expect(await store.listBlobs()).toEqual([{ id: blob.id }]);
    });

    it("lists one Artifact's Contents apart from another's", async () => {
      const store = await fresh();
      const first = artifact();
      const second = artifact();
      const mine = content(first.id);
      const theirs = content(second.id);
      await store.commit({
        putArtifacts: [first, second],
        putContents: [mine, theirs],
      });
      expect(await store.listContents(first.id)).toEqual([mine]);
      expect(sorted(await store.listContents())).toEqual(
        sorted([mine, theirs])
      );
    });

    it("finds blobs by digest and names a backing path in listings", async () => {
      const store = await fresh();
      const inline = inlineBlob();
      const backed: Blob = {
        byteLength: 1,
        createdAt: AT,
        digest: OTHER_DIGEST,
        id: blobId(),
        path: crypto.randomUUID(),
      };
      await store.commit({ putBlobs: [inline, backed] });
      expect(await store.findBlobs(OTHER_DIGEST)).toEqual([backed]);
      expect(sorted(await store.listBlobs())).toEqual(
        sorted([{ id: inline.id }, { id: backed.id, path: backed.path }])
      );
    });

    it("finds the Contents and chunked blobs naming a blob", async () => {
      const store = await fresh();
      const owner = artifact();
      const leaf = inlineBlob();
      const unnamed = inlineBlob();
      const manifest: Blob = {
        byteLength: 1,
        chunks: [leaf.id],
        createdAt: AT,
        digest: OTHER_DIGEST,
        id: blobId(),
      };
      const version = content(owner.id, [leaf.id]);
      await store.commit({
        putArtifacts: [owner],
        putBlobs: [leaf, unnamed, manifest],
        putContents: [version],
      });
      expect(await store.findReferences(leaf.id)).toEqual({
        blobIds: [manifest.id],
        contentIds: [version.id],
      });
      expect(await store.findReferences(unnamed.id)).toEqual({
        blobIds: [],
        contentIds: [],
      });
    });

    it("replaces a record put again and removes deleted ones", async () => {
      const store = await fresh();
      const kept = artifact();
      const gone = artifact();
      const version = content(gone.id);
      const blob = inlineBlob();
      await store.commit({
        putArtifacts: [kept, gone],
        putBlobs: [blob],
        putContents: [version],
      });
      const renamed = { ...kept, name: "Renamed" };
      await store.commit({
        deleteArtifacts: [gone.id],
        deleteBlobs: [blob.id],
        deleteContents: [version.id],
        putArtifacts: [renamed],
      });
      expect(await everyArtifact(store)).toEqual([renamed]);
      expect(await store.getContent(version.id)).toBeNull();
      expect(await store.getBlob(blob.id)).toBeNull();
      expect(await store.findReferences(blob.id)).toEqual({
        blobIds: [],
        contentIds: [],
      });
    });

    it("applies deletes before puts", async () => {
      const store = await fresh();
      const record = artifact();
      await store.commit({ putArtifacts: [record] });
      const replaced = { ...record, name: "Replaced" };
      await store.commit({
        deleteArtifacts: [record.id],
        putArtifacts: [replaced],
      });
      expect(await store.getArtifact(record.id)).toEqual(replaced);
    });

    it("keeps no record of a write's events, with records or alone", async () => {
      const store = await fresh();
      const owner = artifact();
      const version = content(owner.id);
      await store.commit({
        events: [
          event({ artifactId: owner.id, type: "artifact.created" }),
          event({
            artifactId: owner.id,
            contentId: version.id,
            type: "artifact.written",
          }),
        ],
        putArtifacts: [owner],
        putContents: [version],
      });
      await store.commit({
        events: [removedEvent()],
      });

      expect(await everyArtifact(store)).toEqual([owner]);
      expect(await store.listContents()).toEqual([version]);
      expect(await store.listBlobs()).toEqual([]);
    });

    it("refuses whole a write whose event is not plain JSON, whatever kind of value", async () => {
      const store = await fresh();
      const base = event({
        artifactId: artifactId(),
        type: "artifact.created",
      });
      for (const value of unplainEvents()) {
        await expect(
          store.commit({
            events: [value as ArtifactEvent],
            putArtifacts: [artifact()],
          })
        ).rejects.toThrow(TypeError);
      }
      await expect(
        store.commit({ events: base as unknown as ArtifactEvent[] })
      ).rejects.toThrow("events must be an array");
      expect(await everyArtifact(store)).toEqual([]);
    });

    it("refuses such a write through a transaction's view, and the transaction goes on", async () => {
      const store = await fresh();
      const refused = artifact();
      const kept = artifact();
      await requireTransaction(store)(async (view) => {
        for (const value of unplainEvents()) {
          await expect(
            view.commit({
              events: [value as ArtifactEvent],
              putArtifacts: [refused],
            })
          ).rejects.toThrow(TypeError);
        }
        await view.commit({
          events: [event({ artifactId: kept.id, type: "artifact.created" })],
          putArtifacts: [kept],
        });
      });

      expect(await store.getArtifact(refused.id)).toBeNull();
      expect(await store.getArtifact(kept.id)).toEqual(kept);
    });

    it("keeps nothing from a commit that fails", async () => {
      const store = await fresh();
      const before = artifact();
      await store.commit({ putArtifacts: [before] });
      const unstorable = artifact({
        metadata: { unstorable: () => undefined },
      });
      await expect(
        store.commit({
          deleteArtifacts: [before.id],
          putArtifacts: [artifact(), unstorable],
          putBlobs: [inlineBlob()],
        })
      ).rejects.toThrow();
      expect(await everyArtifact(store)).toEqual([before]);
      expect(await store.listBlobs()).toEqual([]);
    });

    it("detaches what it stores from what it returns", async () => {
      const store = await fresh();
      const record = artifact();
      const blob = inlineBlob();
      await store.commit({ putArtifacts: [record], putBlobs: [blob] });
      (record as { name: string }).name = "Changed by the writer";
      blob.bytes?.fill(9);
      Object.assign((await store.getArtifact(record.id)) ?? {}, {
        name: "Changed by a reader",
      });
      const [listed] = await everyArtifact(store);
      (listed?.metadata as Record<string, unknown>).sessionId = "changed";
      (await store.getBlob(blob.id))?.bytes?.fill(7);

      expect((await store.getArtifact(record.id))?.name).toBe("Notes");
      expect((await store.getArtifact(record.id))?.metadata).toEqual({
        sessionId: "session",
      });
      expect((await store.getBlob(blob.id))?.bytes).toEqual(
        new Uint8Array([1])
      );
    });

    it("keeps two scopes over one storage apart", async () => {
      const storage = await open();
      const mine = storage("mine");
      const theirs = storage("theirs");
      const record = artifact();
      const blob = inlineBlob();
      await mine.commit({ putArtifacts: [record], putBlobs: [blob] });
      expect(await theirs.getArtifact(record.id)).toBeNull();
      expect(await everyArtifact(theirs)).toEqual([]);
      expect(await theirs.listBlobs()).toEqual([]);
      expect(await theirs.findBlobs(DIGEST)).toEqual([]);
      expect(await everyArtifact(storage("mine"))).toEqual([record]);
    });

    it("lists Artifacts by filter in creation order, paged by cursor", async () => {
      const store = await fresh();
      const at = (seconds: number) => new Date(AT.getTime() + seconds * 1000);
      // Two share an instant, so ids break the tie.
      const [early, tiedLow, tiedHigh, archived, other] = [
        artifact({ createdAt: at(1), name: "Early Notes" }),
        artifact({
          createdAt: at(2),
          id: artifactIdSchema.parse("a-tied"),
          name: "Tied",
        }),
        artifact({
          createdAt: at(2),
          id: artifactIdSchema.parse("b-tied"),
          name: "Tied",
        }),
        artifact({
          archivedAt: at(3),
          createdAt: at(3),
          name: "Archived Notes",
          status: "archived",
        }),
        artifact({ createdAt: at(4), name: "Other", type: "image/png" }),
      ];
      // Committed out of order: the listing orders them, not the commit.
      await store.commit({
        putArtifacts: [other, archived, tiedHigh, early, tiedLow],
      });
      const listed = (query: Partial<ArtifactListQuery>) =>
        store.listArtifacts({ limit: 10, ...query });

      expect(await listed({})).toEqual({
        artifacts: [early, tiedLow, tiedHigh, other],
        total: 4,
      });
      expect((await listed({ includeArchived: true })).total).toBe(5);
      expect(await listed({ type: "image/png" })).toEqual({
        artifacts: [other],
        total: 1,
      });
      expect(await listed({ includeArchived: true, text: "NOTES" })).toEqual({
        artifacts: [early, archived],
        total: 2,
      });
      expect(
        (await listed({ text: tiedHigh.id.slice(0, 3) })).artifacts
      ).toEqual([tiedHigh]);
      expect(await listed({ limit: 2 })).toEqual({
        artifacts: [early, tiedLow],
        total: 4,
      });
      expect(
        await listed({ after: { createdAt: at(2), id: tiedLow.id }, limit: 2 })
      ).toEqual({ artifacts: [tiedHigh, other], total: 4 });
      expect(
        await listed({ after: { createdAt: at(4), id: other.id } })
      ).toEqual({ artifacts: [], total: 4 });
    });

    it("matches text as toLowerCase does, by code unit, with % and _ as themselves", async () => {
      const store = await fresh();
      const named = (title: string, fields: Partial<Artifact> = {}) =>
        artifact({ name: title, ...fields });
      const records = {
        accented: named("ÄRGER im Büro"),
        dotted: named("İstanbul"),
        emoji: named("😀 face"),
        greek: named("ΟΔΟΣ"),
        id: named("By id", { id: artifactIdSchema.parse("ID-ÄBC") }),
        percent: named("100% done"),
        plain: named("plain"),
        type: named("By type", { type: "TEXT/Markdown" }),
        underscore: named("snake_case"),
      };
      await store.commit({ putArtifacts: Object.values(records) });
      const matching = async (text: string) => {
        const listing = await store.listArtifacts({ limit: 100, text });
        expect(listing.total).toBe(listing.artifacts.length);
        return listing.artifacts.map((row) => row.name).sort();
      };

      expect(await matching("ärger")).toEqual(["ÄRGER im Büro"]);
      expect(await matching("ÄRGER")).toEqual(["ÄRGER im Büro"]);
      // "İ" lower-cases to "i" and a combining dot, so "istanbul" is no match.
      expect(await matching("i̇stanbul")).toEqual(["İstanbul"]);
      expect(await matching("istanbul")).toEqual([]);
      // A final capital sigma lower-cases to the final form.
      expect(await matching("ς")).toEqual(["ΟΔΟΣ"]);
      expect(await matching("σ")).toEqual([]);
      expect(await matching("%")).toEqual(["100% done"]);
      expect(await matching("0% d")).toEqual(["100% done"]);
      expect(await matching("_")).toEqual(["snake_case"]);
      expect(await matching("e_c")).toEqual(["snake_case"]);
      expect(await matching("%d")).toEqual([]);
      expect(await matching("markdown")).toEqual(["By type"]);
      expect(await matching("id-äb")).toEqual(["By id"]);
      // Half of a surrogate pair matches by code unit; a NUL matches nothing.
      expect(await matching("\uD83D")).toEqual(["😀 face"]);
      expect(await matching("\u0000")).toEqual([]);
      // Empty text matches everything.
      expect(await matching("")).toHaveLength(Object.keys(records).length);
    });

    it("orders tied Artifacts by id in code-unit order, and pages between them", async () => {
      const store = await fresh();
      const ids = ["￿", "😀", "a", ""];
      await store.commit({
        putArtifacts: ids.map((id) =>
          artifact({ id: artifactIdSchema.parse(id), name: id })
        ),
      });
      // By code unit, a surrogate pair (U+D83D…) sorts before U+E000;
      // by code point it would sort last.
      const order = ["a", "😀", "", "￿"];
      const page = async (after?: string, limit = 10) =>
        store.listArtifacts({
          ...(after === undefined
            ? {}
            : { after: { createdAt: AT, id: artifactIdSchema.parse(after) } }),
          limit,
        });
      const names = async (after?: string, limit?: number) =>
        (await page(after, limit)).artifacts.map((row) => row.name);

      expect(await names()).toEqual(order);
      expect(await names(undefined, 2)).toEqual(order.slice(0, 2));
      expect(await names("😀")).toEqual(order.slice(2));
      // A cursor need not name a stored Artifact: half a pair sorts first.
      expect(await names("\uD83D")).toEqual(order.slice(1));
      expect((await page("")).total).toBe(4);
    });

    it("counts every match of the filter, whatever the cursor and limit", async () => {
      const store = await fresh();
      const at = (seconds: number) => new Date(AT.getTime() + seconds * 1000);
      const rows = [
        artifact({ createdAt: at(1), name: "Draft note" }),
        artifact({ createdAt: at(2), name: "Image note", type: "image/png" }),
        artifact({
          archivedAt: at(3),
          createdAt: at(3),
          name: "Archived note",
          status: "archived",
        }),
        artifact({
          archivedAt: at(4),
          createdAt: at(4),
          name: "Archived image",
          status: "archived",
          type: "image/png",
        }),
        artifact({ createdAt: at(5), name: "Other" }),
      ];
      await store.commit({ putArtifacts: rows });
      const [first] = rows;
      const after = { createdAt: at(1), id: first?.id as ArtifactId };
      const cases: [Partial<ArtifactListQuery>, number, number][] = [
        [{}, 3, 3],
        [{ includeArchived: true }, 5, 5],
        [{ type: "image/png" }, 1, 1],
        [{ includeArchived: true, type: "image/png" }, 2, 2],
        [{ text: "note" }, 2, 2],
        [{ includeArchived: true, text: "NOTE" }, 3, 3],
        [{ includeArchived: true, text: "image", type: "image/png" }, 2, 2],
        [{ after, includeArchived: true }, 4, 5],
        [{ after, limit: 1, text: "note" }, 1, 2],
        [{ after, includeArchived: true, limit: 1, type: "image/png" }, 1, 2],
        [{ type: "missing" }, 0, 0],
        [{ text: "missing" }, 0, 0],
      ];
      for (const [query, listed, total] of cases) {
        const listing = await store.listArtifacts({ limit: 10, ...query });
        expect(
          [listing.artifacts.length, listing.total],
          JSON.stringify(query)
        ).toEqual([listed, total]);
      }
      // A cursor whose time is no valid Date compares by id alone.
      const [low, ...higher] = sorted(rows);
      const byId = await store.listArtifacts({
        after: { createdAt: new Date(Number.NaN), id: low?.id as ArtifactId },
        includeArchived: true,
        limit: 10,
      });
      expect(sorted(byId.artifacts)).toEqual(higher);
      expect(byId.total).toBe(5);
      // Kept in creation order, and paged: the cursor compares by id, the
      // order stays by time.
      const afterInvalid = (id: string, limit: number) =>
        store.listArtifacts({
          // Any id, the empty one too: a cursor need not name an Artifact.
          after: { createdAt: new Date(Number.NaN), id: id as ArtifactId },
          includeArchived: true,
          limit,
        });
      const pivot = higher[1]?.id ?? "";
      const kept = rows.filter((row) => row.id > pivot);
      expect((await afterInvalid(pivot, 10)).artifacts).toEqual(kept);
      expect(await afterInvalid(pivot, 1)).toEqual({
        artifacts: kept.slice(0, 1),
        total: 5,
      });
      expect((await afterInvalid("", 10)).artifacts).toEqual(rows);
    });

    it("matches text holding a lone surrogate by code unit, within one field, and bounds it by limit", async () => {
      const store = await fresh();
      const at = (seconds: number) => new Date(AT.getTime() + seconds * 1000);
      const rows = [
        artifact({ createdAt: at(1), name: "😀 face" }),
        artifact({ createdAt: at(2), name: "😀 other" }),
        // The pair ends the name and the type follows: no match across them.
        artifact({ createdAt: at(3), name: "x😀", type: "text/plain" }),
        artifact({ createdAt: at(4), name: "🙂 face" }),
        // Holds no unit U+D83D, though its units' hex digits run "…d83d…".
        artifact({ createdAt: at(5), name: "\u0AD8\u3D00" }),
      ];
      await store.commit({ putArtifacts: rows });
      const names = async (text: string, limit = 10) => {
        const listing = await store.listArtifacts({ limit, text });
        return {
          names: listing.artifacts.map((row) => row.name),
          total: listing.total,
        };
      };

      expect(await names("\uD83D")).toEqual({
        names: ["😀 face", "😀 other", "x😀", "🙂 face"],
        total: 4,
      });
      expect(await names("\uDE00")).toEqual({
        names: ["😀 face", "😀 other", "x😀"],
        total: 3,
      });
      expect(await names("\uDE00 f")).toEqual({
        names: ["😀 face"],
        total: 1,
      });
      expect(await names("\uDE00t")).toEqual({ names: [], total: 0 });
      expect(await names("\uDE00 O")).toEqual({
        names: ["😀 other"],
        total: 1,
      });
      expect(await names("\uD83D", 1)).toEqual({
        names: ["😀 face"],
        total: 4,
      });
      // NUL matches nothing, whatever else the text holds.
      expect(await names("\uD83D\u0000")).toEqual({ names: [], total: 0 });
    });

    it("names each referencing record once, and forgets a reference put away", async () => {
      const store = await fresh();
      const owner = artifact();
      const [leaf, other, spare] = [inlineBlob(), inlineBlob(), inlineBlob()];
      const manifest: Blob = {
        byteLength: 3,
        chunks: [leaf.id, leaf.id, spare.id],
        createdAt: AT,
        digest: OTHER_DIGEST,
        id: blobId(),
      };
      const version = content(owner.id, [leaf.id, leaf.id]);
      await store.commit({
        putArtifacts: [owner],
        putBlobs: [leaf, other, spare, manifest],
        putContents: [version],
      });
      expect(await store.findReferences(leaf.id)).toEqual({
        blobIds: [manifest.id],
        contentIds: [version.id],
      });

      // Put again naming other blobs, each record stops naming the first.
      await store.commit({
        putBlobs: [{ ...manifest, chunks: [other.id] }],
        putContents: [{ ...version, tree: content(owner.id, [other.id]).tree }],
      });
      expect(await store.findReferences(leaf.id)).toEqual({
        blobIds: [],
        contentIds: [],
      });
      expect(await store.findReferences(spare.id)).toEqual({
        blobIds: [],
        contentIds: [],
      });
      expect(await store.findReferences(other.id)).toEqual({
        blobIds: [manifest.id],
        contentIds: [version.id],
      });

      await store.commit({
        deleteBlobs: [manifest.id],
        deleteContents: [version.id],
      });
      expect(await store.findReferences(other.id)).toEqual({
        blobIds: [],
        contentIds: [],
      });
    });

    it("keeps the last of one record put twice in one write", async () => {
      const store = await fresh();
      const owner = artifact();
      const [first, last] = [inlineBlob(), inlineBlob()];
      const version = content(owner.id, [first.id]);
      const again = { ...version, tree: content(owner.id, [last.id]).tree };
      await store.commit({
        putArtifacts: [owner, { ...owner, name: "Last" }],
        putBlobs: [first, last],
        putContents: [version, again],
      });
      expect((await store.getArtifact(owner.id))?.name).toBe("Last");
      expect(await store.getContent(version.id)).toEqual(again);
      expect((await store.findReferences(first.id)).contentIds).toEqual([]);
      expect((await store.findReferences(last.id)).contentIds).toEqual([
        version.id,
      ]);
    });

    it("gives every field back exactly, set or null, of every record and source", async () => {
      const store = await fresh();
      const later = new Date(AT.getTime() + 1234);
      const owner = artifact({
        archivedAt: later,
        metadata: {
          // A computed key: an own property, not the prototype.
          ["__proto__"]: { own: true },
          nested: { list: [1, -1.5, "two", null, true, { deep: [] }] },
          sessionId: "s",
          unicode: "\u0000 and \uD800 kept in JSON",
        },
        publishedAt: later,
        status: "archived",
      });
      const bare = artifact();
      const empty: Blob = {
        byteLength: 0,
        bytes: new Uint8Array(0),
        createdAt: AT,
        digest: DIGEST,
        id: blobId(),
      };
      const backed: Blob = {
        byteLength: 2,
        createdAt: later,
        digest: OTHER_DIGEST,
        id: blobId(),
        path: "objects/ab/cd",
      };
      const leaf = inlineBlob();
      const manifest: Blob = {
        byteLength: 1,
        chunks: [leaf.id],
        createdAt: AT,
        digest: DIGEST,
        id: blobId(),
      };
      const version: Content = {
        ...content(owner.id, [backed.id]),
        frozenAt: later,
        metadata: {
          entries: { main: "0.txt" },
          entry: "0.txt",
          failure: { code: "x", message: "y" },
          unknown: { kept: [1] },
        },
        state: "frozen",
        tag: "v1",
        tree: {
          ["__proto__"]: { type: "directory" },
          "0.txt": {
            blobId: backed.id,
            bytes: 2,
            digest: OTHER_DIGEST,
            mime: "text/plain",
            type: "file",
          },
          "1.bin": {
            blobId: empty.id,
            bytes: 0,
            digest: DIGEST,
            mime: null,
            type: "file",
          },
          dev: { type: "device" },
          dir: { type: "directory" },
          link: { target: "../elsewhere", type: "symlink" },
          pipe: { type: "pipe" },
          sock: { type: "socket" },
        },
      };
      const pointed = { ...owner, contentId: version.id };
      await store.commit({
        putArtifacts: [pointed, bare],
        putBlobs: [empty, backed, leaf, manifest],
        putContents: [version],
      });

      expect(await store.getArtifact(pointed.id)).toStrictEqual(pointed);
      expect(await store.getArtifact(bare.id)).toStrictEqual(bare);
      expect(await store.getContent(version.id)).toStrictEqual(version);
      for (const blob of [empty, backed, leaf, manifest]) {
        expect(await store.getBlob(blob.id)).toStrictEqual(blob);
      }
      expect(await store.findBlobs(OTHER_DIGEST)).toStrictEqual([backed]);
      // An own `__proto__` key is kept as a key, in metadata and in a tree.
      const read = await store.getContent(version.id);
      expect(Object.hasOwn(read?.tree ?? {}, "__proto__")).toBe(true);
      const owned = (await store.getArtifact(pointed.id))?.metadata;
      expect(Object.hasOwn(owned ?? {}, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(owned)).toBe(Object.prototype);
    });

    it("commits a tree naming thousands of blobs, and deletes tens of thousands of ids, in one write", async () => {
      const store = await fresh();
      const owner = artifact();
      const files = 11_000;
      const named = Array.from({ length: files }, () => blobId());
      const version = content(owner.id, named);
      await store.commit({ putArtifacts: [owner], putContents: [version] });
      expect(await store.getContent(version.id)).toEqual(version);
      expect(await store.findReferences(named[files - 1] as BlobId)).toEqual({
        blobIds: [],
        contentIds: [version.id],
      });

      // Far more ids than one statement binds; none of them is stored.
      const absent = 33_000;
      await store.commit({
        deleteArtifacts: Array.from({ length: absent }, () => artifactId()),
        deleteBlobs: Array.from({ length: absent }, () => blobId()),
        deleteContents: [
          ...Array.from({ length: absent }, () => contentId()),
          version.id,
        ],
      });
      expect(await store.getContent(version.id)).toBeNull();
      expect(await store.findReferences(named[0] as BlobId)).toEqual({
        blobIds: [],
        contentIds: [],
      });
      expect(await everyArtifact(store)).toEqual([owner]);
    }, 30_000);

    it("commits and deletes thousands of records in one write", async () => {
      const store = await fresh();
      // Past one statement's rows for each table: 2184 Artifacts, 2978
      // Contents, 4095 blobs.
      const count = 5000;
      const owners = Array.from({ length: count }, () => artifact());
      const blobs = owners.map(() => inlineBlob());
      const versions = owners.map((owner, index) =>
        content(owner.id, [blobs[index]?.id as BlobId, blobs[0]?.id as BlobId])
      );
      await store.commit({
        putArtifacts: owners,
        putBlobs: blobs,
        putContents: versions,
      });
      expect((await store.listArtifacts({ limit: 10 })).total).toBe(count);
      expect(await store.listContents()).toHaveLength(count);
      expect(await store.listBlobs()).toHaveLength(count);
      expect(
        (await store.findReferences(blobs[0]?.id as BlobId)).contentIds
      ).toHaveLength(count);

      await store.commit({
        deleteArtifacts: owners.map((row) => row.id),
        deleteBlobs: blobs.map((row) => row.id),
        deleteContents: versions.map((row) => row.id),
      });
      expect(await everyArtifact(store)).toEqual([]);
      expect(await store.listContents()).toEqual([]);
      expect(await store.listBlobs()).toEqual([]);
      expect(await store.findReferences(blobs[0]?.id as BlobId)).toEqual({
        blobIds: [],
        contentIds: [],
      });
    }, 30_000);

    it("takes a write as it stands when commit is called, whatever the caller changes after", async () => {
      const store = await fresh();
      const transaction = requireTransaction(store);
      const owner = artifact({ metadata: { list: ["kept"] } });
      const [leaf, other] = [inlineBlob(), inlineBlob()];
      const version = content(owner.id, [leaf.id]);
      const manifest: Blob = {
        byteLength: 1,
        chunks: [leaf.id],
        createdAt: AT,
        digest: OTHER_DIGEST,
        id: blobId(),
      };
      const expected = structuredClone({ manifest, owner, version });
      const check = async (target: ArtifactStore) => {
        expect(await target.getArtifact(owner.id)).toEqual(expected.owner);
        expect(await target.getContent(version.id)).toEqual(expected.version);
        expect(await target.getBlob(manifest.id)).toEqual(expected.manifest);
        expect(await target.findReferences(leaf.id)).toEqual({
          blobIds: [manifest.id],
          contentIds: [version.id],
        });
        expect(await target.findReferences(other.id)).toEqual({
          blobIds: [],
          contentIds: [],
        });
        expect(await everyArtifact(target)).toHaveLength(1);
      };
      const writeOf = () => ({
        putArtifacts: [structuredClone(owner)],
        putBlobs: [leaf, other, structuredClone(manifest)],
        putContents: [structuredClone(version)],
      });

      // Changed at once, while the commit waits behind a transaction.
      const held = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const running = transaction(async () => {
        entered.resolve();
        await held.promise;
      });
      await entered.promise;
      const queued = writeOf();
      const landing = store.commit(queued);
      scramble(queued, other.id);
      held.resolve();
      await Promise.all([running, landing]);
      await check(store);

      // And through a transaction's view.
      const second = await fresh();
      await requireTransaction(second)(async (view) => {
        const through = writeOf();
        const committed = view.commit(through);
        scramble(through, other.id);
        await committed;
        await check(view);
      });
      await check(second);
    });

    it("keeps a value as structuredClone takes it: no caller's toJSON runs, a getter's value stays", async () => {
      const store = await fresh();
      const hidden = { sessionId: "real" };
      Object.defineProperty(hidden, "toJSON", {
        enumerable: false,
        value: () => ({ sessionId: "changed" }),
      });
      const inherited = Object.create({
        toJSON: () => ({ sessionId: "changed" }),
      }) as Record<string, unknown>;
      inherited.sessionId = "real";
      let reads = 0;
      const getter = Object.defineProperty({}, "sessionId", {
        enumerable: true,
        get() {
          reads += 1;
          return reads === 1 ? "real" : "changed";
        },
      });
      const records = [hidden, inherited, getter].map((metadata) =>
        artifact({ metadata: metadata as Artifact["metadata"] })
      );
      await store.commit({ putArtifacts: records });

      for (const record of records) {
        expect((await store.getArtifact(record.id))?.metadata).toStrictEqual({
          sessionId: "real",
        });
      }
      expect(reads).toBe(1);
    });

    it("commits for good itself, and says its transaction's view does not", async () => {
      const store = await fresh();
      expect(store.durability ?? "commit").toBe("commit");
      const durability = await requireTransaction(store)((view) =>
        Promise.resolve(view.durability)
      );
      // A view's commits stand only if the transaction's work succeeds.
      expect(durability).toBe("host");
    });

    it("refuses a listing limit that is not a positive safe integer", async () => {
      const store = await fresh();
      await store.commit({ putArtifacts: [artifact(), artifact()] });
      for (const limit of [
        -1,
        0,
        2.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        2 ** 53,
      ]) {
        await expect(store.listArtifacts({ limit })).rejects.toThrow(
          "limit must be a positive safe integer"
        );
        await expect(
          requireTransaction(store)((view) => view.listArtifacts({ limit }))
        ).rejects.toThrow("limit must be a positive safe integer");
      }
      expect(
        (await store.listArtifacts({ limit: Number.MAX_SAFE_INTEGER })).total
      ).toBe(2);
    });

    it("lists by the query as it stands when called, whatever the caller changes after", async () => {
      const store = await fresh();
      const transaction = requireTransaction(store);
      const at = (seconds: number) => new Date(AT.getTime() + seconds * 1000);
      const rows = [1, 2, 3].map((seconds) =>
        artifact({ createdAt: at(seconds), name: `Note ${String(seconds)}` })
      );
      await store.commit({ putArtifacts: rows });
      const [first, second] = rows;
      const held = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const running = transaction(async () => {
        entered.resolve();
        await held.promise;
      });
      await entered.promise;
      const after = { createdAt: at(1), id: first?.id as ArtifactId };
      const query = { after, limit: 1, text: "note", type: "text/plain" };
      const listing = store.listArtifacts(query);
      Object.assign(query, { limit: 10, text: "other", type: "image/png" });
      after.createdAt.setTime(0);
      held.resolve();
      await running;

      expect(await listing).toEqual({ artifacts: [second], total: 3 });
    });

    it("keeps a blob's bytes as they were at the call, even over shared memory", async () => {
      const store = await fresh();
      const outer = sharedBlob();
      const landing = store.commit({ putBlobs: [outer] });
      outer.bytes[0] = 9;
      await landing;

      const inner = sharedBlob();
      await requireTransaction(store)(async (view) => {
        const committed = view.commit({ putBlobs: [inner] });
        inner.bytes[0] = 9;
        await committed;
        expect((await view.getBlob(inner.id))?.bytes).toEqual(
          new Uint8Array([1, 2])
        );
      });

      for (const id of [outer.id, inner.id]) {
        const stored = await store.getBlob(id);
        expect(stored?.bytes).toEqual(new Uint8Array([1, 2]));
        expect(stored?.bytes?.buffer).not.toBeInstanceOf(SharedArrayBuffer);
      }
    });

    it("hands out bytes that share no memory with what it holds", async () => {
      const store = await fresh();
      const blob = sharedBlob();
      await store.commit({ putBlobs: [blob] });

      const [found] = await store.findBlobs(blob.digest);
      found?.bytes?.fill(7);
      (await store.getBlob(blob.id))?.bytes?.fill(8);
      await requireTransaction(store)(async (view) => {
        (await view.getBlob(blob.id))?.bytes?.fill(6);
      });
      expect((await store.getBlob(blob.id))?.bytes).toEqual(
        new Uint8Array([1, 2])
      );
    });

    it("queues a plain commit behind a running transaction", async () => {
      const store = await fresh();
      const transaction = requireTransaction(store);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const order: string[] = [];
      const running = transaction(async (view) => {
        entered();
        await held;
        expect(await everyArtifact(view)).toEqual([]);
        order.push("transaction ends");
      });
      await inside;
      const outside = store
        .commit({ putArtifacts: [artifact({ name: "Outside" })] })
        .then(() => order.push("outside lands"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(order).toEqual([]);
      release();
      await Promise.all([running, outside]);
      expect(order).toEqual(["transaction ends", "outside lands"]);
      expect(await everyArtifact(store)).toHaveLength(1);
    });

    it("runs transactions one at a time", async () => {
      const store = await fresh();
      const transaction = requireTransaction(store);
      const order: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = transaction(async (view) => {
        order.push("first starts");
        await held;
        await view.commit({ putArtifacts: [artifact({ name: "First" })] });
        order.push("first commits");
      });
      const second = transaction(async (view) => {
        order.push("second starts");
        expect((await everyArtifact(view)).map((row) => row.name)).toEqual([
          "First",
        ]);
        await view.commit({ putArtifacts: [artifact({ name: "Second" })] });
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await Promise.all([first, second]);
      expect(order).toEqual(["first starts", "first commits", "second starts"]);
      expect(await everyArtifact(store)).toHaveLength(2);
    });

    it("reads a transaction's own commits through its view", async () => {
      const store = await fresh();
      const transaction = requireTransaction(store);
      const record = artifact();
      const blob = inlineBlob();
      await transaction(async (view) => {
        await view.commit({ putArtifacts: [record], putBlobs: [blob] });
        expect(await view.getArtifact(record.id)).toEqual(record);
        expect(await everyArtifact(view)).toEqual([record]);
        expect(await view.findBlobs(DIGEST)).toEqual([blob]);
        await view.commit({ deleteBlobs: [blob.id] });
        expect(await view.getBlob(blob.id)).toBeNull();
      });
      expect(await store.getArtifact(record.id)).toEqual(record);
      expect(await store.getBlob(blob.id)).toBeNull();
    });

    it("keeps every commit made concurrently through one view", async () => {
      const storage = await open();
      const store = storage("conformance");
      const transaction = requireTransaction(store);
      const first = artifact({ name: "First" });
      const second = artifact({ name: "Second" });
      const named = (rows: readonly Artifact[]) =>
        rows.map((row) => row.name).sort();
      await transaction(async (view) => {
        await Promise.all([
          view.commit({ putArtifacts: [first] }),
          view.commit({ putArtifacts: [second] }),
        ]);
        expect(named(await everyArtifact(view))).toEqual(["First", "Second"]);
      });
      expect(named(await everyArtifact(store))).toEqual(["First", "Second"]);
      // Opened again over the same storage: what was saved, not what is cached.
      expect(named(await everyArtifact(storage("conformance")))).toEqual([
        "First",
        "Second",
      ]);
    });

    it("refuses a call to the outer store from inside its own transaction, at once", async () => {
      const store = await fresh();
      const transaction = requireTransaction(store);
      const inner = artifact({ name: "Inner" });
      const calls: Record<string, () => Promise<unknown>> = {
        commit: () => store.commit({ putArtifacts: [artifact()] }),
        transaction: () => transaction(() => Promise.resolve()),
      };
      const ended = Promise.withResolvers<void>();
      let later: Promise<unknown> = Promise.resolve();

      const refusals = await transaction(async (view) => {
        const outcomes: Record<string, string> = {};
        for (const [method, call] of Object.entries(calls)) {
          outcomes[method] = await settlesWithin(call(), 1000);
        }
        // Scheduled from inside, but run once the transaction has ended.
        later = ended.promise.then(() =>
          store.commit({ putArtifacts: [artifact({ name: "Later" })] })
        );
        await view.commit({ putArtifacts: [inner] });
        return outcomes;
      });
      ended.resolve();

      expect(refusals).toEqual({
        commit: expect.stringMatching(REFUSAL),
        transaction: expect.stringMatching(REFUSAL),
      });
      await later;
      await store.commit({ putArtifacts: [artifact({ name: "After" })] });
      expect(
        (await everyArtifact(store)).map((row) => row.name).sort()
      ).toEqual(["After", "Inner", "Later"]);
    });

    it("queues an independent caller behind a transaction it runs alongside", async () => {
      const store = await fresh();
      const transaction = requireTransaction(store);
      const read = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();
      const running = transaction(async (view) => {
        const before = await everyArtifact(view);
        read.resolve();
        await proceed.promise;
        return { after: await everyArtifact(view), before };
      });
      await read.promise;
      const outside = store.commit({ putArtifacts: [artifact()] });
      const nested = transaction(() => Promise.resolve("queued"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      proceed.resolve();
      expect(await running).toEqual({ after: [], before: [] });
      await outside;
      expect(await nested).toBe("queued");
      expect(await everyArtifact(store)).toHaveLength(1);
    });

    it("rejects a view used after its transaction settled", async () => {
      const store = await fresh();
      const transaction = requireTransaction(store);
      const kept = await transaction((view) => Promise.resolve(view));
      await expect(kept.listBlobs()).rejects.toThrow("settled");
      await expect(kept.commit({ putArtifacts: [artifact()] })).rejects.toThrow(
        "settled"
      );
      expect(await everyArtifact(store)).toEqual([]);
    });

    it("keeps none of a transaction's commits when its work throws", async () => {
      const store = await fresh();
      const transaction = requireTransaction(store);
      const before = artifact();
      await store.commit({ putArtifacts: [before] });
      await expect(
        transaction(async (view) => {
          await view.commit({ putArtifacts: [artifact()] });
          await view.commit({ deleteArtifacts: [before.id] });
          throw new Error("abandoned");
        })
      ).rejects.toThrow("abandoned");
      expect(await everyArtifact(store)).toEqual([before]);
    });
  });
}

/** The suite's proof that a store hands its host hook every commit's events. */
function describeRecordedEvents(
  name: string,
  recording: () => Promise<RecordingArtifactStores>
): void {
  const recorder = async () => {
    const opened = await recording();
    return { ...opened, store: opened.stores("conformance") };
  };
  const created = (owner: Artifact) =>
    event({ artifactId: owner.id, type: "artifact.created" });

  describe(`${name} Artifact store events handed to the host`, () => {
    it("hands on each commit's events once, in order, and none for a write without", async () => {
      const { recorded, store } = await recorder();
      const owner = artifact();
      const version = content(owner.id);
      const first = [
        created(owner),
        event({
          artifactId: owner.id,
          contentId: version.id,
          type: "artifact.written",
        }),
      ];
      await store.commit({
        events: first,
        putArtifacts: [owner],
        putContents: [version],
      });
      await store.commit({ putArtifacts: [{ ...owner, name: "renamed" }] });
      const gone = removedEvent();
      await store.commit({ events: [gone] });

      expect(await recorded()).toStrictEqual([...first, gone]);
    });

    it("hands on the events as they were when commit was called", async () => {
      const { recorded, store } = await recorder();
      const owner = artifact();
      const events = [created(owner)];
      const expected = structuredClone(events);

      const pending = store.commit({ events, putArtifacts: [owner] });
      Object.assign(events[0] ?? {}, { type: "artifact.removed" });
      events.push(removedEvent());
      await pending;

      expect(await recorded()).toStrictEqual(expected);
    });

    it("hands on plain JSON, and nothing of a write whose event is not", async () => {
      const { recorded, store } = await recorder();
      const owner = artifact();
      const dated = { ...created(owner), at: new Date() };

      await expect(
        store.commit({
          events: [dated as unknown as ArtifactEvent],
          putArtifacts: [owner],
        })
      ).rejects.toThrow(TypeError);
      expect(await store.getArtifact(owner.id)).toBeNull();
      expect(await recorded()).toStrictEqual([]);
    });

    it("records nothing for a write it refuses", async () => {
      const { recorded, store } = await recorder();
      const owner = artifact({ metadata: { unstorable: () => undefined } });

      await expect(
        store.commit({ events: [created(owner)], putArtifacts: [owner] })
      ).rejects.toThrow();
      expect(await recorded()).toStrictEqual([]);
    });

    it("runs the hook inside the commit: a throw from it keeps neither the write nor its events", async () => {
      const { failNextCommit, recorded, store } = await recorder();
      const owner = artifact();
      failNextCommit();

      await expect(
        store.commit({ events: [created(owner)], putArtifacts: [owner] })
      ).rejects.toThrow();
      expect(await store.getArtifact(owner.id)).toBeNull();
      expect(await recorded()).toStrictEqual([]);

      const kept = created(owner);
      await store.commit({ events: [kept], putArtifacts: [owner] });
      expect(await recorded()).toStrictEqual([kept]);
    });

    it("records a transaction's events only when it is kept", async () => {
      const { recorded, store } = await recorder();
      const transaction = requireTransaction(store);
      const dropped = artifact();
      const owner = artifact();
      const version = content(owner.id);
      const kept = [
        created(owner),
        event({
          artifactId: owner.id,
          contentId: version.id,
          type: "artifact.written",
        }),
      ];

      await expect(
        transaction(async (view) => {
          await view.commit({
            events: [created(dropped)],
            putArtifacts: [dropped],
          });
          throw new Error("work failed");
        })
      ).rejects.toThrow("work failed");
      await transaction(async (view) => {
        await view.commit({
          events: [kept[0] as ArtifactEvent],
          putArtifacts: [owner],
        });
        await view.commit({
          events: [kept[1] as ArtifactEvent],
          putContents: [version],
        });
      });

      expect(await recorded()).toStrictEqual(kept);
    });
  });
}
