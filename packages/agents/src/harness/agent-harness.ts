import type {
  AgentModel,
  HarnessPermissionCallback,
  ModelRoute,
} from "@foundry/core/agents";
import { routeOf } from "@foundry/core/agents";
import type { GenerateTextResult, Output, StreamTextResult, ToolSet } from "ai";
import type { AgentAuthorizer } from "../authorization/authorization";
import { createMemoryAgentAuthorizer } from "../authorization/authorization";
import { createToolContext } from "../tools/context";
import type {
  LoopAgentCallParameters,
  LoopAgentSettings,
  LoopAgentStreamParameters,
  TurnContext,
} from "./loop-agent";
import { LoopAgent } from "./loop-agent";
import type { StreamPart } from "./stream-transform";
import { compileTools, withToolCallRegistration } from "./tool-compiler";
import type { ToolEffectPort } from "./tool-registration";
import { directToolEffectPort } from "./tool-registration";

const DEFAULT_AGENT_ID = "agent";

function defaultPermissiveAuthorizer(): AgentAuthorizer {
  return createMemoryAgentAuthorizer({
    policy: { byKind: { "tool.call": "allow" }, global: "allow" },
  }).authorizer;
}

export type AgentHarnessSettings = Omit<LoopAgentSettings, "toolsContext"> & {
  toolsContext?: Record<string, unknown>;
  agentId?: string;
  policy?: AgentAuthorizer;
  agentGeneration?: number;
  effectPort?: ToolEffectPort;
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
  readonly policy: AgentAuthorizer;
  readonly agentId: string;
  readonly agentGeneration?: number;
  readonly sessionId: string;
  readonly #registrationFor: ReturnType<typeof compileTools>["registrationFor"];
  readonly #toolsContext: Record<string, unknown>;

  constructor(settings: AgentHarnessSettings, context?: TurnContext) {
    const {
      tools,
      policy,
      effectPort,
      agentId,
      agentGeneration,
      sessionId,
      toolsContext,
      permission,
      ...rest
    } = settings;

    this.model = settings.model;
    this.route = routeOf(settings.model);
    this.policy = policy ?? defaultPermissiveAuthorizer();
    this.agentId = agentId ?? DEFAULT_AGENT_ID;
    this.agentGeneration = agentGeneration;
    this.sessionId = sessionId || context?.sessionId || crypto.randomUUID();
    const compiled = compileTools(tools ?? {}, {
      agentGeneration,
      agentId: this.agentId,
      effectPort: effectPort ?? directToolEffectPort,
      permission,
      policy: this.policy,
      sessionId: this.sessionId,
    });
    this.#registrationFor = compiled.registrationFor;

    this.#toolsContext = (
      toolsContext === undefined
        ? createToolContext({ policy: this.policy })
        : createToolContext({ policy: this.policy }, toolsContext)
    ) as Record<string, unknown>;

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
