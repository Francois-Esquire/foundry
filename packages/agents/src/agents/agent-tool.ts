import type { ModelMessage, ToolLoopAgent, ToolSet, UIMessage } from "ai";

import { readUIMessageStream, tool } from "ai";
import { z } from "zod";

import type { ConversationStore } from "../tools/context";
import {
  defaultThread,
  getConversationStore,
  getSpace,
} from "../tools/context";
import { lastTextValue } from "./last-text";
import type { AgentCompatibilityProjection, AgentEntry } from "./registry";
import { resolveAgentEntry } from "./registry";

export interface AgentToolConfig<TOOLS extends ToolSet = ToolSet> {
  agent: ToolLoopAgent<never, TOOLS> | AgentEntry | string;
  agentName: string;
  description: string;
  mesh?: ConversationStore;
  promptDescription: string;
  registry?: AgentCompatibilityProjection;
  space?: string;
}

export function createAgentTool<TOOLS extends ToolSet = ToolSet>(
  config: AgentToolConfig<TOOLS>
) {
  const {
    registry,
    description,
    promptDescription,
    agentName,
    mesh: ctorMesh,
    space: ctorSpace,
  } = config;

  const agent =
    typeof config.agent === "string"
      ? resolveAgentEntry(config.agent, registry)
      : config.agent;

  return tool({
    description,
    async *execute({ prompt, thread }, { abortSignal, context }) {
      const mesh = ctorMesh ?? getConversationStore(context);
      const space = ctorSpace ?? getSpace(context);
      const threadId = thread ?? defaultThread();
      const stateful = mesh !== undefined && space !== undefined;

      const userMessage: ModelMessage = { content: prompt, role: "user" };
      const history = stateful ? mesh.load(space, agentName, threadId) : [];

      const result = stateful
        ? await agent.stream({
            abortSignal,
            messages: [...history, userMessage],
          })
        : await agent.stream({ abortSignal, prompt });

      let lastMessage: UIMessage | undefined;
      for await (const message of readUIMessageStream({
        // ai v7 deprecates this method in favour of the standalone
        // `toUIMessageStream`, but the standalone form needs one concrete
        // `TOOLS` instantiation and this agent is generic. Pending the wider
        // v7 approval/stream migration — see `needsApproval` below.
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- deprecated, not removed; migrates with the approval rework
        stream: result.toUIMessageStream(),
      })) {
        yield message;
        lastMessage = message;
      }

      if (stateful) {
        const { response } = await result.finalStep;
        mesh.append(space, agentName, threadId, [
          userMessage,
          ...response.messages,
        ]);
      }

      return lastMessage;
    },
    inputSchema: z.object({
      prompt: z.string().describe(promptDescription),
      thread: z
        .string()
        .optional()
        .describe(
          `Thread id for the ${agentName} subagent. Default "${defaultThread()}". Reuse the same id to continue iterating; pass a new id to fork.`
        ),
    }),
    toModelOutput: ({ output: message }) => ({
      type: "text",
      value: lastTextValue(message, "Task completed."),
    }),
  });
}
