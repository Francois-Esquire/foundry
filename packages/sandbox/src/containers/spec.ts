import {
  DESTINATION_PORTS_MAX,
  DNS_HOST_NAME_MAX_LENGTH,
  DNS_HOST_NAME_PATTERN,
  PORT_MAX,
  PORT_MIN,
} from "@foundry/lib/network";
import { z } from "zod";
import { SandboxError } from "../errors";
import {
  CONTAINER_ENVIRONMENT_ID_LABEL,
  CONTAINER_PORTABLE_ID_PATTERN,
  CONTAINER_SANDBOX_BASE_LABEL,
  DEFAULT_CONTAINER_CPUS,
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_CONTAINER_MEMORY_MIB,
  DEFAULT_CONTAINER_WORKDIR,
} from "./defaults";
import type {
  ContainerDefaults,
  ContainerMount,
  ContainerSpec,
  DriverCapabilities,
} from "./driver";

const MAX_TCP_PORT = 65_535;
const TRAILING_SLASHES = /\/+$/;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[/\\]/;

const publicEnvironmentName =
  /^(?:NODE_ENV|TZ|LANG|LC_ALL|NO_COLOR|FORCE_COLOR|PORT|FOUNDRY_PUBLIC_[A-Z0-9_]+)$/;

export function isTcpPort(port: number): boolean {
  return Number.isSafeInteger(port) && port >= 1 && port <= MAX_TCP_PORT;
}

export function assertGuestPorts(guestPorts: readonly number[]): void {
  const seen = new Set<number>();
  for (const port of guestPorts) {
    if (!isTcpPort(port)) {
      throw new SandboxError(
        "invalid-contract",
        "guest ports must be integers from 1 through 65535",
        { details: { port } }
      );
    }
    if (seen.has(port)) {
      throw new SandboxError("invalid-contract", "guest ports must be unique", {
        details: { port },
      });
    }
    seen.add(port);
  }
}

export function isAbsoluteGuestPath(path: string): boolean {
  if (path.includes("\0")) {
    return false;
  }
  if (path.startsWith("/")) {
    return (
      !path.includes("//") &&
      path.split("/").every((segment) => segment !== "." && segment !== "..")
    );
  }
  if (WINDOWS_DRIVE_PATH.test(path)) {
    const normalized = path.slice(2).replaceAll("\\", "/");
    return (
      !normalized.includes("//") &&
      normalized
        .split("/")
        .every((segment) => segment !== "." && segment !== "..")
    );
  }
  return false;
}

const publicEnvironmentSchema = z
  .record(z.string().regex(publicEnvironmentName), z.string().max(4096))
  .superRefine((environment, context) => {
    if (Object.keys(environment).length > 64) {
      context.addIssue({
        code: "custom",
        message: "public environment may contain at most 64 entries",
      });
    }
  });

const mountSourceSchema = z.union([
  z
    .object({
      kind: z.literal("host-directory"),
      path: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      kind: z.literal("volume"),
      name: z.string().min(1).max(256),
    })
    .strict(),
]);

const mountSchema = z
  .object({
    access: z.enum(["read-only", "read-write"]),
    executable: z.boolean().optional(),
    id: z.string().regex(CONTAINER_PORTABLE_ID_PATTERN),
    source: mountSourceSchema,
    target: z
      .string()
      .refine(isAbsoluteGuestPath, "must be an absolute normalized path"),
  })
  .strict();

const allowlistSchema = z
  .object({
    destinations: z
      .array(
        z
          .object({
            host: z
              .string()
              .toLowerCase()
              .regex(DNS_HOST_NAME_PATTERN)
              .max(DNS_HOST_NAME_MAX_LENGTH),
            ports: z
              .array(z.number().int().min(PORT_MIN).max(PORT_MAX))
              .min(1)
              .max(DESTINATION_PORTS_MAX)
              .optional(),
          })
          .strict()
      )
      .max(64),
    mode: z.literal("allowlist"),
  })
  .strict();

const exposePortSchema = z
  .object({
    access: z.enum(["loopback", "private", "public"]).optional(),
    port: z.number().int().min(1).max(MAX_TCP_PORT),
    protocol: z.enum(["http", "https", "tcp", "ws", "wss"]).optional(),
  })
  .strict();

const secretBindingSchema = z
  .object({
    hosts: z
      .array(
        z
          .string()
          .toLowerCase()
          .regex(DNS_HOST_NAME_PATTERN)
          .max(DNS_HOST_NAME_MAX_LENGTH)
      )
      .min(1)
      .max(16),
    name: z.string().min(1).max(128),
    target: z.enum(["header", "env"]).optional(),
  })
  .strict();

