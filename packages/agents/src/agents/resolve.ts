import type { ToolSet } from "ai";

import type { AgentAuthorizer } from "../authorization";
import type {
  AgentHarnessSettings,
  CompactionSettings,
  SessionHarnessSettings,
  ToolEffectPort,
} from "../harness";
import { AgentHarness, SessionHarness } from "../harness";
import type { SessionStore } from "../session/store";
import type { Skill } from "../skills";
import { createSkillRegistry } from "../skills";
import { createTodos } from "../tools/todos";
import type { Mesh } from "./mesh";
import type { AgentModel, ObserveTurn } from "./model";
import type { AgentSpec } from "./spec";

/**
 * The capabilities a substrate provides for building agents. The resolver
 * gates on **presence** — an absent capability degrades gracefully (no store →
 * stateless; no mesh → off-bus) rather than branching on substrate kind.
 */
export interface AgentSurface {
  /** Resolve MCP server ids → their tagged tools. Absent → no MCP tools. */
  mcp?: (ids: string[]) => Promise<ToolSet>;
  /** The inter-agent mesh a joining spec registers on. Absent → off-bus. */
  mesh?: Mesh;
  /** Resolve a spec's model id, or the host's default when it names none. Required. */
  model: (id?: string) => AgentModel;
  /** Per-turn observation. Absent → unobserved. */
  observe?: ObserveTurn;
  /** Resolve skill catalog names → skills. Absent → no skills. */
  skills?: (names: string[]) => Promise<Skill[]>;
  /** Session persistence. Absent → stateless. */
  store?: SessionStore;
}

/** Runtime context for one provisioning: which session, and any per-turn overrides. */
export interface ResolveAgentContext {
  /** The model this instance runs; falls back to the surface resolving `spec.model`. */
  model?: AgentModel;
  /** The session this instance runs for; generated on first turn when omitted. */
  sessionId?: string;
}

/**
 * Per-invocation overrides shared by both {@link AgentPreset.createAgent} and
 * `.createSession` (design: "Reusable agent preset"). Both methods forward
 * these fields onto the harness they build through the exact same
 * provisioning stage — that shared forwarding, not a separate preset-level
 * default, is what keeps a preset's direct and Session variants using the
 * same policy and effect defaults.
 */
export interface AgentPresetContext {
  /** Retained preset generation used to scope authorization and call identity. */
  agentGeneration?: number;
  /** Effect boundary every allowed tool call executes through. Defaults to
   *  the harness's direct in-process executor when omitted. */
  effectPort?: ToolEffectPort;
  /** The model this instance runs; falls back to the surface resolving `spec.model`. */
  model?: AgentModel;
  /** Policy every compiled tool call is checked against. Defaults to the
   *  harness's own permissive policy when omitted. */
  policy?: AgentAuthorizer;
  /** Correlation id recorded on turn observation telemetry. */
  sessionId?: string;
  /** Additional tools layered on top of the preset's own; later wins on a name. */
  tools?: ToolSet;
}

/**
 * {@link AgentPresetContext} plus the Session-only continuity settings
 * `AgentPreset.createSession` adds on top of the shared base.
 */
export interface AgentSessionContext extends AgentPresetContext {
  /** Pre-turn auto-compaction; needs a summarize-aware store to take effect. */
  compaction?: CompactionSettings;
  /** Mesh to join for this session, overriding the surface default (e.g. a
   *  session-scoped `meshFor(sessionId)`). */
  mesh?: Mesh;
  /** Adopt an existing session id, or generate one on first turn. */
  sessionId?: string;
  /** Session persistence. Defaults to the surface's store; stateless if neither is set. */
  sessionStore?: SessionStore;
  /**
   * Caller-validated, JSON-safe per-turn context (design: "Agentic surface" —
   * e.g. a Roadmap `{ roadmapId }`). Forwarded here opaquely; this module
   * neither validates it nor merges it into a harness's tool context — a
   * preset's own `.createSession` reads it and decides what, if anything, to
   * fold into its live tool context. Absent for presets that need none.
   */
  surfaceContext?: Readonly<Record<string, unknown>>;
}

/**
 * A retained, reusable agent definition (design: "Reusable agent preset").
 * `createAgent` and `createSession` both provision the same `spec` through
 * the same shared stages — `createSession` only layers Session storage and
 * mesh context on top — so a caller can move one agent between direct,
 * Session, one-off, and background use without it silently becoming a
 * different agent.
 */
export interface AgentPreset {
  createAgent(context: AgentPresetContext): Promise<AgentHarness>;
  createSession(context: AgentSessionContext): Promise<SessionHarness>;
  spec: AgentSpec;
}

/**
 * Stage 1, shared by every {@link AgentPreset} construction path: resolve the
 * model resolver, skills, and MCP registrations, and fold them — together with
 * `spec.id` as the harness's stable `agentId` and this call's policy/effect
 * overrides — into one {@link AgentHarnessSettings}. `spec.tools` is
 * intentionally NOT wired yet (no tool-name catalog exists to resolve it), the
 * same divergence `resolveAgent` has always carried.
 */
