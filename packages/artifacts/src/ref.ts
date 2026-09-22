import { z } from "zod";

/**
 * Branded identifier for an Artifact.
 *
 * Declared here rather than alongside the other domain ids because the Artifact
 * primitive must not depend on the Module domain — the dependency runs the
 * other way. `z.brand` is structural on the brand string, so an `ArtifactId`
 * parsed here and one parsed by a Module-side re-export are the same type.
 */
export const artifactIdSchema = z
  .string()
  .min(1, "ArtifactId must not be empty")
  .brand("ArtifactId");
export type ArtifactId = z.infer<typeof artifactIdSchema>;

export const contentIdSchema = z
  .string()
  .min(1, "ContentId must not be empty")
  .brand("ContentId");
export type ContentId = z.infer<typeof contentIdSchema>;

export const blobIdSchema = z
  .string()
  .min(1, "BlobId must not be empty")
  .brand("BlobId");
export type BlobId = z.infer<typeof blobIdSchema>;
