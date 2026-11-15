import type { ArtifactId, ContentId } from "@foundry/artifacts";
import { describe, expect, test } from "vitest";

import type { InstallationId, ModuleId } from "../domain";
import type { ModuleManifest } from "../manifest";
import type {
  Installation,
  InstallationGrant,
  Module,
  StoredInstallation,
  StoredManifest,
} from "../schema";
import type { ModuleStore, ModuleStorePage, ModuleStoreWrite } from "../store";

/**
 * Fresh, empty storage, reached one scope at a time. The same scope reaches
 * the same records on every call; two scopes never see each other's. A store
 * that has no scopes keeps one store per scope name.
 */
export type ScopedModuleStores = (scope: string) => ModuleStore;

/** Everything a store holds, in list order. */
interface Held {
  readonly installations: readonly StoredInstallation[];
  readonly manifests: readonly StoredManifest[];
  readonly modules: readonly Module[];
}

/**
 * The behaviour every `ModuleStore` shares, as Vitest tests. `open` returns
 * new, empty storage each time it is called. The host's test file closes
 * whatever `open` opened.
 */
export function describeModuleStore(
  name: string,
  open: () => ScopedModuleStores | Promise<ScopedModuleStores>
): void {
  async function store(scope = "scope-a"): Promise<ModuleStore> {
    return (await open())(scope);
  }

  describe(`${name} module store conformance`, () => {
    test("a read by a key that is not text finds nothing", async () => {
      const target = await store();
      await target.commit({ putModules: [module("5")] });
      const numeric = 5 as unknown as string;
      expect(await target.getModule(numeric as ModuleId)).toBeNull();
      expect(await target.getManifest(numeric as ContentId)).toBeNull();
      expect(
        await target.getInstallation(numeric as InstallationId)
      ).toBeNull();
    });

    test("an empty store holds nothing", async () => {
      const empty = await store();
      expect(await empty.getModule(moduleId("missing"))).toBeNull();
      expect(await empty.getManifest(contentId("missing"))).toBeNull();
      expect(await empty.getInstallation(installationId("missing"))).toBeNull();
      expect(await held(empty)).toEqual({
        installations: [],
        manifests: [],
        modules: [],
      });
    });

    test("a commit puts every record kind, and reads return them whole", async () => {
      const target = await store();
      const tasks = module("tasks");
      const retained = manifest("content-1", tasks);
      const running = installation("running", tasks, {
        grants: [grant("host.files.read"), grant("host.network.fetch")],
        installation: {
          containerId: "container-1",
          createdAt: new Date("2026-11-01T00:00:00.001Z"),
          generation: 7,
          startAttempts: 2,
          status: "active",
          updatedAt: new Date("+275760-09-13T00:00:00.000Z"),
        },
      });
      const idle = installation("idle", tasks, {
        installation: {
          createdAt: new Date(-62_198_755_200_000),
          updatedAt: new Date(0),
        },
      });
      await target.commit({
        putInstallations: [running, idle],
        putManifests: [retained],
        putModules: [tasks],
      });

      expect(await target.getModule(tasks.id)).toEqual(tasks);
      expect(await target.getManifest(retained.contentId)).toEqual(retained);
      const read = await target.getInstallation(running.installation.id);
      expect(read).toEqual(running);
      expect(read?.installation.createdAt).toBeInstanceOf(Date);
      expect(read?.grants[0]?.createdAt).toBeInstanceOf(Date);
      expect(read?.installation.updatedAt.getTime()).toBe(8.64e15);
      expect(await target.getInstallation(idle.installation.id)).toEqual(idle);
      expect(await held(target)).toEqual({
        installations: [running, idle],
        manifests: [retained],
        modules: [tasks],
      });
    });

    test("reads list records in the order first put; a put over one keeps its place", async () => {
      const target = await store();
      const [a, b, c] = [module("a"), module("b"), module("c")];
      await target.commit({
        putInstallations: [installation("b", b)],
        putManifests: [manifest("b", b)],
        putModules: [b],
      });
      await target.commit({
        putInstallations: [installation("a", a), installation("c", c)],
        putManifests: [manifest("a", a), manifest("c", c)],
        putModules: [a, c],
      });
      const moved = { ...b, artifactId: artifactId("moved") };
      const changed = installation("b", b, { installation: { generation: 9 } });
      const replaced = manifest("b", b, { replaced: true });
      await target.commit({
        putInstallations: [changed],
        putManifests: [replaced],
        putModules: [moved],
      });

      expect(await held(target)).toEqual({
        installations: [changed, installation("a", a), installation("c", c)],
        manifests: [replaced, manifest("a", a), manifest("c", c)],
        modules: [moved, a, c],
      });
    });

    test("deletes apply before puts, so a record deleted and put again moves last", async () => {
      const target = await store();
      const [a, b, c] = [module("a"), module("b"), module("c")];
      await target.commit({
        putInstallations: [a, b, c].map((owner) =>
          installation(owner.id, owner)
        ),
        putManifests: [a, b, c].map((owner) => manifest(owner.id, owner)),
        putModules: [a, b, c],
      });
      await target.commit({
        deleteInstallations: [installationId("a")],
        deleteManifests: [contentId("a")],
        deleteModules: [a.id],
        putInstallations: [installation("a", a)],
        putManifests: [manifest("a", a)],
        putModules: [a],
      });

      expect(await held(target)).toEqual({
        installations: [b, c, a].map((owner) => installation(owner.id, owner)),
        manifests: [b, c, a].map((owner) => manifest(owner.id, owner)),
        modules: [b, c, a],
      });
    });

    test("deletes remove only what they name, and missing records are no-ops", async () => {
      const target = await store();
      const [a, b] = [module("a"), module("b")];
      await target.commit({
        putInstallations: [installation("a", a), installation("b", b)],
        putManifests: [manifest("a", a), manifest("b", b)],
        putModules: [a, b],
      });
      await target.commit({
        deleteInstallations: [installationId("a"), installationId("x")],
        deleteManifests: [contentId("b"), contentId("x")],
        deleteModules: [a.id, moduleId("x")],
      });

      // The store enforces nothing: an Installation and a manifest outlive
      // the Module they name.
      expect(await held(target)).toEqual({
        installations: [installation("b", b)],
        manifests: [manifest("a", a)],
        modules: [b],
      });
    });

    test("an empty write changes nothing", async () => {
      const target = await store();
      const a = module("a");
      await target.commit({ putModules: [a] });
      await target.commit({});
      await target.commit({
        deleteInstallations: [],
        deleteManifests: [],
        deleteModules: [],
        putInstallations: [],
        putManifests: [],
        putModules: [],
      });

      expect(await held(target)).toEqual({
        installations: [],
        manifests: [],
        modules: [a],
      });
    });

    test("takes each property a write names by name, a getter on a prototype included", async () => {
      const target = await store();
      const a = module("a");
      const write = Object.create({
        putInstallations: [installation("a", a)],
        putModules: [a],
      }) as ModuleStoreWrite;
      await target.commit(write);
      await transactionOf(target)((view) =>
        view.commit(Object.create({ putManifests: [manifest("a", a)] }))
      );

      expect(await held(target)).toEqual({
        installations: [installation("a", a)],
        manifests: [manifest("a", a)],
        modules: [a],
      });
    });

    test("reads each value nested in a manifest once, and keeps what that read gave", async () => {
      const target = await store();
      const owner = module("a");
      let reads = 0;
      const document = {
        get field() {
          reads += 1;
          // Plain at the first read; what a second read would see is not.
          return reads === 1
            ? { kept: "checked" }
            : Object.create({ inherited: "lost" });
        },
        list: [1, "two"],
      };
      await target.commit({
        putManifests: [
          {
            ...manifest("a", owner),
            manifest: document as unknown as ModuleManifest,
          },
        ],
      });

      expect(reads).toBe(1);
      expect((await target.getManifest(contentId("a")))?.manifest).toEqual({
        field: { kept: "checked" },
        list: [1, "two"],
      });
    });

    test("refuses, naming the property, a write neither store could keep as it shows, and applies none of it", async () => {
      const target = await store();
      const kept = module("kept");
      await target.commit({ putModules: [kept] });
      const before = await held(target);
      const hidden = { grants: [] } as unknown as StoredInstallation;
      Object.defineProperty(hidden, "installation", {
        enumerable: false,
        value: installation("hidden", kept).installation,
      });
      const refusals: [unknown, string][] = [
        [
          { putInstallations: [hidden], putModules: [module("partial")] },
          "putInstallations[0] must be a plain object",
        ],
        [
          {
            putModules: [
              module("first"),
              Object.create({ artifactId: "proto-artifact", id: "proto" }),
            ],
          },
          "putModules[1] must be a plain object",
        ],
        [{ putModules: { 0: module("x") } }, "putModules must be an array"],
        [
          { deleteModules: [kept.id, 5], putModules: [module("x")] },
          "deleteModules[1] must be text",
        ],
        [
          {
            putInstallations: [
              installation("i", kept, {
                installation: { id: 5 as unknown as InstallationId },
              }),
            ],
          },
          "putInstallations[0].installation.id must be text",
        ],
        [
          {
            putInstallations: [
              installation("i", kept, {
                installation: { updatedAt: "2026" as unknown as Date },
              }),
            ],
          },
          "putInstallations[0].installation.updatedAt must be a Date",
        ],
        [
          {
            putInstallations: [
              installation("i", kept, {
                grants: [
                  Object.create(grant("inherited")) as InstallationGrant,
                ],
              }),
            ],
          },
          "putInstallations[0].grants[0] must be a plain object",
        ],
        [
          { putManifests: [manifest("m", kept, { when: new Date(0) })] },
          "putManifests[0].manifest.when must be a plain object",
        ],
        [
          { putManifests: [manifest("m", kept, { description: undefined })] },
          "putManifests[0].manifest.description must be JSON data",
        ],
      ];
      for (const [write, message] of refusals) {
        await expect(target.commit(write as ModuleStoreWrite)).rejects.toThrow(
          message
        );
        await expect(
          transactionOf(target)((view) =>
            view.commit(write as ModuleStoreWrite)
          )
        ).rejects.toThrow(message);
      }

      expect(await held(target)).toEqual(before);
    });

    test("a failing commit leaves nothing behind", async () => {
      const target = await store();
      const kept = module("kept");
      const keptInstallation = installation("kept", kept);
      await target.commit({
        putInstallations: [keptInstallation],
        putModules: [kept],
      });

      await expect(
        target.commit({
          deleteInstallations: [keptInstallation.installation.id],
          deleteModules: [kept.id],
          putInstallations: [installation("new", kept)],
          putManifests: [
            manifest("poisoned", kept),
            {
              ...manifest("unreadable", kept),
              manifest: unreadable(),
            },
          ],
          putModules: [module("new")],
        })
      ).rejects.toThrow("unreadable");

      expect(await held(target)).toEqual({
        installations: [keptInstallation],
        manifests: [],
        modules: [kept],
      });
    });

    test("reads are detached from the store", async () => {
      const target = await store();
      const a = module("a");
      const stored = installation("a", a, { grants: [grant("host.read")] });
      const retained = manifest("a", a, { nested: { list: ["x"] } });
      await target.commit({
        putInstallations: [stored],
        putManifests: [retained],
        putModules: [a],
      });

      const readModule = mutable(await target.getModule(a.id));
      readModule.artifactId = artifactId("changed");
      const readInstallation = mutable(
        await target.getInstallation(stored.installation.id)
      );
      mutable(readInstallation.installation).generation = 99;
      readInstallation.installation.createdAt.setTime(0);
      (readInstallation.grants as InstallationGrant[]).push(grant("extra"));
      readInstallation.grants[0]?.createdAt.setTime(0);
      const readManifest = mutable(
        await target.getManifest(retained.contentId)
      );
      nestedList(readManifest.manifest).push("changed");
      const listed = await held(target);
      mutable(listed.modules[0]).id = moduleId("changed");
      listed.installations[0]?.installation.updatedAt.setTime(0);
      nestedList(listed.manifests[0]?.manifest).push("changed");

      expect(await held(target)).toEqual({
        installations: [stored],
        manifests: [retained],
        modules: [a],
      });
    });

    test("a committed write is detached from the caller's values", async () => {
      const target = await store();
      const a = module("a");
      const write = callerWrite(a);
      const expected = heldAfter(write);
      await target.commit(write);

      scramble(write);

      expect(await held(target)).toEqual(expected);
    });

    test("takes a write as it stands when commit is called, though the caller changes it at once", async () => {
      const target = await store();
      const write = callerWrite(module("a"));
      const expected = heldAfter(write);

      const landing = target.commit(write);
      scramble(write);
      await landing;

      expect(await held(target)).toEqual(expected);
    });

    test("takes a write as it stands when commit is called, though it waits behind a transaction", async () => {
      const target = await store();
      const write = callerWrite(module("a"));
      const expected = heldAfter(write);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const running = transactionOf(target)(async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;

      const landing = target.commit(write);
      scramble(write);
      release.resolve();
      await Promise.all([running, landing]);

      expect(await held(target)).toEqual(expected);
    });

    test("takes a write through a transaction's view as it stands when commit is called", async () => {
      const target = await store();
      const write = callerWrite(module("a"));
      const expected = heldAfter(write);

      await transactionOf(target)(async (view) => {
        const committed = view.commit(write);
        scramble(write);
        await committed;
        expect(await held(view)).toEqual(expected);
      });

      expect(await held(target)).toEqual(expected);
    });

    test("two scopes on one storage never see each other", async () => {
      const stores = await open();
      const [first, second] = [stores("scope-a"), stores("scope-b")];
      const inA = module("shared");
      const inB = { ...inA, artifactId: artifactId("in-b") };
      const contents = {
        installations: [installation("shared", inA)],
        manifests: [manifest("shared", inA)],
        modules: [inA],
      };
      await first.commit({
        putInstallations: contents.installations,
        putManifests: contents.manifests,
        putModules: contents.modules,
      });

      expect(await second.getModule(inA.id)).toBeNull();
      expect(await second.getManifest(contentId("shared"))).toBeNull();
      expect(await second.getInstallation(installationId("shared"))).toBeNull();
      expect(
        await second.listModules({ artifactId: inA.artifactId, limit: 10 })
      ).toEqual({ items: [] });
      expect(await held(second)).toEqual({
        installations: [],
        manifests: [],
        modules: [],
      });

      await second.commit({ putModules: [inB] });
      await second.commit({
        deleteInstallations: [installationId("shared")],
        deleteManifests: [contentId("shared")],
        deleteModules: [inB.id],
      });

      expect(await held(first)).toEqual(contents);
      expect(await held(stores("scope-a"))).toEqual(contents);
    });

    test("never hands a position out twice, so a cursor stays valid across deletes", async () => {
      const target = await store();
      const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => module(id));
      await target.commit({ putModules: [a, b, c] as Module[] });
      const first = await target.listModules({ limit: 2 });
      expect(first.items).toEqual([a, b]);

      await target.commit({ deleteModules: [b?.id, c?.id] as ModuleId[] });
      await target.commit({ putModules: [d] as Module[] });
      expect(
        await target.listModules({ after: first.next as number, limit: 2 })
      ).toEqual({ items: [d] });

      // A deleted record put again is new: it lands past the cursor too.
      await target.commit({ deleteModules: [a?.id] as ModuleId[] });
      await target.commit({ putModules: [a] as Module[] });
      expect(
        await target.listModules({ after: first.next as number, limit: 5 })
      ).toEqual({ items: [d, a] });

      // One counter across every kind: an Installation and a manifest
      // filed after the deletes land past the cursor as well.
      await target.commit({
        putInstallations: [installation("i", d as Module)],
        putManifests: [manifest("m", d as Module)],
      });
      const installations = await target.listInstallations({
        after: first.next as number,
        limit: 5,
      });
      expect(installations.items).toHaveLength(1);
    });

    test("list reads page in put order, and filter by exact values", async () => {
      const target = await store();
      const owners = ["a", "b", "c", "d", "e"].map((id) =>
        module(id, id < "c" ? "shared" : `artifact-${id}`)
      );
      await target.commit({
        putInstallations: owners.flatMap((owner) => [
          installation(`${owner.id}-1`, owner),
          installation(`${owner.id}-2`, owner),
        ]),
        putManifests: owners.map((owner) => manifest(owner.id, owner)),
        putModules: owners,
      });

      const first = await target.listModules({ limit: 2 });
      expect(first.items).toEqual(owners.slice(0, 2));
      expect(first.next).toBeDefined();
      const second = await target.listModules({
        after: first.next as number,
        limit: 2,
      });
      expect(second.items).toEqual(owners.slice(2, 4));
      const third = await target.listModules({
        after: second.next as number,
        limit: 2,
      });
      expect(third).toEqual({ items: owners.slice(4) });
      expect(await target.listModules({ limit: 5 })).toEqual({
        items: owners,
      });
      expect(
        await target.listModules({ artifactId: artifactId("shared"), limit: 5 })
      ).toEqual({ items: owners.slice(0, 2) });
      expect(
        await target.listModules({ artifactId: artifactId("none"), limit: 5 })
      ).toEqual({ items: [] });

      const ofC = await target.listInstallations({
        limit: 1,
        moduleId: moduleId("c"),
      });
      expect(ofC.items).toEqual([installation("c-1", module("c"))]);
      expect(
        await target.listInstallations({
          after: ofC.next as number,
          limit: 1,
          moduleId: moduleId("c"),
        })
      ).toEqual({
        items: [installation("c-2", module("c"))],
      });
      expect(
        (await all((page) => target.listInstallations(page))).map(
          (stored) => stored.installation.id
        )
      ).toEqual(owners.flatMap((owner) => [`${owner.id}-1`, `${owner.id}-2`]));

      expect(await target.listManifests({ moduleId: moduleId("d") })).toEqual([
        manifest("d", owners[3] as Module),
      ]);
      expect(await target.listManifests({ moduleId: moduleId("x") })).toEqual(
        []
      );
    });

    test("a list read refuses a limit or a cursor it could not honour alike", async () => {
      const target = await store();
      for (const limit of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
        await expect(target.listModules({ limit })).rejects.toThrow(RangeError);
        await expect(target.listInstallations({ limit })).rejects.toThrow(
          RangeError
        );
      }
      for (const after of [0.5, Number.POSITIVE_INFINITY]) {
        await expect(target.listModules({ after, limit: 1 })).rejects.toThrow(
          RangeError
        );
      }
    });

    test("a transaction reads its own commits and returns what its work returns", async () => {
      const target = await store();
      const a = module("a");
      const result = await transactionOf(target)(async (view) => {
        await view.commit({
          putInstallations: [installation("a", a)],
          putManifests: [manifest("a", a)],
          putModules: [a],
        });
        expect(await view.getModule(a.id)).toEqual(a);
        expect(await held(view)).toEqual({
          installations: [installation("a", a)],
          manifests: [manifest("a", a)],
          modules: [a],
        });
        return "done";
      });

      expect(result).toBe("done");
      expect(await target.getModule(a.id)).toEqual(a);
    });

    test("a transaction whose work throws leaves nothing, and the next one runs", async () => {
      const target = await store();
      const [kept, lost] = [module("kept"), module("lost")];
      await target.commit({ putModules: [kept] });

      await expect(
        transactionOf(target)(async (view) => {
          await view.commit({
            deleteModules: [kept.id],
            putInstallations: [installation("lost", lost)],
            putManifests: [manifest("lost", lost)],
            putModules: [lost],
          });
          throw new Error("work failed");
        })
      ).rejects.toThrow("work failed");
      expect(await held(target)).toEqual({
        installations: [],
        manifests: [],
        modules: [kept],
      });

      await transactionOf(target)((view) =>
        view.commit({ putModules: [lost] })
      );
      expect(await target.getModule(lost.id)).toEqual(lost);
    });

    test("a write from outside cannot land between a transaction's read and its commit", async () => {
      const target = await store();
      const a = module("a");
      await target.commit({ putModules: [a] });
      const outside = { ...a, artifactId: artifactId("outside") };
      const inside = { ...a, artifactId: artifactId("inside") };
      const read = Promise.withResolvers<void>();
      const proceed = Promise.withResolvers<void>();

      const running = transactionOf(target)(async (view) => {
        const before = await view.getModule(a.id);
        read.resolve();
        await proceed.promise;
        const after = await view.getModule(a.id);
        await view.commit({ putModules: [inside] });
        return { after, before };
      });
      await read.promise;
      // An independent caller, while the transaction sits between its read
      // and its commit, given time enough to land if nothing held it back.
      const landed = target.commit({ putModules: [outside] });
      await pause(20);
      proceed.resolve();

      expect(await running).toEqual({ after: a, before: a });
      await landed;
      expect(await target.getModule(a.id)).toEqual(outside);
    });

    test("a call to the store from inside its own transaction is refused at once", async () => {
      const target = await store();
      const a = module("a");
      const calls: Record<string, () => Promise<unknown>> = {
        commit: () => target.commit({ putModules: [a] }),
        getInstallation: () => target.getInstallation(installationId("a")),
        getManifest: () => target.getManifest(contentId("a")),
        getModule: () => target.getModule(a.id),
        listInstallations: () => target.listInstallations({ limit: 1 }),
        listManifests: () => target.listManifests(),
        listModules: () => target.listModules({ limit: 1 }),
        transaction: () => transactionOf(target)(() => Promise.resolve()),
      };
      const { promise: ended, resolve: end } = Promise.withResolvers<void>();
      let later: Promise<unknown> = Promise.resolve();

      const refusals = await transactionOf(target)(async (view) => {
        const outcomes: Record<string, string> = {};
        for (const [method, call] of Object.entries(calls)) {
          outcomes[method] = await settlesWithin(call(), 1000);
        }
        // Scheduled from inside, but run once the transaction has ended.
        later = ended.then(() => target.commit({ putModules: [a] }));
        await view.commit({ putModules: [module("b")] });
        return outcomes;
      });
      end();

      expect(Object.keys(refusals)).toHaveLength(8);
      for (const outcome of Object.values(refusals)) {
        expect(outcome).toMatch(REFUSAL);
      }
      await later;
      expect(
        (await target.listModules({ limit: 10 })).items.map(({ id }) => id)
      ).toEqual(["b", "a"]);
    });
  });
}

