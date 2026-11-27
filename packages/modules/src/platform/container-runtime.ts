import type { Authorization, Permit } from "@foundry/authorization";
import type {
  Container,
  ContainerSandboxConstraints,
  Containers,
} from "@foundry/sandbox";

import type { InstallationId } from "../domain";
import { ModuleStoreConflictError, ModuleStoreNotFoundError } from "../errors";
import { moduleCapabilityAccessRequest, networkAccessRequest } from "../grants";
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
  readonly authorization?: Authorization;
  readonly checkouts: ModuleCheckouts;
  readonly containers: Pick<
    Containers,
    "get" | "start" | "restart" | "open" | "remove"
  > &
    Partial<Pick<Containers, "stop">>;
  readonly fetch?: CreateModuleProgramRuntimeOptions["fetch"];
  readonly healthCheckTimeoutMs?: number;
  readonly store: Pick<
    ModuleCommands,
    "authorization" | "loadGatewayContext" | "setInstallationContainerId"
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
  const authorization = options.authorization ?? options.store.authorization;
  const network = await networkAccessRequest(input.version.manifest);
  let networkPermit: Permit | undefined;
  let destinations: NonNullable<typeof network>["destinations"] | null = null;
  if (network !== null) {
    const outcome = await authorization.authorize(
      moduleCapabilityAccessRequest({
        capability: network.capability,
        constraintsDigest: network.constraintsDigest,
        installationId: input.installationId,
        version: network.version,
      }),
      `network:${input.installationId}:${input.generation}:${crypto.randomUUID()}`,
      {
        openPending: false,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }
    );
    if (outcome.kind === "permitted") {
      networkPermit = outcome.permit;
      ({ destinations } = network);
    }
  }
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
  let container: Container;
  try {
    const existing = context.installation.containerId;
    if (
      existing !== null &&
      (await options.containers.get(existing)) !== undefined
    ) {
      await options.containers.restart(existing, spec, input.signal);
      container = await options.containers.open(existing, input.signal);
    } else {
      container = await options.containers.start(spec, input.signal);
      try {
        await options.store.setInstallationContainerId({
          containerId: container.id,
          expectedGeneration: input.generation,
          installationId: input.installationId,
          now: new Date(),
        });
      } catch (error) {
        return await rethrowAfterCleanup(
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
    }
  } catch (error) {
    networkPermit?.release();
    throw error;
  }
  if (networkPermit === undefined) {
    return container;
  }
  return bindNetworkPermit(container, networkPermit, options.containers);
}

function bindNetworkPermit(
  container: Container,
  permit: Permit,
  containers: CreateContainerModuleProgramRuntimeOptions["containers"]
): Container {
  let closed = false;
  const cutEgress = () => {
    if (closed) {
      return;
    }
    closed = true;
    permit.release();
    container.close().catch(() => undefined);
    containers.stop?.(container.id).catch(() => undefined);
  };
  if (permit.signal.aborted) {
    cutEgress();
  } else {
    permit.signal.addEventListener("abort", cutEgress, { once: true });
  }
  return new Proxy(container, {
    get(target, property, receiver) {
      if (property === "close") {
        return async () => {
          closed = true;
          permit.signal.removeEventListener("abort", cutEgress);
          permit.release();
          await target.close();
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