const lifetimeSchema = z
  .object({
    idleTimeoutMs: z.number().int().positive().optional(),
    ttlMs: z.number().int().positive().optional(),
    whenReleased: z.enum(["stop", "keep"]).optional(),
  })
  .strict();

export const containerSpecSchema = z
  .object({
    expose: z.array(exposePortSchema).max(32).optional(),
    image: z.string().min(1).max(1024).optional(),
    labels: z
      .record(
        z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/i),
        z.string().max(1024)
      )
      .optional(),
    lifetime: lifetimeSchema.optional(),
    mounts: z.array(mountSchema).max(8).optional(),
    network: z
      .union([z.enum(["none", "internet", "open"]), allowlistSchema])
      .optional(),
    publicEnvironment: publicEnvironmentSchema.optional(),
    resources: z
      .object({
        cpus: z.number().positive().max(64).optional(),
        memoryBytes: z.number().int().positive().optional(),
        pids: z.number().int().positive().max(65_536).optional(),
      })
      .strict()
      .optional(),
    secrets: z.array(secretBindingSchema).max(32).optional(),
    workdir: z
      .string()
      .refine(isAbsoluteGuestPath, "must be an absolute normalized path")
      .optional(),
  })
  .strict()
  .superRefine((spec, context) => {
    const exposePorts = (spec.expose ?? []).map((entry) => entry.port);
    if (new Set(exposePorts).size !== exposePorts.length) {
      context.addIssue({
        code: "custom",
        message: "exposed ports must be unique",
      });
    }
    const mounts = spec.mounts ?? [];
    if (new Set(mounts.map((mount) => mount.id)).size !== mounts.length) {
      context.addIssue({
        code: "custom",
        message: "mount ids must be unique",
      });
    }
    if (new Set(mounts.map((mount) => mount.target)).size !== mounts.length) {
      context.addIssue({
        code: "custom",
        message: "mount targets must be unique",
      });
    }
  });

export type ContainerSpecInput = z.input<typeof containerSpecSchema>;
export type ContainerMountInput = NonNullable<
  ContainerSpecInput["mounts"]
>[number];