/** What a store's refusal of a call from inside its own transaction says. */
const REFUSAL = /refused: .*use the view/;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

/** The store's `transaction`; every store this suite describes has one. */
function transactionOf(
  store: ModuleStore
): NonNullable<ModuleStore["transaction"]> {
  const { transaction } = store;
  if (transaction === undefined) {
    throw new Error("the store has no transaction(work)");
  }
  return transaction.bind(store);
}

/** Every record of a list read, one page after another. */
async function all<T>(
  list: (page: {
    readonly after?: number;
    readonly limit: number;
  }) => Promise<ModuleStorePage<T>>
): Promise<T[]> {
  const items: T[] = [];
  let after: number | undefined;
  do {
    const page = await list(
      after === undefined ? { limit: 2 } : { after, limit: 2 }
    );
    items.push(...page.items);
    after = page.next;
  } while (after !== undefined);
  return items;
}

async function held(store: ModuleStore): Promise<Held> {
  return {
    installations: await all((page) => store.listInstallations(page)),
    manifests: await store.listManifests(),
    modules: await all((page) => store.listModules(page)),
  };
}

function moduleId(value: string): ModuleId {
  return value as ModuleId;
}

function artifactId(value: string): ArtifactId {
  return value as ArtifactId;
}

function contentId(value: string): ContentId {
  return value as ContentId;
}

