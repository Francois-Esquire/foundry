import type { AgentSpec } from "@foundry/agents/agents/index";
import { createAgentPreset } from "@foundry/agents/agents/index";
import type {
  HarnessSession,
  SessionHarness,
  SessionStreamOptions,
} from "@foundry/agents/harness";
import type {
  SessionInput,
  SessionMessage,
  SessionStore,
} from "@foundry/agents/session";
import { createModelSummarizer } from "@foundry/agents/session";
import type { Skill } from "@foundry/agents/skills";
import type { ModelManager, TurnExecutorRef } from "@foundry/models";
import { observeAgentTurn } from "@foundry/models";

import type { AutomationService } from "~/automation/service";
import type { HarnessActivities } from "~/sandbox/activities";
import type { HarnessInteractions } from "~/sandbox/interactions";
import { createSandboxSession } from "~/sandbox/session";

import type { ManagerArgs } from "../bindings";
import type { Frame, LiveSession } from "../run-scope";
import { current } from "../run-scope";
import type {
  AgentDefinition,
  Agents,
  Session,
  SessionOptions,
  SessionRef,
  SessionReply,
  SkillSet,
} from "../types";

/**
 * Sessions over `createAgentPreset`, wired by default: the provider is the
 * harness, the working directory is the frame's, every turn is aborted with
 * the step, and its text lands on the step's stream. The n-th call in a body
 * returns the session it created the first time, so a replay continues the
 * same transcript.
 *
 * A host can steer a turn: the turn's own controller aborts it, the
 * partial reply is committed by the harness, and the prompt runs as the next
 * turn on the same session, so the author's `await generate()` resolves
 * with the steered reply. A prompt given on resume after a pause is
 * prepended to the first turn of a recorded session in that step.
 */

export interface AgentsDeps {
  readonly activities?: HarnessActivities;
  readonly automations?: AutomationService;
  /** The route when an agent names neither model nor provider. */
  readonly defaultExecutor: () => TurnExecutorRef;
  /** Simulation uses echo models and never prepares a guest or reads credentials. */
  readonly dry?: boolean;
  readonly interactions?: HarnessInteractions;
  readonly models: ModelManager;
  readonly sessions: SessionStore;
  readonly skills: (set?: SkillSet) => Promise<Skill[]>;
  readonly warn: (message: string) => void;
}

const KIND = "agents.session";

function refOf(session: SessionRef | Session): SessionRef {
  return "ref" in session ? session.ref : session;
}

