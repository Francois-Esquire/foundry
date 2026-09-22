export const ARTIFACT_STATUSES = ["draft", "published", "archived"] as const;

export const CONTENT_STATES = [
  "generating",
  "ready",
  "failed",
  "frozen",
] as const;

export const ARTIFACT_BASES = [
  "html",
  "image",
  "video",
  "audio",
  "text",
  "structured",
] as const;

/** The stored `source` value an Artifact Workspace carries. */
export const ARTIFACT_SOURCE = "artifact";

export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_TREE_BYTES = 8 * 1024 * 1024 * 1024;

/** Stored chunk boundaries; changing this requires migrating existing manifests. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
