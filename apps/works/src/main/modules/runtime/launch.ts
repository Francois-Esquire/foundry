import type { ModuleVersion } from "@foundry/modules/domain";
import {
  isStrictModuleManifest,
  moduleSettingRequests,
} from "@foundry/modules/manifest";
import type { ModuleProgramLaunch } from "@foundry/modules/platform/contracts";
import {
  type ModuleSettingsHostPolicy,
  type ModuleSettingValues,
  resolveModuleSettings,
  withModuleSettingDefaults,
} from "@foundry/modules/settings";
import { ModuleRuntimeError } from "./controller";

/**
 * Works starts a released Program from its own memory default, under the
 * shared host ceilings. A Manifest's `resources` minimums raise it.
 */
export const WORKS_MODULE_SETTINGS: {
  readonly policy: ModuleSettingsHostPolicy;
  readonly user: ModuleSettingValues;
} = Object.freeze({
  policy: withModuleSettingDefaults({
    "resources.memoryBytes": 512 * 1024 * 1024,
  }),
  user: Object.freeze({}),
});

/**
 * What a released Program starts with here: the effective resource settings
 * for its Manifest, and the private-files persistence it declares. A Manifest
 * that declares no persistence keeps its files between opens, as closing an
 * app preserves its local data; one that declares `none` gets fresh files
 * that go once it stops. A Manifest asking for more than this host allows is
 * refused rather than started smaller.
 */
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
