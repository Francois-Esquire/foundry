import type { StorageEntry } from "@foundry/core/storage";
import { isStoragePath } from "@foundry/core/storage";
import { z } from "zod";
import { artifactIdSchema, contentIdSchema } from "./ref";
import type { Artifact, Artifacts, Content } from "./substrate";
import { isGoodContent, rootPath } from "./tree";

export const ArtifactReferenceSchema = z.strictObject({
  artifactId: artifactIdSchema,
  contentId: contentIdSchema.optional(),
  path: z.string().min(1).optional(),
});

export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;

export interface ResolvedReference {
  readonly artifact: Artifact;
  readonly content: Content | null;
  readonly entry: StorageEntry | null;
  /** May name a handler-owned route with no corresponding storage entry. */
  readonly path: string | null;
  readonly status: "available";
}

export type ReferenceResult =
  | ResolvedReference
  | {
      readonly status: "unavailable";
      readonly reason:
        | "artifact-missing"
        | "content-missing"
        | "content-mismatch"
        | "content-unusable"
        | "path-invalid"
        | "entry-missing";
    };

export async function resolveReference(
  artifacts: Pick<Artifacts, "get" | "getContent">,
  reference: ArtifactReference
): Promise<ReferenceResult> {
  const resolved = await artifacts.get(reference.artifactId);
  if (!resolved) {
    return { reason: "artifact-missing", status: "unavailable" };
  }
  const { content: current, ...artifact } = resolved;
  let content: Content | null = isGoodContent(current) ? current : null;
  if (reference.contentId !== undefined) {
    content = await artifacts.getContent(reference.contentId);
    if (!content) {
      return { reason: "content-missing", status: "unavailable" };
    }
    if (content.artifactId !== artifact.id) {
      return { reason: "content-mismatch", status: "unavailable" };
    }
    if (!isGoodContent(content)) {
      return { reason: "content-unusable", status: "unavailable" };
    }
  }

  const path = reference.path ?? (content ? rootPath(content) : null);
  if (path !== null && !isStoragePath(path)) {
    return { reason: "path-invalid", status: "unavailable" };
  }
  const node =
    path !== null && content && Object.hasOwn(content.tree, path)
      ? content.tree[path]
      : undefined;
  if (
    reference.path === undefined &&
    content?.metadata.entry !== undefined &&
    node?.type !== "file"
  ) {
    return { reason: "entry-missing", status: "unavailable" };
  }
  return {
    artifact,
    content,
    entry: node && path !== null ? { ...node, path } : null,
    path,
    status: "available",
  };
}
