import type { AgentSpec } from "@foundry/agents/agents/index";
import { createAgentPreset } from "@foundry/agents/agents/index";
import type {
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
  /** The route when an agent names neither model nor provider. */
  readonly defaultExecutor: () => TurnExecutorRef;
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
  harness: SessionHarness,
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
      while (live.steer !== undefined) {
        check();
        const prompt = live.steer;
        live.steer = undefined;
        write(`\n[steer] ${prompt}\n`);
        const next = begin();
        try {
          message = await harness.generate(prompt, turnOptions(next, options));
        } finally {
          end(next);
        }
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
      return stream;
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

async function openSession(
  deps: AgentsDeps,
  { cwd, frame, scope, write }: ManagerArgs,
  definition: AgentDefinition,
  options: SessionOptions
): Promise<Session> {
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
  const model = deps.models.model(modelId, provider, {
    workingDirectory: options.cwd ?? current.getStore()?.cwd ?? cwd,
  });

  const id = sessionIdFor(recorded, wanted, provider, deps.warn);

  const skills = await deps.skills(definition.skills);
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

  const ref: SessionRef = {
    id,
    model: harness.route.id,
    provider: harness.route.provider,
  };
  scope.ledger.set(key, ref);
  return wrap(harness, ref, frame, write, recorded !== undefined);
}

export function agentsManager(deps: AgentsDeps): (args: ManagerArgs) => Agents {
  return (args) => ({
    session: (definition, options = {}) =>
      openSession(deps, args, definition, options),
  });
}
