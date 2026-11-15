import { eq, lt, sql } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { marblesHarnessActivities } from "~/database/tables";
import type { ActivityRecord, ActivityStore } from "~/lib/sandbox/activities";
import { activityRecordSchema } from "~/lib/sandbox/activities";

export interface DatabaseActivityStoreOptions {
  /** The database the host keeps open. */
  readonly database: StoreDatabase;
  /** The workspace id. */
  readonly scope: string;
}

/**
 * A workspace's harness activities in the Marbles database: a row of
 * `marbles_harness_activities` each, by the workspace id and the
 * activity's key, replaced only by a higher revision. One that no longer
 * reads back through the activity schema is passed over, as the
 * dashboard's projection always has. A lock waited on too long rejects as
 * a `DatabaseBusyError`.
 */
export class DatabaseActivityStore implements ActivityStore {
  readonly #database: StoreDatabase;
  readonly #scope: string;

  constructor(options: DatabaseActivityStoreOptions) {
    this.#database = options.database;
    this.#scope = options.scope;
  }

  load(): Promise<readonly ActivityRecord[]> {
    return asBusy(async () => {
      const rows = await this.#database
        .select({ record: marblesHarnessActivities.record })
        .from(marblesHarnessActivities)
        .where(eq(marblesHarnessActivities.scope, this.#scope));
      return rows.flatMap(({ record }) => {
        const parsed = activityRecordSchema.safeParse(record);
        return parsed.success ? [parsed.data as ActivityRecord] : [];
      });
    });
  }

  put(key: string, record: ActivityRecord): Promise<void> {
    const kept = activityRecordSchema.parse(record);
    return asBusy(async () => {
      await this.#database
        .insert(marblesHarnessActivities)
        .values({
          key,
          record: kept,
          revision: kept.event.revision,
          scope: this.#scope,
        })
        .onConflictDoUpdate({
          set: {
            record: kept,
            revision: sql`excluded.revision`,
          },
          setWhere: lt(
            marblesHarnessActivities.revision,
            sql`excluded.revision`
          ),
          target: [
            marblesHarnessActivities.scope,
            marblesHarnessActivities.key,
          ],
        });
    });
  }
}
