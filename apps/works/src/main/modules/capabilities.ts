import { createModuleCapabilityCatalog } from "@foundry/modules/gateway/catalog";
import type {
  ModuleCapabilityCatalog,
  ModuleCapabilityProvider,
} from "@foundry/modules/gateway/types";
import type { ArtifactHost } from "~/main/artifacts/gateway/host";
import { artifactCapabilities } from "~/main/artifacts/gateway/providers";
import {
  type ExecutionHost,
  executionCapabilities,
} from "~/main/execution/capabilities";
import type { WorkflowRegistry } from "~/main/execution/workflows";
import { unavailable, type WorksCapability } from "~/main/gateway/provider-kit";
import { type ThemeFeed, themeCapability } from "./theme-capability";

/** The services Works' capabilities act on. */
export interface WorksCapabilityServices {
  readonly artifacts: ArtifactHost;
  readonly execution: ExecutionHost;
  readonly theme: ThemeFeed;
  /** The workflows a Module may start; Works' registered ones by default. */
  readonly workflows?: WorkflowRegistry;
}

/**
 * The host operations Works provides to Module Programs (spec §7), bound to
 * live services: release builds take their capability catalog from these,
 * released Programs their Gateway providers, and Access what each approval
 * reaches and what each revoke ends. A Manifest that selects a Capability
 * not listed here does not build, and an existing Version that requires one
 * does not start. Each is delivered only under an approved Grant.
 */
export function worksCapabilities(
  services: WorksCapabilityServices
): readonly WorksCapability[] {
  return [
    themeCapability(services.theme),
    ...artifactCapabilities(services.artifacts),
    ...executionCapabilities(services.execution, services.workflows),
  ];
}

/** The Gateway providers among `capabilities`. */
export function capabilityProviders(
  capabilities: readonly WorksCapability[]
): ModuleCapabilityProvider[] {
  return capabilities.flatMap(({ provider }) => (provider ? [provider] : []));
}

/**
 * Works' capabilities over services that are not there: their descriptors
 * and constraint policies hold, and any invocation throws.
 */
export function describedCapabilities(): readonly WorksCapability[] {
  return worksCapabilities({
    artifacts: unavailable("Artifacts"),
    execution: unavailable("Workflows"),
    theme: unavailable("System theme services"),
  });
}

/**
 * The portable catalog builds generate their Gateway client from: Works'
 * own unless other providers are named.
 */
export function worksCapabilityCatalog(
  providers: readonly ModuleCapabilityProvider[] = capabilityProviders(
    describedCapabilities()
  )
): ModuleCapabilityCatalog {
  return createModuleCapabilityCatalog({
    generation: 1,
    registrations: providers.map((provider) => provider.registration),
  });
}
