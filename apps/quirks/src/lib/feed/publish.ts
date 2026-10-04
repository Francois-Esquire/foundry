import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
  ArtifactCursor,
  ArtifactId,
  Artifacts,
  FileInputs,
} from "@foundry/artifacts";
import { artifactIdSchema } from "@foundry/artifacts";
import { classifyFile } from "@foundry/lib/file-classification";
import { z } from "zod";
import {
  ASK_MODES,
  FEED_ENTRY_FILE,
  FEED_ENTRY_KINDS,
  FEED_ENTRY_TYPE,
  FEED_MEDIA_DIR,
  type FeedEntryKind,
  type FeedPayload,
  type FeedQuestionPayload,
  INPUT_DELIVERIES,
  INPUT_STATUSES,
  type InputStatus,
} from "~/lib/feed/entry";
import { alive } from "~/lib/state/locks";

const PAGE_SIZE = 100;

export interface FeedWorkspace {
  readonly id: string;
  /** Display name: the workspace root's directory name. */
  readonly name: string;
  readonly root: string;
}

/** Where a post came from; the engine knows this, the step body does not. */
interface FeedSource {
  readonly definition: string;
  readonly path: readonly string[];
  readonly runId: string;
}

interface InputState {
  readonly answer?: string;
  /** A note given with the answer, when the host offered one. */
  readonly note?: string;
  readonly status: InputStatus;
}

export interface FeedPublisher {
  /**
   * Cancel live and legacy questions whose process has exited. Deferred
   * permissions remain open because a new host can resolve them for future runs.
   */
  cancelAbandoned(): Promise<number>;
  publish(post: FeedPayload, source: FeedSource): Promise<ArtifactId>;
  /** Write a question's entry; call again with a new state as it is answered. */
  publishInput(
    question: FeedQuestionPayload,
    source: FeedSource,
    state: InputState
  ): Promise<ArtifactId>;
}

/** Provenance stored in each entry's Content metadata under `feed`. */
export const feedMetadataSchema = z.object({
  /** Present on results that carry an artifact version. */
  artifact: z
    .object({ artifactId: z.string(), contentId: z.string() })
    .optional(),
  definition: z.string(),
  /** Present on `input` entries: the question's choices and whether it is settled. */
  input: z
    .object({
      activityId: z.string().optional(),
      answer: z.string().optional(),
      /** The question's markdown, kept so the entry can be rewritten later. */
      body: z.string().optional(),
      choices: z.array(z.string()),
      delivery: z.enum(INPUT_DELIVERIES).optional(),
      /** Approval requests permission; a question requests input. Absent on old entries. */
      mode: z.enum(ASK_MODES).optional(),
      note: z.string().optional(),
      /** While open: the process that can answer it. */
      pid: z.number().int().optional(),
      sessionId: z.string().optional(),
      status: z.enum(INPUT_STATUSES),
    })
    .optional(),
  key: z.string(),
  kind: z.enum(FEED_ENTRY_KINDS),
  media: z.array(z.string()),
  run: z.string(),
  step: z.string(),
  title: z.string(),
  workspace: z.object({ id: z.string(), name: z.string(), root: z.string() }),
});
type FeedMetadata = z.infer<typeof feedMetadataSchema>;

/**
 * Writes entries into an Artifact store. Ids hash workspace, run, step path
 * and key, so a repeated post updates its entry. Publishes are serialized:
 * two posts of one key must not both see "missing" and both create.
 */
