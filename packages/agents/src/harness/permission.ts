import type { AccessRequest, Grant } from "@foundry/authorization";
import { AuthorizationStateError, grantId } from "@foundry/authorization";
import type {
  HarnessPermissionCallback,
  HarnessPermissionRequest,
} from "@foundry/core/agents";
import { validateHarnessProfile } from "@foundry/core/agents";
import { withAbort } from "@foundry/lib/abort";
import type { ApprovalResolution } from "../authorization/authorization";
import {
  agentPrincipal,
  agentPrincipalMatcher,
  capabilityToAccessRequest,
  capabilityToScope,
  HOST_APPROVER,
} from "../authorization/authorization";
import type { Capability } from "../authorization/capability";
import type { SessionPart } from "../schema";
import type { AgentApprovalRequest } from "../session/events";
import { Sessions } from "../session/sessions";
import type { HarnessAuthoritySettings } from "./harness-session";
import { applyHarnessProfile } from "./permission-profile";
import { deriveInvocationId } from "./tool-compiler";

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

function capabilityFor(
  request: Pick<HarnessPermissionRequest, "capability" | "source" | "toolName">
): Capability {
  return (
    request.capability ?? {
      kind: "tool.call",
      source: request.source ?? "harness",
      tool: request.toolName,
    }
  );
}

function accessRequestFor(
  settings: Pick<
    HarnessAuthoritySettings,
    "agentGeneration" | "agentId" | "authoritySessionId" | "principalAttributes"
  >,
  request: Pick<
    HarnessPermissionRequest,
    | "activityId"
    | "capability"
    | "input"
    | "sessionId"
    | "source"
    | "toolCallId"
    | "toolName"
  >,
  waitsForApproval: boolean
): {
  readonly accessRequest: AccessRequest;
  readonly capability: Capability;
  readonly invocationId: string;
  readonly requestedBy: ReturnType<typeof agentPrincipal>;
} {
  const capability = capabilityFor(request);
  const authoritySessionId = settings.authoritySessionId ?? request.sessionId;
  const invocationId = deriveInvocationId(
    {
      agentGeneration: settings.agentGeneration,
      agentId: settings.agentId,
      sessionId: request.sessionId,
    },
    request.toolCallId
  );
  const accessRequest = capabilityToAccessRequest({
    agentGeneration: settings.agentGeneration,
    agentId: settings.agentId,
    capability,
    input: request.input,
    invocationId,
    sessionId: authoritySessionId,
  });
  const requestedBy = agentPrincipal(
    settings.agentId,
    settings.agentGeneration,
    {
      ...settings.principalAttributes,
      agentId: settings.agentId,
      ...(settings.agentGeneration === undefined
        ? {}
        : { agentGeneration: settings.agentGeneration }),
      approvalMode: waitsForApproval ? "live" : "deferred",
      inputSummary: summarizeHarnessInput(request.input),
      recordSessionId: request.sessionId,
      sessionId: authoritySessionId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      toolSource: request.source ?? "harness",
      ...(request.activityId === undefined
        ? {}
        : { activityId: request.activityId }),
    }
  );
  return { accessRequest, capability, invocationId, requestedBy };
}

