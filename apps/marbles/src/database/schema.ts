// biome-ignore lint/performance/noBarrelFile: the composed schema is the one place drizzle-kit reads every table from.
export * from "@foundry/agents/store/tables";
export * from "@foundry/artifacts/store/tables";
export * from "@foundry/modules/store/tables";
export * from "@foundry/sandbox/store/tables";
export * from "@foundry/tasks/store/tables";
export * from "@foundry/workflows/store/tables";
export * from "@foundry/workspaces/store/tables";
export * from "./tables";
