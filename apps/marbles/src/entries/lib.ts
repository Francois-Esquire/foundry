/**
 * The lib entry, `@foundry.sh/marbles/lib`: everything `lib/index.ts`
 * exports, with the published `Engine` (`entries/engine.ts`), which keeps
 * a workspace's tasks in the Marbles database whenever it has a `state`,
 * and `stateProviders`, the machine's provider configuration in the
 * Marbles database of a state root, for a `ProviderConfiguration`.
 */

// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for programmatic hosts.
export { stateProviders } from "~/database/providers";
export { Engine } from "~/entries/engine";
export * from "~/lib/index";
