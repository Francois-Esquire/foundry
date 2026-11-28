import { byCodeUnit } from "@foundry/lib/ordering";
import { pageLimit } from "@foundry/lib/pagination";

import type { ArtifactId, BlobId, ContentId } from "./ids";
import type { Artifact, ContentState } from "./schema";
import type { BlobPageQuery, ContentPageQuery } from "./store";

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

export function byCodePoint(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.charCodeAt(index);
    const b = right.charCodeAt(index);
    if (a !== b) {
      return codePointRank(a) - codePointRank(b);
    }
  }
  return left.length - right.length;
}

function codePointRank(unit: number): number {
  if (unit >= 0xd8_00 && unit <= 0xdf_ff) {
    return unit + 0x20_00;
  }
  return unit >= 0xe0_00 ? unit - 0x08_00 : unit;
}

export interface NormalizedBlobPageQuery {
  readonly cursor?: BlobId;
  readonly limit: number;
}

export function ownedBlobPageQuery(
  query: BlobPageQuery | undefined
): NormalizedBlobPageQuery {
  const cursor = query?.cursor;
  if (cursor !== undefined && typeof cursor !== "string") {
    throw new RangeError("Page cursor is invalid");
  }
  return {
    ...(cursor === undefined ? {} : { cursor }),
    limit: pageLimit(query?.limit),
  };
}

export interface NormalizedContentPageQuery {
  readonly artifactId?: ArtifactId;
  readonly cursor?: ContentId;
  readonly limit: number;
  readonly states?: readonly ContentState[];
  readonly tagged?: boolean;
}

export function ownedContentPageQuery(
  query: ContentPageQuery | undefined
): NormalizedContentPageQuery {
  const cursor = query?.cursor;
  if (cursor !== undefined && typeof cursor !== "string") {
    throw new RangeError("Page cursor is invalid");
  }
  let states: readonly ContentState[] | undefined;
  if (query?.state !== undefined) {
    states = typeof query.state === "string" ? [query.state] : [...query.state];
  }
  return {
    ...(query?.artifactId === undefined
      ? {}
      : { artifactId: query.artifactId }),
    ...(cursor === undefined ? {} : { cursor }),
    limit: pageLimit(query?.limit),
    ...(states === undefined ? {} : { states }),
    ...(query?.tagged === undefined ? {} : { tagged: query.tagged }),
  };
}
