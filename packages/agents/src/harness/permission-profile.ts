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

export async function applyHarnessProfile(
  authorization: Authorization,
  profile: HarnessPermissionProfile,
  options: CompileHarnessProfileOptions & { readonly includeGrants?: boolean }
): Promise<{
  readonly restrictionIds: readonly RestrictionId[];
}> {
  const compiled = compileHarnessProfile(profile, options);
  const existing = new Set(
    (await authorization.listRestrictions()).map((item) => item.id)
  );
  const restrictionIds: RestrictionId[] = [];
  for (const input of compiled.restrictions) {
    if (input.id !== undefined) {
      restrictionIds.push(input.id);
      if (existing.has(input.id)) {
        continue;
      }
    }
    await authorization.restrict(input);
  }
  if (options.includeGrants !== false) {
    for (const input of compiled.grants) {
      try {
        await authorization.grant(input);
      } catch (error) {
        if (!(error instanceof AuthorizationDeniedError)) {
          throw error;
        }
      }
    }
  }
  return { restrictionIds };
}
