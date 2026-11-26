import { byCodeUnit } from "@foundry/lib/ordering";

import type { ArtifactId } from "./ids";
import type { Artifact } from "./schema";

export interface ArtifactCursor {
  readonly createdAt: Date;
  readonly id: ArtifactId;
}

export interface ArtifactFilter {
  readonly includeArchived?: boolean;
  readonly text?: string;
  readonly type?: string;
}

export function artifactCursor(record: {
  readonly id: ArtifactId;
  readonly createdAt: Date;
}): ArtifactCursor {
  return Object.freeze({
    createdAt: new Date(record.createdAt),
    id: record.id,
  });
}

export function normalizeArtifactQuery(
  value: string | undefined
): string | undefined {
  const query = value?.trim();
  return query === undefined || query.length === 0 ? undefined : query;
}

export function ownedListQuery<Q extends { readonly limit: number }>(
  query: Q
): Q {
  const { limit } = query;
  if (!(Number.isSafeInteger(limit) && limit > 0)) {
    throw new RangeError(
      `limit must be a positive safe integer; got ${String(limit)}`
    );
  }
  return structuredClone(query);
}

export function matchesArtifactFilter(
  artifact: Artifact,
  filter: ArtifactFilter
): boolean {
  const text = filter.text?.toLowerCase();
  return (
    ((filter.includeArchived ?? false) || artifact.status !== "archived") &&
    (filter.type === undefined || artifact.type === filter.type) &&
    (text === undefined ||
      [artifact.name, artifact.type, artifact.id].some((value) =>
        value.toLowerCase().includes(text)
      ))
  );
}

export function isAfterCursor(
  artifact: Artifact,
  cursor: ArtifactCursor | undefined
): boolean {
  return cursor === undefined || compareCreated(artifact, cursor) > 0;
}

const compareIds = byCodeUnit((value: { id: string }) => value.id);

export function compareCreated(
  a: { readonly createdAt: Date; readonly id: string },
  b: { readonly createdAt: Date; readonly id: string }
): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || compareIds(a, b);
}
