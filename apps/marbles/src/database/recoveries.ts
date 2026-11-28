import { asBusy } from "~/database/busy";
import { marblesRecoveries } from "~/database/tables";
import type { StoreDatabase } from "~/database/types";
import type { RecoveryLog, RecoveryReport } from "~/lib/recovery-report";
import { recoveryReportSchema } from "~/lib/recovery-report";

export interface DatabaseRecoveryLogOptions {
  readonly database: StoreDatabase;
  readonly scope: string;
}

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
