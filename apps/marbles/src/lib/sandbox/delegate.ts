import {
  agentPrincipal,
  agentPrincipalMatcher,
} from "@foundry/agents/authorization";
import {
  applyHarnessProfile,
  createHarnessActivityRecorder,
  type HarnessSession,
} from "@foundry/agents/harness";
import { Sessions } from "@foundry/agents/session";
import {
  AuthorizationDeniedError,
  type GrantId,
  matchesPrincipal,
} from "@foundry/authorization";
import { tool } from "ai";
import { z } from "zod";
import type { SandboxSessionSettings } from "./session";
import { observedSession, wrapSession } from "./wrapped-session";

export interface DelegationScope {
  budget: { started: number; active: number };
  depth: number;
}

function observedChild(
  session: HarnessSession,
  record: SandboxSessionSettings["record"]
): HarnessSession {
  return record
    ? observedSession(session, record, { tools: true, turns: false })
    : session;
}

function isDelegableParentGrant(
  grant: {
    readonly canDelegate: boolean;
    readonly holder: Parameters<typeof matchesPrincipal>[0];
    readonly sessionId?: string;
  },
  parentPrincipal: ReturnType<typeof agentPrincipal>,
  authoritySessionId: string
): boolean {
  if (!grant.canDelegate) {
    return false;
  }
  if (!matchesPrincipal(grant.holder, parentPrincipal, "allow")) {
    return false;
  }
  return (
    grant.sessionId === undefined || grant.sessionId === authoritySessionId
  );
}

async function delegateParentGrants(
  settings: SandboxSessionSettings,
  childAgentId: string,
  childDepth: number
): Promise<readonly GrantId[]> {
  const { authorization } = settings.options.authority;
  const authoritySessionId = settings.authoritySessionId ?? settings.sessionId;
  if (settings.options.profile && (settings.delegation?.depth ?? 0) === 0) {
    await applyHarnessProfile(authorization, settings.options.profile, {
      agentId: settings.agentId,
      sessionId: authoritySessionId,
    });
  }
  const parentPrincipal = agentPrincipal(settings.agentId);
  const childHolder = agentPrincipalMatcher(childAgentId);
  const activeGrants = await authorization.listGrants({ state: "active" });
  const delegatedIds: GrantId[] = [];
  for (const grant of activeGrants) {
    if (!isDelegableParentGrant(grant, parentPrincipal, authoritySessionId)) {
      continue;
    }
    try {
      const issued = await authorization.grant({
        canDelegate: childDepth < 3,
        ...(grant.expiresAt === undefined
          ? {}
          : { expiresAt: grant.expiresAt }),
        holder: childHolder,
        issuer: parentPrincipal,
        parentIds: [grant.id],
        reason: `Delegated from ${settings.agentId}`,
        requestedBy: parentPrincipal,
        scope: grant.scope,
        sessionId: grant.sessionId ?? authoritySessionId,
        ...(grant.usesRemaining === undefined
          ? {}
          : { usesRemaining: grant.usesRemaining }),
      });
      delegatedIds.push(issued.id);
    } catch (error) {
      if (!(error instanceof AuthorizationDeniedError)) {
        throw error;
      }
    }
  }
  return delegatedIds;
}

async function closeAndRevokeChild(
  child: HarnessSession | undefined,
  settings: SandboxSessionSettings,
  childAgentId: string
): Promise<void> {
  try {
    await child?.close?.();
  } finally {
    await settings.options.authority.authorization
      .revoke(
        {
          kind: "principal",
          principal: agentPrincipal(childAgentId),
        },
        "Delegated child session ended."
      )
      .catch(() => undefined);
  }
}

export function delegationTool(
  settings: SandboxSessionSettings,
  open: (settings: SandboxSessionSettings) => Promise<HarnessSession>
) {
  const { question } = settings.options;
  const scope = settings.delegation ?? {
    budget: { active: 0, started: 0 },
    depth: 0,
  };
  return tool({
    description:
      "Delegate a bounded task to a child agent using this harness, model, workspace, and permissions. Waits for its result. At most 2 concurrent children, 8 total launches, and 3 nested levels per open parent session.",
    async execute({ title, task }, context) {
      if (
        scope.depth >= 3 ||
        scope.budget.started >= 8 ||
        scope.budget.active >= 2
      ) {
        throw new Error("Delegation limit reached for this session.");
      }
      const stopped = new AbortController();
      const signal = AbortSignal.any([
        settings.signal,
        stopped.signal,
        ...(context.abortSignal ? [context.abortSignal] : []),
      ]);
      signal.throwIfAborted();
      scope.budget.started += 1;
      scope.budget.active += 1;
      const id = crypto.randomUUID();
      const childAgentId = `${settings.agentId}:delegate:${id}`;
      const authoritySessionId =
        settings.authoritySessionId ?? settings.sessionId;
      let child: HarnessSession | undefined;
      try {
        await new Sessions({ store: settings.store }).createSession({
          id,
          parentSessionId: settings.sessionId,
          recursionDepth: scope.depth + 1,
          title,
        });
        await delegateParentGrants(settings, childAgentId, scope.depth + 1);
        const record = createHarnessActivityRecorder({
          agentId: settings.agentId,
          harness: settings.harness,
          onActivity: settings.onActivity,
          sessionId: id,
          store: settings.store,
        });
        const activity = {
          id,
          kind: "subagent" as const,
          lifetime: "session" as const,
          title,
        };
        await record({ ...activity, actions: ["stop"], status: "running" });
        try {
          const session = await open({
            ...settings,
            agentId: childAgentId,
            authoritySessionId,
            delegation: { budget: scope.budget, depth: scope.depth + 1 },
            options: {
              ...settings.options,
              question: question
                ? (request) =>
                    question({
                      ...request,
                      activityId: request.activityId ?? id,
                    })
                : undefined,
            },
            parentActivityId: id,
            sessionId: id,
            signal,
          });
          const opened = observedChild(session, settings.record);
          const stoppable = wrapSession(opened, {
            interrupt: async () => {
              stopped.abort(new Error("Child task cancelled."));
              await opened.interrupt();
            },
          });
          child = stoppable;
          child = settings.onChildSession?.(id, stoppable) ?? stoppable;
          const reply = await child.generate(task, { signal });
          signal.throwIfAborted();
          if (reply.status === "error") {
            throw new Error("Child agent turn failed.");
          }
          const text = reply.parts
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
          const finished = child;
          child = undefined;
          await finished.close?.();
          await record({
            ...activity,
            status: "complete",
            summary:
              "Child task completed. Full output is retained in its session.",
          });
          return { sessionId: id, text };
        } catch (error) {
          await record({
            ...activity,
            status: signal.aborted ? "cancelled" : "failed",
            summary: signal.aborted
              ? "Parent turn cancelled."
              : "Child task failed.",
          });
          throw error;
        }
      } finally {
        scope.budget.active -= 1;
        await closeAndRevokeChild(child, settings, childAgentId);
      }
    },
    inputSchema: z.object({
      task: z.string().min(1).max(32_000),
      title: z.string().min(1).max(160),
    }),
  });
}
