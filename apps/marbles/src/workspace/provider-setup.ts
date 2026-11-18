import { ModelManager } from "@foundry/models";
import { DatabaseProviderStore } from "~/database/providers";
import { environmentSnapshot } from "~/lib/environment";
import type { Proposal } from "~/lib/providers/configuration";
import { ProviderConfiguration } from "~/lib/providers/configuration";
import type {
  ProviderWorkspace,
  RegisteredPlugin,
} from "~/lib/providers/plugins";
import { FIRST_PARTY_PLUGINS } from "~/lib/providers/plugins";
import { ConfigurationError } from "~/lib/providers/store";

export interface ProviderSetupOptions {
  readonly confirm: (question: string) => Promise<boolean>;
  readonly plugins?: readonly RegisteredPlugin[];
  readonly print: (line: string) => void;
  readonly state: string;
  readonly workspace?: Omit<ProviderWorkspace, "env">;
}

export async function setupProviders(
  options: ProviderSetupOptions
): Promise<void> {
  const plugins = options.plugins ?? FIRST_PARTY_PLUGINS;
  const configuration = new ProviderConfiguration({
    environment: { machine: environmentSnapshot(), workspace: {} },
    models: new ModelManager(),
    plugins,
    store: DatabaseProviderStore.forState(options.state),
    ...(options.workspace ? { workspace: options.workspace } : {}),
  });
  await configuration.read();
  if (configuration.configured) {
    return;
  }
  const detected = configuration
    .propose()
    .filter((entry) => entry.scope === "machine");
  for (const entry of detected) {
    if (entry.taken !== undefined) {
      options.print(
        `${entry.id} is configured for workspace ${entry.taken}, so it is not offered for the whole machine.`
      );
    }
  }
  const proposed = detected.filter((entry) => entry.taken === undefined);
  if (proposed.length === 0) {
    options.print(
      detected.length === 0
        ? "No model providers were found on this machine. Install Claude Code, Codex, or Pi, then run marbles again."
        : "Nothing else to offer for the whole machine."
    );
    return;
  }
  options.print("Model providers found on this machine, in preference order:");
  for (const [index, entry] of proposed.entries()) {
    const label = plugins.find((plugin) => plugin.id === entry.plugin)?.label;
    options.print(`  ${index + 1}. ${entry.id}${label ? ` (${label})` : ""}`);
  }
  if (await options.confirm("Use these for every workspace? [Y/n] ")) {
    options.print(await save(configuration, proposed));
    return;
  }
  options.print(
    "Nothing saved. Agents need providers; run marbles again to set them up."
  );
}

async function save(
  configuration: ProviderConfiguration,
  proposed: readonly Proposal[]
): Promise<string> {
  try {
    const saved = await configuration.initialize(
      proposed.map(({ scope: _, taken: __, ...entry }) => entry)
    );
    return saved
      ? "Saved for every workspace on this machine."
      : "Providers were configured meanwhile, so those were kept and nothing was saved.";
  } catch (error) {
    if (
      error instanceof ConfigurationError &&
      error.code === "PROVIDER_ID_TAKEN"
    ) {
      return `Nothing saved: ${error.message}. Run marbles again to choose from what is left.`;
    }
    throw error;
  }
}