export function feedPublisher(
  artifacts: Pick<Artifacts, "create" | "get" | "list" | "write">,
  workspace: FeedWorkspace,
  options: {
    /** Recorded on open questions; defaults to this process. */
    readonly pid?: number;
    readonly isAlive?: (pid: number) => boolean;
  } = {}
): FeedPublisher {
  const { pid = process.pid, isAlive = alive } = options;
  let queue: Promise<unknown> = Promise.resolve();
  function serialized<T>(write: () => Promise<T>): Promise<T> {
    const next = queue.then(write);
    queue = next.catch(() => undefined);
    return next;
  }
  async function publish(
    post: EntryDraft,
    source: FeedSource
  ): Promise<ArtifactId> {
    const id = entryId(workspace.id, source, post.id);
    const media = await Promise.all(
      post.media.map(async (path) => {
        const name = basename(path);
        return [
          `${FEED_MEDIA_DIR}/${name}`,
          { bytes: await readFile(path), mime: classifyFile(name).mime },
        ] as const;
      })
    );
    const files: FileInputs = {
      [FEED_ENTRY_FILE]: { bytes: article(post), mime: "text/markdown" },
      ...Object.fromEntries(media),
    };
    const feed: FeedMetadata = {
      ...(post.artifact ? { artifact: post.artifact } : {}),
      definition: source.definition,
      ...(post.input ? { input: post.input } : {}),
      key: post.key,
      kind: post.kind,
      media: media.map(([path]) => path),
      run: source.runId,
      step: source.path.join("."),
      title: post.title,
      workspace,
    };
    if (await artifacts.get(id)) {
      await artifacts.write({
        artifactId: id,
        changes: { put: files, replace: true },
        metadata: { entry: FEED_ENTRY_FILE, feed },
      });
    } else {
      await artifacts.create({
        entries: files,
        id,
        metadata: { entry: FEED_ENTRY_FILE, feed },
        name: post.title,
        type: FEED_ENTRY_TYPE,
      });
    }
    return id;
  }
  async function cancelAbandoned(): Promise<number> {
    let cancelled = 0;
    let cursor: ArtifactCursor | undefined;
    do {
      const page = await artifacts.list({
        limit: PAGE_SIZE,
        type: FEED_ENTRY_TYPE,
        ...(cursor ? { cursor } : {}),
      });
      for (const artifact of page.items) {
        const parsed = feedMetadataSchema.safeParse(
          artifact.content?.metadata.feed
        );
        const input = parsed.success ? parsed.data.input : undefined;
        if (
          !(parsed.success && input) ||
          input.status !== "open" ||
          input.delivery === "deferred" ||
          (input.pid !== undefined && isAlive(input.pid))
        ) {
          continue;
        }
        const { pid: _owner, ...rest } = input;
        const feed: FeedMetadata = {
          ...parsed.data,
          input: { ...rest, status: "cancelled" },
        };
        await artifacts.write({
          artifactId: artifact.id,
          changes: {
            put: {
              [FEED_ENTRY_FILE]: {
                bytes: article({
                  body: rest.body ?? "",
                  input: feed.input,
                  title: feed.title,
                }),
                mime: "text/markdown",
              },
            },
          },
          metadata: { feed },
        });
        cancelled += 1;
      }
      cursor = page.nextCursor;
    } while (cursor);
    return cancelled;
  }
  return {
    cancelAbandoned() {
      return serialized(cancelAbandoned);
    },
    publish(post, source) {
      return serialized(() => publish({ ...post, id: post.key }, source));
    },
    publishInput(question, source, state) {
      const input = {
        ...state,
        body: question.body,
        choices: question.choices,
        ...(question.activityId ? { activityId: question.activityId } : {}),
        ...(question.sessionId ? { sessionId: question.sessionId } : {}),
        ...(question.delivery ? { delivery: question.delivery } : {}),
        mode: question.mode,
        ...(state.status === "open" && question.delivery !== "deferred"
          ? { pid }
          : {}),
      };
      return serialized(() =>
        publish(
          {
            body: question.body,
            // A question and a post may share a key within one step.
            id: `ask:${question.key}`,
            input,
            key: question.key,
            kind: "input",
            media: [],
            title: question.title,
          },
          source
        )
      );
    },
  };
}

function entryId(
  workspace: string,
  source: FeedSource,
  key: string
): ArtifactId {
  const digest = createHash("sha256")
    .update([workspace, source.runId, ...source.path, key].join("\0"))
    .digest("hex")
    .slice(0, 24);
  return artifactIdSchema.parse(`feed-${digest}`);
}

interface EntryDraft {
  readonly artifact?: FeedMetadata["artifact"];
  readonly body: string;
  /** Identity within the step; hashed into the Artifact id. */
  readonly id: string;
  readonly input?: FeedMetadata["input"];
  readonly key: string;
  readonly kind: FeedEntryKind;
  readonly media: readonly string[];
  readonly title: string;
}

/** The file stands alone when opened outside Quirks, so it carries its title. */
function article(post: Pick<EntryDraft, "body" | "input" | "title">): string {
  const sections = [`# ${post.title}`, post.body.trim(), inputLine(post.input)];
  return `${sections.filter(Boolean).join("\n\n")}\n`;
}

function inputLine(input: FeedMetadata["input"]): string {
  if (!input) {
    return "";
  }
  const choices =
    input.choices.length > 0 ? `\n\nChoices: ${input.choices.join(" · ")}` : "";
  if (input.status === "answered") {
    const note = input.note ? ` — ${input.note}` : "";
    return `> Answered: ${input.answer ?? ""}${note}${choices}`;
  }
  if (input.status === "cancelled") {
    return `> No longer waiting: the run stopped before an answer.${choices}`;
  }
  return `> Waiting for an answer.${choices}`;
}
