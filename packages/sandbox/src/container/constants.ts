import { DEFAULT_SANDBOX_WORKING_DIRECTORY } from "../constants";
import type { ContainerResourceStatus } from "./types";

export const DEFAULT_CONTAINER_IMAGE = "docker.io/library/debian:trixie-slim";

export const DEFAULT_CONTAINER_WORKDIR = DEFAULT_SANDBOX_WORKING_DIRECTORY;

export const CONTAINER_SANDBOX_BASE_LABEL = "com.foundry.sandbox";

export const CONTAINER_MANAGED_BY_LABEL = "com.foundry.environment.managed-by";

export const CONTAINER_MANAGED_BY_VALUE = "foundry-sandbox";

export const CONTAINER_RUNTIME_SCOPE_LABEL = "com.foundry.environment.scope-id";

export const CONTAINER_ENVIRONMENT_ID_LABEL = "com.foundry.environment.id";

export const CONTAINER_OWNER_KIND_LABEL = "com.foundry.environment.owner-kind";

export const CONTAINER_OWNER_ID_LABEL = "com.foundry.environment.owner-id";

export const CONTAINER_INSTANCE_LABEL = "com.foundry.container.instance";

export const CONTAINER_ID_LABEL = "com.foundry.container.id";
export const CONTAINER_STORE_LABEL = "com.foundry.container.store";

export const DEFAULT_CONTAINER_MEMORY_MIB = 1024;

export const DEFAULT_CONTAINER_CPUS = 1;

export const CONTAINER_ROW_STATUSES = Object.freeze([
  "starting",
  "running",
  "restarting",
  "missing",
  "stopped",
  "failed",
  "removing",
] as const);

export const ACTIVE_CONTAINER_RESOURCE_STATUSES: ReadonlySet<ContainerResourceStatus> =
  new Set(["starting", "running", "paused", "draining"]);

export const CONTAINER_PORTABLE_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export const CONTAINER_SANDBOX_CONSTRAINTS_FORMAT =
  "foundry.sandbox.container/1" as const;

export const INVENTORY_PAGE_LIMIT = 100;

export const MAX_INVENTORY_PAGES = 1000;

export function removeByHand(name: string): string {
  return `\`msb rm -f ${name}\` (msb is node_modules/.bin/msb, in the Foundry install)`;
}
