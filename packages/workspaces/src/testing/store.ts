import { describe, expect, test } from "vitest";
import type {
  WorkspaceEntry,
  WorkspaceEvent,
  WorkspaceFile,
  WorkspaceId,
  WorkspaceRegistration,
} from "../schema";
import type { WorkspaceStore, WorkspaceStoreWrite } from "../store";
import {
  directoryRecord,
  fileRecord,
  hostWorkspace,
  newRoot,
  newWorkspaceEntryId,
  newWorkspaceId,
  otherSourceWorkspace,
  seed,
} from "./records";

export type ScopedWorkspaceStores = (scope: string) => WorkspaceStore;

export interface RecordingWorkspaceStores {
  readonly failNextCommit: () => void;
  readonly recorded: () => Promise<readonly WorkspaceEvent[]>;
  readonly stores: ScopedWorkspaceStores;
}

export type WorkspaceStoreMode =
  | { readonly hooked: false }
  | {
      readonly hooked: true;
      readonly recording: () => Promise<RecordingWorkspaceStores>;
    };

export function describeWorkspaceStore(
  name: string,
  open: () => ScopedWorkspaceStores | Promise<ScopedWorkspaceStores>,
  mode: WorkspaceStoreMode
): void {
  describe(`${name} WorkspaceStore conformance`, () => {
    describeEvents(open);
    if (mode.hooked) {
      describeRecordedEvents(mode.recording);
    }
    describeReads(open);
    describeOrdering(open);
    describeWrites(open);
    describeScopes(open);
    describeAtomicity(open);
    describeDetachment(open);
    describeOwnership(open);
    describeLargeWrites(open);
    describeTransactions(open);
    describeReentry(open);
    describeFailedTurns(open);
  });
}

type Open = () => ScopedWorkspaceStores | Promise<ScopedWorkspaceStores>;

const SCOPE = "workspaces";

const AT = "2026-01-01T00:00:00.000Z";

function createdEvent(workspaceId: WorkspaceId): WorkspaceEvent {
  return {
    at: AT,
    id: `created-${workspaceId}`,
    type: "workspace.created",
    workspaceId,
  };
}

function removedEvent(workspaceId: WorkspaceId): WorkspaceEvent {
  return {
    at: AT,
    id: `removed-${workspaceId}`,
    type: "workspace.removed",
    workspaceId,
  };
}

function entriesEvent(
  workspaceId: WorkspaceId,
  added: readonly WorkspaceEntry[]
): WorkspaceEvent {
  return {
    added: added.map((entry) => entry.id),
    at: AT,
    changed: [],
    id: `entries-${workspaceId}`,
    removed: [],
    type: "workspace.entries.changed",
    workspaceId,
  };
}

const UNPLAIN_EVENTS: [
  string,
  (workspaceId: WorkspaceId) => WorkspaceEvent[],
][] = [
  [
    "a class instance",
    (workspaceId) => {
      class Created {
        readonly at = AT;
        readonly id = "e";
        readonly type = "workspace.created";
        readonly workspaceId = workspaceId;
      }
      return [new Created() as unknown as WorkspaceEvent];
    },
  ],
  [
    "an object with an own property a copy would not see",
    (workspaceId) => {
      const event = { ...createdEvent(workspaceId) };
      Object.defineProperty(event, "id", { enumerable: false, value: "e" });
      return [event];
    },
  ],
  [
    "an object with a symbol key",
    (workspaceId) => [
      { ...createdEvent(workspaceId), [Symbol("extra")]: 1 } as WorkspaceEvent,
    ],
  ],
  [
    "an object holding a Date",
    (workspaceId) => [
      {
        ...createdEvent(workspaceId),
        at: new Date(0),
      } as unknown as WorkspaceEvent,
    ],
  ],
  [
    "an object holding undefined",
    (workspaceId) => [
      {
        ...createdEvent(workspaceId),
        extra: undefined,
      } as unknown as WorkspaceEvent,
    ],
  ],
  [
    "an object holding NaN",
    (workspaceId) => [
      {
        ...createdEvent(workspaceId),
        extra: Number.NaN,
      } as unknown as WorkspaceEvent,
    ],
  ],
  [
    "not an array",
    (workspaceId) =>
      ({
        0: createdEvent(workspaceId),
        length: 1,
      }) as unknown as WorkspaceEvent[],
  ],
  [
    "an Array subclass",
    (workspaceId) => {
      class Events extends Array<WorkspaceEvent> {}
      return Events.from([createdEvent(workspaceId)]);
    },
  ],
  [
    "an array holding an Array subclass",
    (workspaceId) => {
      class Ids extends Array<string> {}
      return [
        {
          ...createdEvent(workspaceId),
          extra: Ids.from(["a"]),
        } as unknown as WorkspaceEvent,
      ];
    },
  ],
  [
    "an array holding an array with a hidden function",
    (workspaceId) => {
      const items = ["a"];
      Object.defineProperty(items, "hidden", { value: () => undefined });
      return [
        {
          ...createdEvent(workspaceId),
          extra: items,
        } as unknown as WorkspaceEvent,
      ];
    },
  ],
  [
    "an array holding an array with a symbol key",
    (workspaceId) => {
      const items = Object.assign(["a"], { [Symbol("extra")]: 1 });
      return [
        {
          ...createdEvent(workspaceId),
          extra: items,
        } as unknown as WorkspaceEvent,
      ];
    },
  ],
  [
    "an array with an own property beyond its items",
    (workspaceId) =>
      Object.assign([createdEvent(workspaceId)], {
        "-1": createdEvent(workspaceId),
      }),
  ],
];

function uncopyable(workspaceId: WorkspaceId): WorkspaceEntry {
  const entry = directoryRecord(workspaceId, "docs");
  Object.defineProperty(entry, "name", {
    enumerable: true,
    get: () => {
      throw new Error("uncopyable");
    },
  });
  return entry;
}

