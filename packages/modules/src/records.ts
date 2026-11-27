import { artifactIdSchema, contentIdSchema } from "@foundry/artifacts";
import { z } from "zod";

import {
  INSTALLATION_STATUSES,
  installationIdSchema,
  moduleIdSchema,
} from "./domain";
import { moduleManifestSchema } from "./manifest";

export const moduleSchema = z
  .object({
    artifactId: artifactIdSchema,
    id: moduleIdSchema,
  })
  .readonly();
export type Module = z.infer<typeof moduleSchema>;

export const storedManifestSchema = z
  .object({
    contentId: contentIdSchema,
    manifest: moduleManifestSchema,
    moduleId: moduleIdSchema,
  })
  .readonly();
export type StoredManifest = z.infer<typeof storedManifestSchema>;

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
    generation: z.number().int().nonnegative(),
    id: installationIdSchema,
    moduleId: moduleIdSchema,
    startAttempts: z.number().int().nonnegative(),
    status: z.enum(INSTALLATION_STATUSES),
    updatedAt: z.date(),
  })
  .readonly();
export type Installation = z.infer<typeof installationSchema>;

export const installationGrantSchema = z
  .object({
    capability: z.string().min(1),
    constraintsDigest: z.string().min(1),
    createdAt: z.date(),
    version: z.number().int().positive(),
  })
  .readonly();
export type InstallationGrant = z.infer<typeof installationGrantSchema>;

export const storedInstallationSchema = z
  .object({
    installation: installationSchema,
  })
  .readonly();
export type StoredInstallation = z.infer<typeof storedInstallationSchema>;
