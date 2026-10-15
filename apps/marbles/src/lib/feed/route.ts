import type { ChannelEvent } from "@foundry/workflows/channels";
import type { Orchestrator } from "@foundry/workflows/orchestrator";

import {
  FEED_INPUT_KIND,
  FEED_POST_EVENT,
  type FeedAnswer,
  type FeedQuestionPayload,
  feedPostSchema,
  feedQuestionSchema,
  readAnswer,
} from "~/lib/feed/entry";
import type { FeedPublisher, FeedSource } from "~/lib/feed/publish";

interface OpenQuestion {
  readonly question: FeedQuestionPayload;
  readonly source: FeedSource;
  readonly suspensionId: string;
}

export interface FeedRouter {
  /**
   * Take over the open questions of a run recovered from a previous process:
   * their entries are republished as ours, so they stay open and answerable.
   */
  adopt(definition: string, runId: string): Promise<void>;
  /** Answer an open input entry, resuming the run that asked. */
  answer(entryId: string, answer: FeedAnswer): Promise<void>;
  /** Mark every open question cancelled: nothing in this process can answer it now. */
  cancelOpen(): Promise<void>;
  /** Why this router cancelled a run, when it did; forgotten when the run closes. */
  cancelReason(runId: string): string | undefined;
  /** A run ended without answering these: its open questions are marked cancelled. */
  close(runId: string): Promise<void>;
  /** Handle one run's channel events; `settled` awaits the writes they caused. */
  observe(
    definition: string,
    runId: string
  ): {
    readonly onEvent: (event: ChannelEvent) => void;
    readonly settled: () => Promise<void>;
  };
}

/**
 * Steps cannot see their Run, so the engine attributes what they publish.
 * Posts arrive as custom events; questions arrive as Suspensions of kind
 * `marbles.feed.input`. Without `askable` nobody can answer, so a question
 * cancels its run instead of pausing it forever.
 */
export function feedRouter(options: {
  readonly askable: boolean;
  readonly feed: FeedPublisher;
  readonly orchestrator: Orchestrator;
  readonly print: (line: string) => void;
}): FeedRouter {
  const { askable, feed, orchestrator, print } = options;
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
        orchestrator
          .cancelRun(question.source.runId)
          .catch((error: unknown) => print(`[feed] ${String(error)}`)),
      ]);
    }
    return feed
      .publishInput(question.question, question.source, { status: "open" })
      .then((id) => {
        open.set(id, question);
      })
      .catch(warn(title));
  }

  async function adopt(definition: string, runId: string): Promise<void> {
    const pending = await orchestrator.listSuspensions({
      kind: FEED_INPUT_KIND,
      runId,
      status: "pending",
    });
    for (const suspension of pending.items) {
      const question = feedQuestionSchema.safeParse(suspension.request);
      if (!question.success) {
        continue;
      }
      await ask({
        question: question.data,
        source: {
          definition,
          path: [definition, ...suspension.stepPath.slice(1)],
          runId,
        },
        suspensionId: suspension.id,
      });
    }
  }

  return {
    adopt,

    async answer(entryId, answer) {
      const question = open.get(entryId);
      if (!question) {
        throw new Error("This question is no longer waiting for an answer.");
      }
      const { choice, note } = readAnswer(answer);
      const { choices } = question.question;
      if (choices.length > 0 && !choices.includes(choice)) {
        throw new Error(`Choose one of: ${choices.join(", ")}`);
      }
      const suspension = await orchestrator.getSuspension(
        question.suspensionId
      );
      if (suspension?.status !== "pending") {
        open.delete(entryId);
        throw new Error("This question is no longer waiting for an answer.");
      }
      // The step reads a plain choice or `{ choice, note }`; keep the plain
      // form when there is no note so older resolutions stay comparable.
      await orchestrator.resolve(
        suspension.id,
        note === undefined ? choice : { choice, note }
      );
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

    async close(runId) {
      cancelled.delete(runId);
      const questions = [...open].filter(
        ([, question]) => question.source.runId === runId
      );
      for (const [id] of questions) {
        open.delete(id);
      }
      await cancel(questions.map(([, question]) => question));
    },

    observe(definition, runId) {
      // Only durable suspensions are answerable. Parallel children may emit
      // several suspension signals while the queue parks one at a time.
      const writes: Promise<unknown>[] = [];
      const refresh = () => {
        writes.push(adopt(definition, runId).catch(warn("question")));
      };
      const unsubscribe = orchestrator.on("suspended", (payload) => {
        if (payload.runId === runId) {
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
  };
}
