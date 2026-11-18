import type { AgentSpec } from "@foundry/agents/agents/index";
import { createAgentPreset } from "@foundry/agents/agents/index";
import type {
  HarnessSession,
  SessionHarness,
  TurnOptions,
} from "@foundry/agents/harness";
import { McpClient } from "@foundry/agents/mcp";
import type {
  SessionInput,
  SessionMessage,
  SessionStream,
  SessionUsage,
} from "@foundry/agents/session";
import { Sessions } from "@foundry/agents/session";
import type { Skill } from "@foundry/agents/skills";
import type { SessionStore } from "@foundry/agents/store";
import { composeTools } from "@foundry/agents/tools/compose";
import { canonicalizeJson } from "@foundry/lib/json";
import type { ModelManager, ModelSelection, Resolution } from "@foundry/models";
import { observeAgentTurn } from "@foundry/models";
import { DEFAULT_SANDBOX_WORKING_DIRECTORY } from "@foundry/sandbox/constants";
import type { Container } from "@foundry/sandbox/container/containers";
import type { Output } from "ai";
import type { AutomationService } from "~/lib/automation/service";
import type { TurnExecutorRef } from "~/lib/cli-harnesses";
import { DIRECT_HARNESS, harnessOf, isCliHarness } from "~/lib/cli-harnesses";
import type { ExecutionContext } from "~/lib/execution-context";
import { withinContext } from "~/lib/execution-context";
import type { ExecutionObservation } from "~/lib/executions";
import type { RecordObservation } from "~/lib/observations";
import { composeObservers, runTurnObserver } from "~/lib/observations";
import type { Execution } from "~/lib/providers/plugins";
import type { HarnessActivities } from "~/lib/sandbox/activities";
import type { HarnessInteractions } from "~/lib/sandbox/interactions";
import type { SandboxSessionOptions } from "~/lib/sandbox/session";
import { createSandboxSession } from "~/lib/sandbox/session";
import type {
  CostMeter,
  RecordedUsageFact,
  ReportedCost,
  TurnSource,
  UsageLedger,
} from "~/lib/usage";
import { catalogPrices, costMeter, lostFact, usageFact } from "~/lib/usage";
import type { ManagerArgs } from "../bindings";
import { AGENT_DEFINITION, SANDBOX_HANDLE } from "../handles";
import type { LiveSession } from "../run-scope";
import { workingDirectory } from "../run-scope";
import type {
  AgentDefinition,
  AgentLike,
  AgentRoute,
  Agents,
  SandboxAgentOptions,
  SandboxHandle,
  SandboxInstance,
  Session,
  SessionOptions,
  SessionRef,
  SessionReply,
  SkillSet,
} from "../types";
import {
  deferredStream,
  replayedStream,
  replyOf,
  type SessionTurnSite,
  wrapAgentSession,
} from "./agent-turns";
import {
  resolveCompaction,
  resolveTurnLimit,
  type TurnLimit,
  TurnLimitUnsupportedError,
} from "./session-options";

export interface AgentsDeps {
  readonly activities: HarnessActivities;
  readonly automations: AutomationService;
  readonly containerOf: (sandbox: SandboxHandle) => Container;
  readonly context?: ExecutionContext;
  readonly cwd: string;
  readonly defaultExecutor: () => TurnExecutorRef;
  readonly dry: boolean;
  readonly executionOf?: (provider: string) => Execution | null | undefined;
  readonly implementationOf?: (provider: string) => string | undefined;
  readonly instanceOf?: (provider: string) => string | undefined;
  readonly interactions: HarnessInteractions;
  readonly models: ModelManager;
  readonly observe?: (runId: string, observation: ExecutionObservation) => void;
  readonly requireProviders?: () => void;
  readonly sessions: SessionStore;
  readonly skills: (set?: SkillSet) => Promise<Skill[]>;
  readonly usage?: {
    readonly ledger: UsageLedger;
    readonly workspaceId: string;
  };
  readonly warn: (message: string) => void;
}

const KIND = "agents.session";
const TURN_KIND = "agent.turn";

interface RecordedTurn {
  readonly agent?: string;
  readonly message: string;
  readonly path?: readonly string[];
  readonly session: string;
}

export interface AgentTurns {
  generate<OUTPUT extends Output.Output>(
    definition: AgentLike<Output.Output>,
    input: SessionInput,
    options?: TurnOptions<OUTPUT>
  ): Promise<SessionReply<OUTPUT>>;
  stream<OUTPUT extends Output.Output>(
    definition: AgentLike<Output.Output>,
    input: SessionInput,
    options?: TurnOptions<OUTPUT>
  ): SessionStream<OUTPUT>;
}
const DIRECT = "direct";

