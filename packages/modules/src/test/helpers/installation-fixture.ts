import { vi } from "vitest";
import { createModuleAccess } from "../../access";
import { installationIdSchema } from "../../domain";
import { ensureInstallation } from "../../management";
import type { ModuleActivationInput } from "../../platform/contracts";
import { createModuleInstallations } from "../../platform/installations";
import { KeyedTurns } from "../../platform/turns";
import { MODULE_SETTING_HOST_POLICY } from "../../settings";
import {
  publishedModule,
  weatherProvider,
  weatherRequest,
} from "./published-module";

export const installationId = installationIdSchema.parse(
  "forecast-installation"
);
export const launch = {
  files: "installation" as const,
  resources: { cpus: 1, memoryBytes: 268_435_456 },
};
export const settings: ModuleActivationInput["settings"] = {
  policy: MODULE_SETTING_HOST_POLICY,
  user: {},
};

export async function installationFixture(providers = [weatherProvider]) {
  const module = await publishedModule();
  const v1 = await module.publish("1.0.0", [weatherRequest(["Oslo"])]);
  const invocations = { revoke: vi.fn() };
  const checkout: string[] = [];
  const moduleTurns = new KeyedTurns<string>();
  const installations = createModuleInstallations({
    checkouts: {
      select: (version, record) =>
        moduleTurns.run(version.moduleId, async () => {
          checkout.push(`swap ${version.contentId}`);
          try {
            return await record();
          } catch (error) {
            checkout.push("restore");
            throw error;
          }
        }),
    },
    invocations,
    programs: module.programs,
    providers,
    store: module.store,
  });
  const access = createModuleAccess({
    providers: [weatherProvider],
    store: module.store,
  });
  const installation = await ensureInstallation({
    installationId,
    now: new Date(0),
    store: module.store,
    version: v1,
  });
  return {
    ...module,
    access,
    checkout,
    installation,
    installations,
    invocations,
    moduleTurns,
    v1,
  };
}
