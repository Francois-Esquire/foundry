import { randomUUID } from "node:crypto";
import {
  createHarnessActivityRecorder,
  type HarnessSession,
} from "@foundry/agents/harness";
import { tool } from "ai";
import { z } from "zod";
import type { SandboxSessionSettings } from "./session";
import { wrapSession } from "./wrapped-session";

export interface DelegationScope {
  budget: { started: number; active: number };
  depth: number;
}

/** Delegation inherits the parent's guest, model, policy, and bounded execution profile. */
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
      const id = randomUUID();
      let child: HarnessSession | undefined;
      try {
        await settings.store.createSession({
          id,
          parentSessionId: settings.sessionId,
          recursionDepth: scope.depth + 1,
          title,
        });
        await settings.registerChildSession?.(id);
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
          const opened = await open({
            ...settings,
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
          const stoppable = wrapSession(opened, {
            interrupt: async () => {
              stopped.abort(new Error("Child task cancelled."));
              await opened.interrupt();
            },
          });
          // Held before the host sees it, so a throwing callback still closes it.
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
        await child?.close?.();
      }
    },
    inputSchema: z.object({
      task: z.string().min(1).max(32_000),
      title: z.string().min(1).max(160),
    }),
  });
}
