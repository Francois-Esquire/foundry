import type {
  AgentAuthorizer,
  ApprovalResolution,
} from "@foundry/agents/authorization";
import type {
  HarnessAuthoritySettings,
  HarnessQuestionRequest,
  HarnessQuestionResult,
} from "@foundry/agents/harness";
import { resolveHarnessApproval } from "@foundry/agents/harness";
import type {
  AgentApprovalRequest,
  SessionStore,
} from "@foundry/agents/session";
import {
  type FeedAnswer,
  type FeedQuestionPayload,
  readAnswer,
} from "~/lib/feed/entry";
import type { FeedPublisher } from "~/lib/feed/publish";
import {
  type DeferredApproval,
  DeferredApprovals,
  type InteractionSession,
} from "./deferred-approvals";

type Source = DeferredApproval["source"];
type ApprovalNotice = AgentApprovalRequest & {
  sessionId: string;
  approvalMode: "live" | "deferred";
};
type LiveApproval = Parameters<
  NonNullable<HarnessAuthoritySettings["approve"]>
>[0];

import {
  APPROVE_FUTURE,
  APPROVE_SESSION,
  approvalPrompt,
  DENY,
  deferredPrompt,
  OTHER,
  questionAnswer,
  questionPrompt,
} from "./interaction-prompts";

interface PendingInput {
  active(): boolean;
  answer(answer: ReturnType<typeof readAnswer>): Promise<void>;
  busy: boolean;
  readonly durable: boolean;
  question: FeedQuestionPayload;
  readonly source: Source;
}

export interface HarnessInteractionsOptions {
  readonly askable: boolean;
  readonly feed: FeedPublisher;
  readonly pendingPath?: string;
  readonly policy: AgentAuthorizer;
  readonly sessions: SessionStore;
}

/** Human input waits in the host; it never suspends or replays the workflow. */
export class HarnessInteractions {
  readonly #options: HarnessInteractionsOptions;
  readonly #pending = new Map<string, PendingInput>();
  readonly #deferred: DeferredApprovals;
  readonly #waits = new Set<Promise<unknown>>();
  readonly #shutdown = new AbortController();

  constructor(options: HarnessInteractionsOptions) {
    this.#options = options;
    this.#deferred = new DeferredApprovals(options.pendingPath);
  }

