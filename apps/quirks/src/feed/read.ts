import type {
  ArtifactCursor,
  ArtifactResolved,
  Artifacts,
} from "@foundry/artifacts";
import { isGoodContent } from "@foundry/artifacts";
import { classifyFile } from "@foundry/lib/file-classification";

import { FEED_ENTRY_FILE, FEED_ENTRY_TYPE } from "~/feed/entry";
import { feedMetadataSchema } from "~/feed/publish";
import type {
  FeedEntrySnapshot,
  FeedMediaSnapshot,
} from "~/views/dashboard-model";

const PAGE_SIZE = 100;

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
  async function load(
    artifact: ArtifactResolved
  ): Promise<Omit<FeedEntrySnapshot, "posted"> | undefined> {
    const { content } = artifact;
    if (!isGoodContent(content)) {
      return;
    }
    const version = `${content.id}:${content.updatedAt.toISOString()}`;
    const cached = cache.get(artifact.id);
    if (cached?.version === version) {
      return cached.entry;
    }
    const parsed = feedMetadataSchema.safeParse(content.metadata.feed);
    if (!parsed.success) {
      return;
    }
    const feed = parsed.data;
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
      ...(feed.input
        ? {
            input: {
              ...(feed.input.answer === undefined
                ? {}
                : { answer: feed.input.answer }),
              choices: feed.input.choices,
              ...(feed.input.mode === undefined
                ? {}
                : { mode: feed.input.mode }),
              status: feed.input.status,
            },
          }
        : {}),
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
    const artifactsFound: ArtifactResolved[] = [];
    let cursor: ArtifactCursor | undefined;
    do {
      const page = await artifacts.list({
        limit: PAGE_SIZE,
        type: FEED_ENTRY_TYPE,
        ...(cursor ? { cursor } : {}),
      });
      artifactsFound.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    const entries = await Promise.all(artifactsFound.map(load));
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
