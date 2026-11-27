import type { Authorization } from "@foundry/authorization";
import { installationPrincipal } from "../access";
import type { ModuleVersion } from "../domain";
import { ModuleStoreConflictError } from "../errors";
import type { ModuleCapabilityProvider } from "../gateway/types";
import { isStrictModuleManifest, moduleSettingRequests } from "../manifest";
import type { ModuleCommands } from "../modules";
import {
  type ActivationCompatibilityFact,
  type ActivationPreflight,
  preflightModuleActivation,
} from "../preflight";
import { resolveModuleSettings } from "../settings";
import type { ModuleActivationInput, ModuleProgramLaunch } from "./contracts";

export class ModuleActivationRefusedError extends Error {
  override readonly name = "ModuleActivationRefusedError";
  readonly facts: readonly ActivationCompatibilityFact[];

  constructor(facts: readonly ActivationCompatibilityFact[]) {
    super(
      `The Version cannot start: ${facts.map((fact) => fact.detail).join("; ")}`
    );
    this.facts = facts;
  }
}

export async function validateModuleActivation(
  input: ModuleActivationInput,
  options: {
    readonly authorization?: Authorization;
    readonly store: Pick<
      ModuleCommands,
      "authorization" | "loadGatewayContext"
    >;
    readonly providers: readonly ModuleCapabilityProvider[];
  }
): Promise<ActivationPreflight> {
  const { installation, version, launch, settings } = input;
  const context = await options.store.loadGatewayContext(installation.id);
  if (
    !context ||
    context.installation.generation !== installation.generation ||
    context.installation.contentId !== version.contentId
  ) {
    throw new ModuleStoreConflictError(
      `Installation ${installation.id} no longer selects Content ${version.contentId} at generation ${installation.generation}`
    );
  }
  const preflight = await preflightModuleActivation({
    authorization: options.authorization ?? options.store.authorization,
    grants: context.grants,
    principal: installationPrincipal(installation, version),
    providers: options.providers,
    settings,
    version,
  });
  const blocking = [
    ...preflight.facts.filter((fact) => fact.blocking),
    ...unmetLaunchRequirements({ launch, settings, version }),
  ];
  if (blocking.length > 0) {
    throw new ModuleActivationRefusedError(blocking);
  }
  return preflight;
}

function unmetLaunchRequirements(input: {
  readonly launch: ModuleProgramLaunch;
  readonly settings: ModuleActivationInput["settings"];
  readonly version: ModuleVersion;
}): ActivationCompatibilityFact[] {
  const { resources } = input.launch;
  const { manifest } = input.version;
  const persistence = isStrictModuleManifest(manifest)
    ? manifest.persistence?.files
    : undefined;
  const requiredPersistence =
    persistence ?? (manifest.data === undefined ? undefined : "installation");
  const facts: ActivationCompatibilityFact[] = [];
  if (
    requiredPersistence !== undefined &&
    input.launch.files !== requiredPersistence
  ) {
    facts.push({
      blocking: true,
      detail: `The launch uses private files persistence "${input.launch.files}"; the Module requires "${requiredPersistence}"`,
      kind: "unsupported-requirement",
    });
  }
  const resolution = resolveModuleSettings({
    policy: input.settings.policy,
    requests: moduleSettingRequests(input.version.manifest),
    user: {
      ...input.settings.user,
      "resources.cpus": resources.cpus,
      "resources.memoryBytes": resources.memoryBytes,
    },
  });
  if (resolution.ok) {
    return facts;
  }
  return [
    ...facts,
    ...resolution.problems
      .filter(
        (problem) =>
          problem.key === "resources.cpus" ||
          problem.key === "resources.memoryBytes"
      )
      .map((problem) => ({
        blocking: true,
        detail: `Launch ${problem.message}`,
        kind: "unsupported-requirement" as const,
      })),
  ];
}
