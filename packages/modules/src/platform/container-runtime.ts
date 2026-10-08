import type { ContainerSandboxConstraints } from "@foundry/sandbox/container/constraints";
import type {
  Container,
  Containers,
} from "@foundry/sandbox/container/containers";

import type { InstallationId } from "../domain";
import type { ModuleStore } from "../store/contract";
import {
  ModuleStoreConflictError,
  ModuleStoreNotFoundError,
} from "../store/contract";
import type { ModuleProgramRuntimeAdapter } from "./contracts";
import { rethrowAfterCleanup } from "./contracts";
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
    "list" | "start" | "restart" | "open" | "remove"
  >;
  readonly fetch?: CreateModuleProgramRuntimeOptions["fetch"];
  readonly healthCheckTimeoutMs?: number;
  readonly store: Pick<
    ModuleStore,
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
  const spec = moduleRuntimeSpec({
    checkoutPath,
    filesPath: input.files.hostPath,
    installationId: input.installationId,
  });
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
  const existing = context.installation.containerId;
  // Reuse the linked row when it still exists; a deleted row gets a fresh
  // container. Errors from an existing row's restart or open propagate.
  if (
    existing !== null &&
    (await options.containers.list()).some((row) => row.id === existing)
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
        await options.containers.remove(container.id);
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
    network: "disabled",
    ports: [MODULE_PROGRAM_PORT],
    publicEnvironment: {
      NODE_ENV: "production",
      PORT: String(MODULE_PROGRAM_PORT),
    },
    resources: { cpus: 1, memoryBytes: 512 * 1024 * 1024, pids: 256 },
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
