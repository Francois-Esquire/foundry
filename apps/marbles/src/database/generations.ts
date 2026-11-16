import { desc, eq, inArray } from "drizzle-orm";

import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import { marblesGenerations } from "~/database/tables";
import { stateDatabase } from "~/layout";

export type GenerationState = (typeof marblesGenerations.$inferSelect)["state"];

export interface GenerationRecord {
  readonly error: string | null;
  readonly fingerprint: string;
  readonly number: number;
  readonly pid: number;
  readonly started: string | null;
  readonly state: GenerationState;
}

const LIVE: readonly GenerationState[] = ["loading", "current", "retiring"];

export class GenerationRecords {
  readonly #database: StoreDatabase;

  constructor(options: { readonly database: StoreDatabase }) {
    this.#database = options.database;
  }

  begin(fingerprint: string): Promise<number> {
    const at = new Date().toISOString();
    return asBusy(async () => {
      const [row] = await this.#database
        .insert(marblesGenerations)
        .values({
          createdAt: at,
          fingerprint,
          pid: 0,
          state: "loading",
          updatedAt: at,
        })
        .returning({ number: marblesGenerations.number });
      if (row === undefined) {
        throw new Error("no generation was numbered");
      }
      return row.number;
    });
  }

  spawned(number: number, pid: number): Promise<void> {
    return this.#set(number, { pid });
  }

  identify(number: number, started: string | null): Promise<void> {
    return this.#set(number, { started });
  }

  mark(number: number, state: GenerationState, error?: string): Promise<void> {
    return this.#set(number, {
      state,
      ...(error === undefined ? {} : { error }),
    });
  }

  endAll(): Promise<void> {
    return asBusy(async () => {
      await this.#database
        .update(marblesGenerations)
        .set({ state: "exited", updatedAt: new Date().toISOString() })
        .where(inArray(marblesGenerations.state, [...LIVE]));
    });
  }

  #set(
    number: number,
    values: Partial<typeof marblesGenerations.$inferInsert>
  ): Promise<void> {
    return asBusy(async () => {
      await this.#database
        .update(marblesGenerations)
        .set({ ...values, updatedAt: new Date().toISOString() })
        .where(eq(marblesGenerations.number, number));
    });
  }
}

export async function readLiveGenerations(
  state: string
): Promise<readonly GenerationRecord[]> {
  const rows = await asBusy(() =>
    readDatabase(stateDatabase(state), (database) =>
      database
        .select()
        .from(marblesGenerations)
        .where(inArray(marblesGenerations.state, [...LIVE]))
        .orderBy(desc(marblesGenerations.number))
    )
  );
  return (rows ?? []).map((row) => ({
    error: row.error,
    fingerprint: row.fingerprint,
    number: row.number,
    pid: row.pid,
    started: row.started,
    state: row.state,
  }));
}
