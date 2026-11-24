import type { ChannelEvent } from "@foundry/workflows/channels";

import {
  FEED_INPUT_KIND,
  FEED_POST_EVENT,
  type FeedAnswer,
  type FeedQuestionPayload,
  feedPostSchema,
  feedQuestionSchema,
  readAnswer,
} from "~/lib/feed/entry";
import type {
  FeedMetadata,
  FeedPublisher,
  FeedSource,
} from "~/lib/feed/publish";
import type { Suspension, WorkflowQueue } from "~/lib/workflow-queue";

type FeedQueue = Pick<
  WorkflowQueue,
  "cancelRun" | "on" | "resolve" | "suspension" | "suspensions"
>;

interface OpenQuestion {
  readonly question: FeedQuestionPayload;
  readonly source: FeedSource;
  readonly suspensionId: string;
}

export interface FeedRouter {
  answer(entryId: string, answer: FeedAnswer): Promise<void>;
  cancelOpen(): Promise<void>;
  cancelReason(runId: string): string | undefined;
  cancelWith(
    definition: string,
    runId: string,
    cancelRun: () => Promise<void>
  ): Promise<void>;
  close(runId: string): Promise<void>;
  observe(
    definition: string,
    runId: string
  ): {
    readonly onEvent: (event: ChannelEvent) => void;
    readonly settled: () => Promise<void>;
  };
  publishPending(definition: string, runId: string): Promise<void>;
}

export interface FeedRouterOptions {
  readonly askable: boolean;
  readonly durable: boolean;
  readonly entry: (entryId: string) => Promise<FeedMetadata | undefined>;
  readonly feed: FeedPublisher;
  readonly print: (line: string) => void;
  readonly queue: FeedQueue;
}

const NOT_WAITING = "This question is no longer waiting for an answer.";

function refusalName(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return;
  }
  return "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : error.name;
}

function questionOf(
  definition: string,
  suspension: Suspension
): OpenQuestion | undefined {
  const question = feedQuestionSchema.safeParse(suspension.request);
  if (!question.success) {
    return;
  }
  return {
    question: question.data,
    source: {
      definition,
      path: [definition, ...suspension.stepPath.slice(1)],
      runId: suspension.runId,
    },
    suspensionId: suspension.id,
  };
}

