/**
 * Every table in the Marbles database: Marbles' own and each domain
 * package's, composed into the one schema `drizzle-kit` generates the
 * migrations from. A package ships its tables at
 * `@foundry/<package>/store/tables`; adding one is one `export *` line
 * here, then `bun run db:generate`. Two packages exporting the same name
 * fail the typecheck rather than shadow each other.
 */

// biome-ignore lint/performance/noBarrelFile: the composed schema is the one place drizzle-kit reads every table from.
export * from "@foundry/agents/store/tables";
export * from "@foundry/artifacts/store/tables";
export * from "@foundry/modules/store/tables";
export * from "@foundry/sandbox/store/tables";
export * from "@foundry/tasks/store/tables";
export * from "@foundry/workflows/store/tables";
export * from "@foundry/workspaces/store/tables";
export * from "./tables";
