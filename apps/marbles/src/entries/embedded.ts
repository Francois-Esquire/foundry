import { installDefaultRuntime } from "~/create";

installDefaultRuntime();

// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for embedded hosts.
export { Engine } from "~/entries/engine";
export * from "~/lib/embedded";
