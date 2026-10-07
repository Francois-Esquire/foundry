import { z } from "zod";
import {
  CONTAINER_PORTABLE_ID_PATTERN,
  CONTAINER_SANDBOX_CONSTRAINTS_FORMAT,
} from "./constants";
import type { ContainerConfig } from "./types";

const publicEnvironmentName =
  /^(?:NODE_ENV|TZ|LANG|LC_ALL|NO_COLOR|FORCE_COLOR|PORT|FOUNDRY_PUBLIC_[A-Z0-9_]+)$/;
function isAbsoluteGuestPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.includes("//") &&
    !path.includes("\0") &&
    path.split("/").every((segment) => segment !== "." && segment !== "..")
  );
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

const mountSchema = z
  .object({
    access: z.enum(["read-only", "read-write"]),
    executable: z.boolean().optional(),
    id: z.string().regex(CONTAINER_PORTABLE_ID_PATTERN),
    source: z.string().min(1).max(4096),
    // Which guest root a target may fall under is the provider's
    // `mountTargetRoot` option, checked at mount resolution, not here.
    target: z
      .string()
      .refine(isAbsoluteGuestPath, "must be an absolute normalized path"),
  })
  .strict();

export const containerSandboxConstraintsSchema = z
  .object({
    // Opt-in: a detached VM outlives the process. Default attached.
    detached: z.boolean().optional(),
    format: z.literal(CONTAINER_SANDBOX_CONSTRAINTS_FORMAT),
    image: z.string().min(1).max(1024).optional(),
    labels: z
      .record(
        z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/i),
        z.string().max(1024)
      )
      .optional(),
    mounts: z.array(mountSchema).max(8).optional(),
    // This controls guest egress only; it never disables trusted host ingress.
    network: z
      .union([
        z.enum(["disabled", "unrestricted"]),
        z
          .object({
            destinations: z
              .array(
                z
                  .object({
                    host: z
                      .string()
                      .toLowerCase()
                      .regex(
                        /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
                      )
                      .max(253),
                    ports: z
                      .array(z.number().int().min(1).max(65_535))
                      .min(1)
                      .max(32)
                      .optional(),
                  })
                  .strict()
              )
              .max(64),
            mode: z.literal("allowlist"),
          })
          .strict(),
      ])
      .optional(),
    // Profiles may name guest listener ports, but never a host interface or
    // host port. The adapter assigns an ephemeral loopback mapping per lease.
    ports: z.array(z.number().int().min(1).max(65_535)).max(32).optional(),
    publicEnvironment: publicEnvironmentSchema.optional(),
    resources: z
      .object({
        cpus: z.number().positive().max(64).optional(),
        memoryBytes: z.number().int().positive().optional(),
        pids: z.number().int().positive().max(65_536).optional(),
      })
      .strict()
      .optional(),
    workdir: z
      .string()
      .refine(isAbsoluteGuestPath, "must be an absolute normalized path")
      .optional(),
  })
  .strict()
  .superRefine((constraints, context) => {
    const ports = constraints.ports ?? [];
    if (new Set(ports).size !== ports.length) {
      context.addIssue({ code: "custom", message: "ports must be unique" });
    }
    const mounts = constraints.mounts ?? [];
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

export type ContainerSandboxConstraints = z.output<
  typeof containerSandboxConstraintsSchema
>;
export type ContainerSandboxMount = NonNullable<
  ContainerSandboxConstraints["mounts"]
>[number];

/**
 * The container config approved constraints describe, over the registry's
 * own defaults: a field the constraints set wins, `env` and `labels` merge
 * key by key, and anything the constraints leave out — pull policy, network,
 * resource fields — falls back to `defaults`.
 */
export function containerSandboxConfigFromConstraints(
  constraints: ContainerSandboxConstraints | undefined,
  defaults: ContainerConfig = {}
): ContainerConfig {
  if (constraints === undefined) {
    return defaults;
  }
  const { network, resources } = constraints;
  return Object.freeze({
    ...defaults,
    ...defined({
      detached: constraints.detached,
      env: merged(defaults.env, constraints.publicEnvironment),
      image: constraints.image,
      labels: merged(defaults.labels, constraints.labels),
      ports: constraints.ports && [...constraints.ports],
      resources: resources && { ...defaults.resources, ...defined(resources) },
      workdir: constraints.workdir,
    }),
    ...(network === undefined
      ? {}
      : { disableNetwork: network !== "unrestricted", network }),
  });
}

function merged(
  base: Readonly<Record<string, string>> | undefined,
  overrides: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined {
  return base === undefined && overrides === undefined
    ? undefined
    : { ...base, ...overrides };
}

/** Only the fields that are set, so spreading never clears a default. */
function defined<T extends object>(
  fields: T
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}
