import { randomUUID } from "node:crypto";
import type { ToolSet } from "ai";

import type { AgentAuthorizer } from "../authorization/authorization";
import type { AgentHarnessSettings } from "../harness/agent-harness";
import { AgentHarness } from "../harness/agent-harness";
import type {
  CompactionSettings,
  SessionHarnessSettings,
} from "../harness/session-harness";
import { SessionHarness } from "../harness/session-harness";
import type { ToolEffectPort } from "../harness/types";
import { createModelSummarizer } from "../session/compactor";
import type { SessionStore } from "../session/store";
import { createSkillRegistry } from "../skills/registry";
import type { Skill } from "../skills/types";
import { composeTools } from "../tools/compose";
import { createTodos } from "../tools/todos";
import type { Mesh } from "./mesh";
import type { AgentModel, ObserveTurn } from "./model";
import type { AgentSpec } from "./spec";

export type AgentSettings = Omit<
  AgentHarnessSettings,
  | "model"
  | "instructions"
  | "tools"
  | "toolsContext"
  | "agentId"
  | "agentGeneration"
  | "policy"
  | "effectPort"
  | "sessionId"
>;

export interface AgentExecutionContext {
  readonly runId: string;
  readonly signal: AbortSignal;
}

export interface AgentPresetContext {
  agentGeneration?: number;
  effectPort?: ToolEffectPort;
  execution?: AgentExecutionContext;
  instructions?: string;
  model?: AgentModel;
  policy?: AgentAuthorizer;
  sessionId?: string;
  settings?: AgentSettings;
  surfaceContext?: Readonly<Record<string, unknown>>;
  tools?: ToolSet;
  toolsContext?: Record<string, unknown>;
}

export interface AgentSessionContext extends AgentPresetContext {
  compaction?: false | CompactionSettings;
  mesh?: Mesh;
  sessionStore?: SessionStore;
}

export interface ResolveAgentContext {
  model?: AgentModel;
  sessionId?: string;
}

export interface AgentPreset {
  createAgent(context: AgentPresetContext): Promise<AgentHarness>;
  createSession(context: AgentSessionContext): Promise<SessionHarness>;
  spec: AgentSpec;
}

export interface AgentSurface {
  mcp?: (ids: string[]) => Promise<ToolSet>;
  mesh?: Mesh;
  model: (id?: string, provider?: string) => AgentModel;
  observe?: ObserveTurn;
  policy?: AgentAuthorizer;
  skills?: (names: string[]) => Promise<Skill[]>;
  store?: SessionStore;
  tools?: (names: string[], context: AgentPresetContext) => Promise<ToolSet>;
  toolsContext?: Record<string, unknown>;
}

/** Bind domain defaults; invocation overrides are applied after binding. */
export type AgentConfigurationFactory = (
  context: AgentPresetContext,
  spec: AgentSpec
) => SessionHarnessSettings | Promise<SessionHarnessSettings>;

type SessionSettings = Omit<SessionHarnessSettings, keyof AgentHarnessSettings>;

interface Configuration {
  agent: AgentHarnessSettings;
  session: SessionSettings;
}

function splitSettings(settings: SessionHarnessSettings): Configuration {
  const { store, mesh, registry, nodeId, compaction, ...agent } = settings;
  return { agent, session: { compaction, mesh, nodeId, registry, store } };
}

async function resolveTools(
  spec: AgentSpec,
  surface: AgentSurface,
  context: AgentPresetContext
): Promise<ToolSet | undefined> {
  if (!spec.tools?.length) {
    return undefined;
  }
  if (!surface.tools) {
    throw new Error(`Agent "${spec.id}" has no tool resolver`);
  }
  const resolved = await surface.tools(spec.tools, context);
  const tools: ToolSet = {};
  for (const name of spec.tools) {
    const binding = resolved[name];
    if (!binding) {
      throw new Error(`Agent "${spec.id}" has no binding for tool "${name}"`);
    }
    if (Object.hasOwn(tools, name)) {
      throw new Error(`Duplicate tool binding: ${name}`);
    }
    tools[name] = binding;
  }
  return tools;
}

async function provisionSkills(spec: AgentSpec, surface: AgentSurface) {
  const resolved =
    spec.skills?.length && surface.skills
      ? await surface.skills(spec.skills)
      : undefined;
  for (const name of spec.skills ?? []) {
    if (!resolved?.some((skill) => skill.name === name)) {
      throw new Error(`Agent "${spec.id}" has no skill "${name}"`);
    }
  }
  return resolved ? createSkillRegistry(resolved) : undefined;
}