interface Closable {
  close(): Promise<void> | void;
}

interface Source {
  readonly definition: string;
  readonly path: string[];
  readonly runId: string;
}

interface SessionSite extends Omit<SessionTurnSite, "consumed"> {
  readonly consume?: (
    message: SessionMessage,
    usage: SessionUsage | undefined,
    route: SessionRef,
    reported?: ReportedCost
  ) => Promise<void>;
  readonly cwd: string;
  readonly parent?: string;
  record(ref: SessionRef): void;
  readonly recorded?: SessionRef;
  retain(closable: Closable): void;
  signal(): AbortSignal;
  readonly source: Source;
  takeResume(): string | undefined;
  track(live: LiveSession): void;
  write(value: unknown): void;
}

function inRun(source: Source, agentId: string): TurnSource {
  return {
    agentId,
    run: {
      definition: source.definition,
      path: source.path,
      runId: source.runId,
    },
  };
}

function consumer(
  deps: AgentsDeps,
  source: TurnSource
): SessionSite["consume"] {
  const { usage } = deps;
  if (!usage) {
    return;
  }
  const price = catalogPrices(deps.models);
  return async (message, counted, route, reported) => {
    let fact: RecordedUsageFact;
    try {
      fact = usageFact(
        {
          message,
          ...(reported ? { reported } : {}),
          route,
          source,
          ...(counted ? { usage: counted } : {}),
          workspaceId: usage.workspaceId,
        },
        price
      );
    } catch (error) {
      fact = lostFact(
        {
          completedAt: Date.now(),
          sessionId: message.sessionId,
          source,
          turnId: message.id,
          workspaceId: usage.workspaceId,
        },
        error instanceof Error ? error.message : String(error)
      );
    }
    const outcome = await usage.ledger.record(fact);
    if (outcome.saved === "marker") {
      deps.warn(
        `usage for turn ${message.id} was not saved (${outcome.error}); a marker records the missing turn`
      );
    }
    if (outcome.saved === "nothing") {
      deps.warn(
        `usage for turn ${message.id} was not saved (${outcome.error}); it is marked missing until Marbles restarts, and a restart cannot recover it`
      );
    }
  };
}

function frameSite(
  deps: AgentsDeps,
  { frame, scope, write }: ManagerArgs,
  agentId: string,
  observe: RecordObservation | undefined
): SessionSite {
  const { key } = scope.claim(frame, KIND);
  const recorded = scope.ledger.get<SessionRef>(key);
  const source: Source = {
    definition: frame.path[0] ?? agentId,
    path: [...frame.path],
    runId: scope.id,
  };
  return {
    consume: consumer(deps, inRun(source, agentId)),
    cwd: scope.cwd,
    ...(observe === undefined ? {} : { observe }),
    parent: scope.session.id,
    record: (ref) => scope.ledger.set(key, ref),
    ...(recorded === undefined ? {} : { recorded }),
    retain: (closable) => frame.opened.add(closable),
    signal: () => frame.signal,
    source,
    takeResume: () => {
      const prompt = frame.resumePrompt;
      frame.resumePrompt = undefined;
      return prompt;
    },
    track: (live) => frame.sessions.push(live),
    write,
  };
}

function hostSite(site: {
  readonly consume?: SessionSite["consume"];
  readonly cwd: string;
  readonly observe?: RecordObservation;
  retain(closable: Closable): void;
  readonly signal: AbortSignal;
  readonly source: Source;
}): SessionSite {
  return {
    ...(site.consume === undefined ? {} : { consume: site.consume }),
    cwd: site.cwd,
    ...(site.observe === undefined ? {} : { observe: site.observe }),
    record: () => undefined,
    retain: (closable) => site.retain(closable),
    signal: () => site.signal,
    source: site.source,
    takeResume: () => undefined,
    track: () => undefined,
    write: () => undefined,
  };
}

function refOf(session: SessionRef | Session): SessionRef {
  return "ref" in session ? session.ref : session;
}

export class SessionRouteError extends Error {
  readonly code: "SESSION_ROUTE_CONFLICT" | "SESSION_ROUTE_UNRECOVERABLE";
  override readonly name = "SessionRouteError";

  constructor(
    code: "SESSION_ROUTE_CONFLICT" | "SESSION_ROUTE_UNRECOVERABLE",
    message: string
  ) {
    super(message);
    this.code = code;
  }
}

