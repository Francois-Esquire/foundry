import { accessSync, constants } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { type FeedPayload, type FeedPost, feedPayload } from "~/lib/feed/entry";

export function resolveFeedMedia(path: string, root: string): string {
  const resolved = isAbsolute(path) ? path : resolve(root, path);
  try {
    accessSync(resolved, constants.R_OK);
  } catch (error) {
    throw new Error(`feed.post: cannot read media ${resolved}`, {
      cause: error,
    });
  }
  return resolved;
}

export function readFeedMedia(path: string): Promise<Uint8Array> {
  return readFile(path);
}

export function localFeedPayload(entry: FeedPost, root: string): FeedPayload {
  return feedPayload(entry, {
    resolveMedia: (path) => resolveFeedMedia(path, root),
  });
}