function textOf(message: SessionMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

function wrap(
  harness: SessionHarness | HarnessSession,
  ref: SessionRef,
  frame: Frame,
  write: (value: unknown) => void,
  recorded: boolean
): Session {
  const live: LiveSession = { ref };
  frame.sessions.push(live);
  const turnOptions = (
    turn: AbortController,
    options?: SessionStreamOptions
  ): SessionStreamOptions => {
    const signals = [frame.signal, turn.signal];
    if (options?.signal) {
      signals.push(options.signal);
    }
    return {
      ...options,
      onText: (delta) => {
        write(delta);
        options?.onText?.(delta);
      },
      signal: AbortSignal.any(signals),
    };
  };
  const check = () => {
    if (frame.signal.aborted) {
      throw frame.signal.reason instanceof Error
        ? frame.signal.reason
        : new Error(String(frame.signal.reason ?? "step cancelled"));
    }
  };
  /** The turn's controller is on the live session while it runs, for steer. */
  const begin = (): AbortController => {
    const turn = new AbortController();
    live.turn = turn;
    return turn;
  };
  const end = (turn: AbortController) => {
    if (live.turn === turn) {
      live.turn = undefined;
    }
  };
  /** A resume prompt rides on the first turn of the session that was parked. */
  const withResume = (input: SessionInput): SessionInput => {
    const prompt = frame.resumePrompt;
    if (!(recorded && prompt !== undefined && typeof input === "string")) {
      return input;
    }
    frame.resumePrompt = undefined;
    write(`\n[resume] ${prompt}\n`);
    return `${prompt}\n\n${input}`;
  };
  /**
   * A turn cut short by the step's abort is committed by the harness and
   * resolves as if complete; the check afterwards is what keeps authored
   * code from running on after a pause or a cancellation.
   */
  const settled = <T>(value: Promise<T>): Promise<T> => {
    const checked = value.then((result) => {
      check();
      return result;
    });
    checked.catch(() => undefined);
    return checked;
  };
  return {
    async generate(input, options): Promise<SessionReply> {
      check();
      const turn = begin();
      let message: SessionMessage;
      try {
        message = await harness.generate(
          withResume(input),
          turnOptions(turn, options)
        );
      } finally {
        end(turn);
      }
      check();
      while (live.steer !== undefined) {
        const prompt = live.steer;
        live.steer = undefined;
        write(`\n[steer] ${prompt}\n`);
        const next = begin();
        try {
          message = await harness.generate(prompt, turnOptions(next, options));
        } finally {
          end(next);
        }
        check();
      }
      return { ...message, text: textOf(message) };
    },
    harness,
    ref,
    stream(input, options) {
      check();
      const turn = begin();
      const stream = harness.stream(
        withResume(input),
        turnOptions(turn, options)
      );
      stream.message.finally(() => end(turn)).catch(() => undefined);
      return {
        async *[Symbol.asyncIterator]() {
          yield* stream;
          check();
        },
        message: settled(stream.message),
        outcome: settled(stream.outcome),
        text: settled(stream.text),
        usage: settled(stream.usage),
      };
    },
  };
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

async function adoptIntoRun(
  store: SessionStore,
  runSessionId: string,
  id: string
): Promise<void> {
  if ((await store.getSession(runSessionId)) === null) {
    await store.createSession({ id: runSessionId, title: "run" });
  }
  if ((await store.getSession(id)) === null) {
    await store.createSession({ id, parentSessionId: runSessionId });
  }
}

function sandboxModel(models: ModelManager, executor: TurnExecutorRef) {
  if (executor.harness === "claude-code" || executor.harness === "codex") {
    return {};
  }
  return { model: models.model(executor.model, executor.provider) };
}

function sandboxExecutor(
  models: ModelManager,
  model: string | undefined,
  provider: string | undefined
): TurnExecutorRef {
  if (model && (provider === "claude-code" || provider === "codex")) {
    return { harness: provider, model, provider };
  }
  return models.resolveTextExecutor(model, provider);
}

function validateSessionOptions(options: SessionOptions): void {
  if (options.sandbox && options.cwd !== undefined) {
    throw new Error(
      "Sandbox sessions run in /workspace. Select the workspace through the sandbox mount."
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
  interactions: HarnessInteractions | undefined,
  { frame, scope }: ManagerArgs,
  agentId: string,
  sessionId: string,
  options: SessionOptions
): Promise<SessionOptions> {
  if (!interactions) {
    return options;
  }
  const source = {
    definition: frame.path[0] ?? agentId,
    path: [...frame.path],
    runId: scope.id,
  };
  await interactions.registerSession(
    { agentId, sessionId, source },
    options.authority?.policy
  );
  return {
    ...options,
    authority: interactions.authority(source, options.authority),
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

async function openSession(
  deps: AgentsDeps,
  { cwd, frame, scope, write }: ManagerArgs,
  definition: AgentDefinition,
  options: SessionOptions
): Promise<Session> {
  validateSessionOptions(options);
  const { key } = scope.claim(frame, KIND);
  const recorded = scope.ledger.get<SessionRef>(key);
  const wanted = options.session ? refOf(options.session) : undefined;

  const fallback =
    definition.provider === undefined && definition.model === undefined
      ? deps.defaultExecutor()
      : undefined;
  const provider = definition.provider ?? fallback?.provider;
  const modelId = definition.model ?? fallback?.model;
  // A worktree callback narrows the working directory through the async
  // store; a session opened inside it runs there unless the call says otherwise.

  const id = sessionIdFor(recorded, wanted, provider, deps.warn);
  // A fresh session is a child of the run's own session, which is created
  // in the store the first time the run needs it, so a host can read every
  // agent the run opened through `run.session`.
  if (id !== recorded?.id && id !== wanted?.id) {
    await adoptIntoRun(deps.sessions, scope.session.id, id);
  }

  const skills = await deps.skills(definition.skills);
  if (options.sandbox && !deps.dry) {
    const executor = sandboxExecutor(deps.models, modelId, provider);
    const sessionOptions = await interactionOptions(
      deps.interactions,
      { cwd, frame, scope, write },
      definition.id,
      id,
      options
    );
    const source = {
      definition: frame.path[0] ?? definition.id,
      path: [...frame.path],
      runId: scope.id,
    };
    const harness = await createSandboxSession({
      agentId: definition.id,
      harness: executor.harness,
      hostCwd: current.getStore()?.cwd ?? cwd,
      hostToolsForSession: (sessionId) =>
        deps.automations?.tools({
          agentId: definition.id,
          sessionId,
          source,
        }) ?? {},
      modelId: executor.model,
      onActivity: deps.activities
        ? (event) => deps.activities?.record(event, source)
        : undefined,
      onChildSession: (sessionId, activityId, session) =>
        deps.activities?.attach(sessionId, session, activityId),
      provider: executor.provider,
      registerChildSession: (sessionId) =>
        deps.interactions?.registerSession(
          { agentId: definition.id, sessionId, source },
          sessionOptions.authority?.policy
        ) ?? Promise.resolve(),
      ...sandboxModel(deps.models, executor),
      instructions: [
        definition.prompt,
        ...skills.map((skill) => skill.instructions ?? ""),
      ]
        .filter(Boolean)
        .join("\n\n"),
      options: sessionOptions,
      sessionId: id,
      signal: frame.signal,
      store: deps.sessions,
      write,
    });
    deps.activities?.attach(id, harness);
    return retainSession(
      harness,
      id,
      { cwd, frame, scope, write },
      key,
      recorded !== undefined
    );
  }
  const model = deps.models.model(modelId, provider, {
    workingDirectory: options.cwd ?? current.getStore()?.cwd ?? cwd,
  });
  const spec: AgentSpec = {
    id: definition.id,
    ...(modelId === undefined ? {} : { model: modelId }),
    prompt: definition.prompt,
    ...(provider === undefined ? {} : { provider }),
    skills: skills.map((skill) => skill.name),
  };
  const harness = await createAgentPreset(spec, {
    model: () => model,
    observe: observeAgentTurn,
    skills: () => Promise.resolve(skills),
    store: deps.sessions,
  }).createSession({
    ...(options.compaction
      ? {
          compaction: {
            summarizer: createModelSummarizer({ model }),
            ...(options.compaction === true ? {} : options.compaction),
          },
        }
      : {}),
    model,
    sessionId: id,
  });

  return retainSession(
    harness,
    id,
    { cwd, frame, scope, write },
    key,
    recorded !== undefined
  );
}

function retainSession(
  harness: SessionHarness | HarnessSession,
  id: string,
  { frame, scope, write }: ManagerArgs,
  key: string,
  recorded: boolean
): Session {
  if ("close" in harness && harness.close) {
    const { close } = harness;
    frame.opened.add({ close: () => close.call(harness) });
  }
  const ref: SessionRef = {
    id,
    model: harness.route.id,
    provider: harness.route.provider,
  };
  scope.ledger.set(key, ref);
  return wrap(harness, ref, frame, write, recorded);
}

export function agentsManager(deps: AgentsDeps): (args: ManagerArgs) => Agents {
  return (args) => ({
    session: (definition, options = {}) =>
      openSession(deps, args, definition, options),
  });
}
