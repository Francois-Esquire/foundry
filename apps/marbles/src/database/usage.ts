import type { SQL } from "drizzle-orm";
import { eq, max, sql } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { marblesUsageFacts } from "~/database/tables";
import { RecordsGate } from "~/lib/events/records";
import type { RecordedUsageFact } from "~/lib/usage";
import type { StoredUsage, UsageStore } from "~/lib/usage-store";
import { ownerOf, storedUsageFact } from "~/lib/usage-store";

/**
 * A workspace's usage facts in the Marbles database
 * (`marbles_usage_facts`), scoped by the workspace id, one row per turn.
 * Each write is one statement, so two engines recording the same turn,
 * in this process or another, never interleave; each takes the scope's
 * next revision in that statement. Every call surfaces a lock waited on
 * too long as a `DatabaseBusyError`.
 */

export interface DatabaseUsageStoreOptions {
  /** The database the host keeps open. */
  readonly database: StoreDatabase;
  /** The workspace id. */
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
      // One statement, so the revision is the one these facts were read at.
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

  /**
   * `work` on the fact's row, in its stored form taken as the fact is
   * handed over (`storedUsageFact`), which
   * takes the scope's next revision as it lands. A fact that cannot be
   * copied rejects.
   */
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