function describeEvents(open: Open): void {
  describe("events", () => {
    test("a write's events change no record", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("events") });
      const docs = directoryRecord(workspace.id, "docs");
      await store.commit({
        events: [
          createdEvent(workspace.id),
          entriesEvent(workspace.id, [docs]),
        ],
        putEntries: [docs],
        workspace,
      });

      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await store.listEntries(workspace.id)).toEqual([docs]);
    });

    test.each(UNPLAIN_EVENTS)(
      "a write whose events are %s is refused whole, with a TypeError",
      async (_kind, events) => {
        const store = (await open())(SCOPE);
        const workspace = hostWorkspace({ path: newRoot("events") });

        await expect(
          store.commit({ events: events(workspace.id), workspace })
        ).rejects.toThrow(TypeError);
        await expect(
          store.commit({
            events: events(workspace.id),
            removeWorkspace: workspace.id,
          })
        ).rejects.toThrow(TypeError);
        expect(await store.getWorkspace(workspace.id)).toBeNull();
      }
    );

    test.each(UNPLAIN_EVENTS)(
      "a transaction's view refuses a write whose events are %s",
      async (_kind, events) => {
        const store = (await open())(SCOPE);
        const { transaction } = store;
        if (transaction === undefined) {
          return;
        }
        const refused = hostWorkspace({ path: newRoot("refused") });
        const kept = hostWorkspace({ path: newRoot("kept") });

        await transaction.call(store, async (view) => {
          await expect(
            view.commit({ events: events(refused.id), workspace: refused })
          ).rejects.toThrow(TypeError);
          await view.commit({ workspace: kept });
        });
        expect(await store.getWorkspace(refused.id)).toBeNull();
        expect(await store.getWorkspace(kept.id)).toEqual(kept);
      }
    );
  });
}

function describeRecordedEvents(
  recording: () => Promise<RecordingWorkspaceStores>
): void {
  const recorder = async () => {
    const opened = await recording();
    return { ...opened, store: opened.stores(SCOPE) };
  };

  describe("events handed to the host", () => {
    test("each commit's events are handed on once, in order, and none for a write without", async () => {
      const { recorded, store } = await recorder();
      const workspace = hostWorkspace({ path: newRoot("events") });
      const docs = directoryRecord(workspace.id, "docs");
      const first = [
        createdEvent(workspace.id),
        entriesEvent(workspace.id, [docs]),
      ];
      await store.commit({ events: first, putEntries: [docs], workspace });
      await store.commit({ workspace: { ...workspace, name: "quiet" } });
      await store.commit({
        events: [removedEvent(workspace.id)],
        removeWorkspace: workspace.id,
      });

      expect(await recorded()).toEqual([...first, removedEvent(workspace.id)]);
    });

    test("the events are handed on as they were when commit was called", async () => {
      const { recorded, store } = await recorder();
      const workspace = hostWorkspace({ path: newRoot("events") });
      const event = { ...createdEvent(workspace.id) };

      const pending = store.commit({ events: [event], workspace });
      (event as { id: string }).id = "changed later";
      await pending;

      expect(await recorded()).toEqual([createdEvent(workspace.id)]);
    });

    test("a write whose events the store refuses records nothing", async () => {
      const { recorded, store } = await recorder();
      const workspace = hostWorkspace({ path: newRoot("events") });
      for (const [, events] of UNPLAIN_EVENTS) {
        await expect(
          store.commit({ events: events(workspace.id), workspace })
        ).rejects.toThrow(TypeError);
      }
      expect(await recorded()).toEqual([]);
    });

    test("a write the store refuses records nothing", async () => {
      const { recorded, store } = await recorder();
      const workspace = hostWorkspace({ path: newRoot("events") });

      await expect(
        store.commit({
          events: [createdEvent(workspace.id)],
          putEntries: [uncopyable(workspace.id)],
          workspace,
        })
      ).rejects.toThrow("uncopyable");
      expect(await recorded()).toEqual([]);
    });

    test("the hook runs inside the commit: a throw from it keeps neither the write nor its events", async () => {
      const { failNextCommit, recorded, store } = await recorder();
      const workspace = hostWorkspace({ path: newRoot("events") });
      failNextCommit();

      await expect(
        store.commit({ events: [createdEvent(workspace.id)], workspace })
      ).rejects.toThrow();
      expect(await store.getWorkspace(workspace.id)).toBeNull();
      expect(await recorded()).toEqual([]);

      await store.commit({ events: [createdEvent(workspace.id)], workspace });
      expect(await recorded()).toEqual([createdEvent(workspace.id)]);
    });

    test("a transaction's events are recorded only when it is kept", async () => {
      const { recorded, store } = await recorder();
      const { transaction } = store;
      if (transaction === undefined) {
        return;
      }
      const dropped = hostWorkspace({ path: newRoot("dropped") });
      const kept = hostWorkspace({ path: newRoot("kept") });
      const docs = directoryRecord(kept.id, "docs");

      await expect(
        transaction.call(store, async (view) => {
          await view.commit({
            events: [createdEvent(dropped.id)],
            workspace: dropped,
          });
          throw new Error("work failed");
        })
      ).rejects.toThrow("work failed");
      await transaction.call(store, async (view) => {
        await view.commit({ events: [createdEvent(kept.id)], workspace: kept });
        await view.commit({
          events: [entriesEvent(kept.id, [docs])],
          putEntries: [docs],
          workspace: kept,
        });
      });

      expect(await recorded()).toEqual([
        createdEvent(kept.id),
        entriesEvent(kept.id, [docs]),
      ]);
    });
  });
}

