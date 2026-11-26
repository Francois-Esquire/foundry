import type {
  Container,
  ContainerSandboxConstraints,
  Containers,
} from "@foundry/sandbox";

import type { InstallationId } from "../domain";
import { ModuleStoreConflictError, ModuleStoreNotFoundError } from "../errors";
import { approvedNetworkDestinations } from "../grants";
import type { ModuleCommands } from "../modules";
import { rethrowAfterCleanup } from "./container-cleanup";
import type {
  ModuleProgramResources,
  ModuleProgramRuntimeAdapter,
} from "./contracts";
import type { ModuleCheckouts } from "./files";
import type { CreateModuleProgramRuntimeOptions } from "./program-runtime";
import {
  createModuleProgramRuntime,
  MODULE_FILES_ROOT,
  MODULE_PROGRAM_PORT,
  MODULE_PROGRAM_ROOT,
  ModuleProgramRuntimeError,
} from "./program-runtime";

export interface CreateContainerModuleProgramRuntimeOptions {
  readonly checkouts: ModuleCheckouts;
  readonly containers: Pick<
    Containers,
    "get" | "start" | "restart" | "open" | "remove"
  >;
  readonly fetch?: CreateModuleProgramRuntimeOptions["fetch"];
  readonly healthCheckTimeoutMs?: number;
  readonly store: Pick<
    ModuleCommands,
    "loadGatewayContext" | "setInstallationContainerId"
  >;
  readonly transport: CreateModuleProgramRuntimeOptions["transport"];
}

export function createContainerModuleProgramRuntime(
  options: CreateContainerModuleProgramRuntimeOptions
): ModuleProgramRuntimeAdapter {
  return createModuleProgramRuntime({
    transport: options.transport,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.healthCheckTimeoutMs === undefined
      ? {}
      : { healthCheckTimeoutMs: options.healthCheckTimeoutMs }),
    async acquire(input) {
      const checkout = await options.checkouts.ensure({
        version: input.version,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      const container = await openContainer(options, input, checkout.hostPath);
      try {
        await assertMounted(container);
        return container;
      } catch (error) {
        return rethrowAfterCleanup(
          error,
          () => container.close(),
          "Module mount validation and cleanup failed"
        );
      }
    },
  });
}

async function openContainer(
  options: CreateContainerModuleProgramRuntimeOptions,
  input: Parameters<ModuleProgramRuntimeAdapter["start"]>[0],
  checkoutPath: string
): Promise<Container> {
  const context = await options.store.loadGatewayContext(input.installationId);
  if (context === null) {
    throw new ModuleStoreNotFoundError(input.installationId);
  }
  if (
    context.installation.generation !== input.generation ||
    context.installation.contentId !== input.version.contentId
  ) {
    throw new ModuleStoreConflictError(
      "Installation selection or generation changed"
    );
  }
  const destinations = await approvedNetworkDestinations({
    grants: context.grants,
    manifest: input.version.manifest,
  });
  const spec = moduleRuntimeSpec({
    checkoutPath,
    filesPath: input.files.hostPath,
    installationId: input.installationId,
    network:
      destinations === null
        ? "disabled"
        : {
            destinations: destinations.map((destination) => ({
              ...destination,
            })),
            mode: "allowlist",
          },
    resources: input.launch.resources,
  });
  const existing = context.installation.containerId;
  if (
    existing !== null &&
    (await options.containers.get(existing)) !== undefined
  ) {
    await options.containers.restart(existing, spec, input.signal);
    return options.containers.open(existing, input.signal);
  }
  const container = await options.containers.start(spec, input.signal);
  try {
    await options.store.setInstallationContainerId({
      containerId: container.id,
      expectedGeneration: input.generation,
      installationId: input.installationId,
      now: new Date(),
    });
  } catch (error) {
    return rethrowAfterCleanup(
      error,
      async () => {
        await container.close();
        if ((await options.containers.get(container.id)) !== undefined) {
          await options.containers.remove(container.id);
        }
      },
      "Module container linking and cleanup failed"
    );
  }
  return container;
}

function moduleRuntimeSpec(input: {
  readonly installationId: InstallationId;
  readonly checkoutPath: string;
  readonly filesPath: string;
  readonly network: ContainerSandboxConstraints["network"];
  readonly resources: ModuleProgramResources;
}): ContainerSandboxConstraints {
  return {
    format: "foundry.sandbox.container/1",
    image: "docker.io/oven/bun:1-slim",
    labels: { "com.foundry.installation": input.installationId },
    mounts: [
      {
        access: "read-only",
        id: "program",
        source: input.checkoutPath,
        target: MODULE_PROGRAM_ROOT,
      },
      {
        access: "read-write",
        id: "installation-files",
        source: input.filesPath,
        target: MODULE_FILES_ROOT,
      },
    ],
    network: input.network,
    ports: [MODULE_PROGRAM_PORT],
    publicEnvironment: {
      NODE_ENV: "production",
      PORT: String(MODULE_PROGRAM_PORT),
    },
    resources: {
      cpus: input.resources.cpus,
      memoryBytes: input.resources.memoryBytes,
      pids: 256,
    },
    workdir: MODULE_PROGRAM_ROOT,
  };
}

async function assertMounted(container: Container): Promise<void> {
  const mounts = (await container.volumes?.list()) ?? [];
  for (const [target, access] of [
    [MODULE_PROGRAM_ROOT, "read-only"],
    [MODULE_FILES_ROOT, "read-write"],
  ] as const) {
    if (
      !mounts.some(
        (mount) => mount.target === target && mount.access === access
      )
    ) {
      throw new ModuleProgramRuntimeError(
        "mount-mismatch",
        `Module container has no ${access} mount at ${target}`
      );
    }
  }
}