async function pinnedRoute(
  sessions: SessionStore,
  pinned: SessionRef
): Promise<{ readonly model: string; readonly provider: string } | undefined> {
  if (pinned.provider !== undefined && pinned.model !== undefined) {
    return { model: pinned.model, provider: pinned.provider };
  }
  const messages = (await sessions.getSession(pinned.id))
    ? await sessions.listMessages(pinned.id)
    : [];
  if (messages.length === 0) {
    return undefined;
  }
  const routes = new Set<string>();
  for (const message of messages) {
    const route = message.metadata?.model;
    if (route?.provider === undefined) {
      continue;
    }
    if (
      (pinned.provider === undefined || route.provider === pinned.provider) &&
      (pinned.model === undefined || route.id === pinned.model)
    ) {
      routes.add(JSON.stringify([route.provider, route.id]));
    }
  }
  if (routes.size !== 1) {
    throw new SessionRouteError(
      "SESSION_ROUTE_UNRECOVERABLE",
      `session ${pinned.id} does not record ${routes.size === 0 ? "which model it ran on" : "a single model"}; start a new session`
    );
  }
  const [provider, model] = JSON.parse([...routes][0] as string) as [
    string,
    string,
  ];
  return { model, provider };
}

async function hasRun(sessions: SessionStore, id: string): Promise<boolean> {
  return (
    (await sessions.getSession(id)) !== null &&
    (await sessions.listMessages(id)).length > 0
  );
}

async function fileSession(
  store: SessionStore,
  parent: string | undefined,
  id: string
): Promise<void> {
  const sessions = new Sessions({ store });
  if (parent !== undefined && (await sessions.getSession(parent)) === null) {
    await sessions.createSession({ id: parent, title: "run" });
  }
  if ((await sessions.getSession(id)) === null) {
    await sessions.createSession(
      parent === undefined ? { id } : { id, parentSessionId: parent }
    );
  }
}

function startedSandbox(
  sandbox: SandboxHandle | SandboxInstance
): Promise<SandboxHandle> | SandboxHandle {
  const start = Reflect.get(sandbox, SANDBOX_HANDLE) as
    | (() => Promise<SandboxHandle>)
    | undefined;
  return start ? start() : (sandbox as SandboxHandle);
}

function heldText(
  resolution: Resolution<"text">,
  site: SessionSite,
  options?: { nativeMaxTurns?: number; workingDirectory?: string }
) {
  const model = resolution.open(options);
  site.retain({ close: () => resolution.release() });
  return model;
}

export function policed(
  session: HarnessSession,
  resolution: Resolution<"text">,
  models: ModelManager,
  site: SessionSite
): HarnessSession {
  const recheck = () => {
    try {
      resolution.check();
    } catch {
      session.interrupt().catch(() => undefined);
    }
  };
  models.events.on("policies-changed", recheck);
  site.retain({
    close: () => {
      models.events.off("policies-changed", recheck);
    },
  });
  const turns = new Set(["generate", "steer", "stream"]);
  return new Proxy(session, {
    get: (target, name) => {
      const value = Reflect.get(target, name, target);
      if (typeof value !== "function") {
        return value;
      }
      return turns.has(String(name))
        ? (...args: unknown[]) => {
            resolution.check();
            return Reflect.apply(value, target, args);
          }
        : value.bind(target);
    },
  });
}

function selectionOf(route: {
  readonly model?: string;
  readonly provider?: string;
}): ModelSelection {
  if (route.provider === undefined && route.model !== undefined) {
    return route.model;
  }
  return {
    ...(route.model === undefined ? {} : { model: route.model }),
    ...(route.provider === undefined ? {} : { provider: route.provider }),
  };
}

function validateSessionOptions(options: SessionOptions): void {
  if (options.sandbox && options.cwd !== undefined) {
    throw new Error(
      `Sandbox sessions run in ${DEFAULT_SANDBOX_WORKING_DIRECTORY}. Select the workspace through the sandbox mount.`
    );
  }
  if (options.sandbox && options.maxTurns !== undefined) {
    throw new TurnLimitUnsupportedError(
      "maxTurns is not supported for sandbox sessions"
    );
  }
  if (
    !options.sandbox &&
    [
      options.profile,
      options.authority,
      options.question,
      options.apiKey,
      options.oauthToken,
    ].some((value) => value !== undefined)
  ) {
    throw new Error(
      "Harness profiles, authority, and explicit credentials require a sandbox session."
    );
  }
}

