import { eq, inArray } from "drizzle-orm";

import { asBusy } from "~/database/busy";
import { marblesGenerations } from "~/database/tables";
import type { StoreDatabase } from "~/database/types";
import type { OwnerLiveness } from "~/lib/recovery/liveness";
import { PORTABLE_OWNER_LIVENESS } from "~/lib/recovery/liveness";

export type GenerationState = (typeof marblesGenerations.$inferSelect)["state"];

export interface GenerationRecord {
  readonly error: string | null;
  readonly fingerprint: string;
  readonly number: number;
  readonly pid: number;
  readonly started: string | null;
  readonly state: GenerationState;
  readonly workspaces: readonly string[];
}

const LIVE: readonly GenerationState[] = ["loading", "current", "retiring"];

export class GenerationRecords {
  readonly #database: StoreDatabase;
  readonly #liveness: OwnerLiveness;

  constructor(options: {
    readonly database: StoreDatabase;
    readonly liveness?: OwnerLiveness;
  }) {
    this.#database = options.database;
    this.#liveness = options.liveness ?? PORTABLE_OWNER_LIVENESS;
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

  spawned(number: number, pid: number, started: string | null): Promise<void> {
    return this.#set(number, { pid, started });
  }

  identify(number: number, started: string | null): Promise<void> {
    return this.#set(number, { started });
  }

  hosting(number: number, workspaces: readonly string[]): Promise<void> {
    return this.#set(number, { workspaces: [...workspaces].sort() });
  }

  mark(number: number, state: GenerationState, error?: string): Promise<void> {
    return this.#set(number, {
      state,
      ...(error === undefined ? {} : { error }),
    });
  }

  endAll(): Promise<void> {
    return asBusy(async () => {
      const live = await this.#database
        .select({
          number: marblesGenerations.number,
          pid: marblesGenerations.pid,
          started: marblesGenerations.started,
        })
        .from(marblesGenerations)
        .where(inArray(marblesGenerations.state, [...LIVE]));
      const at = new Date().toISOString();
      const provable = live.filter(
        (row) => row.pid <= 0 || row.started !== null
      );
      for (const each of provable) {
        const gone =
          each.pid <= 0 ||
          this.#liveness.isGone({ pid: each.pid, started: each.started });
        await this.#database
          .update(marblesGenerations)
          .set({ state: gone ? "exited" : "retiring", updatedAt: at })
          .where(eq(marblesGenerations.number, each.number));
      }
    });
  }

  async endGone(): Promise<readonly number[]> {
    const retiring = await asBusy(() =>
      this.#database
        .select({
          number: marblesGenerations.number,
          pid: marblesGenerations.pid,
          started: marblesGenerations.started,
        })
        .from(marblesGenerations)
        .where(eq(marblesGenerations.state, "retiring"))
    );
    const gone = retiring.filter(
      (each) =>
        each.pid > 0 &&
        each.started !== null &&
        this.#liveness.isGone({ pid: each.pid, started: each.started })
    );
    for (const each of gone) {
      await this.#set(each.number, { state: "exited" });
    }
    return gone.map((each) => each.number);
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