function describeReads(open: Open): void {
  describe("reads", () => {
    test("answer an empty store with nothing", async () => {
      const store = (await open())(SCOPE);
      const absent = newWorkspaceId();

      expect(await store.getWorkspace(absent)).toBeNull();
      expect(await store.getEntry(absent, newWorkspaceEntryId())).toBeNull();
      expect(await store.listEntries(absent)).toEqual([]);
      expect(await store.findWorkspaceByPath(newRoot("absent"))).toBeNull();
      expect(await store.findWorkspaceBySourceId("absent")).toBeNull();
      expect(await store.listWorkspaces()).toEqual({ items: [], total: 0 });
    });

    test("round-trip a registration and its entries in path order", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const docs = directoryRecord(workspace.id, "docs");
      const readme = fileRecord(workspace.id, { path: "README.md" });
      const guide = fileRecord(workspace.id, { path: "docs/guide.md" });
      const link = {
        ...directoryRecord(workspace.id, "latest"),
        target: "docs/guide.md",
        type: "symlink",
      } as const;
      await seed(store, workspace, [guide, link, docs, readme]);

      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await store.listEntries(workspace.id)).toEqual([
        readme,
        docs,
        guide,
        link,
      ]);
      expect(await store.getEntry(workspace.id, guide.id)).toEqual(guide);
      expect(await store.getEntry(workspace.id, link.id)).toEqual(link);
    });

    test("keep every value as written, at the edges of each field", async () => {
      const store = (await open())(SCOPE);
      const workspace: WorkspaceRegistration = {
        createdAt: new Date(-8.64e15),
        id: newWorkspaceId(),
        lastReconciledAt: new Date(8.64e15),
        name: "\u{1F600} Ａ \t\n",
        source: { kind: "", path: newRoot("edges"), sourceId: "" },
        updatedAt: new Date(0),
      };
      const unnamed = hostWorkspace({ path: newRoot("unnamed") });
      const entries: WorkspaceEntry[] = [
        fileRecord(workspace.id, {
          bytes: 0,
          extension: null,
          mime: null,
          path: "empty",
        }),
        fileRecord(workspace.id, {
          bytes: Number.MAX_SAFE_INTEGER,
          createdAt: new Date(-1),
          extension: "",
          kind: "other",
          mime: "",
          path: "huge.bin",
          updatedAt: new Date(8.64e15),
        }),
        {
          ...directoryRecord(workspace.id, "link"),
          target: "",
          type: "symlink",
        },
        { ...directoryRecord(workspace.id, "socket"), type: "socket" },
        { ...directoryRecord(workspace.id, "device"), type: "device" },
        { ...directoryRecord(workspace.id, "pipe"), type: "pipe" },
      ];
      await seed(store, workspace, entries);
      await seed(store, unnamed);

      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await store.getWorkspace(unnamed.id)).toEqual(unnamed);
      expect(await store.findWorkspaceBySourceId("")).toEqual(workspace);
      expect(await store.listEntries(workspace.id)).toEqual(
        [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))
      );
      for (const entry of entries) {
        expect(await store.getEntry(workspace.id, entry.id)).toEqual(entry);
      }
    });

    test("page within bounds, past the end, and over the largest page", async () => {
      const store = (await open())(SCOPE);
      const created = Array.from({ length: 201 }, (_, index) =>
        hostWorkspace({
          createdAt: new Date(index),
          path: newRoot(String(index)),
        })
      );
      for (const workspace of created) {
        await seed(store, workspace);
      }

      const largest = await store.listWorkspaces({ limit: 1000 });
      expect(largest.items).toEqual(created.slice(0, 200));
      expect(largest.total).toBe(201);
      expect(largest.nextCursor).toBe(200);
      expect(await store.listWorkspaces({ cursor: 200, limit: 5 })).toEqual({
        items: created.slice(200),
        total: 201,
      });
      expect(await store.listWorkspaces({ cursor: 500 })).toEqual({
        items: [],
        total: 201,
      });
      for (const input of [
        { limit: 0 },
        { limit: 1.5 },
        { cursor: -1 },
        { cursor: 1.5 },
      ]) {
        await expect(store.listWorkspaces(input)).rejects.toThrow(RangeError);
      }
    });

    test("scope entries to their Workspace", async () => {
      const store = (await open())(SCOPE);
      const first = hostWorkspace({ path: newRoot("alpha") });
      const second = hostWorkspace({ path: newRoot("beta") });
      const firstReadme = fileRecord(first.id, { path: "README.md" });
      const secondReadme = fileRecord(second.id, { path: "README.md" });
      await seed(store, first, [firstReadme]);
      await seed(store, second, [secondReadme]);

      expect(await store.getEntry(first.id, secondReadme.id)).toBeNull();
      expect(await store.getEntry(second.id, secondReadme.id)).toEqual(
        secondReadme
      );
      expect(await store.listEntries(first.id)).toEqual([firstReadme]);
      expect(await store.listEntries(second.id)).toEqual([secondReadme]);
    });

    test("find the oldest registration by root or source reference", async () => {
      const store = (await open())(SCOPE);
      const artifactId = crypto.randomUUID();
      const older = otherSourceWorkspace(artifactId, newRoot("older"));
      const newer = {
        ...otherSourceWorkspace(artifactId, newRoot("newer")),
        createdAt: new Date(2000),
      };
      await seed(store, newer);
      await seed(store, older);

      expect(await store.findWorkspaceByPath(newer.source.path)).toEqual(newer);
      expect(await store.findWorkspaceByPath(older.source.path)).toEqual(older);
      expect(await store.findWorkspaceBySourceId(artifactId)).toEqual(older);
    });

    test("break a creation-time tie by id when finding the oldest", async () => {
      const store = (await open())(SCOPE);
      const root = newRoot("shared");
      const [low, high] = [newWorkspaceId(), newWorkspaceId()].sort();
      const first = hostWorkspace({ id: low, path: root, sourceId: "same" });
      const second = hostWorkspace({ id: high, path: root, sourceId: "same" });
      await seed(store, second);
      await seed(store, first);

      expect(await store.findWorkspaceByPath(root)).toEqual(first);
      expect(await store.findWorkspaceBySourceId("same")).toEqual(first);
    });

    test("list registrations by creation time, then id, one page at a time", async () => {
      const store = (await open())(SCOPE);
      const [low, middle, high] = [
        newWorkspaceId(),
        newWorkspaceId(),
        newWorkspaceId(),
      ].sort();
      const first = hostWorkspace({
        createdAt: new Date(1000),
        id: high,
        path: newRoot("first"),
      });
      const tiedLow = hostWorkspace({
        createdAt: new Date(2000),
        id: low,
        path: newRoot("tied-low"),
      });
      const tiedHigh = hostWorkspace({
        createdAt: new Date(2000),
        id: middle,
        path: newRoot("tied-high"),
      });
      const ordered = [first, tiedLow, tiedHigh];
      for (const workspace of [tiedHigh, first, tiedLow]) {
        await seed(store, workspace);
      }

      expect(await store.listWorkspaces()).toEqual({
        items: ordered,
        total: 3,
      });
      const firstPage = await store.listWorkspaces({ limit: 2 });
      expect(firstPage.items).toEqual(ordered.slice(0, 2));
      expect(firstPage.total).toBe(3);
      expect(firstPage.nextCursor).toBeDefined();
      const secondPage = await store.listWorkspaces({
        cursor: firstPage.nextCursor,
        limit: 2,
      });
      expect(secondPage.items).toEqual(ordered.slice(2));
      expect(secondPage.total).toBe(3);
      expect(secondPage.nextCursor).toBeUndefined();
    });
  });
}