async function interactionOptions(
  interactions: HarnessInteractions,
  source: Source,
  agentId: string,
  sessionId: string,
  options: SandboxAgentOptions
): Promise<SandboxSessionOptions> {
  const authority = interactions.authority(source, options.authority);
  await interactions.registerSession({ agentId, sessionId, source }, authority);
  return {
    ...options,
    authority,
    question:
      options.question ??
      ((request) =>
        interactions.question(
          source,
          request,
          options.profile?.mode === "attended"
        )),
  };
}

type DefinitionBuilder = (
  route: AgentRoute,
  input: unknown
) => Promise<AgentDefinition<Output.Output>>;

export async function buildDefinition<OUTPUT extends Output.Output>(
  agent: AgentLike<OUTPUT>,
  route: AgentRoute = {},
  input: unknown = (agent as { readonly input?: unknown }).input
): Promise<AgentDefinition<OUTPUT>> {
  const build = Reflect.get(agent, AGENT_DEFINITION) as
    | DefinitionBuilder
    | undefined;
  if (build) {
    return (await build(route, input)) as AgentDefinition<OUTPUT>;
  }
  if (typeof agent.prompt !== "string") {
    throw new Error(`agent "${agent.id}" has no prompt`);
  }
  return agent as AgentDefinition<OUTPUT>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function rejectHoles(value: unknown): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new Error(`an array has no item at index ${index}`);
      }
      rejectHoles(value[index]);
    }
    return;
  }
  for (const child of Object.values(value)) {
    rejectHoles(child);
  }
}

export function inputSnapshot(value: unknown): unknown {
  rejectHoles(value);
  return deepFreeze(JSON.parse(canonicalizeJson(value)));
}

type KeptInput = Pick<SessionRef, "input" | "noInput">;

function keptInput(kept: SessionRef | undefined): KeptInput {
  if (kept === undefined) {
    return {};
  }
  const hasInput = kept.input !== undefined;
  if (hasInput && kept.noInput === true) {
    throw new Error(
      `session ${kept.id} keeps both an input and noInput; pass back the session ref unchanged`
    );
  }
  if (hasInput) {
    return { input: inputSnapshot(kept.input) };
  }
  return kept.noInput === true ? { noInput: true } : {};
}

function sessionInput(
  agent: AgentLike<Output.Output>,
  kept: SessionRef | undefined
): KeptInput {
  const held = keptInput(kept);
  if (!Reflect.has(agent, AGENT_DEFINITION)) {
    return held;
  }
  const given = (agent as { readonly input?: unknown }).input;
  if (given === undefined) {
    return "input" in held ? held : { noInput: true };
  }
  if (
    kept?.noInput === true ||
    (kept?.input !== undefined &&
      canonicalizeJson(kept.input) !== canonicalizeJson(given))
  ) {
    throw new Error(
      `agent "${agent.id}": session ${kept.id} was opened with another input; open a new session for this one`
    );
  }
  return { input: given };
}

async function connectServers(
  definition: AgentDefinition<Output.Output>,
  site: SessionSite
): Promise<McpClient[]> {
  const servers = definition.mcp ?? [];
  const ids = new Set(servers.map((server) => server.id));
  if (ids.size !== servers.length) {
    throw new Error(
      `agent "${definition.id}" names one MCP server id more than once`
    );
  }
  const clients = servers.map(
    (server) => new McpClient({ ...server, enabled: true })
  );
  for (const client of clients) {
    site.retain(client);
  }
  try {
    await Promise.all(clients.map((client) => client.connect()));
    const failed = clients.find((client) => client.status !== "connected");
    if (failed) {
      throw new Error(
        `agent "${definition.id}": MCP server "${failed.id}" did not connect${failed.error ? `: ${failed.error}` : ""}`
      );
    }
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()));
    throw error;
  }
  return clients;
}

function freshRoute(
  deps: AgentsDeps,
  definition: AgentDefinition<Output.Output>
): Route {
  const fallback =
    definition.provider === undefined && definition.model === undefined
      ? deps.defaultExecutor()
      : undefined;
  return {
    modelId: definition.model ?? fallback?.model,
    provider: definition.provider ?? fallback?.provider,
  };
}