  async restore(): Promise<void> {
    const saved = await this.#deferred.load();
    const records = new Map(
      saved.requests.map((record) => [record.approvalId, record])
    );
    for (const session of saved.sessions) {
      const history = await this.#options.sessions.listMessages(
        session.sessionId
      );
      for (const part of history.flatMap((message) => message.parts)) {
        if (
          part.type === "tool_approval_request" &&
          part.approvalMode === "deferred" &&
          part.agentId === session.agentId &&
          part.agentGeneration === session.agentGeneration &&
          !records.has(part.approvalId) &&
          !history.some((message) =>
            message.parts.some(
              (answer) =>
                answer.type === "tool_approval_response" &&
                answer.approvalId === part.approvalId
            )
          )
        ) {
          records.set(part.approvalId, {
            ...session,
            approvalId: part.approvalId,
          });
        }
      }
    }
    for (const record of records.values()) {
      const history = await this.#options.sessions.listMessages(
        record.sessionId
      );
      const parts = history.flatMap((message) => message.parts);
      const request = parts.find(
        (part) =>
          part.type === "tool_approval_request" &&
          part.approvalId === record.approvalId
      );
      const response = parts.find(
        (part) =>
          part.type === "tool_approval_response" &&
          part.approvalId === record.approvalId
      );
      if (
        request?.type !== "tool_approval_request" ||
        request.approvalMode !== "deferred" ||
        request.agentId !== record.agentId ||
        request.agentGeneration !== record.agentGeneration
      ) {
        await this.#deferred.remove(record.approvalId);
        continue;
      }
      await this.#publishDeferred(
        {
          ...record,
          approvalMode: "deferred",
          capability: request.capability,
          input: request.input,
          toolCallId: request.toolCallId,
          toolName: request.name,
        },
        record.source,
        this.#options.policy,
        response?.type === "tool_approval_response" ? response : undefined
      );
      if (response) {
        await this.#deferred.remove(record.approvalId);
      }
    }
  }

  registerSession(
    session: InteractionSession,
    policy?: AgentAuthorizer
  ): Promise<void> {
    return !policy || policy === this.#options.policy
      ? this.#deferred.register(session)
      : Promise.resolve();
  }

  authority(
    source: Source,
    override?: Pick<
      HarnessAuthoritySettings,
      "policy" | "approve" | "onApprovalRequest"
    >
  ): Pick<
    HarnessAuthoritySettings,
    "policy" | "approve" | "onApprovalRequest"
  > {
    const policy = override?.policy ?? this.#options.policy;
    const approve =
      override?.approve ??
      (this.#options.askable
        ? (request: LiveApproval) => this.#approve(source, request)
        : undefined);
    return {
      policy,
      ...(approve ? { approve } : {}),
      onApprovalRequest: async (request) => {
        if (request.approvalMode === "deferred") {
          if (!request.agentId) {
            throw new Error("Approval has no agent identity.");
          }
          const record: DeferredApproval = {
            agentId: request.agentId,
            approvalId: request.approvalId,
            sessionId: request.sessionId,
            source,
            ...(request.agentGeneration === undefined
              ? {}
              : { agentGeneration: request.agentGeneration }),
          };
          if (policy === this.#options.policy) {
            await this.#deferred.put(record);
          }
          await this.#publishDeferred(request, source, policy);
        }
        await override?.onApprovalRequest?.(request);
      },
    };
  }

  async question(
    source: Source,
    request: HarnessQuestionRequest,
    attended: boolean
  ): Promise<HarnessQuestionResult> {
    if (!(attended && this.#options.askable)) {
      await this.#options.feed.publish(
        {
          body:
            "This unattended run needs an answer. Start an attended session to answer and continue.\n\n" +
            request.questions.map((question) => question.question).join("\n\n"),
          key: `question:${request.sessionId}:${request.toolCallId}`,
          kind: "milestone",
          media: [],
          title: "Agent needs input",
        },
        source
      );
      return {
        outcome: "declined",
        reason:
          "No person is available in this scheduled run. Do not invent an answer.",
      };
    }
    const answers: Record<string, string[]> = {};
    for (const question of request.questions) {
      const result = await this.#wait(
        source,
        questionPrompt(request, question),
        request.signal,
        (answer) => questionAnswer(question, answer.choice)
      );
      if (!result) {
        return { outcome: "declined", reason: "The user declined to answer." };
      }
      answers[question.id] = result;
    }
    return { answers, outcome: "answered" };
  }

  async answer(entryId: string, value: FeedAnswer): Promise<boolean> {
    const pending = this.#pending.get(entryId);
    if (!pending) {
      return false;
    }
    if (!pending.active()) {
      throw new Error("This agent is no longer waiting for an answer.");
    }
    if (pending.busy) {
      throw new Error("This answer is already being processed.");
    }
    const answer = readAnswer(value);
    if (
      pending.question.choices.length &&
      !pending.question.choices.includes(answer.choice)
    ) {
      throw new Error("Choose one of the offered answers.");
    }
    pending.busy = true;
    try {
      if (
        pending.question.mode === "question" &&
        pending.question.choices.includes(OTHER) &&
        answer.choice === OTHER
      ) {
        pending.question = { ...pending.question, choices: [] };
        await this.#options.feed.publishInput(
          pending.question,
          pending.source,
          { status: "open" }
        );
        if (!pending.active()) {
          throw new Error("This agent is no longer waiting for an answer.");
        }
      } else {
        await pending.answer(answer);
        this.#pending.delete(entryId);
      }
    } finally {
      pending.busy = false;
    }
    return true;
  }

  async close(): Promise<void> {
    this.#shutdown.abort(new Error("The agent stopped waiting for input."));
    await Promise.allSettled([...this.#waits]);
    for (const [id, pending] of this.#pending) {
      if (!pending.durable) {
        await this.#options.feed.publishInput(
          pending.question,
          pending.source,
          { status: "cancelled" }
        );
        this.#pending.delete(id);
      }
    }
  }

  #approve(source: Source, request: LiveApproval): Promise<ApprovalResolution> {
    return this.#wait(
      source,
      approvalPrompt(request),
      request.signal,
      (answer) => ({
        approved: answer.choice !== DENY,
        lifetime: answer.choice === APPROVE_SESSION ? "session" : "once",
        ...(answer.note ? { reason: answer.note } : {}),
      })
    );
  }

  async #publishDeferred(
    request: ApprovalNotice,
    source: Source,
    policy: AgentAuthorizer,
    response?: { approved: boolean; reason?: string }
  ): Promise<void> {
    const { agentId } = request;
    if (!agentId) {
      throw new Error("Approval has no agent identity.");
    }
    const durable = policy === this.#options.policy;
    const question = deferredPrompt(request, durable);
    if (response) {
      await this.#options.feed.publishInput(question, source, {
        answer: response.approved ? APPROVE_FUTURE : DENY,
        status: "answered",
        ...(response.reason ? { note: response.reason } : {}),
      });
      return;
    }
    let resolved: ReturnType<typeof readAnswer> | undefined;
    const id = await this.#options.feed.publishInput(question, source, {
      status: "open",
    });
    this.#pending.set(id, {
      active: () => !this.#shutdown.signal.aborted,
      answer: async (answer) => {
        if (!resolved) {
          await resolveHarnessApproval(
            {
              agentGeneration: request.agentGeneration,
              agentId,
              policy,
              store: this.#options.sessions,
            },
            request.sessionId,
            request.approvalId,
            {
              approved: answer.choice === APPROVE_FUTURE,
              lifetime: "persistent",
              ...(answer.note ? { reason: answer.note } : {}),
            }
          );
          resolved = answer;
        }
        await this.#options.feed.publishInput(question, source, {
          answer: resolved.choice,
          ...(resolved.note ? { note: resolved.note } : {}),
          status: "answered",
        });
        await this.#deferred.remove(request.approvalId);
      },
      busy: false,
      durable,
      question,
      source,
    });
  }

  #wait<T>(
    source: Source,
    question: FeedQuestionPayload,
    signal: AbortSignal,
    parse: (answer: ReturnType<typeof readAnswer>) => T
  ): Promise<T> {
    if (this.#shutdown.signal.aborted) {
      return Promise.reject(
        new Error("The host is no longer accepting agent input.")
      );
    }
    const pending = this.#open(
      source,
      question,
      AbortSignal.any([signal, this.#shutdown.signal]),
      parse
    );
    this.#waits.add(pending);
    pending.finally(() => this.#waits.delete(pending)).catch(() => undefined);
    return pending;
  }

  async #open<T>(
    source: Source,
    question: FeedQuestionPayload,
    signal: AbortSignal,
    parse: (answer: ReturnType<typeof readAnswer>) => T
  ): Promise<T> {
    signal.throwIfAborted();
    const id = await this.#options.feed.publishInput(question, source, {
      status: "open",
    });
    let cancel!: () => void;
    const result = new Promise<T>((resolve, reject) => {
      cancel = () =>
        reject(
          signal.reason ?? new Error("The agent stopped waiting for input.")
        );
      this.#pending.set(id, {
        active: () => !(signal.aborted || this.#shutdown.signal.aborted),
        answer: async (answer) => {
          signal.throwIfAborted();
          const value = parse(answer);
          await this.#options.feed.publishInput(question, source, {
            answer: answer.choice,
            ...(answer.note ? { note: answer.note } : {}),
            status: "answered",
          });
          signal.throwIfAborted();
          resolve(value);
        },
        busy: false,
        durable: false,
        question,
        source,
      });
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted || this.#shutdown.signal.aborted) {
        cancel();
      }
    });
    try {
      return await result;
    } catch (error) {
      await this.#options.feed.publishInput(question, source, {
        status: "cancelled",
      });
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
      this.#pending.delete(id);
    }
  }
}