function installationId(value: string): InstallationId {
  return value as InstallationId;
}

function module(id: string, artifact = `artifact-${id}`): Module {
  return { artifactId: artifactId(artifact), id: moduleId(id) };
}

/** A retained manifest; the store keeps any JSON value it is given. */
function manifest(
  content: string,
  owner: Module,
  extra: Readonly<Record<string, unknown>> = {}
): StoredManifest {
  return {
    contentId: contentId(content),
    manifest: {
      compatibility: { foundry: "^1.0.0" },
      description: null,
      nested: { flag: true, list: [1, -2.5, "three", null], text: "a\u0000b" },
      program: { entry: "outputs/packages/app/dist/index.js" },
      ...extra,
    } as unknown as ModuleManifest,
    moduleId: owner.id,
  };
}

function grant(capability: string): InstallationGrant {
  return {
    capability,
    constraintsDigest: `digest-${capability}`,
    createdAt: new Date("2026-11-01T00:00:00.123Z"),
    version: 1,
  };
}

/** A disabled Installation of `owner`; `overrides` sets any field. */
function installation(
  id: string,
  owner: Module,
  overrides: {
    readonly grants?: readonly InstallationGrant[];
    readonly installation?: Partial<Installation>;
  } = {}
): StoredInstallation {
  return {
    grants: overrides.grants ?? [],
    installation: {
      containerId: null,
      contentId: contentId(`content-${id}`),
      createdAt: new Date("2026-11-01T00:00:00.000Z"),
      generation: 0,
      id: installationId(id),
      moduleId: owner.id,
      startAttempts: 0,
      status: "disabled",
      updatedAt: new Date("2026-11-01T00:00:00.000Z"),
      ...overrides.installation,
    },
  };
}

