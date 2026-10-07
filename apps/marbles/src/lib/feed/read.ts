import type { Artifacts } from "@foundry/artifacts";
import { isUsableContent } from "@foundry/artifacts";
import { classifyFile } from "@foundry/lib/file-classification";
import type { AskMode, InputDelivery, InputStatus } from "~/lib/feed/entry";
import { FEED_ENTRY_FILE } from "~/lib/feed/entry";
import type { FeedArtifact, FeedMetadata } from "~/lib/feed/publish";
import { listFeedEntries } from "~/lib/feed/publish";

export interface FeedMediaSnapshot {
  /** Loaded for images only, which the reader draws inline. */
  readonly bytes?: Uint8Array;
  readonly kind: "image" | "video" | "audio" | "file";
  readonly name: string;
  /** Path inside the entry, as the markdown references it. */
  readonly path: string;
}

export interface FeedEntrySnapshot {
  /** Set on results that carry an artifact version. */
  readonly artifact?: {
    readonly artifactId: string;
    readonly contentId: string;
  };
  /** Markdown article, starting with the entry's title as a heading. */
  readonly body: string;
  readonly definition: string;
  readonly id: string;
  /** Set on `input` entries: live input, deferred permission, or a workflow suspension. */
  readonly input?: {
    readonly answer?: string;
    readonly sessionId?: string;
    readonly activityId?: string;
    readonly choices: readonly string[];
    /** Absent on legacy and workflow suspension entries. */
    readonly delivery?: InputDelivery;
    /** Approval requests permission; a question requests input. */
    readonly mode?: AskMode;
    /** Given with the answer to an approval. */
    readonly note?: string;
    readonly status: InputStatus;
  };
  readonly kind: "result" | "milestone" | "input";
  readonly media: readonly FeedMediaSnapshot[];
  /** Display time, formatted by the host. */
  readonly posted: string;
  /** ISO time of the first post; entries sort newest first by it. */
  readonly postedAt: string;
  readonly run: string;
  readonly step: string;
  readonly title: string;
  readonly workspace: { readonly id: string; readonly name: string };
}

export type FeedReader = (now?: Date) => Promise<FeedEntrySnapshot[]>;

/**
 * Every feed entry in the store, newest first. The dashboard polls this, so
 * each Content's files are read once and reused until the entry changes.
 * Entries whose metadata this version cannot read are skipped, not fatal.
 */
export function feedReader(
  artifacts: Pick<Artifacts, "list" | "readFile">
): FeedReader {
  const cache = new Map<
    string,
    {
      readonly entry: Omit<FeedEntrySnapshot, "posted">;
      readonly version: string;
    }
  >();
  async function load({
    artifact,
    feed,
  }: FeedArtifact): Promise<Omit<FeedEntrySnapshot, "posted"> | undefined> {
    const { content } = artifact;
    if (!isUsableContent(content)) {
      return;
    }
    const version = `${content.id}:${content.updatedAt.toISOString()}`;
    const cached = cache.get(artifact.id);
    if (cached?.version === version) {
      return cached.entry;
    }
    const body = await artifacts.readFile(content.id, FEED_ENTRY_FILE);
    const media = await Promise.all(
      feed.media.map(async (path): Promise<FeedMediaSnapshot> => {
        const { kind, name } = classifyFile(path);
        if (kind === "image") {
          const file = await artifacts.readFile(content.id, path);
          return {
            kind,
            name,
            path,
            ...(file ? { bytes: file.blob } : {}),
          };
        }
        return {
          kind: kind === "video" || kind === "audio" ? kind : "file",
          name,
          path,
        };
      })
    );
    const entry = {
      ...(feed.artifact ? { artifact: feed.artifact } : {}),
      body: body ? new TextDecoder().decode(body.blob) : `# ${feed.title}\n`,
      definition: feed.definition,
      id: artifact.id,
      ...(feed.input ? { input: inputSnapshot(feed.input) } : {}),
      kind: feed.kind,
      media,
      postedAt: artifact.createdAt.toISOString(),
      run: feed.run,
      step: feed.step,
      title: feed.title,
      workspace: { id: feed.workspace.id, name: feed.workspace.name },
    };
    cache.set(artifact.id, { entry, version });
    return entry;
  }
  return async (now = new Date()) => {
    const entries = await Promise.all(
      (await listFeedEntries(artifacts)).map(load)
    );
    return entries
      .filter((entry) => entry !== undefined)
      .sort((a, b) => b.postedAt.localeCompare(a.postedAt))
      .map((entry) => ({
        ...entry,
        posted: formatPosted(new Date(entry.postedAt), now),
      }));
  };
}

/** `14:05` today, `Sep 21 14:05` otherwise, in machine-local time. */
export function formatPosted(at: Date, now: Date): string {
  const time = at.toLocaleTimeString("en-US", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
  });
  if (at.toDateString() === now.toDateString()) {
    return time;
  }
  const day = at.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
  });
  return `${day} ${time}`;
}

/**
 * The input entry's state for a reader: the stored metadata without the
 * question body (the article carries it) and the owning pid (bookkeeping).
 * Parsed metadata has no undefined keys, so snapshots compare equal.
 */
function inputSnapshot({
  body: _body,
  pid: _pid,
  ...input
}: NonNullable<FeedMetadata["input"]>): NonNullable<
  FeedEntrySnapshot["input"]
> {
  return input;
}
