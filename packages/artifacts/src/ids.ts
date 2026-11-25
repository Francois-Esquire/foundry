import { z } from "zod";

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
