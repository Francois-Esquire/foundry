import { eq } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import { marblesRecoveries } from "~/database/tables";
import { stateDatabase } from "~/layout";
import type { RecoveryLog, RecoveryReport } from "~/lib/crash-recovery";
import { recoveryReportSchema } from "~/lib/crash-recovery";

export interface DatabaseRecoveryLogOptions {
  /** The database the host keeps open. */
  readonly database: StoreDatabase;
  /** The workspace id. */
  readonly scope: string;
}

/**
 * A workspace's last recovery report in the Marbles database: its row of
 * `marbles_recoveries`, replaced by each start's. A lock waited on too
 * long rejects as a `DatabaseBusyError`.
 */
export class DatabaseRecoveryLog implements RecoveryLog {
  readonly #database: StoreDatabase;
  readonly #scope: string;

  constructor(options: DatabaseRecoveryLogOptions) {
    this.#database = options.database;
    this.#scope = options.scope;
  }

  record(report: RecoveryReport): Promise<void> {
    const kept = recoveryReportSchema.parse(report);
    const row = { at: kept.at, steps: kept.steps };
    return asBusy(async () => {
      await this.#database
        .insert(marblesRecoveries)
        .values({ ...row, scope: this.#scope })
        .onConflictDoUpdate({ set: row, target: marblesRecoveries.scope });
    });
  }
}

/**
 * The last recovery report of the workspace `scope` in the Marbles
 * database at the state root `state`, read only; `null` with none kept,
 * no database, or a report that no longer reads back.
 */
export async function readLastRecovery(
  state: string,
  scope: string
): Promise<RecoveryReport | null> {
  const rows = await asBusy(() =>
    readDatabase(stateDatabase(state), (database) =>
      database
        .select()
        .from(marblesRecoveries)
        .where(eq(marblesRecoveries.scope, scope))
    )
  );
  const [row] = rows ?? [];
  if (row === undefined) {
    return null;
  }
  const parsed = recoveryReportSchema.safeParse({
    at: row.at,
    steps: row.steps,
  });
  return parsed.success ? parsed.data : null;
}
