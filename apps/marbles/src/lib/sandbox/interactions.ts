import type {
  ApprovalResolution,
  Capability,
  ToolSource,
} from "@foundry/agents/authorization";
import type {
  HarnessAuthoritySettings,
  HarnessQuestionRequest,
  HarnessQuestionResult,
} from "@foundry/agents/harness";
import { resolveHarnessApproval } from "@foundry/agents/harness";
import type { AgentApprovalRequest } from "@foundry/agents/session";
import type { SessionStore } from "@foundry/agents/store";
import type { Authorization, Grant } from "@foundry/authorization";
import type { FeedPublisher } from "~/lib/feed";
import {
  type FeedAnswer,
  type FeedQuestionPayload,
  readAnswer,
} from "~/lib/feed/entry";
import type { SandboxAuthority } from "~/lib/sandbox";
import {
  approvalPrompt,
  deferredPrompt,
  type LiveApproval,
  type Prompt,
  type PromptAnswer,
  questionPrompt,
} from "./interaction-prompts";

export interface InteractionSource {
  readonly definition: string;
  readonly path: readonly string[];
  readonly runId: string;
}

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
  readonly source: InteractionSource;
  writeIn?: string;
}

export interface HarnessInteractionsOptions {
  readonly askable: boolean;
  readonly authorization: Authorization;
  readonly feed: FeedPublisher;
  readonly sessions: SessionStore;
}

function parseSource(value: unknown): InteractionSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.definition !== "string" ||
    typeof candidate.runId !== "string" ||
    !Array.isArray(candidate.path) ||
    !candidate.path.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  return {
    definition: candidate.definition,
    path: [...candidate.path],
    runId: candidate.runId,
  };
}

function deferredNoticeFromGrant(
  grant: Grant
):
  | { readonly notice: DeferredNotice; readonly source: InteractionSource }
  | undefined {
  const attrs = grant.requestedBy.attributes;
  if (attrs?.approvalMode !== "deferred") {
    return undefined;
  }
  const source = parseSource(attrs.marblesSource);
  if (!source) {
    return undefined;
  }
  const agentId =
    grant.holder.kind === "exact"
      ? grant.holder.principal.id
      : grant.requestedBy.id;
  const versionRaw =
    grant.holder.kind === "exact"
      ? grant.holder.principal.version
      : grant.requestedBy.version;
  const agentGeneration =
    versionRaw !== undefined && Number.isInteger(Number(versionRaw))
      ? Number(versionRaw)
      : undefined;
  const sessionId =
    typeof attrs.recordSessionId === "string"
      ? attrs.recordSessionId
      : (grant.sessionId ?? "");
  if (!sessionId) {
    return undefined;
  }
  const fallbackTool =
    grant.scope.target.kind === "exact" ? grant.scope.target.value : "unknown";
  const toolName =
    typeof attrs.toolName === "string" ? attrs.toolName : fallbackTool;
  const toolSource =
    typeof attrs.toolSource === "string"
      ? (attrs.toolSource as ToolSource)
      : "harness";
  const capability: Capability = {
    kind: "tool.call",
    source: toolSource,
    tool: toolName,
  };
  return {
    notice: {
      ...(typeof attrs.activityId === "string"
        ? { activityId: attrs.activityId }
        : {}),
      ...(agentGeneration === undefined ? {} : { agentGeneration }),
      agentId,
      approvalId: grant.id,
      approvalMode: "deferred",
      capability,
      input: typeof attrs.inputSummary === "string" ? attrs.inputSummary : "",
      sessionId,
      toolCallId:
        typeof attrs.toolCallId === "string" ? attrs.toolCallId : grant.id,
      toolName,
    },
    source,
  };
}

export class HarnessInteractions {
  readonly #options: HarnessInteractionsOptions;
  readonly #pending = new Map<string, PendingInput>();
  readonly #waits = new Set<Promise<unknown>>();
  readonly #shutdown = new AbortController();

  constructor(options: HarnessInteractionsOptions) {
    this.#options = options;
  }

  async restore(): Promise<void> {
    const pendingGrants = await this.#options.authorization.listGrants({
      state: "pending",
    });
    for (const grant of pendingGrants) {
      const parsed = deferredNoticeFromGrant(grant);
      if (!parsed) {
        continue;
      }
      const current = await this.#options.authorization.getGrant(grant.id);
      if (current?.state !== "pending") {
        continue;
      }
      await this.#publishDeferred(
        parsed.notice,
        parsed.source,
        this.#options.authorization,
        true
      );
    }
  }

  authority(
    source: InteractionSource,
    override?: Partial<
      Pick<
        HarnessAuthoritySettings,
        | "approve"
        | "authorization"
        | "onApprovalRequest"
        | "principalAttributes"
      >
    >
  ): SandboxAuthority {
    const authorization =
      override?.authorization ?? this.#options.authorization;
    const durable = authorization === this.#options.authorization;
    const approve =
      override?.approve ??
      (this.#options.askable
        ? (request: LiveApproval) => this.#approve(source, request)
        : undefined);
    return {
      authorization,
      ...(approve ? { approve } : {}),
      onApprovalRequest: async (request) => {
        if (request.approvalMode === "deferred") {
          const { agentId } = request;
          if (!agentId) {
            throw new Error("Approval has no agent identity.");
          }
          await this.#publishDeferred(
            { ...request, agentId },
            source,
            authorization,
            durable
          );
        }
        await override?.onApprovalRequest?.(request);
      },
      principalAttributes: {
        ...override?.principalAttributes,
        marblesSource: {
          definition: source.definition,
          path: [...source.path],
          runId: source.runId,
        },
      },
    };
  }

  async question(
    source: InteractionSource,
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

  #approve(
    source: InteractionSource,
    request: LiveApproval
  ): Promise<ApprovalResolution> {
    return this.#wait(source, approvalPrompt(request), request.signal);
  }

  async #publishDeferred(
    request: DeferredNotice,
    source: InteractionSource,
    authorization: Authorization,
    durable: boolean
  ): Promise<void> {
    const { agentId } = request;
    const prompt = deferredPrompt(request, durable);
    const { question } = prompt;
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
              authorization,
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
      },
      busy: false,
      durable,
      question,
      source,
    });
  }

  #wait<T>(
    source: InteractionSource,
    prompt: Prompt<T>,
    signal: AbortSignal
  ): Promise<T> {
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
    source: InteractionSource,
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
