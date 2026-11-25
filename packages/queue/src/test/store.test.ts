import { Effect } from "effect";
import { afterEach } from "vitest";
import { makeMemoryQueueStore } from "../store/memory";
import { makeSqliteQueueStore } from "../store/sqlite";
import { describeQueueStore } from "../testing/store";
import { closeDatabases, openDatabase } from "./helpers/sqlite";

afterEach(closeDatabases);

describeQueueStore("MemoryQueueStore", () =>
  Effect.runPromise(makeMemoryQueueStore)
);

describeQueueStore("SqliteQueueStore on libSQL", async () =>
  makeSqliteQueueStore({ database: await openDatabase(), scope: "conformance" })
);