async function keptRoute(
  deps: AgentsDeps,
  definition: AgentDefinition<Output.Output>,
  pinned: SessionRef
): Promise<Route> {
  const kept = await pinnedRoute(deps.sessions, pinned);
  if (
    kept !== undefined &&
    deps.instanceOf &&
    pinned.instance === undefined &&
    (await hasRun(deps.sessions, pinned.id))
  ) {
    throw new SessionRouteError(
      "SESSION_ROUTE_UNRECOVERABLE",
      `session ${pinned.id} was recorded before provider instances were identified, so the account it ran on cannot be confirmed; start a new session`
    );
  }
  if (
    kept === undefined ||
    (deps.instanceOf && pinned.instance === undefined)
  ) {
    const fresh = freshRoute(deps, definition);
    return {
      modelId: pinned.model ?? fresh.modelId,
      provider: pinned.provider ?? fresh.provider,
    };
  }
  const { model, provider } = kept;
  if (!namesRoute(definition, kept)) {
    throw new SessionRouteError(
      "SESSION_ROUTE_CONFLICT",
      `session ${pinned.id} runs on ${provider}/${model}, but its agent now names ${describeRoute(definition)}; start a new session`
    );
  }
  const now = deps.implementationOf?.(provider);
  if (
    pinned.implementation !== undefined &&
    now !== undefined &&
    now !== pinned.implementation
  ) {
    throw new SessionRouteError(
      "SESSION_ROUTE_CONFLICT",
      `session ${pinned.id} ran on ${provider} as ${pinned.implementation}, which is now ${now}; start a new session`
    );
  }
  return { modelId: model, provider };
}

function namesRoute(
  definition: { readonly model?: string; readonly provider?: string },
  kept: { readonly model: string; readonly provider: string }
): boolean {
  if (
    definition.provider !== undefined &&
    definition.provider !== kept.provider
  ) {
    return false;
  }
  return (
    definition.model === undefined ||
    definition.model === kept.model ||
    definition.model === `${kept.provider}/${kept.model}`
  );
}

function describeRoute(definition: {
  readonly model?: string;
  readonly provider?: string;
}): string {
  if (definition.provider === undefined) {
    return definition.model === undefined
      ? "the default"
      : `"${definition.model}"`;
  }
  return definition.model === undefined
    ? definition.provider
    : `${definition.provider}/${definition.model}`;
}

interface Route {
  readonly modelId: string | undefined;
  readonly provider: string | undefined;
}

function turnLimitMode(
  deps: AgentsDeps,
  resolution: Resolution<"text">
): TurnLimit["kind"] {
  if (deps.dry) {
    return "steps";
  }
  if (resolution.turnLimit === "unsupported") {
    throw new TurnLimitUnsupportedError(
      `maxTurns is not supported by the ${resolution.provider} model provider`
    );
  }
  return resolution.turnLimit;
}

interface Opening {
  readonly definition: AgentDefinition<Output.Output>;
  readonly execution: Execution | null | undefined;
  readonly id: string;
  readonly limit: TurnLimit | undefined;
  readonly mcp: readonly McpClient[];
  readonly options: SessionOptions;
  readonly resolution: Resolution<"text">;
  readonly route: Route;
  readonly site: SessionSite;
  readonly skills: Skill[];
}

async function openSession<OUTPUT extends Output.Output>(
  deps: AgentsDeps,
  site: SessionSite,
  agent: AgentLike<OUTPUT>,
  options: SessionOptions
): Promise<Session<OUTPUT>> {
  const { context } = deps;
  const session = await withinContext(context, () =>
    openUnentered(deps, site, agent, options)
  );
  if (context === undefined) {
    return session;
  }
  return {
    ...session,
    generate: (input, turn) =>
      withinContext(context, () => session.generate(input, turn)),
    stream: (input, turn) =>
      withinContext(context, () => session.stream(input, turn)),
  };
}

async function openUnentered<OUTPUT extends Output.Output>(
  deps: AgentsDeps,
  site: SessionSite,
  agent: AgentLike<OUTPUT>,
  options: SessionOptions
): Promise<Session<OUTPUT>> {
  const recordedOn = site.recorded?.provider;
  const input = sessionInput(
    agent,
    site.recorded ?? (options.session ? refOf(options.session) : undefined)
  );
  const definition = await buildDefinition(
    agent,
    recordedOn === undefined ? {} : { provider: recordedOn },
    input.input
  );
  site.signal().throwIfAborted();
  if (options.sandbox && definition.mcp?.length) {
    throw new Error(
      `agent "${definition.id}" names MCP servers, which a sandbox session cannot reach yet`
    );
  }
  const mcp = deps.dry
    ? []
    : await connectServers(definition as AgentDefinition<Output.Output>, site);
  try {
    site.signal().throwIfAborted();
    return await openBuilt(deps, site, definition, options, mcp, input);
  } catch (error) {
    await Promise.allSettled(mcp.map((client) => client.close()));
    throw error;
  }
}

