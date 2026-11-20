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

export interface WorksCapabilityServices {
  readonly artifacts: ArtifactHost;
  readonly execution: ExecutionHost;
  readonly theme: ThemeFeed;
  readonly workflows?: WorkflowRegistry;
}

export function worksCapabilities(
  services: WorksCapabilityServices
): readonly WorksCapability[] {
  return [
    themeCapability(services.theme),
    ...artifactCapabilities(services.artifacts),
    ...executionCapabilities(services.execution, services.workflows),
  ];
}

export function capabilityProviders(
  capabilities: readonly WorksCapability[]
): ModuleCapabilityProvider[] {
  return capabilities.flatMap(({ provider }) => (provider ? [provider] : []));
}

export function describedCapabilities(): readonly WorksCapability[] {
  return worksCapabilities({
    artifacts: unavailable("Artifacts"),
    execution: unavailable("Workflows"),
    theme: unavailable("System theme services"),
  });
}

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