function describeWrites(open: Open): void {
  describe("writes", () => {
    test("a save replaces the registration and applies entry changes", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const kept = fileRecord(workspace.id, { path: "a.md" });
      const removed = fileRecord(workspace.id, { path: "b.md" });
      await seed(store, workspace, [kept, removed]);
      const renamed = { ...workspace, name: "beta", updatedAt: new Date(5) };
      const edited = { ...kept, bytes: 9 };
      const added = fileRecord(workspace.id, { path: "c.md" });

      await store.commit({
        deleteEntries: [removed.id],
        putEntries: [edited, added],
        workspace: renamed,
      });

      expect(await store.getWorkspace(workspace.id)).toEqual(renamed);
      expect(await store.listEntries(workspace.id)).toEqual([edited, added]);
      expect(await store.getEntry(workspace.id, removed.id)).toBeNull();
    });

    test("a save with only a registration leaves its entries alone", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const readme = fileRecord(workspace.id, { path: "README.md" });
      await seed(store, workspace, [readme]);
      const renamed = { ...workspace, name: "beta" };

      await store.commit({ workspace: renamed });

      expect(await store.getWorkspace(workspace.id)).toEqual(renamed);
      expect(await store.listEntries(workspace.id)).toEqual([readme]);
    });

    test("entry deletes apply before entry puts", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const readme = fileRecord(workspace.id, { path: "README.md" });
      await seed(store, workspace, [readme]);
      const replaced = { ...readme, bytes: 12 };

      await store.commit({
        deleteEntries: [readme.id],
        putEntries: [replaced],
        workspace,
      });

      expect(await store.getEntry(workspace.id, readme.id)).toEqual(replaced);
    });

    test("a removal deletes the registration and every entry it has", async () => {
      const store = (await open())(SCOPE);
      const first = hostWorkspace({ path: newRoot("alpha") });
      const second = hostWorkspace({ path: newRoot("beta") });
      const firstReadme = fileRecord(first.id, { path: "README.md" });
      const secondReadme = fileRecord(second.id, { path: "README.md" });
      await seed(store, first, [firstReadme]);
      await seed(store, second, [secondReadme]);

      await store.commit({ removeWorkspace: first.id });

      expect(await store.getWorkspace(first.id)).toBeNull();
      expect(await store.findWorkspaceByPath(first.source.path)).toBeNull();
      expect(await store.listEntries(first.id)).toEqual([]);
      expect(await store.listWorkspaces()).toEqual({
        items: [second],
        total: 1,
      });
      expect(await store.listEntries(second.id)).toEqual([secondReadme]);
    });

    test("a removal leaves no entry of its Workspace, whatever it names", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const other = hostWorkspace({ path: newRoot("beta") });
      const named = fileRecord(workspace.id, { path: "a.md" });
      const unnamed = fileRecord(workspace.id, { path: "b.md" });
      const stray = fileRecord(workspace.id, { path: "c.md" });
      await seed(store, workspace, [named, unnamed]);
      await seed(store, other, [stray]);

      const naming = {
        deleteEntries: [named.id],
        removeWorkspace: workspace.id,
      } as unknown as WorkspaceStoreWrite;
      await store.commit(naming);

      expect(await store.getWorkspace(workspace.id)).toBeNull();
      expect(await store.listEntries(workspace.id)).toEqual([]);
      for (const entry of [named, unnamed, stray]) {
        expect(await store.getEntry(workspace.id, entry.id)).toBeNull();
      }
      expect(await store.getWorkspace(other.id)).toEqual(other);

      await seed(store, workspace, [named, unnamed]);
      await store.commit({ removeWorkspace: workspace.id });
      expect(await store.listEntries(workspace.id)).toEqual([]);
      expect(await store.getWorkspace(other.id)).toEqual(other);
    });

    test("an entry put again is replaced whole, even when its type changes", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const file = fileRecord(workspace.id, { path: "node" });
      const directory: WorkspaceEntry = {
        ...directoryRecord(workspace.id, "node"),
        id: file.id,
      };
      const symlink: WorkspaceEntry = {
        ...directory,
        target: "elsewhere",
        type: "symlink",
      };
      const again = { ...file, bytes: 12, extension: null, mime: null };

      for (const entry of [file, directory, symlink, again]) {
        await store.commit({ putEntries: [entry], workspace });
        expect(await store.getEntry(workspace.id, file.id)).toEqual(entry);
        expect(await store.listEntries(workspace.id)).toEqual([entry]);
      }
    });

    test("a put files an entry under its own Workspace", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const other = newWorkspaceId();
      const stray = fileRecord(other, { path: "stray.md" });

      await store.commit({ putEntries: [stray], workspace });

      expect(await store.listEntries(workspace.id)).toEqual([]);
      expect(await store.getEntry(workspace.id, stray.id)).toBeNull();
      expect(await store.listEntries(other)).toEqual([stray]);
      expect(await store.getEntry(other, stray.id)).toEqual(stray);
      await store.commit({ deleteEntries: [stray.id], workspace });
      expect(await store.getEntry(other, stray.id)).toEqual(stray);
    });

    test("a removal of an absent Workspace changes nothing", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      await seed(store, workspace);

      await expect(
        store.commit({ removeWorkspace: newWorkspaceId() })
      ).resolves.toBeUndefined();
      expect(await store.listWorkspaces()).toEqual({
        items: [workspace],
        total: 1,
      });
    });
  });
}

