import { artifactIdSchema, contentIdSchema } from "@foundry/artifacts";
import { z } from "zod";

import {
  INSTALLATION_STATUSES,
  installationIdSchema,
  moduleIdSchema,
} from "./domain";
import { moduleManifestSchema } from "./manifest";

/**
 * The records a ModuleStore persists and returns: Modules, retained
 * manifests with their owning Module, and Installations with their Grants. Each type is inferred from
 * its schema here, so the schema is the one definition of the persisted
 * shape. Versions are not records; the Content is.
 */

/**
 * Stable control-plane identity with one immutable backing Artifact.
 * ModuleId and ArtifactId name different entities even though the Store
 * enforces a one-to-one relationship between them.
 */
export const moduleSchema = z
  .object({
    artifactId: artifactIdSchema,
    id: moduleIdSchema,
  })
  .readonly();
export type Module = z.infer<typeof moduleSchema>;

/**
 * A manifest the Content cannot supply itself: an output-only import, or a
 * legacy row whose stored manifest differs from its embedded source. It is
 * the only copy, and it outranks the embedded one when both exist. It
 * belongs to the Module that retained it: retaining it again under another
 * Module conflicts, and deleting that Module drops it.
 */
export const storedManifestSchema = z
  .object({
    contentId: contentIdSchema,
    manifest: moduleManifestSchema,
    moduleId: moduleIdSchema,
  })
  .readonly();
export type StoredManifest = z.infer<typeof storedManifestSchema>;

/** A retained manifest as the Store lists it, without its owning Module. */
export const retainedManifestSchema = storedManifestSchema
  .unwrap()
  .omit({ moduleId: true })
  .readonly();
export type RetainedManifest = z.infer<typeof retainedManifestSchema>;

export const installationSchema = z
  .object({
    containerId: z.string().min(1).nullable(),
    contentId: contentIdSchema,
    createdAt: z.date(),
    /** The only concurrency token; a running program is bound to the one it saw. */
    generation: z.number().int().nonnegative(),
    id: installationIdSchema,
    moduleId: moduleIdSchema,
    /** Failed starts since the last `active`; reset by a user enable or a version change. */
    startAttempts: z.number().int().nonnegative(),
    status: z.enum(INSTALLATION_STATUSES),
    updatedAt: z.date(),
  })
  .readonly();
export type Installation = z.infer<typeof installationSchema>;

/** One approved capability of an Installation. Revoke is delete. */
export const installationGrantSchema = z
  .object({
    capability: z.string().min(1),
    constraintsDigest: z.string().min(1),
    createdAt: z.date(),
    version: z.number().int().positive(),
  })
  .readonly();
export type InstallationGrant = z.infer<typeof installationGrantSchema>;

/**
 * Why a set of Grants cannot belong to one Installation, or null when it can:
 * an Installation holds at most one Grant per capability.
 */
export function grantCapabilitiesProblem(
  grants: readonly Pick<InstallationGrant, "capability">[]
): string | null {
  const capabilities = new Set<string>();
  for (const { capability } of grants) {
    if (capabilities.has(capability)) {
      return `Grant capability ${capability} is duplicated`;
    }
    capabilities.add(capability);
  }
  return null;
}

/** One Installation and its Grants, as a store keeps them. */
export const storedInstallationSchema = z
  .object({
    grants: z
      .array(installationGrantSchema)
      .readonly()
      .superRefine((grants, context) => {
        const problem = grantCapabilitiesProblem(grants);
        if (problem !== null) {
          context.addIssue({ code: "custom", message: problem });
        }
      }),
    installation: installationSchema,
  })
  .readonly();
export type StoredInstallation = z.infer<typeof storedInstallationSchema>;
