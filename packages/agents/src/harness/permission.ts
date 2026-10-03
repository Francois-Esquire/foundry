import { randomUUID } from "node:crypto";

import type {
  AgentAuthorizationDecision,
  AgentAuthorizationRequest,
  ApprovalResolution,
} from "../authorization";
import type { AgentApprovalRequest, SessionPart } from "../session";
import { validateApprovalResponse } from "../session/converter";
import { harnessProfileDecision } from "./permission-profile";
import { toolAuthorizationRequest } from "./tool-compiler";
import type {
  HarnessAuthoritySettings,
  HarnessPermissionCallback,
  HarnessPermissionRequest,
} from "./turn-driver";
import { validateHarnessProfile } from "./turn-driver";

const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|token|password|passwd|secret|authorization)(["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi;
const BEARER = /\bBearer\s+[^\s"']+/gi;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi;
const MAX_SUMMARY = 240;

/** Never records arbitrary string values or commands. Values can contain secrets. */
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

/** Limit persisted summaries by default; Infinity permits a full redacted live preview. */
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
    agentId: settings.agentId,
    ...(settings.agentGeneration === undefined
      ? {}
      : { agentGeneration: settings.agentGeneration }),
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

/** Resolve live native requests through the same policy and grants as compiled tools. */
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
    agentId: settings.agentId,
    approvalId: randomUUID(),
    ...(settings.agentGeneration === undefined
      ? {}
      : { agentGeneration: settings.agentGeneration }),
    capability: auth.capability,
    input: summarizeHarnessInput(request.input),
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    ...(request.activityId === undefined
      ? {}
      : { activityId: request.activityId }),
  };
  await settings.store.appendMessage({
    parts: [
      {
        agentId: settings.agentId,
        approvalId: approval.approvalId,
        approvalMode: waitsForApproval ? "live" : "deferred",
        capability: approval.capability,
        input: approval.input,
        name: approval.toolName,
        toolCallId: approval.toolCallId,
        type: "tool_approval_request",
        ...(approval.activityId === undefined
          ? {}
          : { activityId: approval.activityId }),
        ...(settings.agentGeneration === undefined
          ? {}
          : { agentGeneration: settings.agentGeneration }),
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
  const resolution = await abortableApproval(
    approve({
      ...approval,
      input: request.input,
      inputSummary: summarizeHarnessInput(request.input),
      sessionId: request.sessionId,
      signal: request.signal,
      ...(request.title ? { title: redactHarnessSummary(request.title) } : {}),
      ...(request.suggestions === undefined
        ? {}
        : { suggestions: request.suggestions }),
    }),
    request.signal
  );
  request.signal.throwIfAborted();
  const decision = await settings.policy.resolveApproval(auth, resolution);
  await settings.store.appendMessage({
    parts: [
      {
        approvalId: approval.approvalId,
        approved: decision.kind === "allow",
        scope: resolution.lifetime === "persistent" ? "always" : "once",
        type: "tool_approval_response",
        ...(decision.kind === "deny" ? { reason: decision.reason } : {}),
      },
    ],
    role: "system",
    sessionId: request.sessionId,
  });
  return decision;
}

async function abortableApproval<T>(
  pending: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new Error("Approval interrupted."));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    if (abort) {
      signal.removeEventListener("abort", abort);
    }
  }
}

/** A scheduled request grants authority for a future invocation, never replays the CLI turn. */
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
    if (
      history.some((message) =>
        message.parts.some(
          (value) =>
            value.type === "tool_approval_response" &&
            value.approvalId === approvalId
        )
      )
    ) {
      throw new Error(`Approval "${approvalId}" already has a response`);
    }
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
  const decision = await settings.policy.resolveApproval(auth, resolution);
  await settings.store.appendMessage({
    parts: [
      {
        approvalId,
        approved: decision.kind === "allow",
        scope: resolution.lifetime === "persistent" ? "always" : "once",
        type: "tool_approval_response",
        ...(decision.kind === "deny" ? { reason: decision.reason } : {}),
      },
    ],
    role: "system",
    sessionId,
  });
}
