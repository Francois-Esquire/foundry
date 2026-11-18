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

export const ARTIFACT_SOURCE = "artifact";

export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_TREE_BYTES = 8 * 1024 * 1024 * 1024;

export const CHUNK_BYTES = 8 * 1024 * 1024;
