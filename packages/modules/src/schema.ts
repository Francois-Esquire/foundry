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
 * manifests, and Installations with their Grants. Each type is inferred from
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
 * the only copy, and it outranks the embedded one when both exist.
 */
export const retainedManifestSchema = z
  .object({
    contentId: contentIdSchema,
    manifest: moduleManifestSchema,
  })
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

/** One Installation and its Grants, as a store keeps them. */
export const storedInstallationSchema = z
  .object({
    grants: z.array(installationGrantSchema).readonly(),
    installation: installationSchema,
  })
  .readonly();
export type StoredInstallation = z.infer<typeof storedInstallationSchema>;
