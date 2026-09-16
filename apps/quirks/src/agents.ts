import type { AgentSpec } from "@foundry/agents/agents/index";
import { createAgentPreset } from "@foundry/agents/agents/index";
import type { SessionStore } from "@foundry/agents/session";
import { createModelSummarizer } from "@foundry/agents/session";
import type { Skill } from "@foundry/agents/skills";
import type { ModelManager, TurnExecutorRef } from "@foundry/models";
import { observeAgentTurn } from "@foundry/models";

import type { Primitives, SessionOptions } from "~/lib/registry";

/**
 * Sessions over `createAgentPreset`: the package provisions prompt, skills and
 * model; Quirks supplies the surface (the session store, a skills reader,
 * turn observation) and pins the executor so the route is explicit, as
 * everywhere else.
 *
 * Compaction is on by default: a session that outlives one process is the
 * whole point of naming it, and a long-lived session fills its window. The
 * turn model summarizes its own history; the window is the model's own, or
 * the harness's fallback when the catalog row declares none.
 */

export interface AgentsOptions {
  readonly executors: readonly TurnExecutorRef[];
  readonly models: ModelManager;
  readonly sessions: SessionStore;
  readonly skills: (names: string[]) => Promise<Skill[]>;
}

export function bindAgents(options: AgentsOptions): Primitives["agents"] {
  const { models, executors, sessions, skills } = options;
  const surface = {
    model: (id?: string) => models.model(id),
    observe: observeAgentTurn,
    skills,
    store: sessions,
  };

  return {
    session(agent: AgentSpec, session: SessionOptions = {}) {
      const executor = session.executor ?? executors[0];
      if (!executor) {
        throw new Error("quirks: no executor available");
      }
      const model = models.model(
        agent.model ?? executor.model,
        executor.provider,
        session.cwd === undefined ? {} : { workingDirectory: session.cwd }
      );
      return createAgentPreset(agent, surface).createSession({
        ...(session.sessionId === undefined
          ? {}
          : { sessionId: session.sessionId }),
        ...(session.compaction === false
          ? {}
          : {
              compaction: {
                summarizer: createModelSummarizer({ model }),
                ...session.compaction,
              },
            }),
        model,
      });
    },
  };
}
