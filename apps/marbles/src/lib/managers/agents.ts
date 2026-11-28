import type { AgentSpec } from "@foundry/agents";
import { composeTools, createAgentPreset } from "@foundry/agents";
import type {
  HarnessSession,
  SessionHarness,
  TurnOptions,
} from "@foundry/agents/harness";
import {
  McpClient,
  type McpClientOptions,
  type McpServerDefinition,
} from "@foundry/agents/mcp";
import type {
  SessionInput,
  SessionMessage,
  SessionStream,
  SessionUsage,
} from "@foundry/agents/session";
import { Sessions } from "@foundry/agents/session";
import type { Skill } from "@foundry/agents/skills";
import type { SessionStore } from "@foundry/agents/store";
import type { Authorization } from "@foundry/authorization";
import { canonicalizeJson } from "@foundry/lib/json";
import type { ModelSelection, Models, Resolution } from "@foundry/models";
import { observeAgentTurn } from "@foundry/models";
import type { Container } from "@foundry/sandbox";
import { DEFAULT_SANDBOX_WORKING_DIRECTORY } from "@foundry/sandbox";
import type { Output } from "ai";
import type { AutomationService } from "~/lib/automation";
import type { ManagerArgs } from "~/lib/definitions/bindings";
import {
  AGENT_DEFINITION,
  AGENT_META,
  AGENT_PROMPT,
  SANDBOX_HANDLE,
} from "~/lib/definitions/handles";
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
} from "~/lib/definitions/types";
import type { ExecutionObservation } from "~/lib/executions";
import type { RecordObservation } from "~/lib/executions/observations";
import {
  composeObservers,
  runTurnObserver,
} from "~/lib/executions/observations";
import type { TurnExecutorRef } from "~/lib/managers/cli-harnesses";
import {
  DIRECT_HARNESS,
  harnessOf,
  isCliHarness,
} from "~/lib/managers/cli-harnesses";
import type { Execution } from "~/lib/providers/plugins";
import type { ExecutionContext } from "~/lib/runs/context";
import { withinContext } from "~/lib/runs/context";
import { workingDirectory } from "~/lib/runs/scope";
import type { SandboxGuestSetup, SandboxSessionOptions } from "~/lib/sandbox";
import { createSandboxSession } from "~/lib/sandbox";
import type { HarnessActivities } from "~/lib/sandbox/activities";
import type { HarnessInteractions } from "~/lib/sandbox/interactions";
import { inputSnapshot } from "~/lib/shared/json-data";
import type {
  CostMeter,
  RecordedUsageFact,
  ReportedCost,
  TurnSource,
  UsageLedger,
} from "~/lib/usage";
import { catalogPrices, costMeter, lostFact, usageFact } from "~/lib/usage";
import {
  type LiveSession,
  replayedStream,
  replyOf,
  type SessionTurnSite,
  wrapAgentSession,
} from "./agent-turns";
import { deferredStream } from "./deferred-stream";
import {
  resolveCompaction,
  resolveTurnLimit,
  type TurnLimit,
  TurnLimitUnsupportedError,
} from "./session-options";