export function feedRouter(options: FeedRouterOptions): FeedRouter {
  const { askable, durable, entry, feed, print, queue } = options;
  const open = new Map<string, OpenQuestion>();
  const cancelled = new Map<string, string>();

  function warn(title: string) {
    return (error: unknown) =>
      print(`[feed] ${title} not published: ${String(error)}`);
  }

  function cancel(questions: readonly OpenQuestion[]): Promise<unknown> {
    return Promise.all(
      questions.map((question) =>
        feed
          .publishInput(question.question, question.source, {
            status: "cancelled",
          })
          .catch(warn(question.question.title))
      )
    );
  }

  function ask(question: OpenQuestion): Promise<unknown> {
    const { title } = question.question;
    if (!askable) {
      print(
        `[feed] "${title}" needs an answer; run \`marbles\` to answer questions from the dashboard`
      );
      cancelled.set(
        question.source.runId,
        `"${title}" is waiting for an answer; open the dashboard with \`marbles\``
      );
      return Promise.all([
        feed
          .publishInput(question.question, question.source, {
            status: "cancelled",
          })
          .catch(warn(title)),
        queue
          .cancelRun(question.source.runId)
          .catch((error: unknown) => print(`[feed] ${String(error)}`)),
      ]);
    }
    const asked = durable
      ? { ...question.question, delivery: "deferred" as const }
      : question.question;
    return feed
      .publishInput(asked, question.source, { status: "open" })
      .then((id) => {
        open.set(id, question);
      })
      .catch(warn(title));
  }

  async function publishPending(
    definition: string,
    runId: string
  ): Promise<void> {
    const pending = await queue.suspensions({ kind: FEED_INPUT_KIND, runId });
    for (const suspension of pending) {
      const question = questionOf(definition, suspension);
      if (question !== undefined) {
        await ask(question);
      }
    }
  }

  async function stored(entryId: string): Promise<OpenQuestion | undefined> {
    const saved = await entry(entryId);
    if (saved?.kind !== "input") {
      return;
    }
    const pending = await queue.suspensions({
      kind: FEED_INPUT_KIND,
      runId: saved.run,
    });
    return pending
      .map((suspension) => questionOf(saved.definition, suspension))
      .find(
        (question) =>
          question?.question.key === saved.key &&
          question.source.path.join(".") === saved.step
      );
  }

  async function stillPending(question: OpenQuestion): Promise<boolean> {
    const suspension = await queue
      .suspension(question.suspensionId)
      .catch(() => undefined);
    return suspension?.status !== "resolved";
  }

  return {
    async answer(entryId, answer) {
      const question = open.get(entryId) ?? (await stored(entryId));
      if (!question) {
        throw new Error(NOT_WAITING);
      }
      const { choice, note } = readAnswer(answer);
      const { choices } = question.question;
      if (choices.length > 0 && !choices.includes(choice)) {
        throw new Error(`Choose one of: ${choices.join(", ")}`);
      }
      const suspension = await queue.suspension(question.suspensionId);
      if (suspension?.status !== "pending") {
        open.delete(entryId);
        throw new Error(NOT_WAITING);
      }
      await queue
        .resolve(
          suspension.id,
          note === undefined ? choice : { choice, note },
          { expectedRevision: suspension.revision }
        )
        .catch((error: unknown) => {
          throw refusalName(error) === "StaleSuspensionRevisionError"
            ? new Error(NOT_WAITING, { cause: error })
            : error;
        });
      open.delete(entryId);
      await feed
        .publishInput(question.question, question.source, {
          answer: choice,
          ...(note === undefined ? {} : { note }),
          status: "answered",
        })
        .catch(warn(question.question.title));
    },

    async cancelOpen() {
      const questions = [...open.values()];
      open.clear();
      await cancel(questions);
    },

    cancelReason: (runId) => cancelled.get(runId),

    async cancelWith(definition, runId, cancelRun) {
      const pending = await queue
        .suspensions({ kind: FEED_INPUT_KIND, runId })
        .catch(() => []);
      await cancelRun();
      for (const [id, question] of open) {
        if (question.source.runId === runId) {
          open.delete(id);
        }
      }
      await cancel(
        pending.flatMap(
          (suspension) => questionOf(definition, suspension) ?? []
        )
      );
    },

    async close(runId) {
      cancelled.delete(runId);
      const questions = [...open].filter(
        ([, question]) => question.source.runId === runId
      );
      for (const [id] of questions) {
        open.delete(id);
      }
      const unanswered: OpenQuestion[] = [];
      for (const [, question] of questions) {
        if (await stillPending(question)) {
          unanswered.push(question);
        }
      }
      await cancel(unanswered);
    },

    observe(definition, runId) {
      const writes: Promise<unknown>[] = [];
      const refresh = () => {
        writes.push(publishPending(definition, runId).catch(warn("question")));
      };
      const unsubscribe = queue.on("suspended", (suspended) => {
        if (suspended === runId) {
          refresh();
        }
      });
      refresh();
      const source = (event: ChannelEvent): FeedSource => ({
        definition,
        path: [definition, ...event.path.slice(1)],
        runId,
      });
      return {
        onEvent(event) {
          if (event._tag === "custom" && event.type === FEED_POST_EVENT) {
            const post = feedPostSchema.safeParse(event.payload);
            if (post.success) {
              writes.push(
                feed
                  .publish(post.data, source(event))
                  .catch(warn(post.data.title))
              );
            }
          }
        },
        async settled() {
          unsubscribe();
          await Promise.all(writes);
        },
      };
    },

    publishPending,
  };
}
