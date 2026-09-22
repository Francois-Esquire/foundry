import type { StorageTree } from "@foundry/core/storage";

import { validateStorageTree } from "@foundry/core/storage";
import { sha256Hex } from "@foundry/lib/digest";
import { canonicalizeJson } from "@foundry/lib/json";
import { byCodeUnit } from "@foundry/lib/ordering";

import type { ARTIFACT_STATUSES, CONTENT_STATES } from "./constants";

export type ArtifactLifecycleStatus = (typeof ARTIFACT_STATUSES)[number];
export type ContentState = (typeof CONTENT_STATES)[number];

export function isGoodContent<T extends { readonly state: ContentState }>(
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

export function filePointers(metadata: ContentMetadata): readonly string[] {
  return [
    ...(metadata.entry === undefined ? [] : [metadata.entry]),
    ...Object.values(metadata.entries ?? {}),
    ...(metadata.thumbnail === undefined ? [] : [metadata.thumbnail]),
  ];
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
