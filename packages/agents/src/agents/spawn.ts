import type { ToolLoopAgent } from "ai";

import { tool } from "ai";
import { z } from "zod";

import { Sessions } from "../session/sessions";
import type { SessionRecord } from "../session/types";
import type { SessionStore } from "../store";
import { collapseFinalText } from "./last-text";
import type { AgentCompatibilityProjection, AgentEntry } from "./registry";
import { resolveAgentEntry } from "./registry";

type AgentRun = Awaited<ReturnType<ToolLoopAgent["stream"]>>;
export type RunAgent = (
  agent: AgentEntry,
  opts: { session: SessionRecord; prompt: string; abortSignal?: AbortSignal }
) => Promise<AgentRun>;

export type SpawnResult =
  | { ok: true; mode: "foreground"; artifact: string }
  | { ok: false; reason: "unknown-kind" };

export interface SpawnDeps {
  depthLimit: number;
  description?: string;
  parentMessageId?: string;
  parentSession: SessionRecord;
  promptDescription?: string;
  registry: AgentCompatibilityProjection;
  runAgent: RunAgent;
  store: SessionStore;
}

export function createSpawnTool(deps: SpawnDeps) {
  const parentDepth = deps.parentSession.recursionDepth ?? 0;
  if (parentDepth + 1 > deps.depthLimit) {
    return;
  }

  return tool({
    description:
      deps.description ??
      "Spawn a sub-agent to handle a delegated task and return its result.",
    execute: async (
      { agentKind, prompt },
      { abortSignal }
    ): Promise<SpawnResult> => {
      let agent: AgentEntry;
      try {
        agent = resolveAgentEntry(agentKind, deps.registry);
      } catch {
        return { ok: false, reason: "unknown-kind" };
      }

      const childSession = await new Sessions({
        store: deps.store,
      }).createSession({
        parentMessageId: deps.parentMessageId,
        parentSessionId: deps.parentSession.id,
        recursionDepth: parentDepth + 1,
      });

      const run = await deps.runAgent(agent, {
        abortSignal,
        prompt,
        session: childSession,
      });

      const artifact = await collapseFinalText(
        run.toUIMessageStream(),
        "Task completed."
      );
      return { artifact, mode: "foreground", ok: true };
    },
    inputSchema: z.object({
      agentKind: z.string().describe("The kind of sub-agent to spawn."),
      prompt: z
        .string()
        .describe(
          deps.promptDescription ??
            "The delegation prompt handed to the sub-agent."
        ),
    }),
    toModelOutput: ({ output }) => ({
      type: "text",
      value: output.ok ? output.artifact : `Cannot spawn: ${output.reason}`,
    }),
  });
}
