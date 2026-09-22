import type { ContainerRowStatus } from "./store";

/**
 * Default base image. Debian slim: a microVM boots its own kernel, and the
 * glibc base is what native addons in the images Studio actually runs expect.
 */
export const DEFAULT_CONTAINER_IMAGE = "docker.io/library/debian:trixie-slim";

/** Working directory created inside the guest and used as the exec `cwd` default. */
export const DEFAULT_CONTAINER_WORKDIR = "/workspace";

/**
 * Broad ownership label every sandbox carries. Predates the scoped labels
 * below; the one-time legacy cleanup selects by it alone.
 */
export const CONTAINER_SANDBOX_BASE_LABEL = "com.foundry.sandbox";

/**
 * Scoped management labels. Together they correlate one native resource to one
 * Registry observation: `managed-by` + `scope-id` select a runtime scope's
 * inventory, and `environment-id` — always the generated native name — is the
 * immutable identity a reconciler validates before acting.
 */
export const CONTAINER_MANAGED_BY_LABEL = "com.foundry.environment.managed-by";

export const CONTAINER_MANAGED_BY_VALUE = "foundry-studio";

export const CONTAINER_RUNTIME_SCOPE_LABEL = "com.foundry.environment.scope-id";

export const CONTAINER_ENVIRONMENT_ID_LABEL = "com.foundry.environment.id";

export const CONTAINER_OWNER_KIND_LABEL = "com.foundry.environment.owner-kind";

export const CONTAINER_OWNER_ID_LABEL = "com.foundry.environment.owner-id";

/**
 * Registry labels. `instance` is the host's data-directory-derived label, so
 * two Studio profiles never sweep each other; `id` is the registry row the VM
 * realizes. Sweep selects by `managed-by` + `instance` only, so VMs the
 * harness starts under the `environment.*` labels are never selected.
 */
export const CONTAINER_INSTANCE_LABEL = "com.foundry.container.instance";

export const CONTAINER_ID_LABEL = "com.foundry.container.id";

/** Guest memory when `resources.memoryBytes` is unset. */
export const DEFAULT_CONTAINER_MEMORY_MIB = 1024;

/** Virtual CPUs when `resources.cpus` is unset. */
export const DEFAULT_CONTAINER_CPUS = 1;

export const CONTAINER_ROW_STATUSES: readonly ContainerRowStatus[] =
  Object.freeze([
    "starting",
    "running",
    "restarting",
    "missing",
    "stopped",
    "failed",
  ]);

export const CONTAINER_SANDBOX_CONSTRAINTS_FORMAT =
  "foundry.sandbox.container/1" as const;

export const INVENTORY_PAGE_LIMIT = 100;

export const MAX_INVENTORY_PAGES = 1000;
