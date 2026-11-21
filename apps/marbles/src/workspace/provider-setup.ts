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

interface DiscoveryOptions {
  readonly plugins?: readonly RegisteredPlugin[];
  readonly recheck?: boolean;
  readonly state: string;
  readonly workspace?: ProviderWorkspace;
}

interface ProviderSetupOptions extends DiscoveryOptions {
  readonly confirm: (question: string) => Promise<boolean>;
  readonly print: (line: string) => void;
}

export async function discoverProviderSetup(options: DiscoveryOptions) {
  const plugins = options.plugins ?? FIRST_PARTY_PLUGINS;
  const configure = () =>
    new ProviderConfiguration({
      environment: environmentSnapshot(),
      models: new ModelManager(),
      plugins,
      store: DatabaseProviderStore.forState(options.state),
      ...(options.workspace ? { workspace: options.workspace } : {}),
    });
  const discovery = configure();
  try {
    await discovery.read();
    const { configured } = discovery;
    const detected =
      configured && !options.recheck
        ? []
        : discovery.propose().filter((entry) => entry.scope === "machine");
    const proposed = detected.filter((entry) => entry.taken === undefined);
    return {
      configured,
      offered: proposed.map(({ id, plugin }) => ({
        id,
        label: plugins.find((candidate) => candidate.id === plugin)?.label,
      })),
      reserved: detected.filter((entry) => entry.taken !== undefined),
      async save() {
        const configuration = configure();
        try {
          await configuration.read();
          return await save(configuration, proposed);
        } finally {
          await configuration.dispose();
        }
      },
    };
  } finally {
    await discovery.dispose();
  }
}

export async function setupProviders(
  options: ProviderSetupOptions
): Promise<void> {
  const setup = await discoverProviderSetup(options);
  if (setup.configured) {
    return;
  }
  for (const entry of setup.reserved) {
    options.print(
      `${entry.id} is configured for workspace ${entry.taken}, so it is not offered for the whole machine.`
    );
  }
  if (setup.offered.length === 0) {
    options.print(
      setup.reserved.length === 0
        ? "No model providers were found on this machine. Install Claude Code, Codex, or Pi, then run marbles again."
        : "Nothing else to offer for the whole machine."
    );
    return;
  }
  options.print("Model providers found on this machine, in preference order:");
  for (const [index, { id, label }] of setup.offered.entries()) {
    options.print(`  ${index + 1}. ${id}${label ? ` (${label})` : ""}`);
  }
  if (await options.confirm("Use these for every workspace? [Y/n] ")) {
    options.print((await setup.save()).message);
    return;
  }
  options.print(
    "Nothing saved. Agents need providers; run marbles again to set them up."
  );
}

async function save(
  configuration: ProviderConfiguration,
  proposed: readonly Proposal[]
) {
  try {
    const saved = await configuration.initialize(
      proposed.map(({ scope: _, taken: __, ...entry }) => entry)
    );
    return {
      conflict: false,
      message: saved
        ? "Saved for every workspace on this machine."
        : "Providers were configured meanwhile, so those were kept and nothing was saved.",
    };
  } catch (error) {
    if (
      error instanceof ConfigurationError &&
      error.code === "PROVIDER_ID_TAKEN"
    ) {
      return {
        conflict: true,
        message: `Nothing saved: ${error.message}. Run marbles again to choose from what is left.`,
      };
    }
    throw error;
  }
}