export interface AgentsDeps {
  readonly activities: HarnessActivities;
  readonly agentIdOf?: (agent: AgentLike<Output.Output>) => string | undefined;
  readonly authorization: Authorization;
  readonly automations: AutomationService;
  readonly containerOf: (sandbox: SandboxHandle) => Container;
  readonly context?: ExecutionContext;
  readonly createMcpClient?: (
    definition: McpServerDefinition,
    options?: McpClientOptions
  ) => McpClient;
  readonly cwd: string;
  readonly defaultExecutor: () => TurnExecutorRef;
  readonly executionOf?: (provider: string) => Execution | null | undefined;
  readonly implementationOf?: (provider: string) => string | undefined;
  readonly instanceOf?: (provider: string) => string | undefined;
  readonly interactions: HarnessInteractions;
  readonly models: Models;
  readonly observe?: (runId: string, observation: ExecutionObservation) => void;
  readonly requireProviders?: () => void;
  readonly sandboxGuest?: SandboxGuestSetup;
  readonly sessions: SessionStore;
  readonly skills: (set?: SkillSet) => Promise<Skill[]>;
  readonly undefinedProvider?: (id: string) => string | undefined;
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

interface SessionSite extends Omit<SessionTurnSite, "consumed" | "track"> {
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
    agent: agentId,
    consume: consumer(deps, inRun(source, agentId)),
    cwd: scope.cwd,
    ...(observe === undefined ? {} : { observe }),
    parent: scope.session.id,
    record: (ref) => scope.ledger.set(key, ref),
    ...(recorded === undefined ? {} : { recorded }),
    retain: (closable) => frame.opened.add(closable),
    signal: () => frame.signal,
    source,
    takeResume: () => scope.takeResumePrompt(frame),
    work: frame.work,
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

function resolveRoute(deps: AgentsDeps, route: Route): Resolution<"text"> {
  try {
    return deps.models.resolve(
      "text",
      selectionOf({ model: route.modelId, provider: route.provider })
    );
  } catch (error) {
    const asked = route.provider ?? route.modelId;
    const [id] = (asked ?? "").split("/");
    const problem =
      id === undefined || id === "" ? undefined : deps.undefinedProvider?.(id);
    if (problem === undefined) {
      throw error;
    }
    throw new Error(`cannot use "${asked}": ${problem}`, { cause: error });
  }
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

function interactionOptions(
  interactions: HarnessInteractions,
  source: Source,
  options: SandboxAgentOptions
): SandboxSessionOptions {
  const authority = interactions.authority(source, options.authority);
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
  input: unknown,
  resolvedId?: string
) => Promise<AgentDefinition<Output.Output>>;

export async function buildDefinition<OUTPUT extends Output.Output>(
  agent: AgentLike<OUTPUT>,
  route: AgentRoute = {},
  input: unknown = (agent as { readonly input?: unknown }).input,
  resolvedId?: string
): Promise<AgentDefinition<OUTPUT>> {
  const build = Reflect.get(agent, AGENT_DEFINITION) as
    | DefinitionBuilder
    | undefined;
  if (build) {
    return (await build(route, input, resolvedId)) as AgentDefinition<OUTPUT>;
  }
  const id = resolvedId ?? agent.id;
  if (typeof agent.prompt !== "string") {
    throw new Error(`agent "${id}" has no prompt`);
  }
  if (id === agent.id) {
    return agent as AgentDefinition<OUTPUT>;
  }
  const promptRender = (agent as AgentDefinition<Output.Output>)[AGENT_PROMPT];
  return {
    ...(agent as AgentDefinition<OUTPUT>),
    ...(promptRender === undefined ? {} : { [AGENT_PROMPT]: promptRender }),
    id,
  };
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
  kept: SessionRef | undefined,
  agentId: string
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
      `agent "${agentId}": session ${kept.id} was opened with another input; open a new session for this one`
    );
  }
  return { input: given };
}

async function connectServers(
  deps: AgentsDeps,
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
  if (servers.length === 0) {
    return [];
  }
  const createClient =
    deps.createMcpClient ??
    ((serverConfig: McpServerDefinition) => new McpClient(serverConfig));
  const clients = servers.map((server) =>
    createClient({ ...server, enabled: true })
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

function turnLimitMode(resolution: Resolution<"text">): TurnLimit["kind"] {
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
  readonly executor: TurnExecutorRef;
  readonly id: string;
  readonly limit: TurnLimit | undefined;
  readonly mcp: readonly McpClient[];
  readonly options: SessionOptions;
  readonly prompt: string;
  readonly resolution: Resolution<"text">;
  readonly route: Route;
  readonly site: SessionSite;
  readonly skills: Skill[];
}

async function openSession<OUTPUT extends Output.Output>(
  deps: AgentsDeps,
  site: SessionSite,
  agent: AgentLike<OUTPUT>,
  options: SessionOptions,
  agentId: string
): Promise<Session<OUTPUT>> {
  const { context } = deps;
  const session = await withinContext(context, () =>
    openUnentered(deps, site, agent, options, agentId)
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
  options: SessionOptions,
  agentId: string
): Promise<Session<OUTPUT>> {
  const recordedOn = site.recorded?.provider;
  const input = sessionInput(
    agent,
    site.recorded ?? (options.session ? refOf(options.session) : undefined),
    agentId
  );
  const definition = await buildDefinition(
    agent,
    recordedOn === undefined ? {} : { provider: recordedOn },
    input.input,
    agentId
  );
  site.signal().throwIfAborted();
  if (options.sandbox && definition.mcp?.length) {
    throw new Error(
      `agent "${definition.id}" names MCP servers, which a sandbox session cannot reach yet`
    );
  }
  const mcp = await connectServers(
    deps,
    definition as AgentDefinition<Output.Output>,
    site
  );
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
  const resolution = resolveRoute(deps, route);
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
  const execution = deps.executionOf?.(resolution.provider);
  const executor: TurnExecutorRef = {
    harness:
      execution === undefined
        ? harnessOf(resolution.provider)
        : (execution?.harness ?? DIRECT_HARNESS),
    model: resolution.model,
    provider: resolution.provider,
  };
  const limit =
    options.sandbox || options.maxTurns === undefined
      ? undefined
      : resolveTurnLimit(options.maxTurns, turnLimitMode(resolution));
  const opening: Opening = {
    definition,
    execution,
    executor,
    id,
    limit,
    mcp,
    options,
    prompt: definition[AGENT_PROMPT]?.(executor.harness) ?? definition.prompt,
    resolution,
    route,
    site,
    skills: await deps.skills(definition.skills),
  };
  const meter = site.consume && !options.sandbox ? costMeter() : undefined;
  const harness = options.sandbox
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
    executor,
    id,
    options,
    prompt,
    resolution,
    site,
    skills,
  }: Omit<Opening, "options"> & { readonly options: SandboxAgentOptions },
  sandbox: SandboxHandle
): Promise<HarnessSession> {
  const { source } = site;
  const guest = isCliHarness(executor.harness);
  if (guest) {
    resolution.hold();
    site.retain({ close: () => resolution.release() });
  }
  const sessionOptions = interactionOptions(deps.interactions, source, options);
  const harness = await createSandboxSession({
    agentId: definition.id,
    container: deps.containerOf(sandbox),
    ...(deps.sandboxGuest?.drivers
      ? { drivers: deps.sandboxGuest.drivers }
      : {}),
    ...(execution ? { execution } : {}),
    ...(deps.sandboxGuest?.guestAuth
      ? { guestAuth: deps.sandboxGuest.guestAuth }
      : {}),
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
    ...(deps.sandboxGuest?.prepareGuest
      ? { prepareGuest: deps.sandboxGuest.prepareGuest }
      : {}),
    provider: executor.provider,
    ...(guest ? {} : { model: heldText(resolution, site) }),
    instructions: [prompt, ...skills.map((skill) => skill.instructions ?? "")]
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
  return deps.activities.attach(id, harness);
}

async function openLocalSession(
  deps: AgentsDeps,
  {
    definition,
    id,
    limit,
    mcp,
    options,
    prompt,
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
    prompt,
    ...(provider === undefined ? {} : { provider }),
    skills: skills.map((skill) => skill.name),
  };
  const authorization =
    (options.sandbox ? undefined : options.authorization) ?? deps.authorization;
  return await createAgentPreset(spec, {
    authorization,
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
    authorization,
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
      },
    },
    settings
  );
}

export class AgentsManager implements Agents {
  readonly #deps: AgentsDeps;
  readonly #closing = new AbortController();
  readonly #held = new Set<Closable>();
  readonly #seenFunctionAgents = new Map<string, object>();

  constructor(deps: AgentsDeps) {
    this.#deps = deps;
  }

  get models(): Models {
    return this.#deps.models;
  }

  get sessions(): SessionStore {
    return this.#deps.sessions;
  }

  #agentId(definition: AgentLike<Output.Output>): string {
    const id = this.#deps.agentIdOf?.(definition) ?? definition.id;
    const meta = (
      definition as { readonly [AGENT_META]?: { readonly define?: object } }
    )[AGENT_META];
    if (meta?.define !== undefined) {
      const seen = this.#seenFunctionAgents.get(id);
      if (seen !== undefined && seen !== meta.define) {
        throw new Error(
          `agent "${id}" already declared by another function; an agent declared with a function is identified by its export or explicit name, not by the values it closes over, so these two would share approvals and triggers. Name each with agent("name", fn) or export each with its own name`
        );
      }
      this.#seenFunctionAgents.set(id, meta.define);
    }
    return id;
  }

  async session<OUTPUT extends Output.Output = never>(
    definition: AgentLike<OUTPUT>,
    options: SessionOptions = {}
  ): Promise<Session<OUTPUT>> {
    validateSessionOptions(options);
    const agentId = this.#agentId(definition);
    return await openSession(
      this.#deps,
      this.#directSite(agentId, (closable) => this.#held.add(closable)),
      definition,
      options,
      agentId
    );
  }

  forRun(run: {
    readonly id: string;
    readonly name: string;
    retain(closable: Closable): void;
    readonly signal: AbortSignal;
  }): Agents {
    return this.#agents((agentId) =>
      hostSite({
        consume: consumer(
          this.#deps,
          inRun(
            { definition: run.name, path: [run.name], runId: run.id },
            agentId
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
        const opening = (async () => {
          const turn = open(definition);
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
    const agentId = this.#agentId(definition);
    const held = new Set<Closable>();
    const claim = args?.scope.claim(args.frame, TURN_KIND);
    const recorded = claim && args?.scope.ledger.get<RecordedTurn>(claim.key);
    const source: Source | undefined = args && {
      definition: args.frame.path[0] ?? agentId,
      path: [...args.frame.path],
      runId: args.scope.id,
    };
    const site: SessionSite =
      args && source
        ? {
            agent: agentId,
            consume: consumer(this.#deps, inRun(source, agentId)),
            ...this.#observing(args.scope.id),
            cwd: args.scope.cwd,
            parent: args.scope.session.id,
            record: () => undefined,
            retain: (closable) => held.add(closable),
            signal: () => args.frame.signal,
            source,
            takeResume: () => undefined,
            work: args.frame.work,
            write: args.write,
          }
        : this.#directSite(agentId, (closable) => held.add(closable));
    return {
      close: async () => {
        await Promise.allSettled([...held].map((closable) => closable.close()));
      },
      record: (message: SessionMessage) => {
        if (claim && message.status === "complete") {
          args?.scope.ledger.set(claim.key, {
            agent: agentId,
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
      session: () => openSession(this.#deps, site, definition, {}, agentId),
    };
  }

  #directSite(
    agentId: string,
    retain: (closable: Closable) => void
  ): SessionSite {
    return {
      consume: consumer(this.#deps, { agentId }),
      cwd: this.#deps.cwd,
      record: () => undefined,
      retain,
      signal: () => this.#closing.signal,
      source: { definition: agentId, path: [], runId: DIRECT },
      takeResume: () => undefined,
      write: () => undefined,
    };
  }

  scoped(args: ManagerArgs): Agents {
    const { observe } = this.#observing(args.scope.id);
    return this.#agents((agentId) =>
      frameSite(this.#deps, args, agentId, observe)
    );
  }

  #agents(siteFor: (agentId: string) => SessionSite): Agents {
    return {
      session: async (definition, options = {}) => {
        validateSessionOptions(options);
        const agentId = this.#agentId(definition);
        return await openSession(
          this.#deps,
          siteFor(agentId),
          definition,
          options,
          agentId
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
