import type { Authorization } from "@foundry/authorization";
import type {
  AgentModel,
  HarnessPermissionCallback,
  ModelRoute,
} from "@foundry/core/agents";
import { routeOf } from "@foundry/core/agents";
import type { GenerateTextResult, Output, StreamTextResult, ToolSet } from "ai";
import { createMemoryAuthorization } from "../authorization/authorization";
import type {
  LoopAgentCallParameters,
  LoopAgentSettings,
  LoopAgentStreamParameters,
  TurnContext,
} from "./loop-agent";
import { LoopAgent } from "./loop-agent";
import type { StreamPart } from "./stream-transform";
import { compileTools, withToolCallRegistration } from "./tool-compiler";

const DEFAULT_AGENT_ID = "agent";

export type AgentHarnessSettings = Omit<LoopAgentSettings, "toolsContext"> & {
  toolsContext?: Record<string, unknown>;
  agentId?: string;
  authoritySessionId?: string;
  authorization?: Authorization;
  agentGeneration?: number;
  permission?: HarnessPermissionCallback;
  sessionId?: string;
};

export interface AgentHarnessStream<OUTPUT extends Output.Output = never> {
  readonly parts: AsyncIterable<StreamPart>;
  readonly result: StreamTextResult<ToolSet, Record<string, unknown>, OUTPUT>;
}

export class AgentHarness {
  readonly agent: LoopAgent;
  readonly model: AgentModel;
  readonly route: ModelRoute;
  readonly authorization: Authorization;
  readonly agentId: string;
  readonly agentGeneration?: number;
  readonly sessionId: string;
  readonly #registrationFor: ReturnType<typeof compileTools>["registrationFor"];
  readonly #toolsContext: Record<string, unknown>;

  constructor(settings: AgentHarnessSettings, context?: TurnContext) {
    const {
      tools,
      authorization,
      authoritySessionId,
      agentId,
      agentGeneration,
      sessionId,
      toolsContext,
      permission,
      ...rest
    } = settings;

    this.model = settings.model;
    this.route = routeOf(settings.model);
    this.authorization = authorization ?? createMemoryAuthorization();
    this.agentId = agentId ?? DEFAULT_AGENT_ID;
    this.agentGeneration = agentGeneration;
    this.sessionId = sessionId || context?.sessionId || crypto.randomUUID();
    const compiled = compileTools(tools ?? {}, {
      agentGeneration,
      agentId: this.agentId,
      authoritySessionId,
      authorization: this.authorization,
      permission,
      sessionId: this.sessionId,
    });
    this.#registrationFor = compiled.registrationFor;

    this.#toolsContext = toolsContext ?? {};

    const agentSettings: LoopAgentSettings = { ...rest, tools: compiled.tools };
    (agentSettings as { toolsContext?: Record<string, unknown> }).toolsContext =
      Object.fromEntries(
        Object.keys(compiled.tools).map((name) => [name, this.#toolsContext])
      );

    this.agent = new LoopAgent(agentSettings, { sessionId: this.sessionId });
  }

  async stream<OUTPUT extends Output.Output = never>(
    opts: LoopAgentStreamParameters<OUTPUT>
  ): Promise<AgentHarnessStream<OUTPUT>> {
    const result = await this.agent.stream(opts);
    return {
      parts: withToolCallRegistration(result.stream, this.#registrationFor, {
        experimentalContext: this.#toolsContext,
        messages: opts.messages ?? [],
      }),
      result,
    };
  }

  generate<OUTPUT extends Output.Output = never>(
    opts: LoopAgentCallParameters<OUTPUT>
  ): Promise<GenerateTextResult<ToolSet, Record<string, unknown>, OUTPUT>> {
    return this.agent.generate(opts);
  }
}