async function provisionSpec(
  spec: AgentSpec,
  surface: AgentSurface,
  context: AgentPresetContext
): Promise<AgentHarnessSettings> {
  const model = context.model ?? surface.model(spec.model);

  const skills =
    spec.skills && spec.skills.length > 0 && surface.skills
      ? createSkillRegistry(await surface.skills(spec.skills))
      : undefined;

  const mcpTools =
    spec.mcp && spec.mcp.length > 0 && surface.mcp
      ? await surface.mcp(spec.mcp)
      : undefined;

  return {
    agentId: spec.id,
    ...(context.agentGeneration === undefined
      ? {}
      : { agentGeneration: context.agentGeneration }),
    model,
    ...(surface.observe ? { observe: surface.observe } : {}),
    instructions: [spec.prompt, skills?.instructions]
      .filter((block) => Boolean(block))
      .join("\n\n"),
    tools: {
      ...createTodos().tools,
      ...skills?.tools,
      ...mcpTools,
      ...context.tools,
    },
    ...(context.policy ? { policy: context.policy } : {}),
    ...(context.effectPort ? { effectPort: context.effectPort } : {}),
  };
}

/** Stage 2, Session-only: resolve which mesh (if any) this spec joins and
 *  under which node id — shared by `createSession` and the legacy
 *  `resolveAgent` wrapper. `context.mesh` overrides the surface default so a
 *  caller can hand in a session-scoped mesh (e.g. `meshFor(sessionId)`). */
function provisionMesh(
  spec: AgentSpec,
  surface: AgentSurface,
  context: AgentSessionContext
): { mesh: Mesh | undefined; nodeId: string } {
  const mesh = spec.mesh?.join ? (context.mesh ?? surface.mesh) : undefined;
  const nodeId = spec.mesh?.node ?? spec.id;
  return { mesh, nodeId };
}

/**
 * Provision an {@link AgentSpec} into a retained {@link AgentPreset} against
 * an {@link AgentSurface} (design: "Reusable agent preset") — the
 * generalization of the desktop's hand-written agent factories onto a
 * capability surface (design: `agent-as-infrastructure-code`). Source-neutral:
 * the spec may come from a file, code, or a virtual mint.
 *
 * `createAgent` and `createSession` both run {@link provisionSpec}, so a
 * direct and a Session harness built from one preset always share prompt,
 * model, skills, MCP tools, policy, and effect defaults; `createSession` only
 * layers Session storage and mesh context on top. `spec.id` is always the
 * constructed harness's `agentId` — reconstructing the preset never falls
 * back to a placeholder identity.
 */
export function createAgentPreset(
  spec: AgentSpec,
  surface: AgentSurface
): AgentPreset {
  return {
    async createAgent(context: AgentPresetContext = {}): Promise<AgentHarness> {
      const settings = await provisionSpec(spec, surface, context);
      return new AgentHarness(settings, {
        sessionId: context.sessionId ?? "",
      });
    },
    async createSession(
      context: AgentSessionContext = {}
    ): Promise<SessionHarness> {
      const settings = await provisionSpec(spec, surface, context);
      const { mesh, nodeId } = provisionMesh(spec, surface, context);
      const store = context.sessionStore ?? surface.store;

      const sessionSettings: SessionHarnessSettings = {
        ...settings,
        ...(store ? { store } : {}),
        ...(mesh
          ? {
              mesh,
              ...(mesh.registry ? { registry: mesh.registry } : {}),
              nodeId,
            }
          : {}),
        ...(context.sessionId === undefined
          ? {}
          : { sessionId: context.sessionId }),
        ...(context.compaction ? { compaction: context.compaction } : {}),
      };

      const harness = new SessionHarness(sessionSettings, {
        sessionId: context.sessionId ?? "",
      });

      // Join the bus so peers can discover and `message_agent` this agent.
      if (mesh) {
        mesh.register(nodeId, {
          agent: harness.agent,
          role: spec.role ?? nodeId,
        });
      }

      return harness;
    },
    spec,
  };
}

/**
 * Provision an {@link AgentSpec} directly into a live {@link SessionHarness}
 * (design: "Reusable agent preset") — a thin, backward-compatible wrapper
 * over `createAgentPreset(spec, surface).createSession(context)`, kept for
 * existing direct callers (e.g. Studio's file-agent loader). New code should
 * retain the {@link AgentPreset} instead, so it can also construct the direct
 * `AgentHarness` variant from the same spec.
 */
export async function resolveAgent(
  spec: AgentSpec,
  surface: AgentSurface,
  context: ResolveAgentContext = {}
): Promise<SessionHarness> {
  return createAgentPreset(spec, surface).createSession(context);
}
