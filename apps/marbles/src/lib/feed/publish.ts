import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
  ArtifactCursor,
  ArtifactId,
  ArtifactResolved,
  Artifacts,
  FileInputs,
} from "@foundry/artifacts";
import { artifactIdSchema } from "@foundry/artifacts";
import { classifyFile } from "@foundry/lib/file-classification";
import {
  isGone,
  type ProcessIdentity,
  thisProcess,
} from "@foundry/lib/node/process-identity";
import { collectPages } from "@foundry/lib/pagination";
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

const PAGE_SIZE = 100;

export interface FeedWorkspace {
  readonly id: string;
  readonly name: string;
  readonly root: string;
}

export interface FeedSource {
  readonly definition: string;
  readonly path: readonly string[];
  readonly runId: string;
}

interface InputState {
  readonly answer?: string;
  readonly note?: string;
  readonly status: InputStatus;
}

export interface FeedPublisher {
  cancelAbandoned(): Promise<number>;
  publish(post: FeedPayload, source: FeedSource): Promise<ArtifactId>;
  publishInput(
    question: FeedQuestionPayload,
    source: FeedSource,
    state: InputState
  ): Promise<ArtifactId>;
}

const feedMetadataSchema = z.object({
  artifact: z
    .object({ artifactId: z.string(), contentId: z.string() })
    .optional(),
  definition: z.string(),
  input: z
    .object({
      activityId: z.string().optional(),
      answer: z.string().optional(),
      body: z.string().optional(),
      choices: z.array(z.string()),
      delivery: z.enum(INPUT_DELIVERIES).optional(),
      mode: z.enum(ASK_MODES).optional(),
      note: z.string().optional(),
      pid: z.number().int().optional(),
      sessionId: z.string().optional(),
      started: z.string().nullable().optional(),
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
export type FeedMetadata = z.infer<typeof feedMetadataSchema>;

export function listFeedArtifacts(
  artifacts: Pick<Artifacts, "list">
): Promise<ArtifactResolved[]> {
  return collectPages((cursor: ArtifactCursor | undefined) =>
    artifacts.list({
      limit: PAGE_SIZE,
      type: FEED_ENTRY_TYPE,
      ...(cursor ? { cursor } : {}),
    })
  );
}

export function feedMetadataOf(
  artifact: ArtifactResolved
): FeedMetadata | undefined {
  const parsed = feedMetadataSchema.safeParse(artifact.content?.metadata.feed);
  return parsed.success ? parsed.data : undefined;
}

export async function feedEntry(
  artifacts: Pick<Artifacts, "get">,
  id: string
): Promise<FeedMetadata | undefined> {
  const parsed = artifactIdSchema.safeParse(id);
  const artifact = parsed.success
    ? await artifacts.get(parsed.data)
    : undefined;
  return artifact ? feedMetadataOf(artifact) : undefined;
}

export function feedPublisher(
  artifacts: Pick<Artifacts, "create" | "get" | "list" | "write">,
  workspace: FeedWorkspace,
  options: {
    readonly owner?: ProcessIdentity;
    readonly gone?: (owner: ProcessIdentity) => boolean;
  } = {}
): FeedPublisher {
  const { gone = isGone, owner = thisProcess() } = options;
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
    for (const artifact of await listFeedArtifacts(artifacts)) {
      const saved = feedMetadataOf(artifact);
      const input = saved?.input;
      if (
        !saved ||
        input?.status !== "open" ||
        input.delivery === "deferred" ||
        (input.pid !== undefined &&
          !gone({ pid: input.pid, started: input.started ?? null }))
      ) {
        continue;
      }
      const { pid: _owner, started: _started, ...rest } = input;
      const feed: FeedMetadata = {
        ...saved,
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
          ? { pid: owner.pid, started: owner.started }
          : {}),
      };
      return serialized(() =>
        publish(
          {
            body: question.body,
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
  readonly id: string;
  readonly input?: FeedMetadata["input"];
  readonly key: string;
  readonly kind: FeedEntryKind;
  readonly media: readonly string[];
  readonly title: string;
}

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
