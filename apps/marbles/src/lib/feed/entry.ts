import { z } from "zod";

export const FEED_ENTRY_TYPE = "application/vnd.foundry.feed-entry+markdown";
export const FEED_ENTRY_FILE = "entry.md";
export const FEED_MEDIA_DIR = "media";
export const FEED_POST_EVENT = "marbles.feed.post";

const FEED_KINDS = ["result", "milestone"] as const;
type FeedKind = (typeof FEED_KINDS)[number];
export const FEED_ENTRY_KINDS = [...FEED_KINDS, "input"] as const;
export type FeedEntryKind = (typeof FEED_ENTRY_KINDS)[number];

export const FEED_INPUT_KIND = "marbles.feed.input";
const MAX_CHOICES = 9;
export const INPUT_STATUSES = ["open", "answered", "cancelled"] as const;
export type InputStatus = (typeof INPUT_STATUSES)[number];

interface FeedArtifactLink {
  readonly artifactId: string;
  readonly contentId: string;
}

export const ASK_MODES = ["question", "approval"] as const;
export type AskMode = (typeof ASK_MODES)[number];
export const INPUT_DELIVERIES = ["live", "deferred"] as const;
export type InputDelivery = (typeof INPUT_DELIVERIES)[number];

const MAX_NOTE = 2000;
const TRAILING_SEPARATORS = /[\\/]+$/;

function pathBasename(path: string): string {
  const trimmed = path.replace(TRAILING_SEPARATORS, "");
  if (trimmed === "") {
    return "";
  }
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

export type FeedAnswer =
  | string
  | { readonly choice: string; readonly note?: string };

export function readAnswer(answer: FeedAnswer): {
  readonly choice: string;
  readonly note?: string;
} {
  const choice = (typeof answer === "string" ? answer : answer.choice).trim();
  if (!choice) {
    throw new Error("An answer is required.");
  }
  const note = typeof answer === "string" ? undefined : answer.note?.trim();
  if (note !== undefined && note.length > MAX_NOTE) {
    throw new Error(`Keep the note under ${String(MAX_NOTE)} characters.`);
  }
  return note ? { choice, note } : { choice };
}

export interface FeedPost {
  readonly artifact?: FeedArtifactLink;
  readonly body?: string;
  readonly key: string;
  readonly kind: FeedKind;
  readonly media?: readonly string[];
  readonly title: string;
}

export const feedPostSchema = z.object({
  artifact: z
    .object({ artifactId: z.string().min(1), contentId: z.string().min(1) })
    .optional(),
  body: z.string().default(""),
  key: z.string().trim().min(1, "feed entries need a key"),
  kind: z.enum(FEED_KINDS),
  media: z.array(z.string().min(1)).default([]),
  title: z.string().trim().min(1, "feed entries need a title"),
});
export type FeedPayload = z.infer<typeof feedPostSchema>;

export function feedPayload(
  entry: FeedPost,
  options?: { readonly resolveMedia?: (path: string) => string }
): FeedPayload {
  const parsed = feedPostSchema.safeParse(entry);
  if (!parsed.success) {
    throw new Error(
      `feed.post: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    );
  }
  const media =
    options?.resolveMedia === undefined
      ? parsed.data.media
      : parsed.data.media.map(options.resolveMedia);
  const names = media.map(pathBasename);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) {
    throw new Error(`feed.post: two media files are named "${duplicate}"`);
  }
  return { ...parsed.data, media };
}

export const feedQuestionSchema = z.object({
  activityId: z.string().optional(),
  body: z.string().default(""),
  choices: z
    .array(z.string().trim().min(1, "choices cannot be empty"))
    .max(MAX_CHOICES, `at most ${MAX_CHOICES} choices`)
    .default([]),
  delivery: z.enum(INPUT_DELIVERIES).optional(),
  key: z.string().trim().min(1, "questions need a key"),
  mode: z.enum(ASK_MODES).default("question"),
  sessionId: z.string().optional(),
  title: z.string().trim().min(1, "questions need a title"),
});
export type FeedQuestionPayload = z.infer<typeof feedQuestionSchema>;
