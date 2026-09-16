import type { ToolLoopAgent } from "ai";

import { tool } from "ai";
import { z } from "zod";

import type { SessionStore } from "../session/store";
import type { SessionRecord } from "../session/types";
import { collapseFinalText } from "./last-text";
import type { AgentCompatibilityProjection, AgentEntry } from "./registry";
import { resolveAgentEntry } from "./registry";

/** The run seam — the resolved child agent's `.stream(...)` (Backbone `runAgent`, M1). */
type AgentRun = Awaited<ReturnType<ToolLoopAgent["stream"]>>;
export type RunAgent = (
  agent: AgentEntry,
  opts: { session: SessionRecord; prompt: string; abortSignal?: AbortSignal }
) => Promise<AgentRun>;

/**
 * The modeled outcomes of a spawn.
 * (The "at-max-depth" outcome is NOT a result — it is the tool's absence: `createSpawnTool`
 * returns `undefined`, so the model never sees a spawn tool to call. Ruling 0006.)
 */
export type SpawnResult =
  | { ok: true; mode: "foreground"; artifact: string }
  | { ok: false; reason: "unknown-kind" };

export interface SpawnDeps {
  /** Max recursion depth (G-A9-DEPTH-VALUE — injected at composition; tests pass a small value). */
  depthLimit: number;
  /** Optional tool copy. */
  description?: string;
  /** The invoking parent message id (Invariant 4). Harness-supplied per turn; optional. */
  parentMessageId?: string;
  /** The parent session — supplies `recursionDepth` for the depth gate and `id` for linkage. */
  parentSession: SessionRecord;
  promptDescription?: string;
  /** Resolution surface (S5). `resolveAgentEntry(kind, registry)` throws on unknown → caught here. */
  registry: AgentCompatibilityProjection;
  /** Runs the resolved child agent bound to the CHILD session. */
  runAgent: RunAgent;
  /** Mints the child session + writes linkage + freezes depth (task 04 contract). */
  store: SessionStore;
}

export function createSpawnTool(deps: SpawnDeps) {
  const parentDepth = deps.parentSession.recursionDepth ?? 0;
  if (parentDepth + 1 > deps.depthLimit) {
    return; // withhold at max (ruling 0006)
  }

  return tool({
    description:
      deps.description ??
      "Spawn a sub-agent to handle a delegated task and return its result.",
    execute: async (
      { agentKind, prompt },
      { abortSignal }
    ): Promise<SpawnResult> => {
      // (1) resolve — untrusted model input (S5). A throw becomes a modeled miss; nothing escapes.
      let agent: AgentEntry;
      try {
        agent = resolveAgentEntry(agentKind, deps.registry);
      } catch {
        return { ok: false, reason: "unknown-kind" };
      }

      // (2) mint the child + write linkage + freeze depth, in one createSession call (§0, ruling 0007).
      const childSession = await deps.store.createSession({
        parentSessionId: deps.parentSession.id,
        ...(deps.parentMessageId === undefined
          ? {}
          : { parentMessageId: deps.parentMessageId }),
        recursionDepth: parentDepth + 1,
      });

      // (3) run bound to the CHILD session (never the parent's). The delegation prompt
      //     is the ONLY parent→child channel (Invariant 6).
      const run = await deps.runAgent(agent, {
        prompt,
        session: childSession,
        ...(abortSignal ? { abortSignal } : {}),
      });

      // (4) foreground: collapse ONLY the final result (ruling 0008 R2).
      const artifact = await collapseFinalText(
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- ai v7 deprecates this method; migrates with the approval rework
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
