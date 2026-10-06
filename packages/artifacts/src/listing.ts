import type { ArtifactId } from "./ref";

export interface ArtifactCursor {
  readonly createdAt: Date;
  readonly id: ArtifactId;
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