export function parseContainerSpecInput(input: unknown): ContainerSpecInput {
  const result = containerSpecSchema.safeParse(input);
  if (!result.success) {
    throw new SandboxError(
      "invalid-contract",
      `invalid container spec: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`)
        .join("; ")}`
    );
  }
  return Object.freeze(result.data);
}

export function resolveContainerSpec(options: {
  readonly defaults?: ContainerDefaults;
  readonly input: ContainerSpecInput;
  readonly labels: Readonly<Record<string, string>>;
  readonly mountTargetRoot?: string;
  readonly name: string;
}): ContainerSpec {
  const { defaults = {}, input, mountTargetRoot, name } = options;
  const expose = (input.expose ?? defaults.expose ?? []).map((entry) =>
    Object.freeze({ ...entry })
  );
  assertGuestPorts(expose.map((entry) => entry.port));

  const mounts = resolvePortableMounts(input.mounts ?? [], mountTargetRoot);
  const cpus = input.resources?.cpus ?? defaults.resources?.cpus;
  const memoryBytes =
    input.resources?.memoryBytes ?? defaults.resources?.memoryBytes;
  const pidsLimit = input.resources?.pids ?? defaults.resources?.pids;
  const network = input.network ?? defaults.network ?? "none";
  const lifetime = mergeLifetime(defaults.lifetime, input.lifetime);

  return Object.freeze({
    cpus:
      cpus === undefined
        ? DEFAULT_CONTAINER_CPUS
        : Math.max(1, Math.ceil(cpus)),
    env: Object.freeze({ ...defaults.env, ...input.publicEnvironment }),
    expose: Object.freeze(expose),
    image: input.image ?? defaults.image ?? DEFAULT_CONTAINER_IMAGE,
    labels: Object.freeze({
      [CONTAINER_SANDBOX_BASE_LABEL]: "1",
      ...defaults.labels,
      ...input.labels,
      ...options.labels,
      [CONTAINER_ENVIRONMENT_ID_LABEL]: name,
    }),
    ...(lifetime === undefined ? {} : { lifetime }),
    memoryMib:
      memoryBytes === undefined
        ? DEFAULT_CONTAINER_MEMORY_MIB
        : Math.max(1, Math.ceil(memoryBytes / (1024 * 1024))),
    mounts,
    name,
    network,
    ...(pidsLimit === undefined ? {} : { pidsLimit }),
    pull: defaults.pull ?? "missing",
    secrets: Object.freeze((input.secrets ?? []).map((s) => Object.freeze(s))),
    workdir: input.workdir ?? defaults.workdir ?? DEFAULT_CONTAINER_WORKDIR,
  });
}

export function assertDriverSupports(
  spec: ContainerSpec,
  capabilities: DriverCapabilities | undefined
): void {
  const caps: DriverCapabilities = capabilities ?? {};
  assertNetworkSupported(spec, caps);
  assertMountsSupported(spec, caps);
  assertEndpointsSupported(spec, caps);
  assertLifetimeAndSecretsSupported(spec, caps);
}

function assertNetworkSupported(
  spec: ContainerSpec,
  capabilities: DriverCapabilities
): void {
  const tier = typeof spec.network === "string" ? spec.network : "allowlist";
  const supported = capabilities.network ?? [];
  if (!supported.includes(tier)) {
    throw new SandboxError(
      "unsupported",
      `driver does not support network policy "${tier}"`
    );
  }
}

function assertMountsSupported(
  spec: ContainerSpec,
  capabilities: DriverCapabilities
): void {
  const supported = capabilities.mounts ?? [];
  for (const mount of spec.mounts) {
    if (!supported.includes(mount.source.kind)) {
      throw new SandboxError(
        "unsupported",
        `driver does not support "${mount.source.kind}" mounts (mount "${mount.id}")`
      );
    }
  }
}

function assertEndpointsSupported(
  spec: ContainerSpec,
  capabilities: DriverCapabilities
): void {
  const supported = capabilities.endpoints ?? [];
  for (const entry of spec.expose) {
    if (entry.access !== undefined) {
      if (!supported.includes(entry.access)) {
        throw new SandboxError(
          "unsupported",
          `driver does not support "${entry.access}" endpoint exposure for port ${String(entry.port)}`
        );
      }
    } else if (supported.length === 0) {
      throw new SandboxError(
        "unsupported",
        `driver does not support endpoint exposure for port ${String(entry.port)}`
      );
    }
  }
}

function assertLifetimeAndSecretsSupported(
  spec: ContainerSpec,
  capabilities: DriverCapabilities
): void {
  if (spec.secrets.length > 0 && capabilities.secrets !== true) {
    throw new SandboxError(
      "unsupported",
      "driver does not support secret bindings"
    );
  }
  if (
    spec.lifetime?.ttlMs !== undefined &&
    capabilities.lifetime?.ttl !== true
  ) {
    throw new SandboxError(
      "unsupported",
      "driver does not support container TTL enforcement"
    );
  }
  if (
    spec.lifetime?.idleTimeoutMs !== undefined &&
    capabilities.lifetime?.idle !== true
  ) {
    throw new SandboxError(
      "unsupported",
      "driver does not support container idle timeout enforcement"
    );
  }
}

function mergeLifetime(
  base: ContainerSpec["lifetime"],
  override: ContainerSpec["lifetime"]
): ContainerSpec["lifetime"] {
  const merged = { ...base, ...override };
  return Object.keys(merged).length === 0 ? undefined : Object.freeze(merged);
}

function isWithinGuestRoot(target: string, root: string): boolean {
  const normTarget =
    target.replaceAll("\\", "/").replace(TRAILING_SLASHES, "") || "/";
  const normRoot =
    root.replaceAll("\\", "/").replace(TRAILING_SLASHES, "") || "/";
  if (normRoot === "/") {
    return normTarget.startsWith("/");
  }
  return normTarget === normRoot || normTarget.startsWith(`${normRoot}/`);
}

function resolvePortableMounts(
  mounts: readonly ContainerMountInput[],
  targetRoot: string | undefined
): readonly ContainerMount[] {
  if (mounts.length === 0) {
    return Object.freeze([]);
  }
  const resolved: ContainerMount[] = [];
  for (const mount of mounts) {
    if (
      targetRoot !== undefined &&
      !isWithinGuestRoot(mount.target, targetRoot)
    ) {
      throw new SandboxError(
        "invalid-contract",
        `sandbox mount "${mount.id}" target must be ${targetRoot} or a child of it`
      );
    }
    resolved.push(
      Object.freeze({
        access: mount.access,
        ...(mount.executable === undefined
          ? {}
          : { executable: mount.executable }),
        id: mount.id,
        source: Object.freeze({ ...mount.source }),
        target: mount.target,
      })
    );
  }
  return Object.freeze(resolved);
}
