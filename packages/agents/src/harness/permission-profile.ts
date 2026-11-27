import type {
  AddRestrictionInput,
  Authorization,
  ConstraintBound,
  IssueGrantInput,
  Principal,
  PrincipalMatcher,
  RestrictionId,
  Scope,
} from "@foundry/authorization";
import {
  AuthorizationDeniedError,
  restrictionId,
} from "@foundry/authorization";
import type { HarnessPermissionProfile } from "@foundry/core/agents";
import { validateHarnessProfile } from "@foundry/core/agents";
import {
  AGENT_SUBJECT_NAMESPACE,
  agentPrincipal,
  agentPrincipalMatcher,
  HOST_APPROVER,
} from "../authorization/authorization";

const WILDCARD = /\*+/gu;

export interface CompileHarnessProfileOptions {
  readonly agentGeneration?: number;
  readonly agentId: string;
  readonly requestedBy?: Principal;
  readonly sessionId: string;
}

export interface CompiledHarnessProfile {
  readonly grants: readonly IssueGrantInput[];
  readonly restrictions: readonly AddRestrictionInput[];
}

export function compileHarnessRule(rule: string): Scope {
  const opening = rule.indexOf("(");
  const name = opening < 0 ? rule : rule.slice(0, opening);
  const target = { kind: "exact" as const, value: name.toLowerCase() };
  if (opening < 0) {
    return { action: "tool.call", target };
  }
  if (!rule.endsWith(")")) {
    throw new Error(`Invalid harness permission rule: ${rule}`);
  }
  const pattern = rule.slice(opening + 1, -1);
  let bound: ConstraintBound;
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -2);
    bound = { op: "commandPrefix", value: prefix };
  } else if (pattern.endsWith("*")) {
    if (pattern.slice(0, -1).includes("*")) {
      throw new Error(
        "Harness command rules support only a trailing wildcard."
      );
    }
    const prefix = pattern.replace(WILDCARD, "").trimEnd();
    bound = { op: "commandPrefix", value: prefix };
  } else {
    bound = { op: "eq", value: pattern };
  }
  return {
    action: "tool.call",
    constraints: { command: bound },
    target,
  };
}

export function compileHarnessProfile(
  profile: HarnessPermissionProfile,
  options: CompileHarnessProfileOptions
): CompiledHarnessProfile {
  validateHarnessProfile(profile);
  const holder = agentPrincipalMatcher(
    options.agentId,
    options.agentGeneration
  );
  const requestedBy =
    options.requestedBy ??
    agentPrincipal(options.agentId, options.agentGeneration);
  const restrictionHolder: PrincipalMatcher = {
    attributes: {
      agentId: { op: "eq", value: options.agentId },
      sessionId: { op: "eq", value: options.sessionId },
      ...(options.agentGeneration === undefined
        ? {}
        : { agentGeneration: { op: "eq", value: options.agentGeneration } }),
    },
    kind: "match",
    principalKind: AGENT_SUBJECT_NAMESPACE,
  };
  const keyPrefix = `harness-profile:${options.sessionId}:${options.agentId}:${options.agentGeneration ?? ""}`;

  const restrictions: AddRestrictionInput[] = profile.disallowedTools.map(
    (rule, index) => ({
      holder: restrictionHolder,
      id: restrictionId(`${keyPrefix}:deny:${index}:${rule}`),
      kind: "deny",
      reason: "Denied by harness profile.",
      scope: compileHarnessRule(rule),
    })
  );

  const grants: IssueGrantInput[] = profile.allowedTools.map((rule, index) => ({
    canDelegate: true,
    holder,
    issuanceKey: `${keyPrefix}:allow:${index}:${rule}`,
    issuer: HOST_APPROVER,
    reason: `Allowed by harness profile rule "${rule}".`,
    requestedBy,
    scope: compileHarnessRule(rule),
    sessionId: options.sessionId,
  }));

  return { grants, restrictions };
}

async function reconcileProfileRestrictions(
  authorization: Authorization,
  restrictions: readonly AddRestrictionInput[],
  denyPrefix: string
): Promise<readonly RestrictionId[]> {
  const desired = new Set(
    restrictions.flatMap((item) => (item.id === undefined ? [] : [item.id]))
  );
  const existing = await authorization.listRestrictions();
  const existingIds = new Set(existing.map((item) => item.id));
  for (const restriction of existing) {
    if (restriction.id.startsWith(denyPrefix) && !desired.has(restriction.id)) {
      await authorization.liftRestriction(restriction.id);
    }
  }
  const restrictionIds: RestrictionId[] = [];
  for (const input of restrictions) {
    if (input.id !== undefined) {
      restrictionIds.push(input.id);
      if (existingIds.has(input.id)) {
        continue;
      }
    }
    await authorization.restrict(input);
  }
  return restrictionIds;
}

async function reconcileProfileGrants(
  authorization: Authorization,
  grants: readonly IssueGrantInput[],
  sessionId: string,
  allowPrefix: string,
  includeGrants: boolean
): Promise<void> {
  const desired = new Set(
    includeGrants
      ? grants.flatMap((item) =>
          item.issuanceKey === undefined ? [] : [item.issuanceKey]
        )
      : []
  );
  const existing = await authorization.listGrants({
    sessionId,
    state: "active",
  });
  for (const grant of existing) {
    if (
      grant.issuanceKey?.startsWith(allowPrefix) &&
      !desired.has(grant.issuanceKey)
    ) {
      await authorization.revoke(
        { grantId: grant.id, kind: "grant" },
        "Harness profile updated."
      );
    }
  }
  if (!includeGrants) {
    return;
  }
  for (const input of grants) {
    try {
      await authorization.grant(input);
    } catch (error) {
      if (!(error instanceof AuthorizationDeniedError)) {
        throw error;
      }
    }
  }
}

export async function applyHarnessProfile(
  authorization: Authorization,
  profile: HarnessPermissionProfile,
  options: CompileHarnessProfileOptions & { readonly includeGrants?: boolean }
): Promise<{
  readonly restrictionIds: readonly RestrictionId[];
}> {
  const compiled = compileHarnessProfile(profile, options);
  const keyPrefix = `harness-profile:${options.sessionId}:${options.agentId}:${options.agentGeneration ?? ""}`;
  const restrictionIds = await reconcileProfileRestrictions(
    authorization,
    compiled.restrictions,
    `${keyPrefix}:deny:`
  );
  await reconcileProfileGrants(
    authorization,
    compiled.grants,
    options.sessionId,
    `${keyPrefix}:allow:`,
    options.includeGrants !== false
  );
  return { restrictionIds };
}
