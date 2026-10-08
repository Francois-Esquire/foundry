import type { ToolLoopAgent } from "ai";

import { tool } from "ai";
import { z } from "zod";

import type { SessionStore } from "../session/store";
import type { SessionRecord } from "../session/types";
import { collapseFinalText } from "./last-text";
import type { AgentCompatibilityProjection, AgentEntry } from "./registry";
import { resolveAgentEntry } from "./registry";

/** Runs a resolved child agent against its session. */
type AgentRun = Awaited<ReturnType<ToolLoopAgent["stream"]>>;
export type RunAgent = (
  agent: AgentEntry,
  opts: { session: SessionRecord; prompt: string; abortSignal?: AbortSignal }
) => Promise<AgentRun>;

/**
 * Spawn failures returned to the model. Reaching the depth limit omits the tool
 * instead of returning a failure.
 */
export type SpawnResult =
  | { ok: true; mode: "foreground"; artifact: string }
  | { ok: false; reason: "unknown-kind" };

export interface SpawnDeps {
  /** Maximum allowed depth of a spawned agent. */
  depthLimit: number;
  description?: string;
  /** Parent message that invoked this child, when supplied by the harness. */
  parentMessageId?: string;
  /** The parent session — supplies `recursionDepth` for the depth gate and `id` for linkage. */
  parentSession: SessionRecord;
  promptDescription?: string;
  /** Resolves the model-supplied agent kind; unknown kinds become a modeled miss. */
  registry: AgentCompatibilityProjection;
  /** Runs the resolved child agent in the supplied child session. */
  runAgent: RunAgent;
  /** Creates child sessions with parent linkage and a fixed recursion depth. */
  store: SessionStore;
}

export function createSpawnTool(deps: SpawnDeps) {
  const parentDepth = deps.parentSession.recursionDepth ?? 0;
  if (parentDepth + 1 > deps.depthLimit) {
    // Omit the tool when another child would exceed the depth limit.
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
      // The requested kind comes from model input; unknown kinds become a modeled miss.
      let agent: AgentEntry;
      try {
        agent = resolveAgentEntry(agentKind, deps.registry);
      } catch {
        return { ok: false, reason: "unknown-kind" };
      }

      // Create the child session with its parent linkage and fixed recursion depth.
      const childSession = await deps.store.createSession({
        parentMessageId: deps.parentMessageId,
        parentSessionId: deps.parentSession.id,
        recursionDepth: parentDepth + 1,
      });

      // Keep the child isolated in its own session; the prompt is its only parent input.
      const run = await deps.runAgent(agent, {
        abortSignal,
        prompt,
        session: childSession,
      });

      // Return the final reply, not the intermediate stream events.
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