async function openBuilt<OUTPUT extends Output.Output>(
  deps: AgentsDeps,
  site: SessionSite,
  definition: AgentDefinition<OUTPUT>,
  options: SessionOptions,
  mcp: readonly McpClient[],
  input: KeptInput
): Promise<Session<OUTPUT>> {
  deps.requireProviders?.();
  const pinned =
    site.recorded ?? (options.session ? refOf(options.session) : undefined);
  const route = pinned
    ? await keptRoute(deps, definition, pinned)
    : freshRoute(deps, definition);
  const id = pinned?.id ?? crypto.randomUUID();
  if (pinned === undefined) {
    await fileSession(deps.sessions, site.parent, id);
  }
  const ran =
    pinned?.instance !== undefined && (await hasRun(deps.sessions, pinned.id));
  const resolution = deps.models.resolve(
    "text",
    selectionOf({ model: route.modelId, provider: route.provider })
  );
  const stamp = {
    implementation: deps.implementationOf?.(resolution.provider),
    instance: deps.instanceOf?.(resolution.provider),
  };
  if (ran && stamp.instance !== pinned?.instance) {
    throw new SessionRouteError(
      "SESSION_ROUTE_CONFLICT",
      `session ${pinned.id} ran on another configuration of provider ${resolution.provider} (its scope, settings, or account environment differ, or the instance it ran on is gone); start a new session`
    );
  }
  const execution = options.sandbox
    ? deps.executionOf?.(resolution.provider)
    : undefined;
  const limit =
    options.sandbox || options.maxTurns === undefined
      ? undefined
      : resolveTurnLimit(options.maxTurns, turnLimitMode(deps, resolution));
  const opening: Opening = {
    definition,
    execution,
    id,
    limit,
    mcp,
    options,
    resolution,
    route,
    site,
    skills: await deps.skills(definition.skills),
  };
  const meter =
    site.consume && !(options.sandbox && !deps.dry) ? costMeter() : undefined;
  const harness =
    options.sandbox && !deps.dry
      ? await openSandboxSession(
          deps,
          { ...opening, options },
          await startedSandbox(options.sandbox)
        )
      : await openLocalSession(deps, opening, meter);
  return retainSession(
    harness,
    id,
    site,
    {
      ...definition.settings,
      ...(limit?.kind === "steps" ? { stopWhen: limit.stopWhen } : {}),
    },
    { ...stamp, input, meter }
  );
}

function turnObserver(site: SessionSite) {
  return site.observe
    ? composeObservers(observeAgentTurn, runTurnObserver(site.observe))
    : observeAgentTurn;
}

async function openSandboxSession(
  deps: AgentsDeps,
  {
    definition,
    execution,
    id,
    options,
    resolution,
    site,
    skills,
  }: Omit<Opening, "options"> & { readonly options: SandboxAgentOptions },
  sandbox: SandboxHandle
): Promise<HarnessSession> {
  const { source } = site;
  const executor: TurnExecutorRef = {
    harness:
      execution === undefined
        ? harnessOf(resolution.provider)
        : (execution?.harness ?? DIRECT_HARNESS),
    model: resolution.model,
    provider: resolution.provider,
  };
  const guest = isCliHarness(executor.harness);
  if (guest) {
    resolution.hold();
    site.retain({ close: () => resolution.release() });
  }
  const sessionOptions = await interactionOptions(
    deps.interactions,
    source,
    definition.id,
    id,
    options
  );
  const harness = await createSandboxSession({
    agentId: definition.id,
    container: deps.containerOf(sandbox),
    ...(execution ? { execution } : {}),
    harness: executor.harness,
    hostCwd: workingDirectory(site.cwd),
    hostToolsForSession: (sessionId) =>
      deps.automations.tools({ agentId: definition.id, sessionId, source }),
    modelId: executor.model,
    observe: turnObserver(site),
    ...(site.observe ? { record: site.observe } : {}),
    onActivity: (event) => deps.activities.record(event, source),
    onChildSession: (sessionId, session) =>
      deps.activities.attach(sessionId, session, { delegated: true }),
    provider: executor.provider,
    registerChildSession: (sessionId) =>
      deps.interactions.registerSession(
        { agentId: definition.id, sessionId, source },
        sessionOptions.authority
      ),
    ...(guest ? {} : { model: heldText(resolution, site) }),
    instructions: [
      definition.prompt,
      ...skills.map((skill) => skill.instructions ?? ""),
    ]
      .filter(Boolean)
      .join("\n\n"),
    options: sessionOptions,
    sessionId: id,
    signal: site.signal(),
    store: deps.sessions,
    ...(resolution.definition.modelId === executor.model
      ? {}
      : { wireModelId: resolution.definition.modelId }),
    write: site.write,
  });
  return deps.activities.attach(
    id,
    guest ? policed(harness, resolution, deps.models, site) : harness
  );
}