function describeAtomicity(open: Open): void {
  describe("atomicity", () => {
    test("a failing save leaves an existing Workspace as it was", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const kept = fileRecord(workspace.id, { path: "a.md" });
      const doomed = fileRecord(workspace.id, { path: "b.md" });
      await seed(store, workspace, [kept, doomed]);
      const before = await everything(store, workspace);

      await expect(
        store.commit({
          deleteEntries: [doomed.id],
          putEntries: [
            { ...kept, bytes: 9 },
            fileRecord(workspace.id, { path: "c.md" }),
            fileRecord(workspace.id, {
              createdAt: unstorableDate(),
              path: "d.md",
            }),
          ],
          workspace: { ...workspace, name: "beta", updatedAt: new Date(5) },
        })
      ).rejects.toThrow();

      expect(await everything(store, workspace)).toEqual(before);
    });

    test("a failing first save leaves no Workspace behind", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });

      await expect(
        store.commit({
          putEntries: [
            fileRecord(workspace.id, { path: "a.md" }),
            fileRecord(workspace.id, {
              path: "b.md",
              updatedAt: unstorableDate(),
            }),
          ],
          workspace,
        })
      ).rejects.toThrow();

      expect(await everything(store, workspace)).toEqual({
        entries: [],
        list: { items: [], total: 0 },
        workspace: null,
      });
      expect(await store.findWorkspaceByPath(workspace.source.path)).toBeNull();
    });
  });
}

function describeDetachment(open: Open): void {
  describe("detachment", () => {
    test("a committed value is not shared with the caller", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("detached") });
      const file = fileRecord(workspace.id, { path: "a.md" });
      const expected = {
        entry: structuredClone(file),
        workspace: structuredClone(workspace),
      };
      await seed(store, workspace, [file]);

      scribbleWorkspace(workspace);
      scribbleEntry(file);

      expect(await store.getWorkspace(expected.workspace.id)).toEqual(
        expected.workspace
      );
      expect(await store.getEntry(expected.workspace.id, file.id)).toEqual(
        expected.entry
      );
    });

    test("no read hands out a value the store keeps", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({
        path: newRoot("detached"),
        sourceId: crypto.randomUUID(),
      });
      const file = fileRecord(workspace.id, { path: "a.md" });
      await seed(store, workspace, [file]);
      const { path } = workspace.source;
      const sourceId = workspace.source.sourceId ?? "";

      const reads = {
        byPath: await store.findWorkspaceByPath(path),
        bySourceId: await store.findWorkspaceBySourceId(sourceId),
        entries: await store.listEntries(workspace.id),
        entry: await store.getEntry(workspace.id, file.id),
        list: await store.listWorkspaces(),
        workspace: await store.getWorkspace(workspace.id),
      };
      for (const read of [
        reads.byPath,
        reads.bySourceId,
        reads.workspace,
        ...reads.list.items,
      ]) {
        if (read) {
          scribbleWorkspace(read);
        }
      }
      for (const read of [reads.entry, ...reads.entries]) {
        if (read) {
          scribbleEntry(read);
        }
      }
      (reads.list.items as WorkspaceRegistration[]).length = 0;
      (reads.entries as WorkspaceEntry[]).length = 0;

      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await store.findWorkspaceByPath(path)).toEqual(workspace);
      expect(await store.findWorkspaceBySourceId(sourceId)).toEqual(workspace);
      expect(await store.listWorkspaces()).toEqual({
        items: [workspace],
        total: 1,
      });
      expect(await store.getEntry(workspace.id, file.id)).toEqual(file);
      expect(await store.listEntries(workspace.id)).toEqual([file]);
    });
  });
}

