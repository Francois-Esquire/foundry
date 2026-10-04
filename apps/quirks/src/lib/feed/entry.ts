import { accessSync, constants } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { z } from "zod";

/**
 * A feed entry is one article a person would read on its own: a result or a
 * milestone. Progress and chatter are logs. Each entry is an Artifact whose
 * Content holds `entry.md` and any media under `media/`.
 */

export const FEED_ENTRY_TYPE = "application/vnd.foundry.feed-entry+markdown";
export const FEED_ENTRY_FILE = "entry.md";
export const FEED_MEDIA_DIR = "media";
/** The custom channel event a step body emits; the engine turns it into an Artifact. */
export const FEED_POST_EVENT = "quirks.feed.post";

const FEED_KINDS = ["result", "milestone"] as const;
type FeedKind = (typeof FEED_KINDS)[number];
/** `input` entries come only from `feed.ask`, never from `feed.post`. */
export const FEED_ENTRY_KINDS = [...FEED_KINDS, "input"] as const;
export type FeedEntryKind = (typeof FEED_ENTRY_KINDS)[number];

/** The Suspension kind `feed.ask` parks under; the engine turns it into an input entry. */
export const FEED_INPUT_KIND = "quirks.feed.input";
/** Choices are answered with the number keys, so at most nine. */
const MAX_CHOICES = 9;
export const INPUT_STATUSES = ["open", "answered", "cancelled"] as const;
export type InputStatus = (typeof INPUT_STATUSES)[number];

interface FeedArtifactLink {
  readonly artifactId: string;
  readonly contentId: string;
}

export const ASK_MODES = ["question", "approval"] as const;
export const INPUT_DELIVERIES = ["live", "deferred"] as const;

/** A note is short: it rides along with an approval, it is not the report. */
const MAX_NOTE = 2000;

/** What a host sends back: the choice or text, optionally with a note. */
export type FeedAnswer =
  | string
  | { readonly choice: string; readonly note?: string };

/** The answer's parts, trimmed; throws on an empty choice or an oversized note. */
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
  /** A result that carries an artifact version. */
  readonly artifact?: FeedArtifactLink;
  /** Markdown. Reference attached media as `media/<file name>`. */
  readonly body?: string;
  /**
   * Names the entry within its step. Posting the same key again in the same
   * run updates that entry instead of adding one, so retries never duplicate.
   */
  readonly key: string;
  readonly kind: FeedKind;
  /** Files copied into the entry under `media/`; relative paths resolve from the workspace root. */
  readonly media?: readonly string[];
  readonly title: string;
}

/** What crosses the channel: validated, with media paths made absolute. */
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

/** Validate a post where the body called it, so mistakes fail the step rather than vanish. */
export function feedPayload(entry: FeedPost, root: string): FeedPayload {
  const parsed = feedPostSchema.safeParse(entry);
  if (!parsed.success) {
    throw new Error(
      `feed.post: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    );
  }
  const media = parsed.data.media.map((path) =>
    isAbsolute(path) ? path : resolve(root, path)
  );
  // The engine reads media just after the post; catch a bad path while the
  // step can still fail on it.
  for (const path of media) {
    try {
      accessSync(path, constants.R_OK);
    } catch (error) {
      throw new Error(`feed.post: cannot read media ${path}`, { cause: error });
    }
  }
  const names = media.map((path) => basename(path));
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
  /** Live input waits in the current process; deferred permission applies to future runs. */
  delivery: z.enum(INPUT_DELIVERIES).optional(),
  key: z.string().trim().min(1, "questions need a key"),
  mode: z.enum(ASK_MODES).default("question"),
  sessionId: z.string().optional(),
  title: z.string().trim().min(1, "questions need a title"),
});
export type FeedQuestionPayload = z.infer<typeof feedQuestionSchema>;

/** Outside a step there is no run to attribute an entry to. */
