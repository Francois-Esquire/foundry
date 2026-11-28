import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { ChangeRecorder } from "~/database/changes";
import type { MarblesDatabase } from "~/database/open";
import { initializeDatabase } from "~/database/open";
import { marblesChanges } from "~/database/tables";
import { DatabaseWorkspaceRecords } from "~/database/tasks";
import { NODE_OWNER_LIVENESS } from "~/host/liveness";
import { stateDatabase } from "~/layout";
import { causingRun } from "~/lib/events/records";

export interface TestMachine {
  changes(state: string, source?: string): Promise<readonly RecordedChange[]>;
  close(): void;
  readonly database: MarblesDatabase;
  records(state: string): DatabaseWorkspaceRecords;
  readonly root: string;
  workspace(): string;
}

interface RecordedChange {
  readonly id: string;
  readonly payload: { readonly type: string } & Record<string, unknown>;
  readonly position: number;
  readonly runId: string | null;
  readonly source: string;
  readonly type: string;
}

export async function testMachine(): Promise<TestMachine> {
  const root = mkdtempSync(join(tmpdir(), "marbles-machine-"));
  const database = await initializeDatabase(stateDatabase(root));
  const changes = async (
    state: string,
    source?: string
  ): Promise<RecordedChange[]> => {
    const rows = await database.database
      .select()
      .from(marblesChanges)
      .where(
        and(
          eq(marblesChanges.scope, basename(state)),
          source === undefined ? undefined : eq(marblesChanges.source, source)
        )
      )
      .orderBy(asc(marblesChanges.position));
    return rows.map((row) => ({
      id: row.id,
      payload: row.payload as RecordedChange["payload"],
      position: row.position,
      runId: row.runId,
      source: row.source,
      type: row.type,
    }));
  };
  return {
    changes,
    close: () => database.close(),
    database,
    records: (state) =>
      new DatabaseWorkspaceRecords({
        changes: new ChangeRecorder(basename(state), {
          causingRun: () => causingRun() ?? undefined,
        }),
        database: database.database,
        liveness: NODE_OWNER_LIVENESS,
        scope: basename(state),
      }),
    root,
    workspace() {
      const dir = mkdtempSync(join(root, "ws-"));
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
}
