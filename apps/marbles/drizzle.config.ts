import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  out: "./src/database/migrations",
  schema: "./src/database/schema.ts",
});