/** A write as a caller holds it, every part of it open to change. */
function callerWrite(owner: Module) {
  return {
    deleteInstallations: [] as InstallationId[],
    deleteManifests: [] as ContentId[],
    deleteModules: [] as ModuleId[],
    putInstallations: [
      installation("added", owner, { grants: [grant("host.read")] }),
    ],
    putManifests: [manifest("added", owner, { nested: { list: ["x"] } })],
    putModules: [{ ...owner }],
  } satisfies ModuleStoreWrite;
}

/** What a store holds once `write`, as it stands now, lands on an empty store. */
function heldAfter(write: ReturnType<typeof callerWrite>): Held {
  return structuredClone({
    installations: write.putInstallations,
    manifests: write.putManifests,
    modules: write.putModules,
  });
}

/**
 * Changes, in place, every value `write` holds, as a caller might once
 * `commit` has returned: each field of each record, its Dates, Grants and
 * manifest, further records put, and deletes of what it put.
 */
function scramble(write: ReturnType<typeof callerWrite>): void {
  for (const put of write.putModules) {
    mutable(put).artifactId = artifactId("changed");
  }
  for (const put of write.putInstallations) {
    mutable(put.installation).status = "failed";
    put.installation.createdAt.setTime(0);
    put.grants[0]?.createdAt.setTime(0);
    (put.grants as InstallationGrant[]).push(grant("late"));
  }
  for (const put of write.putManifests) {
    nestedList(put.manifest).push("changed");
  }
  const late = module("late");
  write.putModules.push(late);
  write.putInstallations.push(installation("late", late));
  write.putManifests.push(manifest("late", late));
  write.deleteModules.push(moduleId("a"));
  write.deleteInstallations.push(installationId("added"));
  write.deleteManifests.push(contentId("added"));
}

/** The list a test manifest nests, open to change. */
function nestedList(value: ModuleManifest | undefined): unknown[] {
  const shaped = value as { nested?: { list?: unknown[] } } | undefined;
  const nested = shaped?.nested?.list;
  if (nested === undefined) {
    throw new Error("expected a test manifest");
  }
  return nested;
}

/** A manifest that throws when read, so no store can copy or encode it. */
function unreadable(): ModuleManifest {
  return Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      throw new Error("unreadable manifest");
    },
  }) as ModuleManifest;
}

/** Drops `readonly` so a test can try to change what a store handed out. */
function mutable<T>(value: T | null | undefined): {
  -readonly [K in keyof T]: T[K];
} {
  if (value === null || value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}