async function openLocalSession(
  deps: AgentsDeps,
  {
    definition,
    id,
    limit,
    mcp,
    options,
    resolution,
    route,
    site,
    skills,
  }: Opening,
  meter: CostMeter | undefined
): Promise<SessionHarness> {
  const { modelId, provider } = route;
  const opened = heldText(resolution, site, {
    ...(limit?.kind === "native" ? { nativeMaxTurns: limit.turns } : {}),
    workingDirectory: options.cwd ?? workingDirectory(site.cwd),
  });
  const model = meter ? meter.wrap(opened) : opened;
  const spec: AgentSpec = {
    id: definition.id,
    ...(mcp.length === 0 ? {} : { mcp: mcp.map((client) => client.id) }),
    ...(modelId === undefined ? {} : { model: modelId }),
    prompt: definition.prompt,
    ...(provider === undefined ? {} : { provider }),
    skills: skills.map((skill) => skill.name),
  };
  return await createAgentPreset(spec, {
    mcp: (ids) =>
      Promise.resolve(
        composeTools(
          ...mcp
            .filter((client) => ids.includes(client.id))
            .map((client) => client.tools())
        )
      ),
    model: () => model,
    observe: turnObserver(site),
    skills: () => Promise.resolve(skills),
    store: deps.sessions,
  }).createSession({
    compaction: resolveCompaction(options.compaction, model),
    model,
    sessionId: id,
  });
}

function retainSession<OUTPUT extends Output.Output>(
  harness: SessionHarness | HarnessSession,
  id: string,
  site: SessionSite,
  settings: AgentDefinition<OUTPUT>["settings"],
  {
    implementation,
    input,
    instance,
    meter,
  }: {
    readonly implementation: string | undefined;
    readonly input: KeptInput;
    readonly instance: string | undefined;
    readonly meter: CostMeter | undefined;
  }
): Session<OUTPUT> {
  const close =
    "close" in harness && harness.close
      ? harness.close.bind(harness)
      : undefined;
  let live: LiveSession | undefined;
  site.retain({
    close: async () => {
      live?.turn?.abort(new Error("the session closed"));
      try {
        await close?.();
      } finally {
        await live?.running?.catch(() => undefined);
      }
    },
  });
  const ref: SessionRef = {
    id,
    ...(implementation === undefined ? {} : { implementation }),
    ...input,
    ...(instance === undefined ? {} : { instance }),
    model: harness.route.id,
    provider: harness.route.provider,
  };
  site.record(ref);
  const { consume } = site;
  return wrapAgentSession(
    harness,
    ref,
    {
      ...site,
      ...(consume
        ? {
            consumed: (message, usage) =>
              consume(message, usage, ref, meter?.take()),
          }
        : {}),
      track: (tracked) => {
        live = tracked;
        site.track(tracked);
      },
    },
    settings
  );
}

export class AgentsManager implements Agents {
  readonly #deps: AgentsDeps;
  readonly #closing = new AbortController();
  readonly #held = new Set<Closable>();

  constructor(deps: AgentsDeps) {
    this.#deps = deps;
  }

  get models(): ModelManager {
    return this.#deps.models;
  }

  get sessions(): SessionStore {
    return this.#deps.sessions;
  }

  async session<OUTPUT extends Output.Output = never>(
    definition: AgentLike<OUTPUT>,
    options: SessionOptions = {}
  ): Promise<Session<OUTPUT>> {
    validateSessionOptions(options);
    return await openSession(
      this.#deps,
      this.#directSite(definition, (closable) => this.#held.add(closable)),
      definition,
      options
    );
  }