export function createHarnessPermission(
  settings: HarnessAuthoritySettings
): HarnessPermissionCallback {
  validateHarnessProfile(settings.profile);
  const waitsForApproval =
    settings.profile.mode === "attended" &&
    settings.profile.unresolved === "ask" &&
    settings.approve !== undefined;
  const appliedSessions = new Map<string, Promise<void>>();

  return async (request) => {
    request.signal.throwIfAborted();
    const authoritySessionId = settings.authoritySessionId ?? request.sessionId;
    let applying = appliedSessions.get(authoritySessionId);
    if (applying === undefined) {
      const pending = applyHarnessProfile(
        settings.authorization,
        settings.profile,
        {
          agentGeneration: settings.agentGeneration,
          agentId: settings.agentId,
          includeGrants: settings.skipProfileGrants !== true,
          sessionId: authoritySessionId,
        }
      ).then(
        () => undefined,
        (error: unknown) => {
          appliedSessions.delete(authoritySessionId);
          throw error;
        }
      );
      appliedSessions.set(authoritySessionId, pending);
      applying = pending;
    }
    await applying;

    const { accessRequest, capability, invocationId, requestedBy } =
      accessRequestFor(settings, request, waitsForApproval);

    const decision = await settings.authorization.check(accessRequest);
    if (decision.kind === "deny") {
      return { behavior: "deny", message: decision.reason };
    }
    if (decision.kind === "allow") {
      const outcome = await settings.authorization.authorize(
        accessRequest,
        invocationId,
        { openPending: false, signal: request.signal }
      );
      if (outcome.kind === "permitted") {
        outcome.permit.release();
        return { behavior: "allow" };
      }
      if (outcome.kind === "denied") {
        return { behavior: "deny", message: outcome.reason };
      }
    }

    const pendingGrant = await settings.authorization.request({
      holder: agentPrincipalMatcher(settings.agentId, settings.agentGeneration),
      invocationId,
      requestedBy,
      scope: capabilityToScope(capability),
      sessionId: authoritySessionId,
    });
    const approval = await recordApprovalRequest(
      settings,
      request,
      capability,
      pendingGrant.id,
      waitsForApproval
    );
    const { approve } = settings;
    if (!(waitsForApproval && approve)) {
      return {
        behavior: "deny",
        message: `Needs approval: ${request.toolName}. The request was recorded for a future run.`,
      };
    }

    return await resolveLiveHarnessApproval(
      settings,
      approve,
      request,
      pendingGrant,
      approval,
      capability,
      authoritySessionId,
      accessRequest,
      invocationId
    );
  };
}

async function resolveLiveHarnessApproval(
  settings: HarnessAuthoritySettings,
  approve: NonNullable<HarnessAuthoritySettings["approve"]>,
  request: HarnessPermissionRequest,
  pendingGrant: Grant,
  approval: AgentApprovalRequest,
  capability: Capability,
  authoritySessionId: string,
  accessRequest: AccessRequest,
  invocationId: string
): Promise<{ behavior: "allow" } | { behavior: "deny"; message: string }> {
  let resolution: ApprovalResolution;
  try {
    resolution = await withAbort(
      approve({
        ...approval,
        input: request.input,
        inputSummary: summarizeHarnessInput(request.input),
        sessionId: request.sessionId,
        signal: request.signal,
        ...(request.title
          ? { title: redactHarnessSummary(request.title) }
          : {}),
        suggestions: request.suggestions,
      }),
      request.signal
    );
    request.signal.throwIfAborted();
  } catch (error) {
    await settings.authorization
      .revoke(
        { grantId: pendingGrant.id, kind: "grant" },
        "Live approval cancelled"
      )
      .catch(() => undefined);
    throw error;
  }

  await applyGrantResolution(
    settings,
    pendingGrant,
    capability,
    request.sessionId,
    authoritySessionId,
    resolution
  );

  if (!resolution.approved) {
    return {
      behavior: "deny",
      message: resolution.reason ?? "Denied by approver.",
    };
  }

  request.signal.throwIfAborted();
  const retry = await settings.authorization.authorize(
    accessRequest,
    invocationId,
    { openPending: false, signal: request.signal }
  );
  if (retry.kind === "permitted") {
    retry.permit.release();
    return { behavior: "allow" };
  }
  return {
    behavior: "deny",
    message:
      retry.kind === "denied"
        ? retry.reason
        : "Approval required but not yet resolved.",
  };
}