async function provisionSpec(
  spec: AgentSpec,
  surface: AgentSurface,
  context: AgentPresetContext
): Promise<AgentHarnessSettings> {
  const model =
    context.model ??
    (spec.provider
      ? surface.model(spec.model, spec.provider)
      : surface.model(spec.model));
  if (spec.skills?.length && !surface.skills) {
    throw new Error(`Agent "${spec.id}" has no skill resolver`);
  }
  if (spec.mcp?.length && !surface.mcp) {
    throw new Error(`Agent "${spec.id}" has no MCP resolver`);
  }
  const skills = await provisionSkills(spec, surface);
  const mcpTools =
    spec.mcp?.length && surface.mcp ? await surface.mcp(spec.mcp) : undefined;
  const domainTools = await resolveTools(spec, surface, context);
  return {
    instructions: [context.instructions ?? spec.prompt, skills?.instructions]
      .filter(Boolean)
      .join("\n\n"),
    model,
    observe: surface.observe,
    policy: surface.policy,
    tools: composeTools(
      createTodos().tools,
      skills?.tools,
      mcpTools,
      domainTools
    ),
    toolsContext: surface.toolsContext,
  };
}

/**
 * The one merge of defaults, spec, and invocation. The session id is fixed here
 * — invoked, else the configured default, else fresh — because the tool context
 * carries it and the harness scopes every authorization request by it.
 */
function configureAgent(
  spec: AgentSpec,
  defaults: AgentHarnessSettings,
  context: AgentPresetContext
): AgentHarnessSettings {
  const sessionId = context.sessionId || defaults.sessionId || randomUUID();
  return {
    ...defaults,
    ...spec.settings,
    ...context.settings,
    agentId: spec.id,
    instructions: defaults.instructions ?? context.instructions ?? spec.prompt,
    ...(context.agentGeneration === undefined
      ? {}
      : { agentGeneration: context.agentGeneration }),
    ...(context.model ? { model: context.model } : {}),
    ...(context.policy ? { policy: context.policy } : {}),
    ...(context.effectPort ? { effectPort: context.effectPort } : {}),
    sessionId,
    tools: composeTools(defaults.tools, context.tools),
    toolsContext: {
      ...defaults.toolsContext,
      ...context.toolsContext,
      sessionId,
      ...(context.execution ? { execution: context.execution } : {}),
    },
  };
}

function resolveCompaction(
  spec: AgentSpec,
  agent: AgentHarnessSettings,
  defaults: SessionSettings,
  context: AgentSessionContext
): CompactionSettings | undefined {
  if (context.compaction !== undefined) {
    return context.compaction || undefined;
  }
  const configured = spec.session?.compaction;
  if (configured === false) {
    return undefined;
  }
  if (!configured) {
    return defaults.compaction;
  }
  return {
    summarizer:
      defaults.compaction?.summarizer ??
      createModelSummarizer({ model: agent.model }),
    ...defaults.compaction,
    ...configured,
  };
}

function configureSession(
  spec: AgentSpec,
  { agent, session }: Configuration,
  context: AgentSessionContext
): SessionHarnessSettings {
  const mesh = context.mesh ?? session.mesh;
  return {
    ...agent,
    ...session,
    compaction: resolveCompaction(spec, agent, session, context),
    mesh,
    nodeId: mesh
      ? (session.nodeId ?? spec.mesh?.node ?? spec.id)
      : session.nodeId,
    registry: mesh?.registry ?? session.registry,
    store: context.sessionStore ?? session.store,
  };
}

export function createAgentPreset(
  spec: AgentSpec,
  source: AgentSurface | AgentConfigurationFactory
): AgentPreset {
  async function configure(
    context: AgentPresetContext
  ): Promise<Configuration> {
    const { tools: _tools, ...overrides } = context;
    const bindingContext = {
      ...overrides,
      instructions: context.instructions ?? spec.prompt,
    };
    const defaults =
      typeof source === "function"
        ? splitSettings(await source(bindingContext, spec))
        : {
            agent: await provisionSpec(spec, source, context),
            session: {
              mesh: spec.mesh?.join ? source.mesh : undefined,
              store: source.store,
            },
          };
    return {
      agent: configureAgent(spec, defaults.agent, context),
      session: defaults.session,
    };
  }

  return {
    async createAgent(context = {}) {
      const { agent } = await configure(context);
      return new AgentHarness(agent);
    },
    async createSession(context = {}) {
      const settings = configureSession(
        spec,
        await configure(context),
        context
      );
      const harness = new SessionHarness(settings);
      if (settings.mesh) {
        settings.mesh.register(harness.nodeId, {
          agent: harness.agent,
          role: spec.role ?? harness.nodeId,
        });
        settings.mesh.registry?.register(spec.id, harness.agent);
      }
      return harness;
    },
    spec,
  };
}

export async function resolveAgent(
  spec: AgentSpec,
  surface: AgentSurface,
  context: ResolveAgentContext = {}
): Promise<SessionHarness> {
  return createAgentPreset(spec, surface).createSession(context);
}