  forRun(run: {
    readonly id: string;
    readonly name: string;
    retain(closable: Closable): void;
    readonly signal: AbortSignal;
  }): Agents {
    return this.#agents((definition) =>
      hostSite({
        consume: consumer(
          this.#deps,
          inRun(
            { definition: run.name, path: [run.name], runId: run.id },
            definition.id
          )
        ),
        cwd: this.#deps.cwd,
        ...this.#observing(run.id),
        retain: (closable) => run.retain(closable),
        signal: run.signal,
        source: { definition: run.name, path: [run.name], runId: run.id },
      })
    );
  }

  turns(args?: ManagerArgs): AgentTurns {
    const open = (definition: AgentLike<Output.Output>) =>
      this.#turn(definition, args);
    return {
      generate: async (definition, input, options) => {
        const turn = open(definition);
        const replayed = await turn.replayed();
        if (replayed) {
          return replyOf(replayed);
        }
        try {
          const session = await turn.session();
          const reply = await session.generate(input, options);
          turn.record(reply);
          return reply;
        } finally {
          await turn.close();
        }
      },
      stream: (definition, input, options) => {
        const turn = open(definition);
        const opening = (async () => {
          const replayed = await turn.replayed();
          if (replayed) {
            return replayedStream(replyOf(replayed));
          }
          try {
            const stream = (await turn.session()).stream(input, options);
            Promise.all([stream.message, stream.output])
              .then(([message]) => turn.record(message))
              .catch(() => undefined)
              .finally(() => turn.close());
            return stream;
          } catch (error) {
            await turn.close();
            throw error;
          }
        })();
        return deferredStream(opening);
      },
    };
  }

  #turn(definition: AgentLike<Output.Output>, args?: ManagerArgs) {
    const held = new Set<Closable>();
    const claim = args?.scope.claim(args.frame, TURN_KIND);
    const recorded = claim && args?.scope.ledger.get<RecordedTurn>(claim.key);
    const source: Source | undefined = args && {
      definition: args.frame.path[0] ?? definition.id,
      path: [...args.frame.path],
      runId: args.scope.id,
    };
    const site: SessionSite =
      args && source
        ? {
            consume: consumer(this.#deps, inRun(source, definition.id)),
            ...this.#observing(args.scope.id),
            cwd: args.scope.cwd,
            parent: args.scope.session.id,
            record: () => undefined,
            retain: (closable) => held.add(closable),
            signal: () => args.frame.signal,
            source,
            takeResume: () => undefined,
            track: (live) => args.frame.sessions.push(live),
            write: args.write,
          }
        : this.#directSite(definition, (closable) => held.add(closable));
    return {
      close: async () => {
        await Promise.allSettled([...held].map((closable) => closable.close()));
      },
      record: (message: SessionMessage) => {
        if (claim && message.status === "complete") {
          args?.scope.ledger.set(claim.key, {
            agent: definition.id,
            message: message.id,
            path: [...args.frame.path],
            session: message.sessionId,
          } satisfies RecordedTurn);
        }
      },
      replayed: async (): Promise<SessionMessage | undefined> => {
        if (!recorded) {
          return;
        }
        const messages = await this.#deps.sessions.listMessages(
          recorded.session
        );
        return messages.find((message) => message.id === recorded.message);
      },
      session: () => openSession(this.#deps, site, definition, {}),
    };
  }

  #directSite(
    definition: AgentLike<Output.Output>,
    retain: (closable: Closable) => void
  ): SessionSite {
    return {
      consume: consumer(this.#deps, { agentId: definition.id }),
      cwd: this.#deps.cwd,
      record: () => undefined,
      retain,
      signal: () => this.#closing.signal,
      source: { definition: definition.id, path: [], runId: DIRECT },
      takeResume: () => undefined,
      track: () => undefined,
      write: () => undefined,
    };
  }

  scoped(args: ManagerArgs): Agents {
    const { observe } = this.#observing(args.scope.id);
    return this.#agents((definition) =>
      frameSite(this.#deps, args, definition.id, observe)
    );
  }

  #agents(
    siteFor: (definition: AgentLike<Output.Output>) => SessionSite
  ): Agents {
    return {
      session: async (definition, options = {}) => {
        validateSessionOptions(options);
        return await openSession(
          this.#deps,
          siteFor(definition),
          definition,
          options
        );
      },
    };
  }

  #observing(runId: string): { readonly observe?: RecordObservation } {
    const { observe } = this.#deps;
    return observe === undefined
      ? {}
      : { observe: (observation) => observe(runId, observation) };
  }

  async close(): Promise<void> {
    this.#closing.abort(new Error("the engine was disposed"));
    try {
      await Promise.allSettled([...this.#held].map((held) => held.close()));
    } finally {
      this.#held.clear();
      await this.#deps.models.dispose();
    }
  }
}
