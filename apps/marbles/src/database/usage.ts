import type { SQL } from "drizzle-orm";
import { eq, max, sql } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import { marblesUsageFacts } from "~/database/tables";
import type { StoreDatabase } from "~/database/types";
import { RecordsGate } from "~/lib/events/records-gate";
import type { RecordedUsageFact } from "~/lib/usage";
import type { StoredUsage, UsageStore } from "~/lib/usage/store";
import { ownerOf, storedUsageFact } from "~/lib/usage/store";

export interface DatabaseUsageStoreOptions {
  readonly database: StoreDatabase;
  readonly scope: string;
}

interface UsageRow {
  readonly fact: unknown;
  readonly revision: SQL<number>;
  readonly runId: string | null;
  readonly scope: string;
  readonly turnId: string;
}

export class DatabaseUsageStore implements UsageStore {
  readonly #database: StoreDatabase;
  readonly #scope: string;
  readonly #gate = new RecordsGate("the usage store is closed");

  constructor(options: DatabaseUsageStoreOptions) {
    this.#database = options.database;
    this.#scope = options.scope;
  }

  close(): Promise<void> {
    return this.#gate.close();
  }

  facts(): Promise<{
    readonly facts: readonly StoredUsage[];
    readonly revision: number;
  }> {
    return this.#call(async () => {
      const rows = await this.#database
        .select({
          fact: marblesUsageFacts.fact,
          revision: marblesUsageFacts.revision,
          runId: marblesUsageFacts.runId,
        })
        .from(marblesUsageFacts)
        .where(eq(marblesUsageFacts.scope, this.#scope));
      return {
        facts: rows.map(
          ({ fact, runId }): StoredUsage => ({
            owner: runId === null ? { kind: "direct" } : { kind: "run", runId },
            value: fact,
          })
        ),
        revision: rows.reduce((top, row) => Math.max(top, row.revision), 0),
      };
    });
  }

  mark(marker: RecordedUsageFact): Promise<void> {
    return this.#write(marker, async (row) => {
      await this.#database
        .insert(marblesUsageFacts)
        .values(row)
        .onConflictDoNothing();
    });
  }

  revision(): Promise<number> {
    return this.#call(async () => {
      const [row] = await this.#database
        .select({ revision: max(marblesUsageFacts.revision) })
        .from(marblesUsageFacts)
        .where(eq(marblesUsageFacts.scope, this.#scope));
      return row?.revision ?? 0;
    });
  }

  save(fact: RecordedUsageFact): Promise<void> {
    return this.#write(fact, async (row) => {
      await this.#database
        .insert(marblesUsageFacts)
        .values(row)
        .onConflictDoUpdate({
          set: {
            fact: row.fact,
            revision: row.revision,
            runId: row.runId,
          },
          target: [marblesUsageFacts.scope, marblesUsageFacts.turnId],
        });
    });
  }

  #write(
    fact: RecordedUsageFact,
    work: (row: UsageRow) => Promise<void>
  ): Promise<void> {
    let copy: RecordedUsageFact;
    try {
      copy = storedUsageFact(fact);
    } catch (error) {
      return Promise.reject(error);
    }
    const owner = ownerOf(copy);
    return this.#call(() =>
      work({
        fact: copy,
        revision: sql<number>`(select coalesce(max("revision"), 0) + 1 from "marbles_usage_facts" where "scope" = ${this.#scope})`,
        runId: owner.kind === "run" ? owner.runId : null,
        scope: this.#scope,
        turnId: copy.turnId,
      })
    );
  }

  #call<T>(call: () => Promise<T>): Promise<T> {
    return this.#gate.run(() => asBusy(call));
  }
}
