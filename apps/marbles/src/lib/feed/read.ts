import type { ArtifactResolved, ArtifactSubstrate } from "@foundry/artifacts";
import { isUsableContent } from "@foundry/artifacts";
import { classifyFile } from "@foundry/lib/file-classification";
import type { AskMode, InputDelivery, InputStatus } from "~/lib/feed/entry";
import { FEED_ENTRY_FILE } from "~/lib/feed/entry";
import type { FeedMetadata } from "~/lib/feed/publish";
import { feedMetadataOf, listFeedArtifacts } from "~/lib/feed/publish";

export interface FeedMediaSnapshot {
  readonly bytes?: Uint8Array;
  readonly kind: "image" | "video" | "audio" | "file";
  readonly name: string;
  readonly path: string;
}

export interface FeedEntrySnapshot {
  readonly artifact?: {
    readonly artifactId: string;
    readonly contentId: string;
  };
  readonly body: string;
  readonly definition: string;
  readonly id: string;
  readonly input?: {
    readonly answer?: string;
    readonly sessionId?: string;
    readonly activityId?: string;
    readonly choices: readonly string[];
    readonly delivery?: InputDelivery;
    readonly mode?: AskMode;
    readonly note?: string;
    readonly status: InputStatus;
  };
  readonly kind: "result" | "milestone" | "input";
  readonly media: readonly FeedMediaSnapshot[];
  readonly posted: string;
  readonly postedAt: string;
  readonly run: string;
  readonly step: string;
  readonly title: string;
  readonly workspace: { readonly id: string; readonly name: string };
  readonly workspaces?: readonly string[];
}

export type FeedReader = (now?: Date) => Promise<FeedEntrySnapshot[]>;

export function feedReader(
  artifacts: Pick<ArtifactSubstrate, "list" | "readFile">
): FeedReader {
  const cache = new Map<
    string,
    {
      readonly entry: Omit<FeedEntrySnapshot, "posted">;
      readonly version: string;
    }
  >();
  async function load(
    artifact: ArtifactResolved
  ): Promise<Omit<FeedEntrySnapshot, "posted"> | undefined> {
    const { content } = artifact;
    if (!isUsableContent(content)) {
      return;
    }
    const version = `${content.id}:${content.updatedAt.toISOString()}`;
    const cached = cache.get(artifact.id);
    if (cached?.version === version) {
      return cached.entry;
    }
    const feed = feedMetadataOf(artifact);
    if (!feed) {
      return;
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
      (await listFeedArtifacts(artifacts)).map(load)
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

function inputSnapshot({
  body: _body,
  pid: _pid,
  started: _started,
  ...input
}: NonNullable<FeedMetadata["input"]>): NonNullable<
  FeedEntrySnapshot["input"]
> {
  return input;
}