function describeTransactions(open: Open): void {
  describe("transactions", () => {
    test("an outside commit waits for a running transaction, then lands", async ({
      skip,
    }) => {
      const store = (await open())(SCOPE);
      if (store.transaction === undefined) {
        return skip();
      }
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      await seed(store, workspace);
      const read = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();

      const inside = store.transaction(async (view) => {
        const before = await view.getWorkspace(workspace.id);
        read.resolve(undefined);
        await release.promise;
        const after = await view.getWorkspace(workspace.id);
        await view.commit({ workspace: { ...workspace, name: "inside" } });
        return { after, before };
      });
      await read.promise;
      const outside = store.commit({
        workspace: { ...workspace, name: "outside" },
      });
      await pause(20);
      release.resolve(undefined);

      expect(await inside).toEqual({ after: workspace, before: workspace });
      await outside;
      expect((await store.getWorkspace(workspace.id))?.name).toBe("outside");
    });

    test("a transaction that throws keeps none of its commits", async ({
      skip,
    }) => {
      const store = (await open())(SCOPE);
      if (store.transaction === undefined) {
        return skip();
      }
      const existing = hostWorkspace({ path: newRoot("existing") });
      const kept = fileRecord(existing.id, { path: "a.md" });
      const doomed = fileRecord(existing.id, { path: "b.md" });
      await seed(store, existing, [kept, doomed]);
      const before = await everything(store, existing);
      const added = hostWorkspace({ path: newRoot("added") });

      await expect(
        store.transaction(async (view) => {
          await view.commit({
            deleteEntries: [doomed.id],
            putEntries: [{ ...kept, bytes: 9 }],
            workspace: { ...existing, name: "renamed" },
          });
          await view.commit({
            putEntries: [fileRecord(added.id, { path: "c.md" })],
            workspace: added,
          });
          await view.commit({ removeWorkspace: existing.id });
          throw new Error("refused");
        })
      ).rejects.toThrow("refused");

      expect(await everything(store, existing)).toEqual(before);
      expect(await store.getEntry(existing.id, doomed.id)).toEqual(doomed);
      expect(await store.getWorkspace(added.id)).toBeNull();
      expect(await store.listEntries(added.id)).toEqual([]);
      expect(await store.findWorkspaceByPath(added.source.path)).toBeNull();
    });

    test("reads through the view see the transaction's own commits", async ({
      skip,
    }) => {
      const store = (await open())(SCOPE);
      if (store.transaction === undefined) {
        return skip();
      }
      const removed = hostWorkspace({ path: newRoot("removed") });
      const gone = fileRecord(removed.id, { path: "gone.md" });
      await seed(store, removed, [gone]);
      const added = hostWorkspace({
        path: newRoot("added"),
        sourceId: crypto.randomUUID(),
      });
      const file = fileRecord(added.id, { path: "a.md" });

      const seen = await store.transaction(async (view) => {
        await view.commit({ putEntries: [file], workspace: added });
        await view.commit({ removeWorkspace: removed.id });
        return {
          byPath: await view.findWorkspaceByPath(added.source.path),
          bySourceId: await view.findWorkspaceBySourceId(
            added.source.sourceId ?? ""
          ),
          entries: await view.listEntries(added.id),
          entry: await view.getEntry(added.id, file.id),
          gone: await view.getEntry(removed.id, gone.id),
          list: await view.listWorkspaces(),
          removed: await view.getWorkspace(removed.id),
          workspace: await view.getWorkspace(added.id),
        };
      });

      expect(seen).toEqual({
        byPath: added,
        bySourceId: added,
        entries: [file],
        entry: file,
        gone: null,
        list: { items: [added], total: 1 },
        removed: null,
        workspace: added,
      });
      expect(await store.getWorkspace(added.id)).toEqual(added);
      expect(await store.getWorkspace(removed.id)).toBeNull();
    });

    test("transactions over one store do not lose each other's writes", async ({
      skip,
    }) => {
      const store = (await open())(SCOPE);
      const { transaction } = store;
      if (transaction === undefined) {
        return skip();
      }
      const workspace = hostWorkspace({ name: "0", path: newRoot("alpha") });
      await seed(store, workspace);
      const increment = () =>
        transaction.call(store, async (view) => {
          const current = await view.getWorkspace(workspace.id);
          await new Promise((resolve) => setTimeout(resolve, 1));
          await view.commit({
            workspace: {
              ...workspace,
              name: String(Number(current?.name) + 1),
            },
          });
        });

      await Promise.all([increment(), increment(), increment()]);

      expect((await store.getWorkspace(workspace.id))?.name).toBe("3");
    });

    test("answer with the work's result, and recover from its failure", async ({
      skip,
    }) => {
      const store = (await open())(SCOPE);
      if (store.transaction === undefined) {
        return skip();
      }
      const workspace = hostWorkspace({ path: newRoot("alpha") });

      await expect(
        store.transaction(() => Promise.reject(new Error("refused")))
      ).rejects.toThrow("refused");
      expect(
        await store.transaction(async (view) => {
          await view.commit({ putEntries: [], workspace });
          return "done";
        })
      ).toBe("done");
      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
    });
  });
}

function describeOrdering(open: Open): void {
  describe("ordering", () => {
    test("break a creation-time tie by id in code-point order", async () => {
      const store = (await open())(SCOPE);
      const fullwidth = hostWorkspace({
        id: "Ａ" as WorkspaceId,
        path: newRoot("fullwidth"),
        sourceId: "tied",
      });
      const astral = hostWorkspace({
        id: "\u{1F600}" as WorkspaceId,
        path: fullwidth.source.path,
        sourceId: "tied",
      });
      await seed(store, astral);
      await seed(store, fullwidth);

      expect((await store.listWorkspaces()).items).toEqual([fullwidth, astral]);
      expect(await store.findWorkspaceByPath(fullwidth.source.path)).toEqual(
        fullwidth
      );
      expect(await store.findWorkspaceBySourceId("tied")).toEqual(fullwidth);
      const first = await store.listWorkspaces({ limit: 1 });
      expect(first.items).toEqual([fullwidth]);
      expect(
        (await store.listWorkspaces({ cursor: first.nextCursor, limit: 1 }))
          .items
      ).toEqual([astral]);
    });

    test("list entries by path in code-unit order, whatever order they were put in", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const paths = ["Ａ.md", "a.md", "\u{1F600}.md", "B.md"];
      const [fullwidth, lower, astral, upper] = paths.map((path) =>
        fileRecord(workspace.id, { path })
      ) as [WorkspaceFile, WorkspaceFile, WorkspaceFile, WorkspaceFile];
      await seed(store, workspace, [fullwidth, lower]);
      await store.commit({ putEntries: [astral, upper], workspace });
      const edited = { ...fullwidth, bytes: 7 };
      await store.commit({ putEntries: [edited], workspace });

      expect(await store.listEntries(workspace.id)).toEqual([
        upper,
        lower,
        astral,
        edited,
      ]);
    });

    test("break a path tie by id, however the entries were put", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const [low, high] = [newWorkspaceEntryId(), newWorkspaceEntryId()].sort();
      const first = fileRecord(workspace.id, { id: low, path: "same.md" });
      const second = fileRecord(workspace.id, { id: high, path: "same.md" });
      await seed(store, workspace, [second, first]);
      expect(await store.listEntries(workspace.id)).toEqual([first, second]);

      await store.commit({ putEntries: [first], workspace });
      await store.commit({
        deleteEntries: [second.id],
        putEntries: [second],
        workspace,
      });
      expect(await store.listEntries(workspace.id)).toEqual([first, second]);
    });
  });
}

