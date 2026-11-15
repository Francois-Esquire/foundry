import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, readDatabase } from "~/database/open";
import { marblesUsageFacts } from "~/database/tables";
import { DatabaseUsageStore } from "~/database/usage";
import { stateDatabase } from "~/layout";
import type { RecordedUsageFact, UsageRecords } from "~/lib/usage";
import { UsageLedger } from "~/lib/usage";
import type { UsageStore } from "~/lib/usage-store";

/**
 * Where a usage store under test comes from: `store()` makes another over
 * the same state, as a second engine would have. `close` ends whatever the
 * stores were made over.
 */
export interface UsageStoreFixture {
  close(): Promise<void>;
  store(): UsageStore;
}

/** A direct session's turn, reported at half a dollar. */
export function directFact(
  turnId: string,
  extra: Partial<RecordedUsageFact> = {}
): RecordedUsageFact {
  return {
    agentId: "helper",
    completedAt: 1,
    cost: {
      amount: 0.5,
      currency: "USD",
      kind: "reported",
      reference: "probe",
    },
    scope: "direct",
    sessionId: "shared",
    tokens: { input: 2, output: 3, total: 5 },
    turnId,
    version: 1,
    workspaceId: "ws",
    ...extra,
  } as RecordedUsageFact;
}

/** A turn in step `build` of run `runId`. */
export function runFact(turnId: string, runId: string): RecordedUsageFact {
  return {
    ...directFact(turnId),
    definitionId: "ship",
    path: ["ship", "build"],
    runId,
    scope: "run",
  };
}

/**
 * The contract every `UsageStore` keeps, whatever it keeps facts in.
 * `shared` says whether two stores from one fixture see one another's
 * facts, as two engines over one database do.
 */
export function describeUsageStore(
  name: string,
  open: () => Promise<UsageStoreFixture>,
  { shared }: { readonly shared: boolean }
): void {
  describe(name, () => {
    let fixture: UsageStoreFixture | undefined;
    const made: UsageStore[] = [];
    const store = async () => {
      fixture ??= await open();
      const usage = fixture.store();
      made.push(usage);
      return usage;
    };

    afterEach(async () => {
      for (const usage of made.splice(0)) {
        await usage.close().catch(() => undefined);
      }
      await fixture?.close();
      fixture = undefined;
    });

    it("keeps one fact per turn, filed under its run or as a direct session's", async () => {
      const usage = await store();
      expect(await usage.facts()).toEqual({ facts: [], revision: 0 });
      await usage.save(directFact("a"));
      await usage.save(runFact("b", "rn-1"));
      await usage.save(directFact("a", { completedAt: 2 }));
      const { facts } = await usage.facts();
      expect(
        [...facts].sort((x, y) =>
          String((x.value as RecordedUsageFact).turnId).localeCompare(
            String((y.value as RecordedUsageFact).turnId)
          )
        )
      ).toEqual([
        {
          owner: { kind: "direct" },
          value: directFact("a", { completedAt: 2 }),
        },
        { owner: { kind: "run", runId: "rn-1" }, value: runFact("b", "rn-1") },
      ]);
    });

    it("never replaces a turn's fact or marker with a marker, and replaces a marker with a fact", async () => {
      const usage = await store();
      await usage.save(directFact("saved"));
      await usage.mark(directFact("saved", { lost: "disk full" }));
      await usage.mark(directFact("lost", { lost: "disk full" }));
      await usage.mark(directFact("lost", { lost: "again" }));
      expect(
        (await usage.facts()).facts.map(
          ({ value }) => (value as RecordedUsageFact).lost
        )
      ).toEqual(expect.arrayContaining([undefined, "disk full"]));
      await usage.save(directFact("lost"));
      expect(
        (await usage.facts()).facts.every(
          ({ value }) => (value as RecordedUsageFact).lost === undefined
        )
      ).toBe(true);
    });

    it("raises its revision with every fact kept, and reads facts at the revision it says", async () => {
      const usage = await store();
      const before = await usage.revision();
      await usage.save(directFact("a"));
      const after = await usage.revision();
      expect(after).toBeGreaterThan(before);
      expect((await usage.facts()).revision).toBe(after);
      await usage.save(directFact("a", { completedAt: 3 }));
      expect(await usage.revision()).toBeGreaterThan(after);
    });

    it("owns a fact from the call, and refuses one it cannot copy", async () => {
      const usage = await store();
      const fact = directFact("a") as { completedAt: number };
      const saving = usage.save(fact as unknown as RecordedUsageFact);
      fact.completedAt = 99;
      await saving;
      expect((await usage.facts()).facts[0]?.value).toEqual(directFact("a"));
      await expect(
        usage.save({
          ...directFact("b"),
          agentId: (() => "x") as unknown as string,
        })
      ).rejects.toThrow();
    });

    it.runIf(shared)(
      "shares facts with every store over the same state",
      async () => {
        const first = await store();
        const second = await store();
        await first.save(directFact("a"));
        await second.save(directFact("b"));
        expect((await first.facts()).facts).toHaveLength(2);
        expect(await first.revision()).toBe(await second.revision());
      }
    );

    it("refuses every call once closed", async () => {
      const usage = await store();
      await usage.close();
      await expect(usage.save(directFact("a"))).rejects.toThrow();
      await expect(usage.facts()).rejects.toThrow();
      await expect(usage.revision()).rejects.toThrow();
    });
  });
}

