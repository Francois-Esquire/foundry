import type { AgentSpec } from "@foundry/agents/agents/index";
import { createAgentPreset } from "@foundry/agents/agents/index";
import type { HarnessSession, SessionHarness } from "@foundry/agents/harness";
import type { SessionStore } from "@foundry/agents/session";
import type { Skill } from "@foundry/agents/skills";
import type { ModelManager, TurnExecutorRef } from "@foundry/models";
import { observeAgentTurn } from "@foundry/models";
import { DEFAULT_SANDBOX_WORKING_DIRECTORY } from "@foundry/sandbox/constants";
import type { Container } from "@foundry/sandbox/container/containers";

import type { AutomationService } from "~/lib/automation/service";
import { isCliHarness } from "~/lib/cli-harnesses";
import type { HarnessActivities } from "~/lib/sandbox/activities";
import type { HarnessInteractions } from "~/lib/sandbox/interactions";
import type { SandboxSessionOptions } from "~/lib/sandbox/session";
import { createSandboxSession } from "~/lib/sandbox/session";
import type { ManagerArgs } from "../bindings";
import type { LiveSession } from "../run-scope";
import { workingDirectory } from "../run-scope";
import type {
  AgentDefinition,
  Agents,
  Sandbox,
  SandboxAgentOptions,
  Session,
  SessionOptions,
  SessionRef,
  SkillSet,
} from "../types";
import { type SessionTurnSite, wrapAgentSession } from "./agent-turns";
import { resolveCompaction } from "./session-options";

/**
 * Sessions over `createAgentPreset`, wired by default: the provider is the
 * harness and the working directory is the workspace root. Opened through a
 * step's view, the working directory is the frame's, every turn is aborted
 * with the step, and its text lands on the step's stream; the n-th call in a
 * body returns the session it created the first time, so a replay continues
 * the same transcript. Opened on the manager there is no step: each call is
 * a new session, and it lives until the engine is disposed.
 *
 * A host can steer a turn: the turn's own controller aborts it, the
 * partial reply is committed by the harness, and the prompt runs as the next
 * turn on the same session, so the author's `await generate()` resolves
 * with the steered reply. A prompt given on resume after a pause is
 * prepended to the first turn of a recorded session in that step.
 */

export interface AgentsDeps {
  /** What agents inside sandboxes are doing, recorded per session. */
  readonly activities: HarnessActivities;
  /** The triggers a sandboxed agent may create, offered to it as tools. */
  readonly automations: AutomationService;
  /** The container behind a sandbox handle; a sandbox session's harness runs in it. */
  readonly containerOf: (sandbox: Sandbox) => Container;
  /** The route when an agent names neither model nor provider. */
  readonly defaultExecutor: () => TurnExecutorRef;
  /** Simulation uses echo models and never prepares a guest or reads credentials. */
  readonly dry: boolean;
  /** Approvals and questions from sandboxed agents, routed to the host. */
  readonly interactions: HarnessInteractions;
  readonly models: ModelManager;
  /** The workspace root: where a session opened outside a step works. */
  readonly root: string;
  readonly sessions: SessionStore;
  readonly skills: (set?: SkillSet) => Promise<Skill[]>;
  readonly warn: (message: string) => void;
}

const KIND = "agents.session";
/** The run id of a session opened on the manager, outside any run. */
const DIRECT = "direct";

interface Closable {
  close(): Promise<void> | void;
}

/** Who is asking, for approvals, activity, and the triggers an agent creates. */
interface Source {
  readonly definition: string;
  readonly path: string[];
  readonly runId: string;
}

/**
 * What a session is opened against. Inside a step it is the frame: the call
 * is counted for replay, turns stop with the step, and the session closes
 * when the run settles. On the manager it is the engine itself.
 */
interface SessionSite extends SessionTurnSite {
  /** The working directory when neither the call nor a worktree names one: the run's root, or the workspace root. */
  readonly cwd: string;
  /** The run's own session; a fresh session is filed under it. */
  readonly parent?: string;
  /** Remember the session this call opened, for the next time its body runs. */
  record(ref: SessionRef): void;
  /** The session this call opened the first time its body ran. */
  readonly recorded?: SessionRef;
  /** Close this with whatever the session belongs to. */
  retain(closable: Closable): void;
  /** Aborts every turn. Read per turn: a frame reissues its signal after a pause. */
  signal(): AbortSignal;
  readonly source: Source;
  /** A prompt given on resume after a pause; handed out once. */
  takeResume(): string | undefined;
  /** Make the session steerable by a host. */
  track(live: LiveSession): void;
  write(value: unknown): void;
}

