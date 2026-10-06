import type { StorageTree } from "@foundry/core/storage";

import { validateStorageTree } from "@foundry/core/storage";
import { sha256Hex } from "@foundry/lib/digest";
import { canonicalizeJson } from "@foundry/lib/json";
import { byCodeUnit } from "@foundry/lib/ordering";

import type { ARTIFACT_STATUSES, CONTENT_STATES } from "./constants";
import { FilePointerError } from "./errors";

export type ArtifactLifecycleStatus = (typeof ARTIFACT_STATUSES)[number];
export type ContentState = (typeof CONTENT_STATES)[number];

/** Ready or frozen Content: the states whose files consumers may read. */
export function isUsableContent<T extends { readonly state: ContentState }>(
  content: T | null | undefined
): content is T & { readonly state: "ready" | "frozen" } {
  return content?.state === "ready" || content?.state === "frozen";
}

export interface ContentMetadata {
  readonly entries?: Readonly<Record<string, string>>;
  readonly entry?: string;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly from?: string;
  readonly messageId?: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly thumbnail?: string;
  readonly [key: string]: unknown;
}

export interface ArtifactMetadata {
  readonly sessionId?: string;
  readonly [key: string]: unknown;
}

/** Describe how one Content was produced. A revision or fork starts without them. */
export const PROVENANCE_METADATA_KEYS = [
  "failure",
  "generation",
  "messageId",
  "runId",
  "sessionId",
] as const;

/** Annotations that remain editable after Content freezes. */
export const ANNOTATION_METADATA_KEYS = ["label", "pinned"] as const;

/** Shallow merge; `undefined` patch values delete keys. */
export function mergeMetadata(
  base: ContentMetadata,
  patch?: Readonly<Record<string, unknown>>
): ContentMetadata {
  return Object.fromEntries(
    Object.entries({ ...base, ...patch }).filter(
      ([, value]) => value !== undefined
    )
  );
}

/** Metadata a successor inherits from `source`: everything but provenance. */
export function successorMetadata(source: {
  readonly id: string;
  readonly metadata: ContentMetadata;
}): ContentMetadata {
  return {
    ...omit(source.metadata, PROVENANCE_METADATA_KEYS),
    from: source.id,
  };
}

/** Whether frozen Content would change beyond its annotations. */
export function semanticMetadataChanged(
  before: ContentMetadata,
  after: ContentMetadata
): boolean {
  return (
    canonicalizeJson(omit(before, ANNOTATION_METADATA_KEYS)) !==
    canonicalizeJson(omit(after, ANNOTATION_METADATA_KEYS))
  );
}

/** Throws unless the metadata is canonical JSON. */
export function assertJsonMetadata(metadata: Readonly<object>): void {
  canonicalizeJson(metadata);
}

/** Every metadata key that names a file, with the path it names. */
export function pointerEntries(
  metadata: ContentMetadata
): readonly (readonly [key: string, path: string])[] {
  return [
    ...(metadata.entry === undefined
      ? []
      : [["entry", metadata.entry] as const]),
    ...Object.entries(metadata.entries ?? {}).map(
      ([name, path]) => [`entries.${name}`, path] as const
    ),
    ...(metadata.thumbnail === undefined
      ? []
      : [["thumbnail", metadata.thumbnail] as const]),
  ];
}

export function filePointers(metadata: ContentMetadata): readonly string[] {
  return pointerEntries(metadata).map(([, path]) => path);
}

/** Throws unless the metadata is JSON and every file pointer names a file. */
export function validatePointers(
  metadata: ContentMetadata,
  tree: StorageTree
): void {
  assertJsonMetadata(metadata);
  for (const [key, path] of pointerEntries(metadata)) {
    if (!Object.hasOwn(tree, path) || tree[path]?.type !== "file") {
      throw new FilePointerError(key, path);
    }
  }
}

/** `metadata.entry`, else the only file, else `index.html`, else null. */
export function rootPath(content: {
  readonly tree: StorageTree;
  readonly metadata: ContentMetadata;
}): string | null {
  if (content.metadata.entry !== undefined) {
    return content.metadata.entry;
  }
  const files = Object.entries(content.tree).filter(
    ([, node]) => node.type === "file"
  );
  if (files.length === 1) {
    return files[0]?.[0] ?? null;
  }
  // biome-ignore lint/suspicious/noUnnecessaryConditions: Record keys may be absent at runtime.
  return content.tree["index.html"]?.type === "file" ? "index.html" : null;
}

export async function digestTree(tree: StorageTree): Promise<string> {
  validateStorageTree(tree);
  const parents = new Set<string>();
  for (const path of Object.keys(tree)) {
    const slash = path.lastIndexOf("/");
    if (slash !== -1) {
      parents.add(path.slice(0, slash));
    }
  }
  // Nonempty directories are implied by paths. Preserve existing file-tree digests.
  const pairs = Object.entries(tree)
    .filter(([path, entry]) => entry.type !== "directory" || !parents.has(path))
    .sort(byCodeUnit(([path]) => path))
    .map(([path, entry]) => [
      path,
      entry.type === "file" ? entry.digest : entry,
    ]);
  return sha256Hex(canonicalizeJson(pairs));
}

function omit(
  metadata: ContentMetadata,
  keys: readonly string[]
): ContentMetadata {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !keys.includes(key))
  );
}
