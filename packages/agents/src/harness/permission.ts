import type {
  HarnessPermissionCallback,
  HarnessPermissionRequest,
} from "@foundry/core/agents";
import { validateHarnessProfile } from "@foundry/core/agents";
import type { ApprovalResolution } from "@foundry/lib/config/authorization";
import type {
  AgentAuthorizationDecision,
  AgentAuthorizationRequest,
} from "../authorization/authorization";
import type { SessionMessage, SessionPart } from "../schema";
import { validateApprovalResponse } from "../session/converter";
import type { AgentApprovalRequest } from "../session/events";
import { Sessions } from "../session/sessions";
import { raceAbort } from "./abortable";
import type { HarnessAuthoritySettings } from "./harness-session";
import { harnessProfileDecision } from "./permission-profile";
import { toolAuthorizationRequest } from "./tool-compiler";

const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|token|password|passwd|secret|authorization)(["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi;
const BEARER = /\bBearer\s+[^\s"']+/gi;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi;
const MAX_SUMMARY = 240;

export function summarizeHarnessInput(input: unknown): string {
  if (typeof input === "string") {
    return `[string: ${input.length} characters]`;
  }
  if (!input || typeof input !== "object") {
    return `[${input === null ? "null" : typeof input}]`;
  }
  if (Array.isArray(input)) {
    return `[array: ${input.length} items]`;
  }
  const keys = Object.keys(input)
    .slice(0, 12)
    .map((key) => key.slice(0, 40));
  return redactHarnessSummary(`fields: ${keys.join(", ")}`);
}

export function redactHarnessSummary(
  summary: string,
  maxLength = MAX_SUMMARY
): string {
  if (
    maxLength !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maxLength) || maxLength < 1)
  ) {
    throw new Error(
      "Harness summary length must be a positive safe integer or Infinity."
    );
  }
  return summary
    .replace(BEARER, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT, "$1$2[redacted]")
    .replace(URL_CREDENTIALS, "$1[redacted]@")
    .slice(0, maxLength);
}

function authorizationRequest(
  settings: Pick<HarnessAuthoritySettings, "agentId" | "agentGeneration">,
  request: Pick<
    HarnessPermissionRequest,
    "sessionId" | "toolName" | "toolCallId" | "input" | "source" | "capability"
  >
): AgentAuthorizationRequest {
  return toolAuthorizationRequest({
    agentGeneration: settings.agentGeneration,
    agentId: settings.agentId,
    capability: request.capability ?? {
      kind: "tool.call",
      source: request.source ?? "harness",
      tool: request.toolName,
    },
    input: request.input,
    sessionId: request.sessionId,
    tool: { name: request.toolName, source: request.source ?? "harness" },
    toolCallId: request.toolCallId,
  });
}

export function createHarnessPermission(
  settings: HarnessAuthoritySettings
): HarnessPermissionCallback {
  validateHarnessProfile(settings.profile);
  const waitsForApproval =
    settings.profile.mode === "attended" &&
    settings.profile.unresolved === "ask" &&
    settings.approve !== undefined;
  return async (request) => {
    request.signal.throwIfAborted();
    const posture = harnessProfileDecision(settings.profile, request);
    if (posture === "deny") {
      return { behavior: "deny", message: "Denied by harness profile." };
    }
    const auth = authorizationRequest(settings, request);
    let decision = await settings.policy.decide(auth);
    if (decision.kind === "requires-approval" && posture === "allow") {
      decision = { kind: "allow", source: "kind-policy" };
    }
    if (decision.kind === "requires-approval") {
      const approval = await recordApprovalRequest(
        settings,
        request,
        auth,
        waitsForApproval
      );
      if (!waitsForApproval) {
        return {
          behavior: "deny",
          message: `Needs approval: ${request.toolName}. The request was recorded for a future run.`,
        };
      }
      decision = await resolveLiveApproval(settings, request, auth, approval);
    }
    request.signal.throwIfAborted();
    const claim = await settings.policy.claim(auth, decision);
    return claim.kind === "authorized"
      ? { behavior: "allow" }
      : { behavior: "deny", message: claim.reason };
  };
}

async function recordApprovalRequest(
  settings: HarnessAuthoritySettings,
  request: HarnessPermissionRequest,
  auth: AgentAuthorizationRequest,
  waitsForApproval: boolean
): Promise<AgentApprovalRequest> {
  const approval: AgentApprovalRequest = {
    activityId: request.activityId,
    agentGeneration: settings.agentGeneration,
    agentId: settings.agentId,
    approvalId: crypto.randomUUID(),
    capability: auth.capability,
    input: summarizeHarnessInput(request.input),
    toolCallId: request.toolCallId,
    toolName: request.toolName,
  };
  await new Sessions({ store: settings.store }).appendMessage({
    parts: [
      {
        activityId: approval.activityId,
        agentGeneration: settings.agentGeneration,
        agentId: settings.agentId,
        approvalId: approval.approvalId,
        approvalMode: waitsForApproval ? "live" : "deferred",
        capability: approval.capability,
        input: approval.input,
        name: approval.toolName,
        toolCallId: approval.toolCallId,
        type: "tool_approval_request",
      },
    ],
    role: "system",
    sessionId: request.sessionId,
  });
  await settings.onApprovalRequest?.({
    ...approval,
    approvalMode: waitsForApproval ? "live" : "deferred",
    sessionId: request.sessionId,
  });
  return approval;
}

async function resolveLiveApproval(
  settings: HarnessAuthoritySettings & {
    approve?: HarnessAuthoritySettings["approve"];
  },
  request: HarnessPermissionRequest,
  auth: AgentAuthorizationRequest,
  approval: AgentApprovalRequest
): Promise<AgentAuthorizationDecision> {
  const { approve } = settings;
  if (!approve) {
    throw new Error("No live approver configured.");
  }
  const resolution = await raceAbort(
    approve({
      ...approval,
      input: request.input,
      inputSummary: summarizeHarnessInput(request.input),
      sessionId: request.sessionId,
      signal: request.signal,
      ...(request.title ? { title: redactHarnessSummary(request.title) } : {}),
      suggestions: request.suggestions,
    }),
    request.signal
  );
  request.signal.throwIfAborted();
  return await recordApprovalResponse(
    settings,
    auth,
    request.sessionId,
    approval.approvalId,
    resolution
  );
}

async function recordApprovalResponse(
  settings: Pick<HarnessAuthoritySettings, "store" | "policy">,
  auth: AgentAuthorizationRequest,
  sessionId: string,
  approvalId: string,
  resolution: ApprovalResolution
): Promise<AgentAuthorizationDecision> {
  const decision = await settings.policy.resolveApproval(auth, resolution);
  await new Sessions({ store: settings.store }).appendMessage({
    parts: [
      {
        approvalId,
        approved: decision.kind === "allow",
        reason: decision.kind === "deny" ? decision.reason : undefined,
        scope: resolution.lifetime === "persistent" ? "always" : "once",
        type: "tool_approval_response",
      },
    ],
    role: "system",
    sessionId,
  });
  return decision;
}

export async function resolveHarnessApproval(
  settings: Pick<
    HarnessAuthoritySettings,
    "store" | "policy" | "agentId" | "agentGeneration"
  >,
  sessionId: string,
  approvalId: string,
  resolution: ApprovalResolution
): Promise<void> {
  const history = await settings.store.listMessages(sessionId);
  const part = history
    .flatMap((message) => message.parts)
    .find(
      (
        value
      ): value is Extract<SessionPart, { type: "tool_approval_request" }> =>
        value.type === "tool_approval_request" &&
        value.approvalId === approvalId
    );
  if (
    !part ||
    part.agentId !== settings.agentId ||
    part.agentGeneration !== settings.agentGeneration ||
    part.capability.kind !== "tool.call" ||
    (part.capability.source !== "harness" &&
      part.capability.source !== "builtin")
  ) {
    throw new Error(
      "Approval does not belong to this harness agent generation."
    );
  }
  if (part.approvalMode === "deferred") {
    refuseOtherAnswer(history, approvalId, resolution);
  } else {
    validateApprovalResponse(history, {
      approvalId,
      approved: resolution.approved,
      type: "tool_approval_response",
    });
  }
  if (
    resolution.approved &&
    resolution.lifetime !== "persistent" &&
    resolution.lifetime !== "session"
  ) {
    throw new Error(
      "A deferred harness approval requires a session or persistent grant for the next run."
    );
  }
  const auth = authorizationRequest(settings, {
    capability: part.capability,
    input: part.input,
    sessionId,
    source: part.capability.source,
    toolCallId: part.toolCallId,
    toolName: part.name,
  });
  if (part.approvalMode === "deferred") {
    await answerDeferredApproval(
      settings,
      auth,
      sessionId,
      approvalId,
      resolution
    );
    return;
  }
  await recordApprovalResponse(
    settings,
    auth,
    sessionId,
    approvalId,
    resolution
  );
}

type ApprovalResponse = Extract<
  SessionPart,
  { type: "tool_approval_response" }
>;

function storedResponse(
  history: readonly SessionMessage[],
  approvalId: string
): ApprovalResponse | undefined {
  return history
    .flatMap((message) => message.parts)
    .find(
      (value): value is ApprovalResponse =>
        value.type === "tool_approval_response" &&
        value.approvalId === approvalId
    );
}

function responseScope(resolution: ApprovalResolution): "always" | "once" {
  return resolution.lifetime === "persistent" ? "always" : "once";
}

function sameAnswer(
  stored: ApprovalResponse,
  resolution: ApprovalResolution
): boolean {
  return (
    stored.approved === resolution.approved &&
    stored.scope === responseScope(resolution)
  );
}

function alreadyAnswered(approvalId: string): Error {
  return new Error(`Approval "${approvalId}" already has a response`);
}

function refuseOtherAnswer(
  history: readonly SessionMessage[],
  approvalId: string,
  resolution: ApprovalResolution
): void {
  const stored = storedResponse(history, approvalId);
  if (stored && !sameAnswer(stored, resolution)) {
    throw alreadyAnswered(approvalId);
  }
}

async function answerDeferredApproval(
  settings: Pick<HarnessAuthoritySettings, "store" | "policy">,
  auth: AgentAuthorizationRequest,
  sessionId: string,
  approvalId: string,
  resolution: ApprovalResolution
): Promise<void> {
  const sessions = new Sessions({ store: settings.store });
  const recorded = await sessions.appendMessageIf(
    {
      parts: [
        {
          approvalId,
          approved: resolution.approved,
          ...(resolution.approved
            ? { granted: false }
            : { reason: resolution.reason }),
          scope: responseScope(resolution),
          type: "tool_approval_response",
        },
      ],
      role: "system",
      sessionId,
    },
    (history) => storedResponse(history, approvalId) === undefined
  );
  if (recorded !== undefined) {
    await grantAnswer(settings, sessions, recorded, auth, resolution);
    return;
  }
  const answer = storedAnswer(
    await settings.store.listMessages(sessionId),
    approvalId
  );
  if (!(answer && sameAnswer(answer.response, resolution))) {
    throw alreadyAnswered(approvalId);
  }
  if (answer.response.granted !== false) {
    return;
  }
  if ((await settings.policy.decide(auth)).kind === "allow") {
    await markGranted(sessions, answer.message);
    return;
  }
  await grantAnswer(settings, sessions, answer.message, auth, resolution);
}

async function grantAnswer(
  settings: Pick<HarnessAuthoritySettings, "policy">,
  sessions: Sessions,
  message: SessionMessage,
  auth: AgentAuthorizationRequest,
  resolution: ApprovalResolution
): Promise<void> {
  const decision = await settings.policy.resolveApproval(auth, resolution);
  if (resolution.approved && decision.kind === "allow") {
    await markGranted(sessions, message);
  }
}

async function markGranted(
  sessions: Sessions,
  message: SessionMessage
): Promise<void> {
  await sessions.updateMessage(message.id, {
    parts: message.parts.map((part) =>
      part.type === "tool_approval_response" ? { ...part, granted: true } : part
    ),
  });
}

function storedAnswer(
  history: readonly SessionMessage[],
  approvalId: string
):
  | { readonly message: SessionMessage; readonly response: ApprovalResponse }
  | undefined {
  for (const message of history) {
    const response = storedResponse([message], approvalId);
    if (response !== undefined) {
      return { message, response };
    }
  }
}
