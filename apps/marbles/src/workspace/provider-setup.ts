import { join } from "node:path";
import { ModelManager } from "@foundry/models";
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
  /** Ask a yes-or-no question; resolves true for yes. */
  readonly confirm: (question: string) => Promise<boolean>;
  readonly plugins?: readonly RegisteredPlugin[];
  readonly print: (line: string) => void;
  /** The Marbles state root, where the machine's configuration is written. */
  readonly state: string;
  /** The workspace being run: its own configuration counts as configured. */
  readonly workspace?: Omit<ProviderWorkspace, "env">;
}

/**
 * First setup for an interactive run with no provider configuration: show
 * what each plugin detects, in preference order, and write it for the whole
 * machine only when the person confirms. An id a workspace already uses is
 * not offered. Nothing is written otherwise, and a file another process
 * wrote while the question was open is kept.
 */
export async function setupProviders(
  options: ProviderSetupOptions
): Promise<void> {
  const plugins = options.plugins ?? FIRST_PARTY_PLUGINS;
  const configuration = new ProviderConfiguration({
    environment: { machine: environmentSnapshot(), workspace: {} },
    models: new ModelManager(),
    plugins,
    state: options.state,
    ...(options.workspace ? { workspace: options.workspace } : {}),
  });
  if (configuration.configured) {
    return;
  }
  const detected = configuration
    .propose()
    .filter((entry) => entry.scope === "machine");
  const file = join(options.state, "providers.json");
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
        ? `No model providers were found on this machine. Install Claude Code, Codex, or Pi, or write ${file}.`
        : `Nothing else to offer for the whole machine; write ${file} to configure it.`
    );
    return;
  }
  options.print("Model providers found on this machine, in preference order:");
  for (const [index, entry] of proposed.entries()) {
    const label = plugins.find((plugin) => plugin.id === entry.plugin)?.label;
    options.print(`  ${index + 1}. ${entry.id}${label ? ` (${label})` : ""}`);
  }
  if (await options.confirm("Use these for every workspace? [Y/n] ")) {
    options.print(await save(configuration, proposed, file));
    return;
  }
  options.print(
    `Nothing saved. Agents need providers; write ${file} to set them.`
  );
}

/** Write the confirmed entries, unless the machine was configured or an id taken meanwhile. */
async function save(
  configuration: ProviderConfiguration,
  proposed: readonly Proposal[],
  file: string
): Promise<string> {
  try {
    const saved = await configuration.initialize(
      proposed.map(({ scope: _, taken: __, ...entry }) => entry)
    );
    return saved
      ? `Saved to ${file}.`
      : `${file} was written meanwhile, so it was kept and nothing was saved.`;
  } catch (error) {
    // A workspace took one of these ids while the question was open.
    if (
      error instanceof ConfigurationError &&
      error.code === "PROVIDER_ID_TAKEN"
    ) {
      return `Nothing saved: ${error.message}. Run marbles again to choose from what is left.`;
    }
    throw error;
  }
}