/** The site a step's frame is: one claim per call, in call order. */
function frameSite(
  { frame, scope, write }: ManagerArgs,
  agentId: string
): SessionSite {
  const { key } = scope.claim(frame, KIND);
  const recorded = scope.ledger.get<SessionRef>(key);
  return {
    cwd: scope.cwd,
    parent: scope.session.id,
    record: (ref) => scope.ledger.set(key, ref),
    ...(recorded === undefined ? {} : { recorded }),
    retain: (closable) => frame.opened.add(closable),
    signal: () => frame.signal,
    source: {
      definition: frame.path[0] ?? agentId,
      path: [...frame.path],
      runId: scope.id,
    },
    takeResume: () => {
      const prompt = frame.resumePrompt;
      frame.resumePrompt = undefined;
      return prompt;
    },
    track: (live) => frame.sessions.push(live),
    write,
  };
}

function refOf(session: SessionRef | Session): SessionRef {
  return "ref" in session ? session.ref : session;
}

/** The recorded id on replay, the wanted one when its provider matches, else fresh. */
function sessionIdFor(
  recorded: SessionRef | undefined,
  wanted: SessionRef | undefined,
  provider: string | undefined,
  warn: (message: string) => void
): string {
  if (recorded) {
    return recorded.id;
  }
  if (wanted) {
    if (wanted.provider === undefined || wanted.provider === provider) {
      return wanted.id;
    }
    warn(
      `session ${wanted.id} was opened on ${wanted.provider}; starting a new session on ${provider ?? "the default provider"}`
    );
  }
  return crypto.randomUUID();
}

/** File a fresh session under the run's own, or on its own outside a run. */
async function fileSession(
  store: SessionStore,
  parent: string | undefined,
  id: string
): Promise<void> {
  if (parent !== undefined && (await store.getSession(parent)) === null) {
    await store.createSession({ id: parent, title: "run" });
  }
  if ((await store.getSession(id)) === null) {
    await store.createSession(
      parent === undefined ? { id } : { id, parentSessionId: parent }
    );
  }
}

/** A CLI harness runs its own CLI in the guest; any other harness needs the network model. */
function sandboxModel(models: ModelManager, executor: TurnExecutorRef) {
  if (isCliHarness(executor.harness)) {
    return {};
  }
  return { model: models.model(executor.model, executor.provider) };
}

/** A CLI harness's provider shares its id, and runs any model it is named with. */
function sandboxExecutor(
  models: ModelManager,
  model: string | undefined,
  provider: string | undefined
): TurnExecutorRef {
  if (model && isCliHarness(provider)) {
    return { harness: provider, model, provider };
  }
  return models.resolveTextExecutor(model, provider);
}