async function recordApprovalRequest(
  settings: HarnessAuthoritySettings,
  request: HarnessPermissionRequest,
  capability: Capability,
  approvalId: string,
  waitsForApproval: boolean
): Promise<AgentApprovalRequest> {
  const approval: AgentApprovalRequest = {
    activityId: request.activityId,
    agentGeneration: settings.agentGeneration,
    agentId: settings.agentId,
    approvalId,
    capability,
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

async function applyGrantResolution(
  settings: Pick<HarnessAuthoritySettings, "authorization" | "store">,
  grant: Grant,
  capability: Capability,
  sessionId: string,
  authoritySessionId: string,
  resolution: ApprovalResolution
): Promise<void> {
  const approver = resolution.approver ?? HOST_APPROVER;
  const lifetime = resolution.lifetime ?? "once";
  if (resolution.approved) {
    await settings.authorization.approve(grant.id, {
      approver,
      ...(resolution.reason === undefined ? {} : { reason: resolution.reason }),
      rootAuthority: true,
      usesRemaining: 1,
    });
    if (lifetime === "session" || lifetime === "persistent") {
      await settings.authorization.grant({
        canDelegate: true,
        holder: grant.holder,
        issuanceKey: `approval:${grant.id}:${lifetime}`,
        issuer: approver,
        ...(resolution.reason === undefined
          ? {}
          : { reason: resolution.reason }),
        requestedBy: grant.requestedBy,
        scope: capabilityToScope(capability),
        ...(lifetime === "session" ? { sessionId: authoritySessionId } : {}),
      });
    }
  } else {
    await settings.authorization.deny(grant.id, {
      approver,
      reason: resolution.reason ?? "Denied by approver.",
    });
  }

  await new Sessions({ store: settings.store }).appendMessage({
    parts: [
      {
        approvalId: grant.id,
        approved: resolution.approved,
        ...(resolution.approved
          ? { granted: true }
          : { reason: resolution.reason }),
        scope: lifetime === "persistent" ? "always" : "once",
        type: "tool_approval_response",
      },
    ],
    role: "system",
    sessionId,
  });
}

function grantBelongsToAgent(
  grant: Grant,
  agentId: string,
  agentGeneration?: number
): boolean {
  if (grant.holder.kind !== "exact") {
    return false;
  }
  const { principal } = grant.holder;
  if (principal.kind !== "agent" || principal.id !== agentId) {
    return false;
  }
  const expectedVersion =
    agentGeneration === undefined ? undefined : String(agentGeneration);
  return principal.version === expectedVersion;
}

function capabilityFromGrantOrHistory(
  grant: Grant,
  part?: Extract<SessionPart, { type: "tool_approval_request" }>
): Capability {
  if (part !== undefined) {
    return part.capability;
  }
  const fallbackTool =
    grant.scope.target.kind === "exact" ? grant.scope.target.value : "unknown";
  const toolName =
    typeof grant.requestedBy.attributes?.toolName === "string"
      ? grant.requestedBy.attributes.toolName
      : fallbackTool;
  const toolSource =
    typeof grant.requestedBy.attributes?.toolSource === "string"
      ? (grant.requestedBy.attributes.toolSource as
          | "harness"
          | "builtin"
          | "declared"
          | "skill"
          | "mcp"
          | "mesh"
          | "module")
      : "harness";
  return {
    kind: "tool.call",
    source: toolSource,
    tool: toolName,
  };
}

export async function resolveHarnessApproval(
  settings: Pick<
    HarnessAuthoritySettings,
    | "agentGeneration"
    | "agentId"
    | "authoritySessionId"
    | "authorization"
    | "store"
  >,
  sessionId: string,
  approvalId: string,
  resolution: ApprovalResolution
): Promise<void> {
  const grant = await settings.authorization.getGrant(grantId(approvalId));
  if (
    grant === null ||
    !grantBelongsToAgent(grant, settings.agentId, settings.agentGeneration)
  ) {
    throw new Error(
      "Approval does not belong to this harness agent generation."
    );
  }
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
  const capability = capabilityFromGrantOrHistory(grant, part);
  if (
    capability.kind !== "tool.call" ||
    (capability.source !== "harness" && capability.source !== "builtin")
  ) {
    throw new Error(
      "Approval does not belong to this harness agent generation."
    );
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

  try {
    await applyGrantResolution(
      settings,
      grant,
      capability,
      sessionId,
      settings.authoritySessionId ?? grant.sessionId ?? sessionId,
      resolution
    );
  } catch (error) {
    if (error instanceof AuthorizationStateError) {
      throw new Error(`Approval "${approvalId}" already has a response`, {
        cause: error,
      });
    }
    throw error;
  }
}
