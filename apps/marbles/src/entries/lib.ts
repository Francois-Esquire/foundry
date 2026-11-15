/**
 * The lib entry, `@foundry.sh/marbles/lib`: everything `lib/index.ts`
 * exports, with the published `Engine` (`entries/engine.ts`), which keeps
 * a workspace's tasks in the Marbles database whenever it has a `state`.
 */

// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for programmatic hosts.
export { Engine } from "~/entries/engine";
export * from "~/lib/index";
