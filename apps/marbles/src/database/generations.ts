import { desc, eq, inArray } from "drizzle-orm";

import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import { marblesGenerations } from "~/database/tables";
import { stateDatabase } from "~/layout";

/**
 * The Marbles process's engine generations in the Marbles database, one
 * row each (`marbles_generations`): its number, its process, what it
 * loaded and how it is doing. The daemon is the one writer; `status`
 * reads it. A generation's work is owned by its process identity in the
 * other tables, so this record and those owners meet on `pid` and
 * `started`. A lock waited on too long rejects as a `DatabaseBusyError`.
 */

export type GenerationState = (typeof marblesGenerations.$inferSelect)["state"];

/** One generation, as its row says. */
export interface GenerationRecord {
  readonly error: string | null;
  readonly fingerprint: string;
  readonly number: number;
  readonly pid: number;
  readonly started: string | null;
  readonly state: GenerationState;
  /** The workspaces whose engines it started and still hosts. */
  readonly workspaces: readonly string[];
}

/** The states of a generation whose process may still be alive. */
const LIVE: readonly GenerationState[] = ["loading", "current", "retiring"];

export class GenerationRecords {
  readonly #database: StoreDatabase;

  constructor(options: { readonly database: StoreDatabase }) {
    this.#database = options.database;
  }

  /** Number a generation about to load what `fingerprint` names; its pid comes once spawned. */
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

  /** Generation `number` was spawned as `pid`. */
  spawned(number: number, pid: number): Promise<void> {
    return this.#set(number, { pid });
  }

  /** Keep the start time generation `number`'s process reported. */
  identify(number: number, started: string | null): Promise<void> {
    return this.#set(number, { started });
  }

  /** Generation `number` hosts `workspaces` now: each whose engine started there. */
  hosting(number: number, workspaces: readonly string[]): Promise<void> {
    return this.#set(number, { workspaces: [...workspaces].sort() });
  }

  /** Generation `number` is in `state` now, with why when it failed or died. */
  mark(number: number, state: GenerationState, error?: string): Promise<void> {
    return this.#set(number, {
      state,
      ...(error === undefined ? {} : { error }),
    });
  }

  /**
   * Every generation recorded live, marked exited: for a Marbles process
   * starting, whose predecessor left them so when it died. A generation
   * whose Marbles process is gone drains its runs and exits on its own, and
   * what it held once it is gone is put right by the next engine start's
   * recovery.
   */
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

/**
 * The generations recorded live in the Marbles database at the state root
 * `state`, newest first, read only: the current one, and any finishing
 * their runs. Empty with no database, or nothing migrated into it.
 */
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
    workspaces: row.workspaces,
  }));
}
