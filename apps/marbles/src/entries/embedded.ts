import { installDefaultRuntime } from "~/create";
import { installNodeContextRuntime } from "~/lib/async-context/node";

installNodeContextRuntime();
installDefaultRuntime();

// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for embedded hosts.
export { Engine } from "~/entries/engine";
export * from "~/lib/embedded";
