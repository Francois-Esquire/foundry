import {
  CONTAINER_ENVIRONMENT_ID_LABEL,
  CONTAINER_SANDBOX_BASE_LABEL,
  DEFAULT_CONTAINER_CPUS,
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_CONTAINER_MEMORY_MIB,
  DEFAULT_CONTAINER_WORKDIR,
} from "./defaults";
import { assertGuestPorts, reserveHostPorts } from "./ports";
import type {
  ContainerConfig,
  ContainerMountSpec,
  ContainerSpec,
} from "./runtime";

export async function resolveContainerSpec(
  config: ContainerConfig,
  mounts: readonly ContainerMountSpec[] = []
): Promise<ContainerSpec> {
  const guestPorts = config.ports ?? [];
  assertGuestPorts(guestPorts);
  const ports = await reserveHostPorts(guestPorts);
  const memoryBytes = config.resources?.memoryBytes;
  const cpus = config.resources?.cpus;
  const name = config.name ?? `foundry-${crypto.randomUUID()}`;
  return {
    cpus:
      cpus === undefined
        ? DEFAULT_CONTAINER_CPUS
        : Math.max(1, Math.ceil(cpus)),
    detached: config.detached ?? false,
    disableNetwork:
      config.network === undefined
        ? (config.disableNetwork ?? true)
        : config.network !== "unrestricted",
    ...(config.network === undefined ? {} : { network: config.network }),
    env: config.env ?? {},
    image: config.image ?? DEFAULT_CONTAINER_IMAGE,
    labels: {
      [CONTAINER_SANDBOX_BASE_LABEL]: "1",
      ...config.labels,
      [CONTAINER_ENVIRONMENT_ID_LABEL]: name,
    },
    memoryMib:
      memoryBytes === undefined
        ? DEFAULT_CONTAINER_MEMORY_MIB
        : Math.max(1, Math.ceil(memoryBytes / (1024 * 1024))),
    name,
    ports,
    pull: config.pull ?? "missing",
    workdir: config.workdir ?? DEFAULT_CONTAINER_WORKDIR,
    ...(config.resources?.pids === undefined
      ? {}
      : { pidsLimit: config.resources.pids }),
    mounts: Object.freeze([...mounts]),
  };
}
