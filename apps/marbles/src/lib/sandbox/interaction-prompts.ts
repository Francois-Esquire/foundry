import type { ApprovalResolution } from "@foundry/agents/authorization";
import type {
  HarnessAuthoritySettings,
  HarnessQuestion,
  HarnessQuestionRequest,
} from "@foundry/agents/harness";
import { redactHarnessSummary } from "@foundry/agents/harness";
import type { AgentApprovalRequest } from "@foundry/agents/session";
import type { FeedQuestionPayload, readAnswer } from "~/lib/feed/entry";

const APPROVE_ONCE = "Approve once";
const APPROVE_SESSION = "Allow for this session";
const APPROVE_FUTURE = "Allow future runs";
const DENY = "Deny";
const OTHER = "Write another answer";
const DECLINE = "Decline to answer";

/** A live approval request, as the harness hands it to the host. */
export type LiveApproval = Parameters<
  NonNullable<HarnessAuthoritySettings["approve"]>
>[0];

/** An answer from the feed, already checked against the offered choices. */
export type PromptAnswer = ReturnType<typeof readAnswer>;

/** A question for a person and how to read their answer to it. */
export interface Prompt<T> {
  parse(answer: PromptAnswer): T;
  readonly question: FeedQuestionPayload;
  /** The choice that asks for a typed answer instead, when one is offered. */
  readonly writeIn?: string;
}

/** A deferred approval can also be shown answered, from a response already recorded. */
interface DeferredPrompt extends Prompt<boolean> {
  /** The choice that stands for a recorded approval or denial. */
  choiceFor(approved: boolean): string;
}

export function approvalPrompt(
  request: LiveApproval
): Prompt<ApprovalResolution> {
  return {
    parse: (answer) => ({
      approved: answer.choice !== DENY,
      lifetime: answer.choice === APPROVE_SESSION ? "session" : "once",
      ...(answer.note ? { reason: answer.note } : {}),
    }),
    question: {
      activityId: request.activityId,
      body: `Agent: ${request.agentId}\n\nTool: ${request.toolName}\n\n${operationSummary(request.input)}\n\nA session grant applies to this tool for this agent, not just these arguments.`,
      choices: [APPROVE_ONCE, APPROVE_SESSION, DENY],
      delivery: "live",
      key: request.approvalId,
      mode: "approval",
      sessionId: request.sessionId,
      title: request.title ?? `Allow ${request.toolName}?`,
    },
  };
}

/** A refused action's grant for future runs; `durable` when it waits across restarts. */
export function deferredPrompt(
  request: AgentApprovalRequest,
  durable: boolean
): DeferredPrompt {
  return {
    choiceFor: (approved) => (approved ? APPROVE_FUTURE : DENY),
    parse: (answer) => answer.choice === APPROVE_FUTURE,
    question: {
      activityId: request.activityId,
      body: `Agent: ${request.agentId}\n\nTool: ${request.toolName}\n\n${String(request.input)}\n\nThe action was refused. Approval grants this tool to this agent in future runs; it does not replay the refused action.`,
      choices: [APPROVE_FUTURE, DENY],
      ...(durable ? { delivery: "deferred" as const } : {}),
      key: request.approvalId,
      mode: "approval",
      title: `Future permission: ${request.toolName}`,
    },
  };
}

/** One question; its answer is the selections, or undefined when declined. */
export function questionPrompt(
  request: HarnessQuestionRequest,
  question: HarnessQuestion
): Prompt<string[] | undefined> {
  const labels = question.options?.map((option) => option.label) ?? [];
  const offered =
    !question.multiSelect &&
    labels.length > 0 &&
    labels.length <= 7 &&
    !labels.includes(OTHER) &&
    !labels.includes(DECLINE);
  return {
    parse: (answer) => questionAnswer(question, answer.choice),
    question: {
      activityId: request.activityId,
      body: [
        question.question,
        ...(question.options ?? []).map(
          (option) =>
            `- ${option.label}${option.description ? `: ${option.description}` : ""}`
        ),
        question.multiSelect
          ? "Enter one or more answers, separated by semicolons. Type /decline to decline."
          : "Type /decline to decline.",
      ].join("\n\n"),
      choices: offered ? [...labels, OTHER, DECLINE] : [],
      delivery: "live",
      key: `question:${request.sessionId}:${request.toolCallId}:${question.id}`,
      mode: "question",
      sessionId: request.sessionId,
      title: question.header ?? question.question,
    },
    ...(offered ? { writeIn: OTHER } : {}),
  };
}

function questionAnswer(
  question: HarnessQuestion,
  choice: string
): string[] | undefined {
  if (choice === DECLINE || choice === "/decline") {
    return;
  }
  if (!question.multiSelect) {
    return [choice];
  }
  const selections = choice
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  if (selections.length === 0) {
    throw new Error("Enter at least one answer.");
  }
  return [...new Set(selections)];
}

function operationSummary(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "Review the requested tool before approving.";
  }
  const fields = Object.entries(input).filter(
    ([key, value]) =>
      [
        "command",
        "file_path",
        "path",
        "cwd",
        "workflow",
        "at",
        "source",
        "input",
        "key",
        "id",
        "enabled",
        "title",
        "task",
      ].includes(key) && value !== undefined
  );
  return fields
    .map(
      ([key, value]) =>
        `${key}: ${redactHarnessSummary(typeof value === "string" ? value : JSON.stringify(value), Number.POSITIVE_INFINITY)}`
    )
    .join("\n");
}
