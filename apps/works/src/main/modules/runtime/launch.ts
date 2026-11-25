import {
  isStrictModuleManifest,
  type ModuleSettingsHostPolicy,
  type ModuleSettingValues,
  type ModuleVersion,
  moduleSettingRequests,
  resolveModuleSettings,
  withModuleSettingDefaults,
} from "@foundry/modules";
import type { ModuleProgramLaunch } from "@foundry/modules/platform";
import { ModuleRuntimeError } from "./controller";

export const WORKS_MODULE_SETTINGS: {
  readonly policy: ModuleSettingsHostPolicy;
  readonly user: ModuleSettingValues;
} = Object.freeze({
  policy: withModuleSettingDefaults({
    "resources.memoryBytes": 512 * 1024 * 1024,
  }),
  user: Object.freeze({}),
});

export function worksModuleLaunch(
  version: Pick<ModuleVersion, "manifest">
): ModuleProgramLaunch {
  const resolution = resolveModuleSettings({
    ...WORKS_MODULE_SETTINGS,
    requests: moduleSettingRequests(version.manifest),
  });
  if (!resolution.ok) {
    throw new ModuleRuntimeError(
      `This release cannot run here: ${resolution.problems.map((problem) => problem.message).join("; ")}`
    );
  }
  const { effective } = resolution;
  const { manifest } = version;
  return {
    files:
      (isStrictModuleManifest(manifest)
        ? manifest.persistence?.files
        : undefined) ?? "installation",
    resources: {
      cpus: effective["resources.cpus"],
      memoryBytes: effective["resources.memoryBytes"],
    },
  };
}
