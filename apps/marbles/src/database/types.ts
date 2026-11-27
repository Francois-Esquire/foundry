import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

export type StoreDatabase = BaseSQLiteDatabase<"async", unknown>;
