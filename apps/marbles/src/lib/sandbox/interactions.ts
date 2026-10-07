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
  SessionMessage,
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
import {
  approvalPrompt,
  deferredPrompt,
  type LiveApproval,
  type Prompt,
  type PromptAnswer,
  questionPrompt,
} from "./interaction-prompts";
import type { SandboxAuthority } from "./session";

type Source = DeferredApproval["source"];
/** A deferred approval request whose agent is known. */
type DeferredNotice = AgentApprovalRequest & {
  agentId: string;
  approvalMode: "live" | "deferred";
  sessionId: string;
};

interface PendingInput {
  active(): boolean;
  answer(answer: PromptAnswer): Promise<void>;
  busy: boolean;
  readonly durable: boolean;
  question: FeedQuestionPayload;
  readonly source: Source;
  /** The choice that reopens the question for a typed answer; cleared once used. */
  writeIn?: string;
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
  /**
   * Authorities this host built over its own policy. Only their deferred
   * approvals are kept across restarts: a custom policy's grants would not
   * be there to resolve them. Kept here so no caller can claim it.
   */
  readonly #durable = new WeakSet<SandboxAuthority>();

  constructor(options: HarnessInteractionsOptions) {
    this.#options = options;
    this.#deferred = new DeferredApprovals(options.pendingPath);
  }

  async restore(): Promise<void> {
    const saved = await this.#deferred.load();
    const records = new Map(
      saved.requests.map((record) => [record.approvalId, record])
    );
    const histories = await this.#histories([
      ...saved.sessions.map((session) => session.sessionId),
      ...saved.requests.map((record) => record.sessionId),
    ]);
    for (const session of saved.sessions) {
      const history = histories.get(session.sessionId);
      for (const request of history?.requests.values() ?? []) {
        if (
          request.approvalMode === "deferred" &&
          request.agentId === session.agentId &&
          request.agentGeneration === session.agentGeneration &&
          !records.has(request.approvalId) &&
          !history?.responses.has(request.approvalId)
        ) {
          records.set(request.approvalId, {
            ...session,
            approvalId: request.approvalId,
          });
        }
      }
    }
    for (const record of records.values()) {
      const history = histories.get(record.sessionId);
      const request = history?.requests.get(record.approvalId);
      const response = history?.responses.get(record.approvalId);
      if (
        request?.approvalMode !== "deferred" ||
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
        true,
        response
      );
      if (response) {
        await this.#deferred.remove(record.approvalId);
      }
    }
  }

  /** Each session's approval requests and responses by approval id, read once per session. */
  async #histories(
    sessionIds: readonly string[]
  ): Promise<Map<string, ApprovalHistory>> {
    const unique = [...new Set(sessionIds)];
    const loaded = await Promise.all(
      unique.map(async (sessionId) => {
        const history: ApprovalHistory = {
          requests: new Map(),
          responses: new Map(),
        };
        const messages = await this.#options.sessions.listMessages(sessionId);
        for (const part of messages.flatMap((message) => message.parts)) {
          if (part.type === "tool_approval_request") {
            if (!history.requests.has(part.approvalId)) {
              history.requests.set(part.approvalId, part);
            }
          } else if (
            part.type === "tool_approval_response" &&
            !history.responses.has(part.approvalId)
          ) {
            history.responses.set(part.approvalId, part);
          }
        }
        return [sessionId, history] as const;
      })
    );
    return new Map(loaded);
  }

  /** Keep a session's deferred approvals across restarts, when `authority` came from this host's own policy. */
  registerSession(
    session: InteractionSession,
    authority: SandboxAuthority
  ): Promise<void> {
    return this.#durable.has(authority)
      ? this.#deferred.register(session)
      : Promise.resolve();
  }

  authority(
    source: Source,
    override?: Pick<
      HarnessAuthoritySettings,
      "policy" | "approve" | "onApprovalRequest"
    >
  ): SandboxAuthority {
    const policy = override?.policy ?? this.#options.policy;
    const durable = policy === this.#options.policy;
    const approve =
      override?.approve ??
      (this.#options.askable
        ? (request: LiveApproval) => this.#approve(source, request)
        : undefined);
    const authority: SandboxAuthority = {
      policy,
      ...(approve ? { approve } : {}),
      onApprovalRequest: async (request) => {
        if (request.approvalMode === "deferred") {
          const { agentId } = request;
          if (!agentId) {
            throw new Error("Approval has no agent identity.");
          }
          if (durable) {
            await this.#deferred.put({
              agentId,
              approvalId: request.approvalId,
              sessionId: request.sessionId,
              source,
              ...(request.agentGeneration === undefined
                ? {}
                : { agentGeneration: request.agentGeneration }),
            });
          }
          await this.#publishDeferred(
            { ...request, agentId },
            source,
            policy,
            durable
          );
        }
        await override?.onApprovalRequest?.(request);
      },
    };
    if (durable) {
      this.#durable.add(authority);
    }
    return authority;
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
        request.signal
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
      if (pending.writeIn !== undefined && answer.choice === pending.writeIn) {
        pending.question = { ...pending.question, choices: [] };
        pending.writeIn = undefined;
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
    return this.#wait(source, approvalPrompt(request), request.signal);
  }

  async #publishDeferred(
    request: DeferredNotice,
    source: Source,
    policy: AgentAuthorizer,
    durable: boolean,
    response?: { approved: boolean; reason?: string }
  ): Promise<void> {
    const { agentId } = request;
    const prompt = deferredPrompt(request, durable);
    const { question } = prompt;
    if (response) {
      await this.#options.feed.publishInput(question, source, {
        answer: prompt.choiceFor(response.approved),
        status: "answered",
        ...(response.reason ? { note: response.reason } : {}),
      });
      return;
    }
    let resolved: PromptAnswer | undefined;
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
              approved: prompt.parse(answer),
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

  #wait<T>(source: Source, prompt: Prompt<T>, signal: AbortSignal): Promise<T> {
    if (this.#shutdown.signal.aborted) {
      return Promise.reject(
        new Error("The host is no longer accepting agent input.")
      );
    }
    const pending = this.#open(
      source,
      prompt,
      AbortSignal.any([signal, this.#shutdown.signal])
    );
    this.#waits.add(pending);
    pending.finally(() => this.#waits.delete(pending)).catch(() => undefined);
    return pending;
  }

  async #open<T>(
    source: Source,
    { parse, question, writeIn }: Prompt<T>,
    signal: AbortSignal
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
        ...(writeIn === undefined ? {} : { writeIn }),
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

/** One session's approval requests and responses, by approval id. */
interface ApprovalHistory {
  readonly requests: Map<string, ApprovalRequestPart>;
  readonly responses: Map<string, ApprovalResponsePart>;
}

type MessagePart = SessionMessage["parts"][number];
type ApprovalRequestPart = Extract<
  MessagePart,
  { type: "tool_approval_request" }
>;
type ApprovalResponsePart = Extract<
  MessagePart,
  { type: "tool_approval_response" }
>;
