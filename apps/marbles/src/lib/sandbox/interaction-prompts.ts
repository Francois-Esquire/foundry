import type {
  HarnessAuthoritySettings,
  HarnessQuestion,
  HarnessQuestionRequest,
} from "@foundry/agents/harness";
import { redactHarnessSummary } from "@foundry/agents/harness";
import type { AgentApprovalRequest } from "@foundry/agents/session";
import type { FeedQuestionPayload } from "~/lib/feed/entry";

const APPROVE_ONCE = "Approve once";
export const APPROVE_SESSION = "Allow for this session";
export const APPROVE_FUTURE = "Allow future runs";
export const DENY = "Deny";
export const OTHER = "Write another answer";
const DECLINE = "Decline to answer";
type LiveApproval = Parameters<
  NonNullable<HarnessAuthoritySettings["approve"]>
>[0];

export function approvalPrompt(request: LiveApproval): FeedQuestionPayload {
  return {
    activityId: request.activityId,
    body: `Agent: ${request.agentId}\n\nTool: ${request.toolName}\n\n${operationSummary(request.input)}\n\nA session grant applies to this tool for this agent, not just these arguments.`,
    choices: [APPROVE_ONCE, APPROVE_SESSION, DENY],
    delivery: "live",
    key: request.approvalId,
    mode: "approval",
    sessionId: request.sessionId,
    title: request.title ?? `Allow ${request.toolName}?`,
  };
}

export function deferredPrompt(
  request: AgentApprovalRequest,
  durable = true
): FeedQuestionPayload {
  return {
    activityId: request.activityId,
    body: `Agent: ${request.agentId}\n\nTool: ${request.toolName}\n\n${String(request.input)}\n\nThe action was refused. Approval grants this tool to this agent in future runs; it does not replay the refused action.`,
    choices: [APPROVE_FUTURE, DENY],
    ...(durable ? { delivery: "deferred" as const } : {}),
    key: request.approvalId,
    mode: "approval",
    title: `Future permission: ${request.toolName}`,
  };
}

export function questionPrompt(
  request: HarnessQuestionRequest,
  question: HarnessQuestion
): FeedQuestionPayload {
  const labels = question.options?.map((option) => option.label) ?? [];
  const choices =
    !question.multiSelect &&
    labels.length > 0 &&
    labels.length <= 7 &&
    !labels.includes(OTHER) &&
    !labels.includes(DECLINE)
      ? [...labels, OTHER, DECLINE]
      : [];
  return {
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
    choices,
    delivery: "live",
    key: `question:${request.sessionId}:${request.toolCallId}:${question.id}`,
    mode: "question",
    sessionId: request.sessionId,
    title: question.header ?? question.question,
  };
}

export function questionAnswer(
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
