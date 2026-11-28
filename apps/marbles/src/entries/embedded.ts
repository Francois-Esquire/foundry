import { installDefaultRuntime } from "~/create";
import { installNodeContextRuntime } from "~/host/async-context";

installNodeContextRuntime();
installDefaultRuntime();

// biome-ignore lint/performance/noBarrelFile: This is the public package entry point for embedded hosts.
export { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
export { claudeCodeProvider } from "@foundry/models/providers/claude-code";
export { codexProvider } from "@foundry/models/providers/codex";
export { piProvider } from "@foundry/models/providers/pi";
export { Workspaces } from "@foundry/workspaces";
export { directory } from "@foundry/workspaces/node";
export { git } from "@foundry/workspaces/node/git";
export { nodeObserver } from "@foundry/workspaces/node/watch";
export { DatabaseProviderStore } from "~/database/providers";
export { Engine } from "~/entries/engine";
export * from "~/lib/embedded";
export { FileRunOutputSink } from "~/state/output";
