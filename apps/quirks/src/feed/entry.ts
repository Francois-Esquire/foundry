import { accessSync, constants } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { StepContext } from "@foundry/workflows/step";
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
export type FeedKind = (typeof FEED_KINDS)[number];
/** `input` entries come only from `feed.ask`, never from `feed.post`. */
export const FEED_ENTRY_KINDS = [...FEED_KINDS, "input"] as const;
export type FeedEntryKind = (typeof FEED_ENTRY_KINDS)[number];

/** The Suspension kind `feed.ask` parks under; the engine turns it into an input entry. */
export const FEED_INPUT_KIND = "quirks.feed.input";
/** Choices are answered with the number keys, so at most nine. */
const MAX_CHOICES = 9;
export const INPUT_STATUSES = ["open", "answered", "cancelled"] as const;
export type InputStatus = (typeof INPUT_STATUSES)[number];

export interface FeedPost {
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

export interface FeedQuestion {
  /** Markdown context for the question. */
  readonly body?: string;
  /** Offer these answers; without them the answer is free text. */
  readonly choices?: readonly string[];
  /** Names the question within its step, like a post's key. */
  readonly key: string;
  readonly title: string;
}

export interface Feed {
  /**
   * Post a question as an input entry and pause the run until it is answered
   * from the dashboard. Other runs keep going meanwhile. When the run resumes
   * the step body runs again from the start, and this call returns the answer
   * instead of pausing, so work before it should be safe to repeat.
   */
  ask(question: FeedQuestion): Promise<string>;
  /** Publish or update an entry. Only valid inside a running step. */
  post(entry: FeedPost): void;
}

/** What crosses the channel: validated, with media paths made absolute. */
export const feedPostSchema = z.object({
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
  body: z.string().default(""),
  choices: z
    .array(z.string().trim().min(1, "choices cannot be empty"))
    .max(MAX_CHOICES, `at most ${MAX_CHOICES} choices`)
    .default([]),
  key: z.string().trim().min(1, "questions need a key"),
  title: z.string().trim().min(1, "questions need a title"),
});
export type FeedQuestionPayload = z.infer<typeof feedQuestionSchema>;

/** Park the step until the dashboard answers; the answer must fit the question. */
export async function askFeed(
  suspend: StepContext["suspend"],
  question: FeedQuestion
): Promise<string> {
  const parsed = feedQuestionSchema.safeParse(question);
  if (!parsed.success) {
    throw new Error(
      `feed.ask: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    );
  }
  const request = parsed.data;
  const answer = await suspend<unknown>({
    kind: FEED_INPUT_KIND,
    name: `feed.ask:${request.key}`,
    reason: request.title,
    request,
  });
  if (typeof answer !== "string") {
    throw new Error("feed.ask: the answer was not text");
  }
  if (request.choices.length > 0 && !request.choices.includes(answer)) {
    throw new Error(`feed.ask: "${answer}" is not one of the choices`);
  }
  return answer;
}

/** Outside a step there is no run to attribute an entry to. */
export const unboundFeed: Feed = {
  ask() {
    return Promise.reject(
      new Error("feed.ask can only be called inside a running step")
    );
  },
  post() {
    throw new Error("feed.post can only be called inside a running step");
  },
};
