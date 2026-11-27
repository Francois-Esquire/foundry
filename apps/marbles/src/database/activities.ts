import { eq, lt, sql } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import { marblesHarnessActivities } from "~/database/tables";
import type { StoreDatabase } from "~/database/types";
import type { ActivityRecord, ActivityStore } from "~/lib/sandbox/activities";
import { activityRecordSchema } from "~/lib/sandbox/activities";

export interface DatabaseActivityStoreOptions {
  readonly database: StoreDatabase;
  readonly scope: string;
}

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