function validateSessionOptions(options: SessionOptions): void {
  if (options.sandbox && options.cwd !== undefined) {
    throw new Error(
      `Sandbox sessions run in ${DEFAULT_SANDBOX_WORKING_DIRECTORY}. Select the workspace through the sandbox mount.`
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

/** A sandbox session's options with its authority settled, and the session registered under it. */
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

/** Where a session's turns go: the agent's own route, else the engine's default. */
interface Route {
  readonly modelId: string | undefined;
  readonly provider: string | undefined;
}

/** What both kinds of session are opened with, once the route and id are settled. */
interface Opening {
  readonly definition: AgentDefinition;
  readonly id: string;
  readonly options: SessionOptions;
  readonly route: Route;
  readonly site: SessionSite;
  readonly skills: Skill[];
}

/**
 * The route, the session id, and the skills, then a sandbox session or a
 * local one. A fresh session is a child of the run's own session, which is
 * created in the store the first time the run needs it, so a host can read
 * every agent the run opened through `run.session`.
 */
async function openSession(
  deps: AgentsDeps,
  site: SessionSite,
  definition: AgentDefinition,
  options: SessionOptions
): Promise<Session> {
  const wanted = options.session ? refOf(options.session) : undefined;
  const fallback =
    definition.provider === undefined && definition.model === undefined
      ? deps.defaultExecutor()
      : undefined;
  const route: Route = {
    modelId: definition.model ?? fallback?.model,
    provider: definition.provider ?? fallback?.provider,
  };
  const id = sessionIdFor(site.recorded, wanted, route.provider, deps.warn);
  if (id !== site.recorded?.id && id !== wanted?.id) {
    await fileSession(deps.sessions, site.parent, id);
  }
  const opening: Opening = {
    definition,
    id,
    options,
    route,
    site,
    skills: await deps.skills(definition.skills),
  };
  const harness =
    options.sandbox && !deps.dry
      ? await openSandboxSession(deps, { ...opening, options }, options.sandbox)
      : await openLocalSession(deps, opening);
  return retainSession(harness, id, site);
}

/** A harness inside the sandbox's container, with approvals, questions, and activity routed to the host. */
async function openSandboxSession(
  deps: AgentsDeps,
  {
    definition,
    id,
    options,
    route,
    site,
    skills,
  }: Omit<Opening, "options"> & { readonly options: SandboxAgentOptions },
  sandbox: Sandbox
): Promise<HarnessSession> {
  const { source } = site;
  const executor = sandboxExecutor(deps.models, route.modelId, route.provider);
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
    harness: executor.harness,
    hostCwd: workingDirectory(site.cwd),
    hostToolsForSession: (sessionId) =>
      deps.automations.tools({ agentId: definition.id, sessionId, source }),
    modelId: executor.model,
    onActivity: (event) => deps.activities.record(event, source),
    onChildSession: (sessionId, session) =>
      deps.activities.attach(sessionId, session, { delegated: true }),
    provider: executor.provider,
    registerChildSession: (sessionId) =>
      deps.interactions.registerSession(
        { agentId: definition.id, sessionId, source },
        sessionOptions.authority
      ),
    ...sandboxModel(deps.models, executor),
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
    write: site.write,
  });
  return deps.activities.attach(id, harness);
}

/**
 * An agent preset in this process. It works where the call says, else in
 * the worktree a callback narrowed the frame to, else the site's directory.
 */
async function openLocalSession(
  deps: AgentsDeps,
  { definition, id, options, route, site, skills }: Opening
): Promise<SessionHarness> {
  const { modelId, provider } = route;
  const model = deps.models.model(modelId, provider, {
    workingDirectory: options.cwd ?? workingDirectory(site.cwd),
  });
  const spec: AgentSpec = {
    id: definition.id,
    ...(modelId === undefined ? {} : { model: modelId }),
    prompt: definition.prompt,
    ...(provider === undefined ? {} : { provider }),
    skills: skills.map((skill) => skill.name),
  };
  return await createAgentPreset(spec, {
    model: () => model,
    observe: observeAgentTurn,
    skills: () => Promise.resolve(skills),
    store: deps.sessions,
  }).createSession({
    compaction: resolveCompaction(options.compaction, model),
    model,
    sessionId: id,
  });
}

function retainSession(
  harness: SessionHarness | HarnessSession,
  id: string,
  site: SessionSite
): Session {
  if ("close" in harness && harness.close) {
    const { close } = harness;
    site.retain({ close: () => close.call(harness) });
  }
  const ref: SessionRef = {
    id,
    model: harness.route.id,
    provider: harness.route.provider,
  };
  site.record(ref);
  return wrapAgentSession(harness, ref, site);
}

export class AgentsManager implements Agents {
  readonly #deps: AgentsDeps;
  /** Stops the turns of sessions opened outside a step. */
  readonly #closing = new AbortController();
  /** What those sessions hold open; closed with the manager. */
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

  /**
   * Open a session outside any step: it works in the workspace root unless
   * the call names a directory, each call is a new session, and it stays
   * open until the engine is disposed. Pass `onText` to a turn to stream it.
   */
  async session(
    definition: AgentDefinition,
    options: SessionOptions = {}
  ): Promise<Session> {
    validateSessionOptions(options);
    return await openSession(
      this.#deps,
      {
        cwd: this.#deps.root,
        record: () => undefined,
        retain: (closable) => this.#held.add(closable),
        signal: () => this.#closing.signal,
        source: { definition: definition.id, path: [], runId: DIRECT },
        takeResume: () => undefined,
        track: () => undefined,
        write: () => undefined,
      },
      definition,
      options
    );
  }

  /** What a step body sees: sessions bound to its frame's signal, stream, and working directory. */
  scoped(args: ManagerArgs): Agents {
    return {
      session: async (definition, options = {}) => {
        validateSessionOptions(options);
        return await openSession(
          this.#deps,
          frameSite(args, definition.id),
          definition,
          options
        );
      },
    };
  }

  /**
   * Stop what was opened outside a step, then the models: the Codex provider
   * holds a `codex app-server` child, and without this the process never
   * exits.
   */
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