function describeScopes(open: Open): void {
  describe("scopes", () => {
    test("two scopes on one storage never see each other", async () => {
      const stores = await open();
      const [first, second] = [stores("scope-a"), stores("scope-b")];
      const workspace = hostWorkspace({
        path: newRoot("shared"),
        sourceId: "shared",
      });
      const readme = fileRecord(workspace.id, { path: "README.md" });
      await seed(first, workspace, [readme]);

      expect(await second.getWorkspace(workspace.id)).toBeNull();
      expect(await second.getEntry(workspace.id, readme.id)).toBeNull();
      expect(await second.listEntries(workspace.id)).toEqual([]);
      expect(
        await second.findWorkspaceByPath(workspace.source.path)
      ).toBeNull();
      expect(await second.findWorkspaceBySourceId("shared")).toBeNull();
      expect(await second.listWorkspaces()).toEqual({ items: [], total: 0 });

      const theirs = { ...workspace, name: "theirs" };
      const theirReadme = { ...readme, bytes: 99 };
      await seed(second, theirs, [theirReadme]);
      expect(await second.getEntry(workspace.id, readme.id)).toEqual(
        theirReadme
      );
      await second.commit({ removeWorkspace: workspace.id });

      expect(await first.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await first.listEntries(workspace.id)).toEqual([readme]);
      expect(await first.listWorkspaces()).toEqual({
        items: [workspace],
        total: 1,
      });
      expect(await stores("scope-a").getEntry(workspace.id, readme.id)).toEqual(
        readme
      );
    });
  });
}

function describeLargeWrites(open: Open): void {
  describe("large writes", () => {
    test("one save can put and delete thousands of entries", async () => {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("large") });
      const first = manyFiles(workspace.id, "a", 5000);
      await seed(store, workspace, first);
      expect(await store.listEntries(workspace.id)).toHaveLength(5000);

      const second = manyFiles(workspace.id, "b", 5000);
      const absent = Array.from({ length: 33_000 }, newWorkspaceEntryId);
      await store.commit({
        deleteEntries: [...absent, ...first.map((entry) => entry.id)],
        putEntries: second,
        workspace,
      });
      expect(await store.listEntries(workspace.id)).toEqual(second);

      await store.commit({ removeWorkspace: workspace.id });
      expect(await everything(store, workspace)).toEqual({
        entries: [],
        list: { items: [], total: 0 },
        workspace: null,
      });
    });
  });
}

function describeReentry(open: Open): void {
  describe("re-entry", () => {
    test("a call to the store from inside its own transaction is refused at once", async ({
      skip,
    }) => {
      const store = (await open())(SCOPE);
      if (store.transaction === undefined) {
        return skip();
      }
      const transaction: NonNullable<WorkspaceStore["transaction"]> =
        store.transaction.bind(store);
      const workspace = hostWorkspace({ path: newRoot("alpha") });
      const readme = fileRecord(workspace.id, { path: "README.md" });
      const calls: Record<string, () => Promise<unknown>> = {
        commit: () => seed(store, workspace),
        findWorkspaceByPath: () => store.findWorkspaceByPath("/x"),
        findWorkspaceBySourceId: () => store.findWorkspaceBySourceId("x"),
        getEntry: () => store.getEntry(workspace.id, readme.id),
        getWorkspace: () => store.getWorkspace(workspace.id),
        listEntries: () => store.listEntries(workspace.id),
        listWorkspaces: () => store.listWorkspaces(),
        transaction: () => transaction(() => Promise.resolve()),
      };
      const { promise: ended, resolve: end } = Promise.withResolvers<void>();
      let later: Promise<unknown> = Promise.resolve();

      const refusals = await transaction(async (view) => {
        const outcomes: Record<string, string> = {};
        for (const [method, call] of Object.entries(calls)) {
          outcomes[method] = await settlesWithin(call(), 1000);
        }
        later = ended.then(() =>
          store.commit({ putEntries: [readme], workspace })
        );
        await view.commit({ workspace: { ...workspace, name: "inside" } });
        return outcomes;
      });
      end();

      expect(Object.keys(refusals)).toHaveLength(8);
      for (const outcome of Object.values(refusals)) {
        expect(outcome).toMatch(REFUSAL);
      }
      await later;
      expect(await store.getWorkspace(workspace.id)).toEqual(workspace);
      expect(await store.listEntries(workspace.id)).toEqual([readme]);
    });
  });
}

function describeFailedTurns(open: Open): void {
  describe("after a failure", () => {
    test("a commit made after a transaction whose work throws lands, and nothing of the transaction stays", async ({
      skip,
    }) => {
      const store = (await open())(SCOPE);
      if (store.transaction === undefined) {
        return skip();
      }
      const doomed = hostWorkspace({ path: newRoot("doomed") });
      await expect(
        store.transaction(async (view) => {
          await seed(view, doomed);
          throw new Error("work failed");
        })
      ).rejects.toThrow("work failed");
      const after = hostWorkspace({ path: newRoot("after") });

      expect(await settlesWithin(seed(store, after), 2000)).toBe("resolved");
      expect(await store.getWorkspace(doomed.id)).toBeNull();
      expect(await store.getWorkspace(after.id)).toEqual(after);
    });

    test("commits queued behind a transaction that fails land, and so does one behind a failing commit", async ({
      skip,
    }) => {
      const store = (await open())(SCOPE);
      if (store.transaction === undefined) {
        return skip();
      }
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const failing = store.transaction(async () => {
        entered.resolve(undefined);
        await release.promise;
        throw new Error("work failed");
      });
      await entered.promise;
      const queued = hostWorkspace({ path: newRoot("queued") });
      const waiting = seed(store, queued);
      const refused = store.commit({
        workspace: hostWorkspace({
          createdAt: unstorableDate(),
          path: newRoot("refused"),
        }),
      });
      const last = hostWorkspace({ path: newRoot("last") });
      const behind = seed(store, last);
      release.resolve(undefined);

      await expect(failing).rejects.toThrow("work failed");
      await expect(refused).rejects.toThrow();
      expect(await settlesWithin(waiting, 2000)).toBe("resolved");
      expect(await settlesWithin(behind, 2000)).toBe("resolved");
      expect(await store.getWorkspace(queued.id)).toEqual(queued);
      expect(await store.getWorkspace(last.id)).toEqual(last);
    });
  });
}

