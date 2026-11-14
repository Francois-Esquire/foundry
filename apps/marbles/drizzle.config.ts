import { defineConfig } from "drizzle-kit";

/**
 * Marbles owns the migrations for every table in its database, its own and
 * each domain package's: `bun run db:generate` writes the next one from the
 * composed schema, and opening the database applies it.
 */
export default defineConfig({
  dialect: "sqlite",
  out: "./src/database/migrations",
  schema: "./src/database/schema.ts",
});