/**
 * What the usage ledger of the workspace `scope` (a test engine's, `test`,
 * by default) reads from the Marbles database at the state root `state`,
 * as a later engine would; nothing when there is no database.
 */
export async function storedUsage(
  state: string,
  scope = "test"
): Promise<UsageRecords | undefined> {
  return await readDatabase(stateDatabase(state), (database) =>
    new UsageLedger(new DatabaseUsageStore({ database, scope })).read()
  );
}

/**
 * Put `value` as turn `turnId`'s stored fact, filed under `runId` (or a
 * direct session's), whatever it holds, as a damaged or foreign row would
 * read.
 */
export async function putStoredFact(
  state: string,
  row: {
    readonly runId: string | null;
    readonly turnId: string;
    readonly value: unknown;
  },
  scope = "test"
): Promise<void> {
  const opened = await openDatabase(stateDatabase(state));
  if (opened === undefined) {
    throw new Error(`no Marbles database at ${state}`);
  }
  try {
    const values = {
      fact: row.value,
      revision: sql<number>`(select coalesce(max("revision"), 0) + 1 from "marbles_usage_facts" where "scope" = ${scope})`,
      runId: row.runId,
      scope,
      turnId: row.turnId,
    };
    await opened.database
      .insert(marblesUsageFacts)
      .values(values)
      .onConflictDoUpdate({
        set: values,
        target: [marblesUsageFacts.scope, marblesUsageFacts.turnId],
      });
  } finally {
    opened.close();
  }
}

/**
 * A usage store whose saves and marks fail when `fail` says so, counting
 * every one; reads go to `inner`. Several engines may share one: closing
 * it leaves `inner` open, for the test that made it to close.
 */
export class FailingUsageStore implements UsageStore {
  writes = 0;
  readonly #fail: (write: number) => boolean;
  readonly #inner: UsageStore;

  constructor(inner: UsageStore, fail: (write: number) => boolean) {
    this.#inner = inner;
    this.#fail = fail;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  facts(): ReturnType<UsageStore["facts"]> {
    return this.#inner.facts();
  }

  mark(marker: RecordedUsageFact): Promise<void> {
    return this.#write(() => this.#inner.mark(marker));
  }

  revision(): Promise<number> {
    return this.#inner.revision();
  }

  save(fact: RecordedUsageFact): Promise<void> {
    return this.#write(() => this.#inner.save(fact));
  }

  #write(write: () => Promise<void>): Promise<void> {
    this.writes += 1;
    return this.#fail(this.writes)
      ? Promise.reject(new Error("disk full"))
      : write();
  }
}