const REFUSAL = /refused: .*use the view/;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

function manyFiles(
  workspaceId: WorkspaceId,
  prefix: string,
  count: number
): WorkspaceFile[] {
  return Array.from({ length: count }, (_, index) =>
    fileRecord(workspaceId, {
      path: `${prefix}${String(index).padStart(5, "0")}.md`,
    })
  );
}

function describeOwnership(open: Open): void {
  describe("a write and a list input are the store's from the call", () => {
    async function arranged() {
      const store = (await open())(SCOPE);
      const workspace = hostWorkspace({ path: newRoot("owned") });
      const kept = fileRecord(workspace.id, { path: "a.md" });
      const doomed = fileRecord(workspace.id, { path: "b.md" });
      await seed(store, workspace, [kept, doomed]);
      const save = {
        deleteEntries: [] as WorkspaceEntry["id"][],
        putEntries: [fileRecord(workspace.id, { path: "c.md" })],
        workspace: { ...workspace, name: "saved", updatedAt: new Date(5) },
      };
      const expected = structuredClone({
        entries: [kept, doomed, ...save.putEntries],
        list: { items: [save.workspace], total: 1 },
        workspace: save.workspace,
      });
      return { doomed, expected, save, store, workspace };
    }

    function scramble(
      save: Awaited<ReturnType<typeof arranged>>["save"],
      doomed: WorkspaceEntry
    ): void {
      const { workspace } = save;
      scribbleWorkspace(workspace);
      for (const entry of save.putEntries) {
        scribbleEntry(entry);
      }
      save.putEntries.push(fileRecord(workspace.id, { path: "late.md" }));
      save.deleteEntries.push(doomed.id);
      Object.assign(save, {
        removeWorkspace: workspace.id,
        workspace: undefined,
      });
    }

    test("a commit changed at once after the call lands as it was called", async () => {
      const { doomed, expected, save, store, workspace } = await arranged();

      const landing = store.commit(save);
      scramble(save, doomed);
      await landing;

      expect(await everything(store, workspace)).toEqual(expected);
    });

    test("a commit changed while it waits behind a transaction lands as it was called", async ({
      skip,
    }) => {
      const { doomed, expected, save, store, workspace } = await arranged();
      if (store.transaction === undefined) {
        return skip();
      }
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const running = store.transaction(async () => {
        entered.resolve(undefined);
        await release.promise;
      });
      await entered.promise;

      const landing = store.commit(save);
      scramble(save, doomed);
      release.resolve(undefined);
      await Promise.all([running, landing]);

      expect(await everything(store, workspace)).toEqual(expected);
    });

    test("a commit through a transaction's view lands as it was called", async ({
      skip,
    }) => {
      const { doomed, expected, save, store, workspace } = await arranged();
      if (store.transaction === undefined) {
        return skip();
      }

      await store.transaction(async (view) => {
        const committed = view.commit(save);
        scramble(save, doomed);
        await committed;
        expect(await everything(view, workspace)).toEqual(expected);
      });

      expect(await everything(store, workspace)).toEqual(expected);
    });

    test("listWorkspaces pages by its input as it was called, at once or behind a transaction", async ({
      skip,
    }) => {
      const store = (await open())(SCOPE);
      const created = [0, 1, 2].map((index) =>
        hostWorkspace({
          createdAt: new Date(index),
          path: newRoot(String(index)),
        })
      );
      for (const workspace of created) {
        await seed(store, workspace);
      }
      const firstPage = { items: created.slice(0, 1), nextCursor: 1, total: 3 };
      const change = (input: { cursor?: number; limit?: number }) => {
        Object.assign(input, { cursor: 2, limit: 3 });
      };

      const atOnce: { cursor?: number; limit?: number } = { limit: 1 };
      const listed = store.listWorkspaces(atOnce);
      change(atOnce);
      expect(await listed).toEqual(firstPage);

      if (store.transaction === undefined) {
        return skip();
      }
      const entered = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const running = store.transaction(async () => {
        entered.resolve(undefined);
        await release.promise;
      });
      await entered.promise;
      const queued: { cursor?: number; limit?: number } = { limit: 1 };
      const waiting = store.listWorkspaces(queued);
      change(queued);
      release.resolve(undefined);
      await running;
      expect(await waiting).toEqual(firstPage);
    });
  });
}

async function everything(
  store: WorkspaceStore,
  workspace: WorkspaceRegistration
) {
  return {
    entries: await store.listEntries(workspace.id),
    list: await store.listWorkspaces(),
    workspace: await store.getWorkspace(workspace.id),
  };
}

function unstorableDate(): Date {
  const refuse = (): never => {
    throw new Error("This timestamp cannot be stored");
  };
  return {
    [Symbol.toPrimitive]: refuse,
    getTime: refuse,
    toISOString: refuse,
    toJSON: refuse,
    valueOf: refuse,
  } as unknown as Date;
}

function scribbleWorkspace(workspace: WorkspaceRegistration): void {
  const writable = workspace as {
    name: string;
    source: { path: string; sourceId: string | null };
  };
  workspace.createdAt.setTime(0);
  workspace.lastReconciledAt.setTime(0);
  workspace.updatedAt.setTime(0);
  writable.name = "scribbled";
  writable.source.path = "/scribbled";
  writable.source.sourceId = "scribbled";
}

function scribbleEntry(entry: WorkspaceEntry): void {
  entry.createdAt.setTime(0);
  entry.updatedAt.setTime(0);
  (entry as { name: string; path: string }).name = "scribbled";
  (entry as { name: string; path: string }).path = "scribbled";
}
